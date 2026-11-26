"""Tests for workbench features: batch bin assignment, shared-image safety, and power budget facts."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.db import (
    _normalize_electrical_facts,
    batch_assign_bin,
    create_part,
    create_shopping_item,
    init_db,
    is_image_referenced,
)
from app.main import create_app


def _make_settings(tmpdir: Path) -> Settings:
    data_dir = tmpdir / "data"
    images_dir = data_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        local_dev_mode=True,
        cf_team_domain="",
        cf_policy_aud="",
        data_dir=data_dir,
        seed_file=tmpdir / "seed.json",
        max_upload_mb=10,
        mcp_enabled=True,
        mcp_read_only=False,
        mcp_api_token="test-token",
    )


class FeatureTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.settings = _make_settings(self.tmp_path)
        init_db(self.settings)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_power_budget_electrical_facts_normalization(self) -> None:
        clean = _normalize_electrical_facts(
            {
                "logic": "v33",
                "ma": "120.556",
                "reg_ma": 500,
                "mah": 2000,
            }
        )
        self.assertEqual(clean["ma"], 120.56)
        self.assertEqual(clean["reg_ma"], 500.0)
        self.assertEqual(clean["mah"], 2000.0)

        invalid = _normalize_electrical_facts(
            {
                "ma": -5,
                "reg_ma": 0,
                "mah": 999999,
            }
        )
        self.assertNotIn("ma", invalid)
        self.assertNotIn("reg_ma", invalid)
        self.assertNotIn("mah", invalid)

        nan_vals = _normalize_electrical_facts(
            {
                "ma": float("nan"),
                "reg_ma": float("inf"),
                "mah": "nope",
            }
        )
        self.assertEqual(nan_vals, {})

    def test_batch_assign_bin_and_clear(self) -> None:
        p1 = create_part(self.settings.db_path, {"name": "BME280", "category": "Sensors"})
        p2 = create_part(self.settings.db_path, {"name": "OLED", "category": "Displays"})
        p3 = create_part(self.settings.db_path, {"name": "ESP32", "category": "Microcontrollers", "location": "A1"})

        app = create_app(self.settings)
        with TestClient(app) as client:
            res = client.post(
                "/api/parts/batch-bin",
                json={"part_ids": [p1["id"], p2["id"]], "location": "B2"},
                headers={"Sec-Fetch-Site": "same-origin"},
            )
            self.assertEqual(res.status_code, 200)
            body = res.json()
            self.assertEqual(body["updated_count"], 2)
            self.assertEqual(body["location"], "B2")
            self.assertEqual({p["location"] for p in body["parts"]}, {"B2"})

            # Clear bin on p1 only
            res_clear = client.post(
                "/api/parts/batch-bin",
                json={"part_ids": [p1["id"]], "location": ""},
                headers={"Sec-Fetch-Site": "same-origin"},
            )
            self.assertEqual(res_clear.status_code, 200)
            self.assertEqual(res_clear.json()["parts"][0]["location"], "")

            # p3 remains untouched
            parts = {p["id"]: p for p in client.get("/api/parts").json()}
            self.assertEqual(parts[p1["id"]]["location"], "")
            self.assertEqual(parts[p2["id"]]["location"], "B2")
            self.assertEqual(parts[p3["id"]]["location"], "A1")

        with self.assertRaises(ValueError):
            batch_assign_bin(self.settings.db_path, [], "A1")

    def test_shared_image_kept_when_restock_shopping_item_deleted(self) -> None:
        img_name = "a1b2c3d4e5f60718293a4b5c6d7e8f90.webp"
        img_file = self.settings.images_dir / img_name
        img_file.write_bytes(b"RIFF\x10\x00\x00\x00WEBPVP8 ")

        part = create_part(
            self.settings.db_path,
            {"name": "ESP32-C3 SuperMini", "category": "Microcontrollers", "image_path": img_name},
        )
        restock = create_shopping_item(
            self.settings.db_path,
            {"name": "ESP32-C3 SuperMini", "category": "Microcontrollers", "image_path": img_name, "why_needed": "Restock"},
        )
        self.assertTrue(is_image_referenced(self.settings.db_path, img_name))

        app = create_app(self.settings)
        with TestClient(app) as client:
            # Deleting the restock shopping item must NOT delete the part's image
            r_del_shop = client.delete(
                f"/api/shopping/{restock['id']}",
                headers={"Sec-Fetch-Site": "same-origin"},
            )
            self.assertEqual(r_del_shop.status_code, 200)
            self.assertTrue(img_file.exists(), "Part photo must remain on disk while part references it")
            self.assertTrue(is_image_referenced(self.settings.db_path, img_name))

            # Once the part itself is deleted, no rows reference the file, so it is cleaned up
            r_del_part = client.delete(
                f"/api/parts/{part['id']}",
                headers={"Sec-Fetch-Site": "same-origin"},
            )
            self.assertEqual(r_del_part.status_code, 200)
            self.assertFalse(is_image_referenced(self.settings.db_path, img_name))
            self.assertFalse(img_file.exists(), "Unreferenced image should be removed after last owner is deleted")


if __name__ == "__main__":
    unittest.main()
