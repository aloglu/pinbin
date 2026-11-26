from __future__ import annotations

import io
import ipaddress
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.backup import BackupError, create_backup_zip_bytes, restore_backup_zip_bytes
from app.config import Settings
from app.db import (
    create_part,
    create_project,
    get_guest_pass_settings,
    get_mcp_runtime_settings,
    import_parts_from_rows,
    init_db,
    list_parts,
    rotate_guest_pass_token,
    rotate_mcp_token,
    set_project_checks,
    set_project_nets,
    update_guest_pass_settings,
    update_mcp_runtime_settings,
)
from app.images import sanitize_pinout_svg
from app.main import create_app
from app.scraper import ScrapeError, _is_blocked_ip, _validate_url_sync


def _make_settings(tmpdir: Path, *, mcp_enabled: bool = True, mcp_read_only: bool = False) -> Settings:
    return Settings(
        local_dev_mode=True,
        cf_team_domain="",
        cf_policy_aud="",
        data_dir=tmpdir,
        seed_file=tmpdir / "no_seed.json",
        max_upload_mb=10,
        mcp_enabled=mcp_enabled,
        mcp_read_only=mcp_read_only,
        mcp_api_token="",
    )


class AuditFixesTest(unittest.TestCase):
    def test_svg_sanitizer_allowlist_blocks_style_and_html_breakout(self) -> None:
        dirty = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" onload="alert(1)">'
            "<style>@import url(https://evil.example/a.css); body { display: none; }</style>"
            '<script>alert(1)</script>'
            '<foreignObject><img src="x" onerror="alert(1)"/></foreignObject>'
            '<defs><linearGradient id="g1"><stop offset="0%" stop-color="#fff"/></linearGradient></defs>'
            '<rect x="0" y="0" width="100" height="50" fill="url(#g1)" style="background:url(https://evil)"/>'
            '<path d="M0 0 L10 10" stroke="url(https://evil.example/x)"/>'
            "<text x=\"10\" y=\"20\">GPIO4</text>"
            "</svg>"
        )
        cleaned = sanitize_pinout_svg(dirty)
        self.assertNotIn("<style", cleaned.lower())
        self.assertNotIn("@import", cleaned.lower())
        self.assertNotIn("<script", cleaned.lower())
        self.assertNotIn("foreignobject", cleaned.lower())
        self.assertNotIn("onload", cleaned.lower())
        self.assertNotIn("onerror", cleaned.lower())
        self.assertNotIn("evil.example", cleaned.lower())
        self.assertIn("url(#g1)", cleaned)
        self.assertIn("GPIO4", cleaned)

    def test_mcp_read_only_env_is_hard_ceiling(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            rw_settings = _make_settings(base, mcp_read_only=False)
            init_db(rw_settings)
            update_mcp_runtime_settings(rw_settings, {"access": "rw"})

            ro_settings = _make_settings(base, mcp_read_only=True)
            rt = get_mcp_runtime_settings(ro_settings)
            self.assertEqual(rt["access"], "ro")
            self.assertTrue(rt["env_read_only"])
            with self.assertRaises(ValueError):
                update_mcp_runtime_settings(ro_settings, {"access": "rw"})

            app = create_app(ro_settings)
            with TestClient(app) as client:
                cfg = client.get("/api/config").json()
                self.assertTrue(cfg["mcp_read_only"])
                res = client.post(
                    "/mcp",
                    json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                ).json()
                names = {t["name"] for t in res["result"]["tools"]}
                self.assertIn("list_parts", names)
                self.assertNotIn("create_part", names)
                self.assertNotIn("delete_part", names)

    def test_mcp_granular_permissions_and_tools_list(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            settings = _make_settings(Path(td), mcp_read_only=False)
            app = create_app(settings)
            with TestClient(app) as client:
                update_mcp_runtime_settings(
                    settings,
                    {"access": "rw", "can_parts": False, "can_projects": False, "can_shopping": True, "can_delete": False},
                )
                listed = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).json()
                names = {t["name"] for t in listed["result"]["tools"]}
                self.assertIn("create_shopping_item", names)
                self.assertNotIn("remove_shopping_offer", names)
                self.assertNotIn("move_shopping_to_inventory", names)
                self.assertNotIn("create_part", names)

                # Disable all writes -> glossary write must also be blocked
                update_mcp_runtime_settings(settings, {"can_shopping": False})
                res = client.post(
                    "/mcp",
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {"name": "create_glossary_term", "arguments": {"term": "Test", "summary": "x"}},
                    },
                ).json()
                self.assertTrue(res["result"]["isError"])

    def test_backup_strips_secrets_and_validates_restore(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            settings = _make_settings(Path(td))
            init_db(settings)
            create_part(settings.db_path, {"name": "Resistor 10k", "category": "Passives"})
            mcp_rt = rotate_mcp_token(settings)
            update_guest_pass_settings(settings.db_path, True)
            guest_cfg = rotate_guest_pass_token(settings.db_path)

            raw_zip = create_backup_zip_bytes(settings)
            # Verify exported inventory.db has NO live auth tokens
            with zipfile.ZipFile(io.BytesIO(raw_zip), "r") as zf:
                exported_db = Path(td) / "check_exported.db"
                exported_db.write_bytes(zf.read("inventory.db"))
                conn = sqlite3.connect(str(exported_db))
                try:
                    keys = {r[0] for r in conn.execute("SELECT key FROM settings").fetchall()}
                finally:
                    conn.close()
                self.assertNotIn("mcp_api_token", keys)
                self.assertNotIn("guest_pass_token", keys)

            # Corrupt zip returns BackupError (not uncaught exception)
            with self.assertRaises(BackupError):
                restore_backup_zip_bytes(b"not-a-zip", settings)

            # Fake WebP inside zip is rejected before touching live DB
            bad_buf = io.BytesIO()
            with zipfile.ZipFile(bad_buf, "w") as zf:
                with zipfile.ZipFile(io.BytesIO(raw_zip), "r") as orig:
                    zf.writestr("inventory.db", orig.read("inventory.db"))
                zf.writestr("images/deadbeef1234.webp", b"<html>not a webp</html>")
            with self.assertRaises(BackupError):
                restore_backup_zip_bytes(bad_buf.getvalue(), settings)

            # Valid restore preserves live MCP & Guest Pass secrets
            restore_backup_zip_bytes(raw_zip, settings)
            self.assertEqual(get_mcp_runtime_settings(settings)["token"], mcp_rt["token"])
            self.assertEqual(get_guest_pass_settings(settings.db_path)["token"], guest_cfg["token"])

    def test_csrf_headers_and_guest_pass_next_validation(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            settings = _make_settings(Path(td))
            app = create_app(settings)
            with TestClient(app) as client:
                # Security headers & JS no-cache
                r_js = client.get("/static/js/main.js")
                self.assertEqual(r_js.status_code, 200)
                self.assertEqual(r_js.headers.get("cache-control"), "no-cache")
                self.assertEqual(r_js.headers.get("x-content-type-options"), "nosniff")
                self.assertEqual(r_js.headers.get("x-frame-options"), "DENY")
                self.assertIn("script-src 'self'", r_js.headers.get("content-security-policy", ""))

                # Cross-site POST blocked by CSRF guard
                r_csrf = client.post(
                    "/api/guest-pass/rotate",
                    headers={"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"},
                )
                self.assertEqual(r_csrf.status_code, 403)

                # Same-origin POST works
                r_ok = client.patch("/api/guest-pass", json={"enabled": True})
                self.assertEqual(r_ok.status_code, 200)
                tok = r_ok.json()["token"]

                # Traversal & /guest/logout in `next` are rejected -> falls back to /guest/inventory
                r_pass = client.get(f"/guest/pass/{tok}?next=/guest/../settings", follow_redirects=False)
                self.assertEqual(r_pass.status_code, 302)
                self.assertEqual(r_pass.headers["location"], "/guest/inventory")

                r_pass2 = client.get(f"/guest/pass/{tok}?next=/guest/logout", follow_redirects=False)
                self.assertEqual(r_pass2.status_code, 302)
                self.assertEqual(r_pass2.headers["location"], "/guest/inventory")

    def test_project_net_check_pk_collisions_and_csv_url_sanitization(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            settings = _make_settings(Path(td))
            init_db(settings)
            p1 = create_project(settings.db_path, {"name": "Proj A"})
            p2 = create_project(settings.db_path, {"name": "Proj B"})
            net_payload = [{"id": "n1", "name": "I2C", "kind": "i2c", "conns": [["u1", "SDA"], ["s1", "SDA"]]}]
            chk_payload = [{"id": "c1", "severity": "check", "title": "Verify 3.3V"}]
            set_project_nets(settings.db_path, p1["id"], net_payload)
            set_project_nets(settings.db_path, p2["id"], net_payload)
            set_project_checks(settings.db_path, p1["id"], chk_payload)
            set_project_checks(settings.db_path, p2["id"], chk_payload)

            import_parts_from_rows(
                settings.db_path,
                [{"name": "CSV Part", "source_url": "javascript:alert(1)", "pinout_url": "data:text/html,x", "warning": "Careful"}],
            )
            parts = list_parts(settings.db_path)
            csv_part = next(p for p in parts if p["name"] == "CSV Part")
            self.assertEqual(csv_part["source_url"], "")
            self.assertEqual(csv_part["pinout_url"], "")
            self.assertEqual(len(csv_part["care_notes"]), 1)

    def test_ssrf_blocks_nat64_and_non_standard_ports(self) -> None:
        self.assertTrue(_is_blocked_ip(ipaddress.IPv6Address("64:ff9b::127.0.0.1")))
        self.assertTrue(_is_blocked_ip(ipaddress.IPv6Address("::ffff:127.0.0.1")))
        with self.assertRaises(ScrapeError):
            _validate_url_sync("http://93.184.216.34:8080/test")


if __name__ == "__main__":
    unittest.main()
