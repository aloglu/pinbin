from __future__ import annotations

import hashlib
import hmac
import itertools
import json
import math
import re
import secrets
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

from app.config import CATEGORIES, Settings
from app.glossary_seed import GLOSSARY_CATEGORIES, GLOSSARY_META, GLOSSARY_SEED
from app.images import compute_images_stats, safe_delete_image, sanitize_pinout_svg

db_lock = threading.RLock()

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subtitle TEXT DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Sensors',
    quantity INTEGER NOT NULL DEFAULT 1,
    low_stock_threshold INTEGER DEFAULT NULL,
    location TEXT DEFAULT '',
    in_use_project TEXT DEFAULT '',
    what_it_does TEXT DEFAULT '',
    visual_tell TEXT DEFAULT '',
    warning TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    source_url TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    pinout_image_path TEXT DEFAULT '',
    pinout_url TEXT DEFAULT '',
    pinout_svg TEXT DEFAULT '',
    specs TEXT DEFAULT '{}',
    electrical_facts TEXT DEFAULT '{}',
    care_notes TEXT DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
    usage_date TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS glossary (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Circuit Basics',
    summary TEXT NOT NULL DEFAULT '',
    rule_of_thumb TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '',
    related_ids TEXT NOT NULL DEFAULT '[]',
    bench_tool TEXT NOT NULL DEFAULT '',
    figure_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shopping_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT DEFAULT '',
    price TEXT DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 1,
    notes TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    retailer TEXT DEFAULT '',
    tag TEXT DEFAULT '',
    category TEXT DEFAULT '',
    specs TEXT DEFAULT '{}',
    electrical_facts TEXT DEFAULT '{}',
    care_notes TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'order',
    in_stock TEXT DEFAULT '',
    why_needed TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    option_label TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'planning',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_variants (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    is_selected INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    variant_id TEXT DEFAULT NULL REFERENCES project_variants(id) ON DELETE CASCADE,
    part_id TEXT DEFAULT NULL REFERENCES parts(id) ON DELETE CASCADE,
    shopping_item_id TEXT DEFAULT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
    ref TEXT DEFAULT '',
    role TEXT DEFAULT 'periph',
    label TEXT DEFAULT '',
    quantity_needed INTEGER NOT NULL DEFAULT 1,
    project_notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_nets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'sig',
    rail REAL DEFAULT NULL,
    is_chain INTEGER NOT NULL DEFAULT 0,
    is_wake INTEGER NOT NULL DEFAULT 0,
    connections TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_checks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    severity TEXT NOT NULL DEFAULT 'check',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    node_refs TEXT NOT NULL DEFAULT '[]',
    net_ids TEXT NOT NULL DEFAULT '[]',
    is_done INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_activity (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'Inventory',
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shopping_item_offers (
    id TEXT PRIMARY KEY,
    shopping_item_id TEXT NOT NULL REFERENCES shopping_items(id) ON DELETE CASCADE,
    retailer TEXT DEFAULT '',
    url TEXT DEFAULT '',
    price TEXT DEFAULT '',
    in_stock TEXT DEFAULT '',
    is_selected INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retailers (
    domain TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    shipping_cost REAL DEFAULT NULL,
    free_shipping_threshold REAL DEFAULT NULL,
    currency TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

PROJECT_STATUSES = ("planning", "active", "completed", "archived")
SHOPPING_STATUSES = ("order", "ordered", "arrived")
PROJECT_ITEM_ROLES = ("power", "mcu", "periph", "material")
NET_KINDS = ("bat", "v5", "v33", "i2c", "spi", "sig")
CHECK_SEVERITIES = ("danger", "check", "ok")
CARE_SEVERITIES = ("danger", "check", "info")
ALLOWED_CURRENCIES = {"TRY", "EUR", "USD"}

DEFAULT_UI_SETTINGS: dict[str, Any] = {
    "theme": "system",
    "font": "plex",
    "motion": "system",
    "view_mode": "grid",
    "sort_by": "recent",
    "inline_tooltips": True,
    "show_caution_badge": True,
    "show_ok_checks": True,
    "strap_pin_checks": True,
    "currency": "TRY",
    "logo_color": "#00e676",
    "last_backup_at": "",
}

ALLOWED_LOGO_COLORS = {
    "#00e676", "#ffcc00", "#111111", "#ffffff", "#c0392b",
    "#6c3cff", "#2962ff", "#ff2d55", "#ff3b30", "#ff69b4",
}

ALLOWED_SORT_VALUES = {
    "recent",
    "name",
    "fewest",
    "most",
    "bin",
    "category",
    "care",
    # Legacy aliases kept for compatibility
    "location",
    "qty_asc",
    "qty_desc",
    "needs_photo",
}

UPDATABLE_FIELDS = {
    "name",
    "subtitle",
    "category",
    "quantity",
    "low_stock_threshold",
    "location",
    "in_use_project",
    "what_it_does",
    "visual_tell",
    "warning",
    "notes",
    "source_url",
    "image_path",
    "pinout_image_path",
    "pinout_url",
    "pinout_svg",
    "specs",
    "electrical_facts",
    "care_notes",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@contextmanager
def get_connection(db_path: Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(str(db_path), timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute("PRAGMA busy_timeout=5000;")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(settings: Settings) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.images_dir.mkdir(parents=True, exist_ok=True)
    with db_lock:
        with get_connection(settings.db_path) as conn:
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.executescript(SCHEMA_SQL)

            def _ensure_cols(table: str, migrations: list[tuple[str, str]]) -> None:
                existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
                for col_name, col_def in migrations:
                    if col_name not in existing:
                        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_def}")

            _ensure_cols(
                "parts",
                [
                    ("specs", "TEXT DEFAULT '{}'"),
                    ("electrical_facts", "TEXT DEFAULT '{}'"),
                    ("care_notes", "TEXT DEFAULT '[]'"),
                    ("pinout_svg", "TEXT DEFAULT ''"),
                ],
            )
            _ensure_cols(
                "shopping_items",
                [
                    ("retailer", "TEXT DEFAULT ''"),
                    ("tag", "TEXT DEFAULT ''"),
                    ("category", "TEXT DEFAULT ''"),
                    ("specs", "TEXT DEFAULT '{}'"),
                    ("in_stock", "TEXT DEFAULT ''"),
                    ("why_needed", "TEXT DEFAULT ''"),
                    ("status", "TEXT NOT NULL DEFAULT 'order'"),
                    ("electrical_facts", "TEXT DEFAULT '{}'"),
                    ("care_notes", "TEXT DEFAULT '[]'"),
                ],
            )
            _ensure_cols(
                "projects",
                [
                    ("option_label", "TEXT DEFAULT ''"),
                    ("tags", "TEXT DEFAULT '[]'"),
                ],
            )
            _ensure_cols("project_variants", [("notes", "TEXT DEFAULT ''")])
            _ensure_cols(
                "project_items",
                [
                    ("ref", "TEXT DEFAULT ''"),
                    ("role", "TEXT DEFAULT 'periph'"),
                    ("label", "TEXT DEFAULT ''"),
                ],
            )
            _ensure_cols(
                "glossary",
                [
                    ("related_ids", "TEXT NOT NULL DEFAULT '[]'"),
                    ("bench_tool", "TEXT NOT NULL DEFAULT ''"),
                    ("figure_key", "TEXT NOT NULL DEFAULT ''"),
                ],
            )

            _migrate_legacy_in_use_projects(conn)
            _migrate_shopping_item_offers(conn)
            _migrate_parts_care_and_facts(conn)
            _migrate_projects_redesign(conn)
            _seed_glossary_if_empty(conn)


def _infer_care_severity(text: str) -> str:
    low = text.lower()
    danger_words = ("do not", "never", "damage", "burn", "short", "destroy", "mains", "reverse polarity", "5v directly")
    if any(w in low for w in danger_words):
        return "danger"
    return "check"


def _infer_electrical_facts_from_row(row: sqlite3.Row) -> dict[str, Any]:
    """Derive starter electrical_facts from legacy specs/text when none are set yet."""
    cat = str(row["category"] or "")
    name = str(row["name"] or "")
    specs = _normalize_specs(row["specs"])
    text = f"{name} {row['subtitle'] or ''} {row['notes'] or ''} {json.dumps(specs)}".lower()

    if cat == "Tools":
        return {"logic": "none"}

    facts: dict[str, Any] = {}
    ifaces: list[str] = []
    if re.search(r"\bi2c\b", text):
        ifaces.append("I2C")
    if re.search(r"\bspi\b", text):
        ifaces.append("SPI")
    if re.search(r"\b(uart|serial)\b", text):
        ifaces.append("UART")
    if re.search(r"\b(analog|adc)\b", text):
        ifaces.append("Analog")
    if re.search(r"\b(pwm|servo)\b", text):
        ifaces.append("PWM")
    if "1-wire" in text or "dht11" in text or "dht22" in text:
        ifaces.append("1-Wire")
    if re.search(r"\b(wifi|wi-fi)\b", text):
        ifaces.append("Wi-Fi")
    if re.search(r"\b(ble|bluetooth)\b", text):
        ifaces.append("BLE")
    if ifaces:
        facts["interfaces"] = ifaces

    logic_val = str(specs.get("Logic") or specs.get("Supply") or "").lower()
    has_33 = "3.3v" in logic_val or "3.3" in logic_val
    has_5 = "5v" in logic_val
    if has_33 and has_5:
        facts["logic"] = "vboth"
    elif has_33:
        facts["logic"] = "v33"
    elif has_5:
        facts["logic"] = "v5"

    if cat == "Microcontrollers":
        if "esp32" in text:
            facts["logic"] = "v33"
            facts["io"] = 3.6
            facts["strap"] = ["GPIO0", "GPIO2", "GPIO12", "GPIO15"]
            facts["power"] = {"VIN": [4.5, 12.0], "3V3": [3.0, 3.6]}
        elif "pico" in text or "rp2350" in text or "rp2040" in text:
            facts["logic"] = "v33"
            facts["io"] = 3.6
            facts["power"] = {"VSYS": [1.8, 5.5], "3V3": [3.0, 3.6]}
        elif "uno" in text or "atmega328" in text:
            facts["logic"] = "v5"
            facts["io"] = 5.5
            facts["power"] = {"VIN": [7.0, 12.0], "5V": [4.5, 5.5]}
    else:
        if "hc-sr04" in text:
            facts["logic"] = "v5"
            facts["vin"] = [4.5, 5.5]
            facts["out"] = {"ECHO": 5.0}
        elif "rc522" in text:
            facts["logic"] = "v33"
            facts["vin"] = [3.0, 3.6]
        elif "ssd1306" in text or "oled" in text:
            facts["logic"] = "vboth"
            facts["vin"] = [3.0, 5.5]
        elif "1602" in text or "16x2" in text:
            facts["logic"] = "v5"
            facts["vin"] = [4.5, 5.5]
        elif "mq-2" in text:
            facts["logic"] = "v5"
            facts["vin"] = [4.9, 5.1]
        elif "dht11" in text:
            facts["logic"] = "vboth"
            facts["vin"] = [3.3, 5.5]
        elif "rtc" in text or "ds3231" in text or "ds1307" in text:
            facts["logic"] = "vboth"
            facts["vin"] = [2.3, 5.5]

    m_i2c = re.search(r"0x[0-9a-f]{2}", text)
    if m_i2c and "I2C" in ifaces:
        facts["i2c"] = "0x" + m_i2c.group(0)[2:].upper()

    if "28byj" in text:
        facts["logic"] = "v5"
    elif "uln2003" in text or "sg90" in text or "sg-90" in text or "relay" in text or "buzzer" in text:
        facts.setdefault("logic", "v5")

    return facts


def _migrate_parts_care_and_facts(conn: sqlite3.Connection) -> None:
    rows = conn.execute("SELECT * FROM parts").fetchall()
    for r in rows:
        updates: dict[str, Any] = {}
        raw_care = str(r["care_notes"] or "").strip()
        warning = str(r["warning"] or "").strip()
        if (not raw_care or raw_care == "[]") and warning:
            updates["care_notes"] = json.dumps([{"severity": _infer_care_severity(warning), "text": warning}])
        raw_facts = str(r["electrical_facts"] or "").strip()
        if not raw_facts or raw_facts == "{}":
            inferred = _infer_electrical_facts_from_row(r)
            if inferred:
                updates["electrical_facts"] = json.dumps(inferred)
        if updates:
            set_sql = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(f"UPDATE parts SET {set_sql} WHERE id = ?", list(updates.values()) + [r["id"]])


def _migrate_projects_redesign(conn: sqlite3.Connection) -> None:
    # Copy selected variant name into projects.option_label if empty
    projs = conn.execute("SELECT id, option_label FROM projects").fetchall()
    for p in projs:
        if not str(p["option_label"] or "").strip():
            var = conn.execute(
                "SELECT name FROM project_variants WHERE project_id = ? ORDER BY is_selected DESC, sort_order ASC, created_at ASC LIMIT 1",
                (p["id"],),
            ).fetchone()
            if var and str(var["name"] or "").strip():
                conn.execute(
                    "UPDATE projects SET option_label = ? WHERE id = ?",
                    (str(var["name"]).strip()[:120], p["id"]),
                )

    # Ensure every project_item has a unique ref per project and a sensible role
    for p in projs:
        items = conn.execute(
            "SELECT pi.id, pi.ref, pi.role, pi.part_id, pi.shopping_item_id, pt.category AS p_cat, si.category AS s_cat "
            "FROM project_items pi "
            "LEFT JOIN parts pt ON pt.id = pi.part_id "
            "LEFT JOIN shopping_items si ON si.id = pi.shopping_item_id "
            "WHERE pi.project_id = ? ORDER BY pi.created_at ASC, pi.rowid ASC",
            (p["id"],),
        ).fetchall()
        used_refs = {str(it["ref"] or "").strip() for it in items if str(it["ref"] or "").strip()}
        idx = 1
        for it in items:
            ref = str(it["ref"] or "").strip()
            role = str(it["role"] or "").strip()
            upd: dict[str, Any] = {}
            if not ref:
                while f"n{idx}" in used_refs:
                    idx += 1
                ref = f"n{idx}"
                used_refs.add(ref)
                upd["ref"] = ref
            if role not in PROJECT_ITEM_ROLES:
                cat = str(it["p_cat"] or it["s_cat"] or "")
                if cat == "Microcontrollers":
                    upd["role"] = "mcu"
                elif cat in ("Prototyping", "Tools"):
                    upd["role"] = "material"
                else:
                    upd["role"] = "periph"
            if upd:
                set_sql = ", ".join(f"{k} = ?" for k in upd)
                conn.execute(f"UPDATE project_items SET {set_sql} WHERE id = ?", list(upd.values()) + [it["id"]])


def _migrate_shopping_item_offers(conn: sqlite3.Connection) -> None:
    """Backfill initial selected offer for existing shopping_items that have a url or retailer."""
    rows = conn.execute(
        """
        SELECT si.id, si.retailer, si.url, si.price, si.in_stock, si.created_at, si.updated_at
        FROM shopping_items si
        WHERE NOT EXISTS (
            SELECT 1 FROM shopping_item_offers o WHERE o.shopping_item_id = si.id
        )
        AND (TRIM(COALESCE(si.url, '')) != '' OR TRIM(COALESCE(si.retailer, '')) != '')
        """
    ).fetchall()
    for r in rows:
        url = str(r["url"] or "").strip()
        retailer = str(r["retailer"] or "").strip() or _extract_retailer(url)
        conn.execute(
            """
            INSERT INTO shopping_item_offers (
                id, shopping_item_id, retailer, url, price, in_stock, is_selected, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, '', ?, ?)
            """,
            (
                uuid.uuid4().hex,
                r["id"],
                retailer[:80],
                url,
                str(r["price"] or "").strip()[:40],
                str(r["in_stock"] or "").strip().lower(),
                r["created_at"],
                r["updated_at"],
            ),
        )


def _migrate_legacy_in_use_projects(conn: sqlite3.Connection) -> None:
    """Create first-class projects rows for any legacy parts.in_use_project names."""
    rows = conn.execute(
        "SELECT id, in_use_project FROM parts WHERE in_use_project IS NOT NULL AND TRIM(in_use_project) != ''"
    ).fetchall()
    if not rows:
        return
    existing_projects = {
        str(r["name"]).strip().lower(): r["id"]
        for r in conn.execute("SELECT id, name FROM projects").fetchall()
    }
    now = utc_now_iso()
    for row in rows:
        proj_name = str(row["in_use_project"]).strip()
        key = proj_name.lower()
        proj_id = existing_projects.get(key)
        if not proj_id:
            proj_id = uuid.uuid4().hex
            conn.execute(
                """
                INSERT INTO projects (id, name, description, status, notes, created_at, updated_at)
                VALUES (?, ?, '', 'active', '', ?, ?)
                """,
                (proj_id, proj_name, now, now),
            )
            existing_projects[key] = proj_id
        already = conn.execute(
            "SELECT id FROM project_items WHERE project_id = ? AND part_id = ?",
            (proj_id, row["id"]),
        ).fetchone()
        if not already:
            conn.execute(
                """
                INSERT INTO project_items (
                    id, project_id, variant_id, part_id, shopping_item_id,
                    quantity_needed, project_notes, created_at, updated_at
                ) VALUES (?, ?, NULL, ?, NULL, 1, '', ?, ?)
                """,
                (uuid.uuid4().hex, proj_id, row["id"], now, now),
            )


def _seed_glossary_if_empty(conn: sqlite3.Connection) -> None:
    """Insert any missing starter glossary terms and backfill diagram/tool metadata."""
    now = utc_now_iso()
    for item in GLOSSARY_SEED:
        meta = GLOSSARY_META.get(item["id"], {})
        rel_json = json.dumps(meta.get("related_ids") or [])
        bench_tool = str(meta.get("bench_tool") or "")
        figure_key = str(meta.get("figure_key") or "")
        conn.execute(
            """
            INSERT OR IGNORE INTO glossary (
                id, term, category, summary, rule_of_thumb, keywords,
                related_ids, bench_tool, figure_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item["id"],
                item["term"],
                item["category"],
                item["summary"],
                item["rule_of_thumb"],
                item["keywords"],
                rel_json,
                bench_tool,
                figure_key,
                now,
                now,
            ),
        )
        if meta:
            conn.execute(
                """
                UPDATE glossary
                SET related_ids = CASE WHEN related_ids = '' OR related_ids = '[]' THEN ? ELSE related_ids END,
                    bench_tool = CASE WHEN bench_tool = '' THEN ? ELSE bench_tool END,
                    figure_key = CASE WHEN figure_key = '' THEN ? ELSE figure_key END
                WHERE id = ?
                """,
                (rel_json, bench_tool, figure_key, item["id"]),
            )


def seed_if_empty(settings: Settings) -> int:
    if not settings.seed_file.exists():
        return 0

    with db_lock:
        with get_connection(settings.db_path) as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM parts").fetchone()
            raw = json.loads(settings.seed_file.read_text(encoding="utf-8"))
            if not isinstance(raw, list):
                return 0

            if row and row["cnt"] > 0:
                # Non-destructive backfill: populate baseline specs on seeded parts that still have empty specs
                for item in raw:
                    if not isinstance(item, dict) or not item.get("id") or not item.get("specs"):
                        continue
                    specs_json = json.dumps(_normalize_specs(item.get("specs")))
                    if specs_json != "{}":
                        conn.execute(
                            "UPDATE parts SET specs = ? WHERE id = ? AND (specs IS NULL OR specs = '' OR specs = '{}')",
                            (specs_json, str(item["id"]).strip()),
                        )
                return 0

            now = utc_now_iso()
            inserted = 0
            for item in raw:
                if not isinstance(item, dict) or not item.get("name"):
                    continue
                part_id = str(item.get("id") or uuid.uuid4().hex).strip()
                category = str(item.get("category") or "Sensors").strip()
                if category not in CATEGORIES:
                    category = "Sensors"

                qty = item.get("quantity", 1)
                try:
                    qty = max(0, int(qty))
                except (TypeError, ValueError):
                    qty = 1

                lst = item.get("low_stock_threshold")
                if lst is not None and lst != "":
                    try:
                        lst = max(0, int(lst))
                    except (TypeError, ValueError):
                        lst = None
                else:
                    lst = None

                specs_json = json.dumps(_normalize_specs(item.get("specs")))

                conn.execute(
                    """
                    INSERT OR IGNORE INTO parts (
                        id, name, subtitle, category, quantity, low_stock_threshold,
                        location, in_use_project, what_it_does, visual_tell, warning,
                        notes, source_url, image_path, pinout_image_path, pinout_url,
                        specs, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        part_id,
                        str(item.get("name", "")).strip(),
                        str(item.get("subtitle", "") or "").strip(),
                        category,
                        qty,
                        lst,
                        str(item.get("location", "") or "").strip(),
                        str(item.get("in_use_project", "") or "").strip(),
                        str(item.get("what_it_does", "") or "").strip(),
                        str(item.get("visual_tell", "") or "").strip(),
                        str(item.get("warning", "") or "").strip(),
                        str(item.get("notes", "") or "").strip(),
                        str(item.get("source_url", "") or "").strip(),
                        str(item.get("image_path", "") or "").strip(),
                        str(item.get("pinout_image_path", "") or "").strip(),
                        str(item.get("pinout_url", "") or "").strip(),
                        specs_json,
                        now,
                        now,
                    ),
                )
                inserted += 1
            return inserted


def _normalize_specs(raw: Any) -> dict[str, str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return {}
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, str] = {}
    for k, v in raw.items():
        ks = str(k or "").strip()[:60]
        vs = str(v or "").strip()[:120]
        if ks and vs:
            clean[ks] = vs
    return clean


def _normalize_electrical_facts(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return {}
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, Any] = {}

    logic = str(raw.get("logic") or "").strip().lower()
    if logic in ("v33", "v5", "vboth", "none"):
        clean["logic"] = logic

    ifaces_raw = raw.get("interfaces")
    if isinstance(ifaces_raw, list):
        ifaces: list[str] = []
        for it in ifaces_raw[:12]:
            s = str(it or "").strip()[:24]
            if s and s not in ifaces:
                ifaces.append(s)
        if ifaces:
            clean["interfaces"] = ifaces

    vin_raw = raw.get("vin")
    if isinstance(vin_raw, (list, tuple)) and len(vin_raw) == 2:
        try:
            lo, hi = float(vin_raw[0]), float(vin_raw[1])
            if math.isfinite(lo) and math.isfinite(hi) and 0 <= lo <= hi <= 60:
                clean["vin"] = [round(lo, 2), round(hi, 2)]
        except (TypeError, ValueError):
            pass

    if raw.get("io") not in (None, ""):
        try:
            io_v = float(raw["io"])
            if math.isfinite(io_v) and 0 < io_v <= 24:
                clean["io"] = round(io_v, 2)
        except (TypeError, ValueError):
            pass

    if raw.get("vout") not in (None, ""):
        try:
            vo = float(raw["vout"])
            if math.isfinite(vo) and 0 < vo <= 60:
                clean["vout"] = round(vo, 2)
        except (TypeError, ValueError):
            pass

    i2c_raw = str(raw.get("i2c") or "").strip()
    if i2c_raw and re.match(r"^0x[0-9a-f]{2}$", i2c_raw, re.IGNORECASE):
        clean["i2c"] = "0x" + i2c_raw[2:].upper()

    out_raw = raw.get("out")
    if isinstance(out_raw, dict):
        out_clean: dict[str, float] = {}
        for k, v in list(out_raw.items())[:12]:
            ks = str(k or "").strip()[:24]
            try:
                fv = float(v)
                if ks and math.isfinite(fv) and 0 <= fv <= 60:
                    out_clean[ks] = round(fv, 2)
            except (TypeError, ValueError):
                continue
        if out_clean:
            clean["out"] = out_clean

    for list_key in ("strap", "wake", "pairs"):
        arr = raw.get(list_key)
        if isinstance(arr, list):
            vals = [str(x or "").strip()[:40] for x in arr[:20] if str(x or "").strip()]
            if vals:
                clean[list_key] = list(dict.fromkeys(vals))

    pwr_raw = raw.get("power")
    if isinstance(pwr_raw, dict):
        pwr_clean: dict[str, list[float]] = {}
        for k, v in list(pwr_raw.items())[:8]:
            ks = str(k or "").strip()[:24]
            if ks and isinstance(v, (list, tuple)) and len(v) == 2:
                try:
                    lo, hi = float(v[0]), float(v[1])
                    if math.isfinite(lo) and math.isfinite(hi) and 0 <= lo <= hi <= 60:
                        pwr_clean[ks] = [round(lo, 2), round(hi, 2)]
                except (TypeError, ValueError):
                    continue
        if pwr_clean:
            clean["power"] = pwr_clean

    glyph = str(raw.get("glyph") or "").strip().lower()[:20]
    if glyph and re.match(r"^[a-z0-9_-]+$", glyph):
        clean["glyph"] = glyph

    return clean


def _normalize_care_notes(raw: Any) -> list[dict[str, str]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    clean: list[dict[str, str]] = []
    for entry in raw[:20]:
        sev = "info"
        txt = ""
        if isinstance(entry, dict):
            sev = str(entry.get("severity") or "info").strip().lower()
            txt = str(entry.get("text") or "").strip()[:500]
        elif isinstance(entry, (list, tuple)) and len(entry) >= 2:
            sev = str(entry[0] or "info").strip().lower()
            txt = str(entry[1] or "").strip()[:500]
        if sev not in CARE_SEVERITIES:
            sev = "info"
        if txt:
            clean.append({"severity": sev, "text": txt})
    return clean


def _normalize_tags(raw: Any) -> list[str]:
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            raw = parsed if isinstance(parsed, list) else [x.strip() for x in raw.split(",")]
        except Exception:
            raw = [x.strip() for x in raw.split(",")]
    if not isinstance(raw, list):
        return []
    seen: list[str] = []
    for t in raw[:20]:
        s = str(t or "").strip().lower()[:40]
        if s and s not in seen:
            seen.append(s)
    return seen


def _normalize_string_list(raw: Any, limit: int = 30) -> list[str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for x in raw[:limit]:
        s = str(x or "").strip()[:80]
        if s and s not in out:
            out.append(s)
    return out


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    if "specs" in d:
        d["specs"] = _normalize_specs(d["specs"])
    if "electrical_facts" in d:
        d["electrical_facts"] = _normalize_electrical_facts(d["electrical_facts"])
    if "care_notes" in d:
        d["care_notes"] = _normalize_care_notes(d["care_notes"])
    if "tags" in d:
        d["tags"] = _normalize_tags(d["tags"])
    if "related_ids" in d:
        d["related_ids"] = _normalize_string_list(d["related_ids"])
    return d


def list_parts(
    db_path: Path,
    *,
    q: str | None = None,
    category: str | None = None,
    location: str | None = None,
    needs_photo: bool = False,
    in_use: bool = False,
    low_stock: bool = False,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []

    if category and category.strip() and category.strip() != "All":
        clauses.append("category = ?")
        params.append(category.strip())

    if location and location.strip():
        clauses.append("LOWER(TRIM(location)) = LOWER(TRIM(?))")
        params.append(location.strip())

    if needs_photo:
        clauses.append("(image_path IS NULL OR TRIM(image_path) = '')")

    if in_use:
        clauses.append("(in_use_project IS NOT NULL AND TRIM(in_use_project) != '')")

    if low_stock:
        clauses.append("(low_stock_threshold IS NOT NULL AND quantity <= low_stock_threshold)")

    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        clauses.append(
            "("
            "LOWER(name) LIKE ? OR "
            "LOWER(subtitle) LIKE ? OR "
            "LOWER(location) LIKE ? OR "
            "LOWER(in_use_project) LIKE ? OR "
            "LOWER(what_it_does) LIKE ? OR "
            "LOWER(visual_tell) LIKE ? OR "
            "LOWER(warning) LIKE ? OR "
            "LOWER(notes) LIKE ? OR "
            "LOWER(category) LIKE ?"
            ")"
        )
        params.extend([like] * 9)

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = f"SELECT * FROM parts {where_sql} ORDER BY created_at DESC, rowid ASC"

    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute(sql, params).fetchall()
            return [_row_to_dict(r) for r in rows]


def get_part(db_path: Path, part_id: str) -> dict[str, Any] | None:
    with db_lock:
        with get_connection(db_path) as conn:
            row = conn.execute("SELECT * FROM parts WHERE id = ?", (part_id,)).fetchone()
            return _row_to_dict(row) if row else None


def create_part(db_path: Path, data: dict[str, Any]) -> dict[str, Any]:
    part_id = str(data.get("id") or uuid.uuid4().hex).strip()
    now = utc_now_iso()

    category = str(data.get("category") or "Sensors").strip()
    if category not in CATEGORIES:
        category = "Sensors"

    qty = max(0, int(data.get("quantity", 1) or 0))
    lst = data.get("low_stock_threshold")
    if lst is not None and lst != "":
        lst = max(0, int(lst))
    else:
        lst = None

    specs_json = json.dumps(_normalize_specs(data.get("specs")))
    facts_json = json.dumps(_normalize_electrical_facts(data.get("electrical_facts")))
    care_list = _normalize_care_notes(data.get("care_notes"))
    warning_str = str(data.get("warning", "") or "").strip()
    if not care_list and warning_str:
        care_list = [{"severity": _infer_care_severity(warning_str), "text": warning_str}]
    elif care_list and not warning_str:
        warning_str = care_list[0]["text"]
    care_json = json.dumps(care_list)
    pinout_svg = sanitize_pinout_svg(data.get("pinout_svg", "")) if data.get("pinout_svg") else ""

    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO parts (
                    id, name, subtitle, category, quantity, low_stock_threshold,
                    location, in_use_project, what_it_does, visual_tell, warning,
                    notes, source_url, image_path, pinout_image_path, pinout_url,
                    pinout_svg, specs, electrical_facts, care_notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    part_id,
                    str(data.get("name", "")).strip(),
                    str(data.get("subtitle", "") or "").strip(),
                    category,
                    qty,
                    lst,
                    str(data.get("location", "") or "").strip(),
                    str(data.get("in_use_project", "") or "").strip(),
                    str(data.get("what_it_does", "") or "").strip(),
                    str(data.get("visual_tell", "") or "").strip(),
                    warning_str,
                    str(data.get("notes", "") or "").strip(),
                    _validate_http_url(data.get("source_url", "")),
                    str(data.get("image_path", "") or "").strip(),
                    str(data.get("pinout_image_path", "") or "").strip(),
                    _validate_http_url(data.get("pinout_url", "")),
                    pinout_svg,
                    specs_json,
                    facts_json,
                    care_json,
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM parts WHERE id = ?", (part_id,)).fetchone()
            return _row_to_dict(row)


def update_part(db_path: Path, part_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    filtered: dict[str, Any] = {}
    for key, val in updates.items():
        if key not in UPDATABLE_FIELDS:
            continue
        if key == "quantity":
            filtered[key] = max(0, int(val))
        elif key == "low_stock_threshold":
            filtered[key] = None if (val is None or val == "") else max(0, int(val))
        elif key == "category":
            cat = str(val or "Sensors").strip()
            filtered[key] = cat if cat in CATEGORIES else "Sensors"
        elif key == "name":
            name_val = str(val or "").strip()
            if not name_val:
                raise ValueError("Part name cannot be empty")
            filtered[key] = name_val
        elif key == "specs":
            filtered[key] = json.dumps(_normalize_specs(val))
        elif key == "electrical_facts":
            filtered[key] = json.dumps(_normalize_electrical_facts(val))
        elif key == "care_notes":
            care_clean = _normalize_care_notes(val)
            filtered[key] = json.dumps(care_clean)
            if "warning" not in updates:
                filtered["warning"] = care_clean[0]["text"] if care_clean else ""
        elif key == "pinout_svg":
            filtered[key] = sanitize_pinout_svg(val) if str(val or "").strip() else ""
        elif key in ("source_url", "pinout_url"):
            filtered[key] = _validate_http_url(val)
        else:
            filtered[key] = str(val or "").strip()

    if "warning" in filtered and "care_notes" not in filtered:
        w = filtered["warning"]
        filtered["care_notes"] = json.dumps([{"severity": _infer_care_severity(w), "text": w}]) if w else "[]"

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute("SELECT * FROM parts WHERE id = ?", (part_id,)).fetchone()
            if not existing:
                return None

            if not filtered:
                return _row_to_dict(existing)

            filtered["updated_at"] = utc_now_iso()
            set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
            params = list(filtered.values()) + [part_id]
            conn.execute(f"UPDATE parts SET {set_clause} WHERE id = ?", params)
            row = conn.execute("SELECT * FROM parts WHERE id = ?", (part_id,)).fetchone()
            return _row_to_dict(row)


def rename_bin(db_path: Path, old_bin: str, new_bin: str) -> int:
    old_clean = str(old_bin or "").strip()
    new_clean = str(new_bin or "").strip()[:32]
    if not old_clean or not new_clean:
        raise ValueError("Both old and new bin names are required")
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            cur = conn.execute(
                "UPDATE parts SET location = ?, updated_at = ? WHERE LOWER(TRIM(location)) = LOWER(?)",
                (new_clean, now, old_clean),
            )
            return cur.rowcount


def delete_part(db_path: Path, part_id: str) -> dict[str, Any] | None:
    with db_lock:
        with get_connection(db_path) as conn:
            row = conn.execute("SELECT * FROM parts WHERE id = ?", (part_id,)).fetchone()
            if not row:
                return None
            part = _row_to_dict(row)
            conn.execute("DELETE FROM parts WHERE id = ?", (part_id,))
            return part


def get_ui_settings(db_path: Path) -> dict[str, Any]:
    result = dict(DEFAULT_UI_SETTINGS)
    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
            for row in rows:
                k = row["key"]
                if k not in DEFAULT_UI_SETTINGS:
                    continue
                try:
                    result[k] = json.loads(row["value"])
                except Exception:
                    result[k] = row["value"]
    return result


def update_ui_settings(db_path: Path, updates: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for k, v in updates.items():
        if k == "theme" and v in ("system", "dark", "light"):
            clean[k] = v
        elif k == "font" and v in ("plex", "instrument"):
            clean[k] = v
        elif k == "motion" and v in ("system", "full", "reduced"):
            clean[k] = v
        elif k == "view_mode" and v in ("grid", "list"):
            clean[k] = v
        elif k == "sort_by" and v in ALLOWED_SORT_VALUES:
            clean[k] = v
        elif k in ("inline_tooltips", "show_caution_badge", "show_ok_checks", "strap_pin_checks") and isinstance(v, bool):
            clean[k] = v
        elif k == "currency" and isinstance(v, str) and v.upper() in ALLOWED_CURRENCIES:
            clean[k] = v.upper()
        elif k == "logo_color" and isinstance(v, str) and v.lower() in ALLOWED_LOGO_COLORS:
            clean[k] = v.lower()

    if clean:
        with db_lock:
            with get_connection(db_path) as conn:
                for k, v in clean.items():
                    conn.execute(
                        "INSERT INTO settings (key, value) VALUES (?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (k, json.dumps(v)),
                    )

    return get_ui_settings(db_path)


def list_glossary(db_path: Path) -> list[dict[str, Any]]:
    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute("SELECT * FROM glossary ORDER BY LOWER(term) ASC").fetchall()
            return [_row_to_dict(r) for r in rows]


def create_glossary_term(db_path: Path, data: dict[str, Any]) -> dict[str, Any]:
    term_id = str(data.get("id") or uuid.uuid4().hex).strip()
    now = utc_now_iso()
    cat = str(data.get("category") or "Circuit Basics").strip()
    if cat not in GLOSSARY_CATEGORIES:
        cat = "Circuit Basics"

    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO glossary (
                    id, term, category, summary, rule_of_thumb, keywords,
                    related_ids, bench_tool, figure_key, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    term_id,
                    str(data.get("term", "")).strip(),
                    cat,
                    str(data.get("summary", "") or "").strip(),
                    str(data.get("rule_of_thumb", "") or "").strip(),
                    str(data.get("keywords", "") or "").strip(),
                    json.dumps(_normalize_string_list(data.get("related_ids"))),
                    str(data.get("bench_tool", "") or "").strip()[:40],
                    str(data.get("figure_key", "") or "").strip()[:40],
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM glossary WHERE id = ?", (term_id,)).fetchone()
            return _row_to_dict(row)


def update_glossary_term(db_path: Path, term_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"term", "category", "summary", "rule_of_thumb", "keywords", "related_ids", "bench_tool", "figure_key"}
    filtered: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "term":
            tv = str(v or "").strip()
            if not tv:
                raise ValueError("Term cannot be empty")
            filtered[k] = tv
        elif k == "category":
            cv = str(v or "Circuit Basics").strip()
            filtered[k] = cv if cv in GLOSSARY_CATEGORIES else "Circuit Basics"
        elif k == "related_ids":
            filtered[k] = json.dumps(_normalize_string_list(v))
        else:
            filtered[k] = str(v or "").strip()

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute("SELECT * FROM glossary WHERE id = ?", (term_id,)).fetchone()
            if not existing:
                return None
            if not filtered:
                return _row_to_dict(existing)
            filtered["updated_at"] = utc_now_iso()
            set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
            conn.execute(
                f"UPDATE glossary SET {set_clause} WHERE id = ?",
                list(filtered.values()) + [term_id],
            )
            row = conn.execute("SELECT * FROM glossary WHERE id = ?", (term_id,)).fetchone()
            return _row_to_dict(row)


def delete_glossary_term(db_path: Path, term_id: str) -> bool:
    with db_lock:
        with get_connection(db_path) as conn:
            cur = conn.execute("DELETE FROM glossary WHERE id = ?", (term_id,))
            return cur.rowcount > 0


def _extract_retailer(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    try:
        host = (urlparse(raw).hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""


def _validate_http_url(url: str) -> str:
    clean = str(url or "").strip()
    if not clean:
        return ""
    parsed = urlparse(clean)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        raise ValueError("URL must start with http:// or https://")
    return clean


def _parse_price_amount(price_str: str) -> tuple[float | None, str]:
    """Parse a human-formatted price string via the unified parse_price helper."""
    val, cur = parse_price(price_str)
    if cur == "TRY":
        cur = "TL"
    return val, cur


def _sync_project_in_use_flags(conn: sqlite3.Connection, project_id: str) -> None:
    """Keep parts.in_use_project in sync when a project is active vs planning/completed/archived."""
    proj = conn.execute("SELECT id, name, status FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not proj:
        return
    now = utc_now_iso()
    proj_name = str(proj["name"]).strip()
    status = str(proj["status"]).strip()

    # Clear parts currently marked with this project name first
    conn.execute(
        "UPDATE parts SET in_use_project = '', updated_at = ? WHERE LOWER(TRIM(in_use_project)) = LOWER(?)",
        (now, proj_name),
    )

    if status != "active":
        return

    # Find selected variant (fall back to first variant if variants exist, matching _hydrate_project)
    sel_var = conn.execute(
        "SELECT id FROM project_variants WHERE project_id = ? ORDER BY is_selected DESC, sort_order ASC, created_at ASC LIMIT 1",
        (project_id,),
    ).fetchone()
    sel_vid = sel_var["id"] if sel_var else None

    if sel_vid:
        rows = conn.execute(
            "SELECT DISTINCT part_id FROM project_items "
            "WHERE project_id = ? AND part_id IS NOT NULL AND (variant_id IS NULL OR variant_id = ?)",
            (project_id, sel_vid),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT DISTINCT part_id FROM project_items WHERE project_id = ? AND part_id IS NOT NULL",
            (project_id,),
        ).fetchall()

    for r in rows:
        conn.execute(
            "UPDATE parts SET in_use_project = ?, updated_at = ? WHERE id = ?",
            (proj_name, now, r["part_id"]),
        )


def _hydrate_project(conn: sqlite3.Connection, proj_row: sqlite3.Row) -> dict[str, Any]:
    proj = _row_to_dict(proj_row)
    pid = proj["id"]
    proj["option"] = str(proj.get("option_label") or "").strip()
    proj["archived"] = proj.get("status") == "archived"

    var_rows = conn.execute(
        "SELECT * FROM project_variants WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC",
        (pid,),
    ).fetchall()
    variants = []
    for vr in var_rows:
        vd = dict(vr)
        vd["is_selected"] = bool(vd.get("is_selected"))
        variants.append(vd)

    selected_variant_id = next((v["id"] for v in variants if v["is_selected"]), None)
    if selected_variant_id is None and variants:
        selected_variant_id = variants[0]["id"]

    item_rows = conn.execute(
        "SELECT * FROM project_items WHERE project_id = ? ORDER BY created_at ASC, rowid ASC",
        (pid,),
    ).fetchall()

    items: list[dict[str, Any]] = []
    for ir in item_rows:
        item = dict(ir)
        item["ref"] = str(item.get("ref") or "").strip() or item["id"][:8]
        item["role"] = item.get("role") if item.get("role") in PROJECT_ITEM_ROLES else "periph"
        item["label"] = str(item.get("label") or "").strip()
        if item.get("part_id"):
            p_row = conn.execute("SELECT * FROM parts WHERE id = ?", (item["part_id"],)).fetchone()
            if not p_row:
                continue
            p = _row_to_dict(p_row)
            item["item_type"] = "part"
            item["name"] = p["name"]
            item["subtitle"] = p.get("subtitle") or ""
            item["category"] = p.get("category") or ""
            item["image_path"] = p.get("image_path") or ""
            item["location"] = p.get("location") or ""
            item["owned_quantity"] = int(p.get("quantity") or 0)
            item["price"] = ""
            item["retailer"] = ""
            item["url"] = p.get("source_url") or ""
            item["in_stock"] = ""
            item["shopping_status"] = ""
            item["why_needed"] = ""
            item["specs"] = p.get("specs") or {}
            item["electrical_facts"] = p.get("electrical_facts") or {}
            item["care_notes"] = p.get("care_notes") or []
        elif item.get("shopping_item_id"):
            s_row = conn.execute(
                "SELECT * FROM shopping_items WHERE id = ?", (item["shopping_item_id"],)
            ).fetchone()
            if not s_row:
                continue
            s = _row_to_dict(s_row)
            item["item_type"] = "shopping"
            item["name"] = s["name"]
            item["subtitle"] = ""
            item["category"] = s.get("category") or ""
            item["image_path"] = s.get("image_path") or ""
            item["location"] = ""
            item["owned_quantity"] = 0
            shop_qty = max(1, int(s.get("quantity") or 1))
            buy_qty = max(int(item.get("quantity_needed") or 1), shop_qty)
            item["shopping_quantity"] = shop_qty
            item["buy_quantity"] = buy_qty
            item["spares_count"] = max(0, buy_qty - 1)
            item["price"] = s.get("price") or ""
            item["retailer"] = s.get("retailer") or _extract_retailer(s.get("url") or "")
            item["url"] = s.get("url") or ""
            item["in_stock"] = s.get("in_stock") or ""
            item["shopping_status"] = s.get("status") or "order"
            item["why_needed"] = s.get("why_needed") or s.get("notes") or ""
            item["specs"] = s.get("specs") or {}
            item["electrical_facts"] = s.get("electrical_facts") or {}
            item["care_notes"] = s.get("care_notes") or []
        else:
            continue
        items.append(item)

    net_rows = conn.execute(
        "SELECT * FROM project_nets WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC",
        (pid,),
    ).fetchall()
    nets: list[dict[str, Any]] = []
    for nr in net_rows:
        nd = dict(nr)
        try:
            conns = json.loads(nd.get("connections") or "[]")
        except Exception:
            conns = []
        nets.append(
            {
                "id": nd["id"],
                "project_id": pid,
                "name": nd["name"],
                "kind": nd["kind"] if nd["kind"] in NET_KINDS else "sig",
                "rail": nd["rail"],
                "chain": bool(nd.get("is_chain")),
                "wake": bool(nd.get("is_wake")),
                "conns": conns if isinstance(conns, list) else [],
                "sort_order": int(nd.get("sort_order") or 0),
            }
        )

    check_rows = conn.execute(
        "SELECT * FROM project_checks WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC",
        (pid,),
    ).fetchall()
    checks: list[dict[str, Any]] = []
    for cr in check_rows:
        cd = dict(cr)
        checks.append(
            {
                "id": cd["id"],
                "project_id": pid,
                "severity": cd["severity"] if cd["severity"] in CHECK_SEVERITIES else "check",
                "title": cd["title"],
                "body": cd.get("body") or "",
                "node_refs": _normalize_string_list(cd.get("node_refs")),
                "net_ids": _normalize_string_list(cd.get("net_ids")),
                "is_done": bool(cd.get("is_done")),
                "sort_order": int(cd.get("sort_order") or 0),
            }
        )

    # Compute readiness for Core + selected variant (or all items if no variants)
    active_items = [
        it
        for it in items
        if it.get("variant_id") is None or (selected_variant_id and it.get("variant_id") == selected_variant_id)
    ]
    owned_count = sum(1 for it in active_items if it["item_type"] == "part" and it["owned_quantity"] > 0)
    to_buy_count = sum(1 for it in active_items if it["item_type"] == "shopping")
    cost_totals: dict[str, float] = {}
    base_cost_totals: dict[str, float] = {}
    spares_total = 0
    for it in active_items:
        if it["item_type"] == "shopping":
            buy_qty = max(1, int(it.get("buy_quantity") or it.get("quantity_needed") or 1))
            spares_total += max(0, buy_qty - 1)
            val, cur = _parse_price_amount(it.get("price") or "")
            if val is not None:
                key = cur or "TL"
                cost_totals[key] = round(cost_totals.get(key, 0.0) + val * buy_qty, 2)
                base_cost_totals[key] = round(base_cost_totals.get(key, 0.0) + val, 2)

    proj["variants"] = variants
    proj["selected_variant_id"] = selected_variant_id
    proj["items"] = items
    proj["nets"] = nets
    proj["checks"] = checks
    proj["readiness"] = {
        "owned_count": owned_count,
        "to_buy_count": to_buy_count,
        "total_count": len(active_items),
        "spares_count": spares_total,
        "remaining_cost": cost_totals,
        "remaining_cost_base": base_cost_totals,
    }
    return proj


def list_projects(db_path: Path) -> list[dict[str, Any]]:
    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute(
                "SELECT * FROM projects ORDER BY CASE status "
                "WHEN 'active' THEN 0 WHEN 'planning' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, "
                "updated_at DESC, LOWER(name) ASC"
            ).fetchall()
            return [_hydrate_project(conn, r) for r in rows]


def create_project(db_path: Path, data: dict[str, Any]) -> dict[str, Any]:
    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError("Project name cannot be empty")
    status = str(data.get("status") or "planning").strip().lower()
    if status not in PROJECT_STATUSES:
        status = "planning"
    option_val = str(data.get("option") or data.get("option_label") or "").strip()[:120]
    tags_json = json.dumps(_normalize_tags(data.get("tags")))
    proj_id = str(data.get("id") or uuid.uuid4().hex).strip()
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO projects (id, name, description, option_label, tags, status, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    proj_id,
                    name[:160],
                    str(data.get("description") or "").strip(),
                    option_val,
                    tags_json,
                    status,
                    str(data.get("notes") or "").strip(),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (proj_id,)).fetchone()
            return _hydrate_project(conn, row)


def update_project(db_path: Path, project_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"name", "description", "option", "option_label", "tags", "status", "notes"}
    filtered: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "name":
            nv = str(v or "").strip()
            if not nv:
                raise ValueError("Project name cannot be empty")
            filtered[k] = nv[:160]
        elif k in ("option", "option_label"):
            filtered["option_label"] = str(v or "").strip()[:120]
        elif k == "tags":
            filtered["tags"] = json.dumps(_normalize_tags(v))
        elif k == "status":
            sv = str(v or "planning").strip().lower()
            filtered[k] = sv if sv in PROJECT_STATUSES else "planning"
        else:
            filtered[k] = str(v or "").strip()

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not existing:
                return None
            old_name = str(existing["name"]).strip()
            if filtered:
                filtered["updated_at"] = utc_now_iso()
                set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
                conn.execute(
                    f"UPDATE projects SET {set_clause} WHERE id = ?",
                    list(filtered.values()) + [project_id],
                )
                if "name" in filtered and filtered["name"].lower() != old_name.lower():
                    conn.execute(
                        "UPDATE parts SET in_use_project = ?, updated_at = ? "
                        "WHERE LOWER(TRIM(in_use_project)) = LOWER(?)",
                        (filtered["name"], filtered["updated_at"], old_name),
                    )
                if "status" in filtered or "name" in filtered:
                    _sync_project_in_use_flags(conn, project_id)
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            return _hydrate_project(conn, row)


def delete_project(db_path: Path, project_id: str) -> dict[str, Any] | None:
    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not existing:
                return None
            proj = dict(existing)
            now = utc_now_iso()
            conn.execute(
                "UPDATE parts SET in_use_project = '', updated_at = ? WHERE LOWER(TRIM(in_use_project)) = LOWER(?)",
                (now, str(proj["name"]).strip()),
            )
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            return proj


def create_project_variant(db_path: Path, project_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError("Variant name cannot be empty")
    now = utc_now_iso()
    var_id = str(data.get("id") or uuid.uuid4().hex).strip()
    with db_lock:
        with get_connection(db_path) as conn:
            proj = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not proj:
                return None
            existing_cnt = conn.execute(
                "SELECT COUNT(*) AS c FROM project_variants WHERE project_id = ?", (project_id,)
            ).fetchone()["c"]
            is_selected = 1 if (data.get("is_selected") or existing_cnt == 0) else 0
            if is_selected:
                conn.execute(
                    "UPDATE project_variants SET is_selected = 0 WHERE project_id = ?",
                    (project_id,),
                )
            conn.execute(
                """
                INSERT INTO project_variants (id, project_id, name, description, notes, is_selected, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    var_id,
                    project_id,
                    name[:120],
                    str(data.get("description") or "").strip(),
                    str(data.get("notes") or "").strip(),
                    is_selected,
                    int(data.get("sort_order") if data.get("sort_order") is not None else existing_cnt),
                    now,
                    now,
                ),
            )
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
            _sync_project_in_use_flags(conn, project_id)
            row = conn.execute("SELECT * FROM project_variants WHERE id = ?", (var_id,)).fetchone()
            out = dict(row)
            out["is_selected"] = bool(out.get("is_selected"))
            return out


def update_project_variant(
    db_path: Path, project_id: str, variant_id: str, updates: dict[str, Any]
) -> dict[str, Any] | None:
    allowed = {"name", "description", "notes", "is_selected", "sort_order"}
    filtered: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "name":
            nv = str(v or "").strip()
            if not nv:
                raise ValueError("Variant name cannot be empty")
            filtered[k] = nv[:120]
        elif k == "is_selected":
            filtered[k] = 1 if bool(v) else 0
        elif k == "sort_order":
            filtered[k] = int(v)
        else:
            filtered[k] = str(v or "").strip()

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute(
                "SELECT * FROM project_variants WHERE id = ? AND project_id = ?",
                (variant_id, project_id),
            ).fetchone()
            if not existing:
                return None
            now = utc_now_iso()
            if filtered.get("is_selected") == 1:
                conn.execute(
                    "UPDATE project_variants SET is_selected = 0 WHERE project_id = ?",
                    (project_id,),
                )
            if filtered:
                filtered["updated_at"] = now
                set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
                conn.execute(
                    f"UPDATE project_variants SET {set_clause} WHERE id = ?",
                    list(filtered.values()) + [variant_id],
                )
                conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
                _sync_project_in_use_flags(conn, project_id)
            row = conn.execute("SELECT * FROM project_variants WHERE id = ?", (variant_id,)).fetchone()
            out = dict(row)
            out["is_selected"] = bool(out.get("is_selected"))
            return out


def delete_project_variant(db_path: Path, project_id: str, variant_id: str) -> bool:
    with db_lock:
        with get_connection(db_path) as conn:
            cur = conn.execute(
                "DELETE FROM project_variants WHERE id = ? AND project_id = ?",
                (variant_id, project_id),
            )
            if cur.rowcount > 0:
                conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (utc_now_iso(), project_id))
                _sync_project_in_use_flags(conn, project_id)
                return True
            return False


def _generate_unique_ref(conn: sqlite3.Connection, project_id: str, desired: str = "") -> str:
    rows = conn.execute("SELECT ref FROM project_items WHERE project_id = ?", (project_id,)).fetchall()
    used = {str(r["ref"] or "").strip() for r in rows if str(r["ref"] or "").strip()}
    clean = re.sub(r"[^a-zA-Z0-9_-]", "", str(desired or "").strip())[:24]
    if clean and clean not in used:
        return clean
    base = clean or "n"
    idx = 1
    while f"{base}{idx}" in used:
        idx += 1
    return f"{base}{idx}"


def add_project_item(db_path: Path, project_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    part_id = str(data.get("part_id") or "").strip() or None
    shop_id = str(data.get("shopping_item_id") or "").strip() or None
    if bool(part_id) == bool(shop_id):
        raise ValueError("Provide exactly one of part_id or shopping_item_id")
    variant_id = str(data.get("variant_id") or "").strip() or None
    qty = max(1, int(data.get("quantity_needed", 1) or 1))
    notes = str(data.get("project_notes") or "").strip()
    role = str(data.get("role") or "").strip().lower()
    if role not in PROJECT_ITEM_ROLES:
        role = ""
    label = str(data.get("label") or "").strip()[:120]
    desired_ref = str(data.get("ref") or "").strip()
    now = utc_now_iso()

    with db_lock:
        with get_connection(db_path) as conn:
            proj = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not proj:
                return None
            if variant_id:
                v_ok = conn.execute(
                    "SELECT id FROM project_variants WHERE id = ? AND project_id = ?",
                    (variant_id, project_id),
                ).fetchone()
                if not v_ok:
                    raise ValueError(f"Variant not found in project: {variant_id}")
            if part_id:
                p_ok = conn.execute("SELECT id, category FROM parts WHERE id = ?", (part_id,)).fetchone()
                if not p_ok:
                    raise ValueError(f"Part not found: {part_id}")
                if not role:
                    pcat = str(p_ok["category"] or "")
                    role = "mcu" if pcat == "Microcontrollers" else ("material" if pcat in ("Prototyping", "Tools") else "periph")
                dup = conn.execute(
                    "SELECT id, ref, label, project_notes FROM project_items WHERE project_id = ? AND part_id = ? AND COALESCE(variant_id, '') = ?",
                    (project_id, part_id, variant_id or ""),
                ).fetchone()
                if dup:
                    if desired_ref and desired_ref != dup["ref"]:
                        new_ref = _generate_unique_ref(conn, project_id, desired_ref)
                    else:
                        new_ref = dup["ref"] or _generate_unique_ref(conn, project_id)
                    new_label = label if "label" in data else (dup["label"] or "")
                    new_notes = notes if "project_notes" in data else (dup["project_notes"] or "")
                    conn.execute(
                        "UPDATE project_items SET ref = ?, role = ?, label = ?, quantity_needed = ?, project_notes = ?, updated_at = ? WHERE id = ?",
                        (new_ref, role, new_label, qty, new_notes, now, dup["id"]),
                    )
                    item_id = dup["id"]
                else:
                    item_id = uuid.uuid4().hex
                    ref = _generate_unique_ref(conn, project_id, desired_ref)
                    conn.execute(
                        """
                        INSERT INTO project_items (
                            id, project_id, variant_id, part_id, shopping_item_id,
                            ref, role, label, quantity_needed, project_notes, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (item_id, project_id, variant_id, part_id, ref, role, label, qty, notes, now, now),
                    )
            else:
                s_ok = conn.execute("SELECT id, category FROM shopping_items WHERE id = ?", (shop_id,)).fetchone()
                if not s_ok:
                    raise ValueError(f"Shopping item not found: {shop_id}")
                if not role:
                    scat = str(s_ok["category"] or "")
                    role = "mcu" if scat == "Microcontrollers" else ("material" if scat in ("Prototyping", "Tools") else "periph")
                dup = conn.execute(
                    "SELECT id, ref, label, project_notes FROM project_items WHERE project_id = ? AND shopping_item_id = ? AND COALESCE(variant_id, '') = ?",
                    (project_id, shop_id, variant_id or ""),
                ).fetchone()
                if dup:
                    if desired_ref and desired_ref != dup["ref"]:
                        new_ref = _generate_unique_ref(conn, project_id, desired_ref)
                    else:
                        new_ref = dup["ref"] or _generate_unique_ref(conn, project_id)
                    new_label = label if "label" in data else (dup["label"] or "")
                    new_notes = notes if "project_notes" in data else (dup["project_notes"] or "")
                    conn.execute(
                        "UPDATE project_items SET ref = ?, role = ?, label = ?, quantity_needed = ?, project_notes = ?, updated_at = ? WHERE id = ?",
                        (new_ref, role, new_label, qty, new_notes, now, dup["id"]),
                    )
                    item_id = dup["id"]
                else:
                    item_id = uuid.uuid4().hex
                    ref = _generate_unique_ref(conn, project_id, desired_ref)
                    conn.execute(
                        """
                        INSERT INTO project_items (
                            id, project_id, variant_id, part_id, shopping_item_id,
                            ref, role, label, quantity_needed, project_notes, created_at, updated_at
                        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (item_id, project_id, variant_id, shop_id, ref, role, label, qty, notes, now, now),
                    )
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
            _sync_project_in_use_flags(conn, project_id)
            row = conn.execute("SELECT * FROM project_items WHERE id = ?", (item_id,)).fetchone()
            return dict(row)


def update_project_item(
    db_path: Path, project_id: str, item_id: str, updates: dict[str, Any]
) -> dict[str, Any] | None:
    allowed = {"variant_id", "quantity_needed", "project_notes", "ref", "role", "label"}
    filtered: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "quantity_needed":
            filtered[k] = max(1, int(v))
        elif k == "variant_id":
            filtered[k] = str(v or "").strip() or None
        elif k == "role":
            rv = str(v or "periph").strip().lower()
            filtered[k] = rv if rv in PROJECT_ITEM_ROLES else "periph"
        elif k == "ref":
            rf = re.sub(r"[^a-zA-Z0-9_-]", "", str(v or "").strip())[:24]
            if rf:
                filtered[k] = rf
        elif k == "label":
            filtered[k] = str(v or "").strip()[:120]
        else:
            filtered[k] = str(v or "").strip()

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute(
                "SELECT * FROM project_items WHERE id = ? AND project_id = ?",
                (item_id, project_id),
            ).fetchone()
            if not existing:
                return None
            if filtered.get("variant_id"):
                v_ok = conn.execute(
                    "SELECT id FROM project_variants WHERE id = ? AND project_id = ?",
                    (filtered["variant_id"], project_id),
                ).fetchone()
                if not v_ok:
                    raise ValueError(f"Variant not found in project: {filtered['variant_id']}")
            if filtered.get("ref") and filtered["ref"] != existing["ref"]:
                filtered["ref"] = _generate_unique_ref(conn, project_id, filtered["ref"])
            if filtered:
                now = utc_now_iso()
                filtered["updated_at"] = now
                set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
                conn.execute(
                    f"UPDATE project_items SET {set_clause} WHERE id = ?",
                    list(filtered.values()) + [item_id],
                )
                conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
                _sync_project_in_use_flags(conn, project_id)
            row = conn.execute("SELECT * FROM project_items WHERE id = ?", (item_id,)).fetchone()
            return dict(row)


def _normalize_net_connections(raw: Any) -> list[list[str]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    out: list[list[str]] = []
    for entry in raw[:40]:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
            r = str(entry[0] or "").strip()[:32]
            pin = str(entry[1] or "").strip()[:48]
            if r:
                out.append([r, pin])
        elif isinstance(entry, dict):
            r = str(entry.get("ref") or "").strip()[:32]
            pin = str(entry.get("pin") or "").strip()[:48]
            if r:
                out.append([r, pin])
    return out


def set_project_nets(db_path: Path, project_id: str, nets: list[dict[str, Any]]) -> dict[str, Any] | None:
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            proj = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not proj:
                return None
            conn.execute("DELETE FROM project_nets WHERE project_id = ?", (project_id,))
            used_ids = {
                r["id"]
                for r in conn.execute("SELECT id FROM project_nets").fetchall()
            }
            for idx, net in enumerate(nets[:60]):
                if not isinstance(net, dict):
                    continue
                conns = _normalize_net_connections(net.get("conns") if "conns" in net else net.get("connections"))
                if len(conns) < 2:
                    continue
                kind = str(net.get("kind") or "sig").strip().lower()
                if kind not in NET_KINDS:
                    kind = "sig"
                name = str(net.get("name") or "").strip()[:120] or kind.upper()
                rail_val = net.get("rail")
                rail: float | None = None
                if rail_val not in (None, ""):
                    try:
                        rv = float(rail_val)
                        if math.isfinite(rv) and 0 < rv <= 60:
                            rail = round(rv, 2)
                    except (TypeError, ValueError):
                        rail = None
                net_id = str(net.get("id") or "").strip()[:64]
                if not net_id or net_id in used_ids:
                    net_id = uuid.uuid4().hex
                used_ids.add(net_id)
                conn.execute(
                    """
                    INSERT INTO project_nets (
                        id, project_id, name, kind, rail, is_chain, is_wake, connections, sort_order, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        net_id,
                        project_id,
                        name,
                        kind,
                        rail,
                        1 if bool(net.get("chain") or net.get("is_chain")) else 0,
                        1 if bool(net.get("wake") or net.get("is_wake")) else 0,
                        json.dumps(conns),
                        idx,
                        now,
                        now,
                    ),
                )
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            return _hydrate_project(conn, row)


def set_project_checks(db_path: Path, project_id: str, checks: list[dict[str, Any]]) -> dict[str, Any] | None:
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            proj = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not proj:
                return None
            prev_done = {
                r["id"]: bool(r["is_done"])
                for r in conn.execute("SELECT id, is_done FROM project_checks WHERE project_id = ?", (project_id,)).fetchall()
            }
            conn.execute("DELETE FROM project_checks WHERE project_id = ?", (project_id,))
            used_ids = {
                r["id"]
                for r in conn.execute("SELECT id FROM project_checks").fetchall()
            }
            for idx, chk in enumerate(checks[:60]):
                if not isinstance(chk, dict):
                    continue
                title = str(chk.get("title") or "").strip()[:240]
                if not title:
                    continue
                sev = str(chk.get("severity") or "check").strip().lower()
                if sev not in CHECK_SEVERITIES:
                    sev = "check"
                chk_id = str(chk.get("id") or "").strip()[:64]
                if not chk_id or chk_id in used_ids:
                    chk_id = uuid.uuid4().hex
                used_ids.add(chk_id)
                done = bool(chk.get("is_done")) if "is_done" in chk else prev_done.get(chk_id, False)
                conn.execute(
                    """
                    INSERT INTO project_checks (
                        id, project_id, severity, title, body, node_refs, net_ids, is_done, sort_order, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chk_id,
                        project_id,
                        sev,
                        title,
                        str(chk.get("body") or "").strip()[:1000],
                        json.dumps(_normalize_string_list(chk.get("node_refs"))),
                        json.dumps(_normalize_string_list(chk.get("net_ids"))),
                        1 if done else 0,
                        idx,
                        now,
                        now,
                    ),
                )
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            return _hydrate_project(conn, row)


def update_project_check(
    db_path: Path, project_id: str, check_id: str, updates: dict[str, Any]
) -> dict[str, Any] | None:
    allowed = {"severity", "title", "body", "node_refs", "net_ids", "is_done"}
    filtered: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "severity":
            sv = str(v or "check").strip().lower()
            filtered[k] = sv if sv in CHECK_SEVERITIES else "check"
        elif k == "title":
            tv = str(v or "").strip()[:240]
            if not tv:
                raise ValueError("Check title cannot be empty")
            filtered[k] = tv
        elif k == "body":
            filtered[k] = str(v or "").strip()[:1000]
        elif k in ("node_refs", "net_ids"):
            filtered[k] = json.dumps(_normalize_string_list(v))
        elif k == "is_done":
            filtered[k] = 1 if bool(v) else 0

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute(
                "SELECT id FROM project_checks WHERE id = ? AND project_id = ?",
                (check_id, project_id),
            ).fetchone()
            if not existing:
                return None
            if filtered:
                now = utc_now_iso()
                filtered["updated_at"] = now
                set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
                conn.execute(
                    f"UPDATE project_checks SET {set_clause} WHERE id = ? AND project_id = ?",
                    list(filtered.values()) + [check_id, project_id],
                )
                conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            return _hydrate_project(conn, row)


def delete_project_item(db_path: Path, project_id: str, item_id: str) -> bool:
    with db_lock:
        with get_connection(db_path) as conn:
            cur = conn.execute(
                "DELETE FROM project_items WHERE id = ? AND project_id = ?",
                (item_id, project_id),
            )
            if cur.rowcount > 0:
                conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (utc_now_iso(), project_id))
                _sync_project_in_use_flags(conn, project_id)
                return True
            return False


def teardown_project(db_path: Path, project_name: str) -> int:
    """Clear in_use_project for all parts assigned to the given project and set project to planning."""
    clean = project_name.strip()
    if not clean:
        return 0
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            cur = conn.execute(
                "UPDATE parts SET in_use_project = '', updated_at = ? "
                "WHERE LOWER(TRIM(in_use_project)) = LOWER(?)",
                (now, clean),
            )
            conn.execute(
                "UPDATE projects SET status = 'planning', updated_at = ? "
                "WHERE LOWER(TRIM(name)) = LOWER(?) AND status = 'active'",
                (now, clean),
            )
            return cur.rowcount


def _normalize_domain(raw: str) -> str:
    text = str(raw or "").strip().lower()
    if not text:
        return ""
    if "://" in text:
        try:
            host = (urlparse(text).hostname or "").lower()
            text = host
        except Exception:
            pass
    else:
        text = text.split("/", 1)[0].split(":", 1)[0]
    if text.startswith("www."):
        text = text[4:]
    return text.strip()[:80]


def _sync_shopping_item_from_selected_offer(conn: sqlite3.Connection, item_id: str) -> None:
    """Keep shopping_items.(retailer, url, price, in_stock) synced with the selected offer."""
    offers = conn.execute(
        """
        SELECT * FROM shopping_item_offers
        WHERE shopping_item_id = ?
        ORDER BY is_selected DESC, created_at ASC, rowid ASC
        """,
        (item_id,),
    ).fetchall()
    now = utc_now_iso()
    if not offers:
        conn.execute(
            "UPDATE shopping_items SET retailer = '', url = '', price = '', in_stock = '', updated_at = ? WHERE id = ?",
            (now, item_id),
        )
        return
    chosen = offers[0]
    if not chosen["is_selected"]:
        conn.execute("UPDATE shopping_item_offers SET is_selected = 1 WHERE id = ?", (chosen["id"],))
    conn.execute(
        """
        UPDATE shopping_items
        SET retailer = ?, url = ?, price = ?, in_stock = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            str(chosen["retailer"] or "").strip()[:80],
            str(chosen["url"] or "").strip(),
            str(chosen["price"] or "").strip()[:40],
            str(chosen["in_stock"] or "").strip().lower(),
            now,
            item_id,
        ),
    )


def _hydrate_shopping_item(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    item = _row_to_dict(row)
    if not item.get("retailer") and item.get("url"):
        item["retailer"] = _extract_retailer(item["url"])
    links = conn.execute(
        """
        SELECT pi.id AS project_item_id, pi.project_id, p.name AS project_name,
               pi.variant_id, pv.name AS variant_name, pv.is_selected AS variant_is_selected,
               pi.project_notes
        FROM project_items pi
        JOIN projects p ON p.id = pi.project_id
        LEFT JOIN project_variants pv ON pv.id = pi.variant_id
        WHERE pi.shopping_item_id = ?
        """,
        (item["id"],),
    ).fetchall()
    hydrated_links: list[dict[str, Any]] = []
    for lk in links:
        d = dict(lk)
        if d["variant_id"] is None:
            d["variant_is_selected"] = True
        else:
            sel_row = conn.execute(
                "SELECT id FROM project_variants WHERE project_id = ? ORDER BY is_selected DESC, sort_order ASC, created_at ASC LIMIT 1",
                (d["project_id"],),
            ).fetchone()
            d["variant_is_selected"] = bool(sel_row and sel_row["id"] == d["variant_id"])
        hydrated_links.append(d)
    item["project_links"] = hydrated_links
    # True when this item ONLY belongs to unselected sub-builds (not Core, not any selected variant)
    item["in_inactive_variant"] = bool(hydrated_links) and all(
        lk["variant_id"] is not None and not lk["variant_is_selected"] for lk in hydrated_links
    )
    offer_rows = conn.execute(
        """
        SELECT id, shopping_item_id, retailer, url, price, in_stock, is_selected, notes, created_at, updated_at
        FROM shopping_item_offers
        WHERE shopping_item_id = ?
        ORDER BY is_selected DESC, created_at ASC, rowid ASC
        """,
        (item["id"],),
    ).fetchall()
    item["offers"] = [
        {
            **dict(o),
            "is_selected": bool(o["is_selected"]),
        }
        for o in offer_rows
    ]
    return item


def get_shopping_item(db_path: Path, item_id: str) -> dict[str, Any] | None:
    with db_lock:
        with get_connection(db_path) as conn:
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            return _hydrate_shopping_item(conn, row) if row else None


def list_shopping_items(db_path: Path) -> list[dict[str, Any]]:
    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute("SELECT * FROM shopping_items ORDER BY created_at DESC, rowid DESC").fetchall()
            return [_hydrate_shopping_item(conn, r) for r in rows]


def create_shopping_item(db_path: Path, data: dict[str, Any]) -> dict[str, Any]:
    item_id = str(data.get("id") or uuid.uuid4().hex).strip()
    now = utc_now_iso()
    qty = max(1, int(data.get("quantity", 1) or 1))
    url = _validate_http_url(data.get("url", ""))
    retailer = str(data.get("retailer", "") or "").strip() or _extract_retailer(url)
    cat = str(data.get("category", "") or "").strip()
    if cat and cat not in CATEGORIES:
        cat = ""
    specs_json = json.dumps(_normalize_specs(data.get("specs")))
    facts_json = json.dumps(_normalize_electrical_facts(data.get("electrical_facts")))
    care_json = json.dumps(_normalize_care_notes(data.get("care_notes")))
    status = str(data.get("status", "order") or "order").strip().lower()
    if status not in SHOPPING_STATUSES:
        status = "order"
    in_stock = str(data.get("in_stock", "") or "").strip().lower()
    if in_stock not in ("in_stock", "out_of_stock", ""):
        in_stock = ""
    why_needed = str(data.get("why_needed", "") or "").strip()
    notes = str(data.get("notes", "") or "").strip()

    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO shopping_items (
                    id, name, url, price, quantity, notes, image_path,
                    retailer, tag, category, specs, electrical_facts, care_notes,
                    status, in_stock, why_needed, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    str(data.get("name", "")).strip(),
                    url,
                    str(data.get("price", "") or "").strip()[:40],
                    qty,
                    notes,
                    str(data.get("image_path", "") or "").strip(),
                    retailer[:80],
                    str(data.get("tag", "") or "").strip()[:80],
                    cat,
                    specs_json,
                    facts_json,
                    care_json,
                    status,
                    in_stock,
                    why_needed,
                    now,
                    now,
                ),
            )
            raw_offers = data.get("offers")
            offer_list: list[dict[str, Any]] = []
            if isinstance(raw_offers, list):
                for o in raw_offers:
                    if isinstance(o, dict):
                        o_url = _validate_http_url(o.get("url", ""))
                        o_ret = str(o.get("retailer", "") or "").strip() or _extract_retailer(o_url)
                        if not o_url and not o_ret:
                            continue
                        o_stock = str(o.get("in_stock", "") or "").strip().lower()
                        if o_stock not in ("in_stock", "out_of_stock", ""):
                            o_stock = ""
                        offer_list.append(
                            {
                                "retailer": o_ret[:80],
                                "url": o_url,
                                "price": str(o.get("price", "") or "").strip()[:40],
                                "in_stock": o_stock,
                                "is_selected": bool(o.get("is_selected", False)),
                                "notes": str(o.get("notes", "") or "").strip()[:200],
                            }
                        )
            if url or retailer:
                already_has_primary = any(
                    (url and o["url"] == url) or (not url and retailer and o["retailer"].lower() == retailer.lower())
                    for o in offer_list
                )
                if not already_has_primary:
                    offer_list.insert(
                        0,
                        {
                            "retailer": retailer[:80],
                            "url": url,
                            "price": str(data.get("price", "") or "").strip()[:40],
                            "in_stock": in_stock,
                            "is_selected": not any(o["is_selected"] for o in offer_list),
                            "notes": "",
                        },
                    )
            if offer_list:
                if not any(o["is_selected"] for o in offer_list):
                    offer_list[0]["is_selected"] = True
                selected_seen = False
                for o in offer_list:
                    sel = 1 if (o["is_selected"] and not selected_seen) else 0
                    if sel:
                        selected_seen = True
                    conn.execute(
                        """
                        INSERT INTO shopping_item_offers (
                            id, shopping_item_id, retailer, url, price, in_stock, is_selected, notes, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            uuid.uuid4().hex,
                            item_id,
                            o["retailer"],
                            o["url"],
                            o["price"],
                            o["in_stock"],
                            sel,
                            o["notes"],
                            now,
                            now,
                        ),
                    )
                _sync_shopping_item_from_selected_offer(conn, item_id)
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            return _hydrate_shopping_item(conn, row)


def update_shopping_item(db_path: Path, item_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {
        "name",
        "url",
        "price",
        "quantity",
        "notes",
        "image_path",
        "retailer",
        "tag",
        "category",
        "specs",
        "electrical_facts",
        "care_notes",
        "status",
        "in_stock",
        "why_needed",
    }
    filtered: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "quantity":
            filtered[k] = max(1, int(v))
        elif k == "name":
            nv = str(v or "").strip()
            if not nv:
                raise ValueError("Item name cannot be empty")
            filtered[k] = nv
        elif k == "category":
            cv = str(v or "").strip()
            filtered[k] = cv if cv in CATEGORIES else ""
        elif k == "specs":
            filtered[k] = json.dumps(_normalize_specs(v))
        elif k == "electrical_facts":
            filtered[k] = json.dumps(_normalize_electrical_facts(v))
        elif k == "care_notes":
            filtered[k] = json.dumps(_normalize_care_notes(v))
        elif k == "status":
            sv = str(v or "order").strip().lower()
            filtered[k] = sv if sv in SHOPPING_STATUSES else "order"
        elif k == "in_stock":
            sv = str(v or "").strip().lower()
            filtered[k] = sv if sv in ("in_stock", "out_of_stock", "") else ""
        elif k == "url":
            filtered[k] = _validate_http_url(v)
        else:
            filtered[k] = str(v or "").strip()

    if "url" in filtered and "retailer" not in filtered:
        derived = _extract_retailer(filtered["url"])
        if derived:
            filtered["retailer"] = derived

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            if not existing:
                return None
            if not filtered:
                return _hydrate_shopping_item(conn, existing)
            filtered["updated_at"] = utc_now_iso()
            set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
            conn.execute(
                f"UPDATE shopping_items SET {set_clause} WHERE id = ?",
                list(filtered.values()) + [item_id],
            )
            offer_sync_fields = {"url", "retailer", "price", "in_stock"}
            if offer_sync_fields.intersection(filtered.keys()):
                updated_row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
                sel_offer = conn.execute(
                    """
                    SELECT id FROM shopping_item_offers
                    WHERE shopping_item_id = ?
                    ORDER BY is_selected DESC, created_at ASC, rowid ASC
                    LIMIT 1
                    """,
                    (item_id,),
                ).fetchone()
                now = utc_now_iso()
                clean_ret = str(updated_row["retailer"] or "").strip()[:80]
                clean_url = str(updated_row["url"] or "").strip()
                if sel_offer:
                    if not clean_ret and not clean_url:
                        conn.execute("DELETE FROM shopping_item_offers WHERE id = ?", (sel_offer["id"],))
                        _sync_shopping_item_from_selected_offer(conn, item_id)
                    else:
                        conn.execute(
                            """
                            UPDATE shopping_item_offers
                            SET retailer = ?, url = ?, price = ?, in_stock = ?, is_selected = 1, updated_at = ?
                            WHERE id = ?
                            """,
                            (
                                clean_ret,
                                clean_url,
                                str(updated_row["price"] or "").strip()[:40],
                                str(updated_row["in_stock"] or "").strip().lower(),
                                now,
                                sel_offer["id"],
                            ),
                        )
                elif clean_url or clean_ret:
                    conn.execute(
                        """
                        INSERT INTO shopping_item_offers (
                            id, shopping_item_id, retailer, url, price, in_stock, is_selected, notes, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, 1, '', ?, ?)
                        """,
                        (
                            uuid.uuid4().hex,
                            item_id,
                            str(updated_row["retailer"] or "").strip()[:80],
                            str(updated_row["url"] or "").strip(),
                            str(updated_row["price"] or "").strip()[:40],
                            str(updated_row["in_stock"] or "").strip().lower(),
                            now,
                            now,
                        ),
                    )
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            return _hydrate_shopping_item(conn, row)


def delete_shopping_item(db_path: Path, item_id: str) -> dict[str, Any] | None:
    with db_lock:
        with get_connection(db_path) as conn:
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            if not row:
                return None
            item = dict(row)
            conn.execute("DELETE FROM shopping_items WHERE id = ?", (item_id,))
            return item


def move_shopping_item_to_inventory(db_path: Path, item_id: str) -> dict[str, Any] | None:
    with db_lock:
        with get_connection(db_path) as conn:
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            if not row:
                return None
            item = _row_to_dict(row)
            part_id = uuid.uuid4().hex
            now = utc_now_iso()
            cat = item.get("category") or "Sensors"
            if cat not in CATEGORIES:
                cat = "Sensors"
            specs_json = json.dumps(_normalize_specs(item.get("specs")))
            facts_json = json.dumps(_normalize_electrical_facts(item.get("electrical_facts")))
            care_list = _normalize_care_notes(item.get("care_notes"))
            care_json = json.dumps(care_list)
            first_warning = care_list[0]["text"] if care_list else ""

            # Find any projects referencing this shopping item before deleting it
            linked_rows = conn.execute(
                "SELECT id, project_id FROM project_items WHERE shopping_item_id = ?",
                (item_id,),
            ).fetchall()

            conn.execute(
                """
                INSERT INTO parts (
                    id, name, subtitle, category, quantity, low_stock_threshold,
                    location, in_use_project, what_it_does, visual_tell, warning,
                    notes, source_url, image_path, pinout_image_path, pinout_url,
                    pinout_svg, specs, electrical_facts, care_notes, created_at, updated_at
                ) VALUES (?, ?, '', ?, ?, NULL, '', '', '', '', ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, ?)
                """,
                (
                    part_id,
                    item["name"],
                    cat,
                    max(1, int(item.get("quantity") or 1)),
                    first_warning,
                    item.get("notes") or "",
                    item.get("url") or "",
                    item.get("image_path") or "",
                    specs_json,
                    facts_json,
                    care_json,
                    now,
                    now,
                ),
            )

            # Re-link project_items from shopping_item_id to the new owned part_id
            for lr in linked_rows:
                conn.execute(
                    "UPDATE project_items SET part_id = ?, shopping_item_id = NULL, updated_at = ? WHERE id = ?",
                    (part_id, now, lr["id"]),
                )

            conn.execute("DELETE FROM shopping_items WHERE id = ?", (item_id,))

            for lr in linked_rows:
                _sync_project_in_use_flags(conn, lr["project_id"])

            new_row = conn.execute("SELECT * FROM parts WHERE id = ?", (part_id,)).fetchone()
            return _row_to_dict(new_row)


def bulk_update_shopping_status_by_store(
    db_path: Path, retailer: str, status: str, item_ids: list[str] | None = None
) -> list[dict[str, Any]]:
    st = str(status or "").strip().lower()
    if st not in SHOPPING_STATUSES:
        raise ValueError("Status must be one of: order, ordered, arrived")
    target = _normalize_domain(retailer) or str(retailer or "").strip().lower()
    if not target and not item_ids:
        raise ValueError("Retailer or item_ids required")
    now = utc_now_iso()
    updated_ids: list[str] = []
    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute("SELECT * FROM shopping_items").fetchall()
            wanted = set(item_ids) if item_ids else None
            for r in rows:
                if wanted is not None:
                    if r["id"] not in wanted:
                        continue
                else:
                    r_store = _normalize_domain(r["retailer"] or r["url"] or "") or str(r["retailer"] or "").strip().lower()
                    if r_store != target:
                        continue
                conn.execute(
                    "UPDATE shopping_items SET status = ?, updated_at = ? WHERE id = ?",
                    (st, now, r["id"]),
                )
                updated_ids.append(r["id"])
            return [
                _hydrate_shopping_item(conn, conn.execute("SELECT * FROM shopping_items WHERE id = ?", (iid,)).fetchone())
                for iid in updated_ids
            ]


def import_parts_from_rows(db_path: Path, rows: list[dict[str, Any]]) -> int:
    """Import parts from parsed CSV rows. Updates existing by id or inserts new rows."""
    now = utc_now_iso()
    count = 0
    with db_lock:
        with get_connection(db_path) as conn:
            for item in rows:
                name = str(item.get("name") or "").strip()
                if not name:
                    continue
                part_id = str(item.get("id") or "").strip() or uuid.uuid4().hex
                cat = str(item.get("category") or "Sensors").strip()
                if cat not in CATEGORIES:
                    cat = "Sensors"
                try:
                    qty = max(0, int(str(item.get("quantity", "1")).strip() or "1"))
                except ValueError:
                    qty = 1
                raw_lst = str(item.get("low_stock_threshold") or "").strip()
                try:
                    lst = max(0, int(raw_lst)) if raw_lst != "" else None
                except ValueError:
                    lst = None

                specs_json = json.dumps(_normalize_specs(item.get("specs") or "{}"))
                try:
                    safe_source_url = _validate_http_url(str(item.get("source_url") or ""))
                except ValueError:
                    safe_source_url = ""
                try:
                    safe_pinout_url = _validate_http_url(str(item.get("pinout_url") or ""))
                except ValueError:
                    safe_pinout_url = ""
                warn_text = str(item.get("warning") or "").strip()
                care_json = json.dumps([{"severity": "check", "text": warn_text}] if warn_text else [])
                existing = conn.execute("SELECT id FROM parts WHERE id = ?", (part_id,)).fetchone()
                if existing:
                    conn.execute(
                        """
                        UPDATE parts SET
                            name=?, subtitle=?, category=?, quantity=?, low_stock_threshold=?,
                            location=?, in_use_project=?, what_it_does=?, visual_tell=?,
                            warning=?, care_notes=?, notes=?, source_url=?, pinout_url=?, specs=?, updated_at=?
                        WHERE id=?
                        """,
                        (
                            name,
                            str(item.get("subtitle") or "").strip(),
                            cat,
                            qty,
                            lst,
                            str(item.get("location") or "").strip(),
                            str(item.get("in_use_project") or "").strip(),
                            str(item.get("what_it_does") or "").strip(),
                            str(item.get("visual_tell") or "").strip(),
                            warn_text,
                            care_json,
                            str(item.get("notes") or "").strip(),
                            safe_source_url,
                            safe_pinout_url,
                            specs_json,
                            now,
                            part_id,
                        ),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO parts (
                            id, name, subtitle, category, quantity, low_stock_threshold,
                            location, in_use_project, what_it_does, visual_tell, warning, care_notes,
                            notes, source_url, image_path, pinout_image_path, pinout_url,
                            specs, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?)
                        """,
                        (
                            part_id,
                            name,
                            str(item.get("subtitle") or "").strip(),
                            cat,
                            qty,
                            lst,
                            str(item.get("location") or "").strip(),
                            str(item.get("in_use_project") or "").strip(),
                            str(item.get("what_it_does") or "").strip(),
                            str(item.get("visual_tell") or "").strip(),
                            warn_text,
                            care_json,
                            str(item.get("notes") or "").strip(),
                            safe_source_url,
                            safe_pinout_url,
                            specs_json,
                            now,
                            now,
                        ),
                    )
                count += 1
    return count


# =============================================================================
# Shopping item offers, retailer metadata, and cart consolidation optimizer
# =============================================================================


def add_shopping_offer(db_path: Path, item_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    url = _validate_http_url(data.get("url", ""))
    retailer = str(data.get("retailer", "") or "").strip() or _extract_retailer(url)
    if not url and not retailer:
        raise ValueError("Offer must include a URL or retailer")
    price = str(data.get("price", "") or "").strip()[:40]
    in_stock = str(data.get("in_stock", "") or "").strip().lower()
    if in_stock not in ("in_stock", "out_of_stock", ""):
        in_stock = ""
    notes = str(data.get("notes", "") or "").strip()[:200]
    want_selected = bool(data.get("is_selected", False))
    now = utc_now_iso()

    with db_lock:
        with get_connection(db_path) as conn:
            item_row = conn.execute("SELECT id FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            if not item_row:
                return None
            existing_count = conn.execute(
                "SELECT COUNT(*) AS cnt FROM shopping_item_offers WHERE shopping_item_id = ?",
                (item_id,),
            ).fetchone()["cnt"]
            select_flag = 1 if (want_selected or existing_count == 0) else 0
            if select_flag:
                conn.execute(
                    "UPDATE shopping_item_offers SET is_selected = 0 WHERE shopping_item_id = ?",
                    (item_id,),
                )
            offer_id = uuid.uuid4().hex
            conn.execute(
                """
                INSERT INTO shopping_item_offers (
                    id, shopping_item_id, retailer, url, price, in_stock, is_selected, notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (offer_id, item_id, retailer[:80], url, price, in_stock, select_flag, notes, now, now),
            )
            if select_flag:
                _sync_shopping_item_from_selected_offer(conn, item_id)
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            return _hydrate_shopping_item(conn, row)


def update_shopping_offer(
    db_path: Path, item_id: str, offer_id: str, updates: dict[str, Any]
) -> dict[str, Any] | None:
    allowed = {"retailer", "url", "price", "in_stock", "is_selected", "notes"}
    filtered: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "is_selected":
            filtered[k] = 1 if bool(v) else 0
        elif k == "in_stock":
            sv = str(v or "").strip().lower()
            filtered[k] = sv if sv in ("in_stock", "out_of_stock", "") else ""
        elif k == "price":
            filtered[k] = str(v or "").strip()[:40]
        elif k == "retailer":
            filtered[k] = str(v or "").strip()[:80]
        elif k == "notes":
            filtered[k] = str(v or "").strip()[:200]
        elif k == "url":
            filtered[k] = _validate_http_url(v)
        else:
            filtered[k] = str(v or "").strip()

    if "url" in filtered and "retailer" not in filtered:
        derived = _extract_retailer(filtered["url"])
        if derived:
            filtered["retailer"] = derived

    with db_lock:
        with get_connection(db_path) as conn:
            offer = conn.execute(
                "SELECT * FROM shopping_item_offers WHERE id = ? AND shopping_item_id = ?",
                (offer_id, item_id),
            ).fetchone()
            if not offer:
                return None
            if filtered:
                if filtered.get("is_selected") == 1:
                    conn.execute(
                        "UPDATE shopping_item_offers SET is_selected = 0 WHERE shopping_item_id = ?",
                        (item_id,),
                    )
                filtered["updated_at"] = utc_now_iso()
                set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
                conn.execute(
                    f"UPDATE shopping_item_offers SET {set_clause} WHERE id = ? AND shopping_item_id = ?",
                    list(filtered.values()) + [offer_id, item_id],
                )
                _sync_shopping_item_from_selected_offer(conn, item_id)
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            return _hydrate_shopping_item(conn, row) if row else None


def delete_shopping_offer(db_path: Path, item_id: str, offer_id: str) -> dict[str, Any] | None:
    with db_lock:
        with get_connection(db_path) as conn:
            offer = conn.execute(
                "SELECT id FROM shopping_item_offers WHERE id = ? AND shopping_item_id = ?",
                (offer_id, item_id),
            ).fetchone()
            if not offer:
                return None
            conn.execute(
                "DELETE FROM shopping_item_offers WHERE id = ? AND shopping_item_id = ?",
                (offer_id, item_id),
            )
            _sync_shopping_item_from_selected_offer(conn, item_id)
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            return _hydrate_shopping_item(conn, row) if row else None


def list_retailers(db_path: Path) -> list[dict[str, Any]]:
    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute("SELECT * FROM retailers ORDER BY domain ASC").fetchall()
            return [dict(r) for r in rows]


def upsert_retailer(db_path: Path, domain: str, data: dict[str, Any]) -> dict[str, Any]:
    norm = _normalize_domain(domain)
    if not norm:
        raise ValueError("Retailer domain cannot be empty")

    def _opt_float(val: Any) -> float | None:
        if val is None or val == "":
            return None
        f = float(val)
        if not math.isfinite(f) or f < 0:
            raise ValueError("Shipping values must be finite non-negative numbers")
        return round(f, 2)

    name = str(data.get("name", "") or "").strip()[:80]
    shipping_cost = _opt_float(data.get("shipping_cost"))
    free_threshold = _opt_float(data.get("free_shipping_threshold"))
    currency = str(data.get("currency", "") or "").strip().upper()[:10]
    notes = str(data.get("notes", "") or "").strip()[:200]
    now = utc_now_iso()

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute("SELECT domain FROM retailers WHERE domain = ?", (norm,)).fetchone()
            if existing:
                conn.execute(
                    """
                    UPDATE retailers
                    SET name = ?, shipping_cost = ?, free_shipping_threshold = ?, currency = ?, notes = ?, updated_at = ?
                    WHERE domain = ?
                    """,
                    (name, shipping_cost, free_threshold, currency, notes, now, norm),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO retailers (
                        domain, name, shipping_cost, free_shipping_threshold, currency, notes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (norm, name, shipping_cost, free_threshold, currency, notes, now, now),
                )
            row = conn.execute("SELECT * FROM retailers WHERE domain = ?", (norm,)).fetchone()
            return dict(row)


def parse_price(price_str: str) -> tuple[float | None, str]:
    """Parse common price strings like '249,90 TL', '₺1.249,50', '$12.50', '€8.99'."""
    s = str(price_str or "").strip()
    if not s:
        return None, ""
    upper = s.upper()
    currency = ""
    if "₺" in s or "TRY" in upper or re.search(r"\bTL\b", upper):
        currency = "TRY"
    elif "$" in s or "USD" in upper:
        currency = "USD"
    elif "€" in s or "EUR" in upper:
        currency = "EUR"
    elif "£" in s or "GBP" in upper:
        currency = "GBP"

    m = re.search(r"\d[\d.,]*", s)
    if not m:
        return None, currency
    num = m.group(0)
    if "." in num and "," in num:
        if num.rfind(",") > num.rfind("."):
            num = num.replace(".", "").replace(",", ".")
        else:
            num = num.replace(",", "")
    elif "," in num:
        parts = num.split(",")
        if len(parts) == 2 and len(parts[1]) in (1, 2):
            num = f"{parts[0]}.{parts[1]}"
        else:
            num = num.replace(",", "")
    elif "." in num:
        parts = num.split(".")
        # Multiple dots (e.g. '1.200.000') are thousands separators.
        # A single dot with 3 trailing digits is only a thousands separator if integer part != '0'
        # (so '$0.125' stays 0.125) and currency is not USD/GBP (where '.' is decimal).
        if len(parts) > 2 or (
            len(parts) == 2
            and len(parts[1]) == 3
            and parts[0] != "0"
            and 1 <= len(parts[0]) <= 3
            and currency not in ("USD", "GBP")
        ):
            num = num.replace(".", "")

    try:
        val = float(num)
        return (round(val, 4) if val < 1 else round(val, 2)), currency
    except ValueError:
        return None, currency


def _build_cart_plan_summary(
    assignments: list[tuple[dict[str, Any], dict[str, Any]]],
    retailer_meta: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    by_store: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for item, offer in assignments:
        store = _normalize_domain(offer.get("retailer") or offer.get("url") or "") or (offer.get("retailer") or "Unknown")
        by_store.setdefault(store, []).append((item, offer))

    carts: list[dict[str, Any]] = []
    grand_subtotal = 0.0
    grand_shipping = 0.0
    all_priced = True
    currencies: set[str] = set()

    for store in sorted(by_store.keys()):
        entries = by_store[store]
        meta = retailer_meta.get(store, {})
        subtotal = 0.0
        store_priced = True
        cart_items: list[dict[str, Any]] = []

        for item, offer in entries:
            unit_price, cur = parse_price(offer.get("price", ""))
            if cur:
                currencies.add(cur)
            qty = max(1, int(item.get("quantity") or 1))
            line_total = round(unit_price * qty, 2) if unit_price is not None else None
            if line_total is not None:
                subtotal = round(subtotal + line_total, 2)
            else:
                store_priced = False
                all_priced = False
            cart_items.append(
                {
                    "item_id": item["id"],
                    "name": item["name"],
                    "quantity": qty,
                    "offer_id": offer["id"],
                    "price": offer.get("price", ""),
                    "unit_price": unit_price,
                    "line_total": line_total,
                    "in_stock": offer.get("in_stock", ""),
                    "url": offer.get("url", ""),
                }
            )

        if meta.get("currency"):
            currencies.add(str(meta["currency"]).upper())

        shipping_cost = meta.get("shipping_cost")
        free_threshold = meta.get("free_shipping_threshold")
        applied_shipping = 0.0
        free_shipping_remaining: float | None = None
        if shipping_cost is not None:
            if free_threshold is not None and store_priced and subtotal >= free_threshold:
                applied_shipping = 0.0
                free_shipping_remaining = 0.0
            else:
                applied_shipping = round(float(shipping_cost), 2)
                if free_threshold is not None and store_priced:
                    free_shipping_remaining = round(max(0.0, float(free_threshold) - subtotal), 2)

        grand_subtotal = round(grand_subtotal + subtotal, 2)
        grand_shipping = round(grand_shipping + applied_shipping, 2)

        carts.append(
            {
                "retailer": store,
                "display_name": meta.get("name") or store,
                "item_count": len(cart_items),
                "subtotal": subtotal if store_priced else None,
                "shipping_cost": applied_shipping if shipping_cost is not None else None,
                "free_shipping_threshold": free_threshold,
                "free_shipping_remaining": free_shipping_remaining,
                "total": round(subtotal + applied_shipping, 2) if store_priced else None,
                "items": cart_items,
            }
        )

    carts.sort(key=lambda c: (-c["item_count"], c["retailer"]))
    mixed_currencies = len(currencies) > 1
    comparable_totals = all_priced and bool(carts) and not mixed_currencies
    return {
        "store_count": len(carts),
        "carts": carts,
        "subtotal": grand_subtotal if comparable_totals else None,
        "shipping_total": grand_shipping if not mixed_currencies else None,
        "total": round(grand_subtotal + grand_shipping, 2) if comparable_totals else None,
        "currency": next(iter(currencies)) if len(currencies) == 1 else "",
        "all_priced": all_priced,
        "mixed_currencies": mixed_currencies,
    }


def optimize_shopping_carts(
    db_path: Path,
    *,
    item_ids: list[str] | None = None,
    project_id: str | None = None,
    tag: str | None = None,
    mode: str = "fewest_orders",
    include_out_of_stock: bool = False,
    include_inactive_variants: bool = False,
    apply: bool = False,
) -> dict[str, Any]:
    """Compute an optimal retailer assignment across shopping items."""
    clean_mode = "lowest_cost" if mode == "lowest_cost" else "fewest_orders"
    all_items = list_shopping_items(db_path)
    retailers_list = list_retailers(db_path)
    retailer_meta = {r["domain"]: r for r in retailers_list}

    # Filter items by requested scope
    items = all_items
    if not include_inactive_variants and not item_ids:
        items = [it for it in items if not it.get("in_inactive_variant")]
    if item_ids:
        wanted = set(item_ids)
        items = [it for it in items if it["id"] in wanted]
    if project_id:
        items = [
            it for it in items
            if any(lk.get("project_id") == project_id for lk in (it.get("project_links") or []))
        ]
    if tag and tag.strip() and tag.strip().lower() != "all":
        t_low = tag.strip().lower()
        def _matches_tag(it: dict[str, Any]) -> bool:
            item_tag = (it.get("tag") or "").strip().lower()
            links = it.get("project_links") or []
            if t_low == "general" and not item_tag and not links:
                return True
            if item_tag == t_low:
                return True
            return any((lk.get("project_name") or "").strip().lower() == t_low for lk in links)
        items = [it for it in items if _matches_tag(it)]

    assignable: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    unassigned_items: list[dict[str, Any]] = []
    current_assignments: list[tuple[dict[str, Any], dict[str, Any]]] = []

    for it in items:
        offers = it.get("offers") or []
        if not offers:
            unassigned_items.append({"item_id": it["id"], "name": it["name"], "quantity": it["quantity"]})
            continue
        selected = next((o for o in offers if o.get("is_selected")), offers[0])
        current_assignments.append((it, selected))

        if include_out_of_stock:
            candidates = list(offers)
        else:
            in_stock_candidates = [o for o in offers if o.get("in_stock") != "out_of_stock"]
            candidates = in_stock_candidates if in_stock_candidates else list(offers)
        assignable.append((it, candidates))

    def _offer_store(offer: dict[str, Any]) -> str:
        return _normalize_domain(offer.get("retailer") or offer.get("url") or "") or (offer.get("retailer") or "Unknown")

    def _offer_cost(item: dict[str, Any], offer: dict[str, Any]) -> float:
        p, _ = parse_price(offer.get("price", ""))
        if p is None:
            return 1e9
        return round(p * max(1, int(item.get("quantity") or 1)), 2)

    def _evaluate_subset(
        stores: set[str],
    ) -> tuple[int, float, int, list[tuple[dict[str, Any], dict[str, Any]]]] | None:
        chosen: list[tuple[dict[str, Any], dict[str, Any]]] = []
        subtotals: dict[str, float] = {}
        store_all_priced: dict[str, bool] = {}
        unpriced_penalty = 0
        for item, cands in assignable:
            matching = [o for o in cands if _offer_store(o) in stores]
            if not matching:
                return None
            # Prefer in_stock, then lowest price (priced beats unpriced), then currently selected
            best = min(
                matching,
                key=lambda o: (
                    1 if o.get("in_stock") == "out_of_stock" else 0,
                    _offer_cost(item, o),
                    0 if o.get("is_selected") else 1,
                ),
            )
            chosen.append((item, best))
            st = _offer_store(best)
            p, _ = parse_price(best.get("price", ""))
            if p is not None:
                subtotals[st] = subtotals.get(st, 0.0) + p * max(1, int(item.get("quantity") or 1))
                store_all_priced.setdefault(st, True)
            else:
                unpriced_penalty += 1
                store_all_priced[st] = False

        used_stores = {_offer_store(o) for _, o in chosen}
        total_cost = sum(subtotals.values())
        for st in used_stores:
            meta = retailer_meta.get(st, {})
            sc = meta.get("shipping_cost")
            ft = meta.get("free_shipping_threshold")
            if sc is not None:
                if ft is None or not store_all_priced.get(st, False) or subtotals.get(st, 0.0) < float(ft):
                    total_cost += float(sc)
        return (unpriced_penalty, round(total_cost, 2), len(used_stores), chosen)

    all_stores = sorted({_offer_store(o) for _, cands in assignable for o in cands})
    best_assignments: list[tuple[dict[str, Any], dict[str, Any]]] = list(current_assignments)

    if assignable and all_stores:
        if len(all_stores) <= 12:
            best_score: tuple[Any, ...] | None = None
            for k in range(1, len(all_stores) + 1):
                found_at_k = False
                for combo in itertools.combinations(all_stores, k):
                    res = _evaluate_subset(set(combo))
                    if res is None:
                        continue
                    found_at_k = True
                    unpriced, cost, n_stores, chosen = res
                    changes = sum(1 for _, o in chosen if not o.get("is_selected"))
                    score = (
                        (n_stores, unpriced, cost, changes)
                        if clean_mode == "fewest_orders"
                        else (unpriced, cost, n_stores, changes)
                    )
                    if best_score is None or score < best_score:
                        best_score = score
                        best_assignments = chosen
                if clean_mode == "fewest_orders" and found_at_k:
                    break
        else:
            # Greedy set cover fallback for large retailer counts
            remaining = list(range(len(assignable)))
            picked_stores: set[str] = set()
            while remaining:
                best_store = max(
                    all_stores,
                    key=lambda st: sum(
                        1 for idx in remaining if any(_offer_store(o) == st for o in assignable[idx][1])
                    ),
                )
                picked_stores.add(best_store)
                remaining = [
                    idx for idx in remaining
                    if not any(_offer_store(o) == best_store for o in assignable[idx][1])
                ]
            res = _evaluate_subset(picked_stores)
            if clean_mode == "lowest_cost":
                cheapest_stores = {
                    _offer_store(
                        min(
                            cands,
                            key=lambda o: (
                                1 if o.get("in_stock") == "out_of_stock" else 0,
                                _offer_cost(it, o),
                                0 if o.get("is_selected") else 1,
                            ),
                        )
                    )
                    for it, cands in assignable
                }
                res_cheap = _evaluate_subset(cheapest_stores)
                if res_cheap is not None and (res is None or (res_cheap[0], res_cheap[1]) < (res[0], res[1])):
                    res = res_cheap
            if res is not None:
                best_assignments = res[3]

    current_summary = _build_cart_plan_summary(current_assignments, retailer_meta)
    recommended_summary = _build_cart_plan_summary(best_assignments, retailer_meta)

    changes_list: list[dict[str, Any]] = []
    current_by_item = {it["id"]: off for it, off in current_assignments}
    for it, off in best_assignments:
        cur = current_by_item.get(it["id"])
        if cur and cur["id"] != off["id"]:
            changes_list.append(
                {
                    "item_id": it["id"],
                    "name": it["name"],
                    "from_offer_id": cur["id"],
                    "from_retailer": _offer_store(cur),
                    "from_price": cur.get("price", ""),
                    "to_offer_id": off["id"],
                    "to_retailer": _offer_store(off),
                    "to_price": off.get("price", ""),
                }
            )

    # Straggler detection: stores with 1-2 items when another store has strictly more items
    stragglers: list[dict[str, Any]] = []
    rec_carts = recommended_summary["carts"]
    if len(rec_carts) >= 2:
        primary_store = rec_carts[0]["retailer"]
        primary_count = rec_carts[0]["item_count"]
        for c in rec_carts[1:]:
            if c["item_count"] <= 2 and c["item_count"] < primary_count:
                stragglers.append(
                    {
                        "retailer": c["retailer"],
                        "item_count": c["item_count"],
                        "primary_retailer": primary_store,
                        "items": [{"item_id": x["item_id"], "name": x["name"]} for x in c["items"]],
                        "suggestion": (
                            f"Only {c['item_count']} {'item' if c['item_count'] == 1 else 'items'} on {c['retailer']} — "
                            f"check if available on {primary_store} to eliminate an extra order."
                        ),
                    }
                )

    applied = False
    if apply and changes_list:
        with db_lock:
            with get_connection(db_path) as conn:
                for ch in changes_list:
                    conn.execute(
                        "UPDATE shopping_item_offers SET is_selected = 0 WHERE shopping_item_id = ?",
                        (ch["item_id"],),
                    )
                    conn.execute(
                        "UPDATE shopping_item_offers SET is_selected = 1, updated_at = ? WHERE id = ? AND shopping_item_id = ?",
                        (utc_now_iso(), ch["to_offer_id"], ch["item_id"]),
                    )
                    _sync_shopping_item_from_selected_offer(conn, ch["item_id"])
        applied = True

    return {
        "mode": clean_mode,
        "applied": applied,
        "changes_count": len(changes_list),
        "changes": changes_list,
        "current": current_summary,
        "recommended": recommended_summary,
        "stragglers": stragglers,
        "unassigned_items": unassigned_items,
    }


# =============================================================================
# MCP runtime settings, activity log, storage stats, and wipe
# =============================================================================


def get_mcp_runtime_settings(settings: Settings) -> dict[str, Any]:
    defaults: dict[str, Any] = {
        "access": "ro" if settings.mcp_read_only else "rw",
        "can_parts": True,
        "can_projects": True,
        "can_shopping": True,
        "can_delete": False,
        "token": settings.mcp_api_token or "",
        "last_request_at": "",
        "env_read_only": settings.mcp_read_only,
    }
    key_map = {
        "mcp_access": "access",
        "mcp_can_parts": "can_parts",
        "mcp_can_projects": "can_projects",
        "mcp_can_shopping": "can_shopping",
        "mcp_can_delete": "can_delete",
        "mcp_api_token": "token",
        "mcp_last_request_at": "last_request_at",
    }
    with db_lock:
        with get_connection(settings.db_path) as conn:
            rows = conn.execute(
                "SELECT key, value FROM settings WHERE key LIKE 'mcp_%'"
            ).fetchall()
            for r in rows:
                dest = key_map.get(r["key"])
                if not dest:
                    continue
                try:
                    val = json.loads(r["value"])
                except Exception:
                    val = r["value"]
                if dest == "token" and not val:
                    continue
                defaults[dest] = val

            week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
            weekly_count = conn.execute(
                "SELECT COUNT(*) AS c FROM mcp_activity WHERE created_at >= ?",
                (week_ago,),
            ).fetchone()["c"]
            defaults["weekly_requests"] = int(weekly_count)

    # Hard ceiling: MCP_READ_ONLY=true in server environment can never be overridden by SQLite
    if settings.mcp_read_only:
        defaults["access"] = "ro"
    return defaults


def update_mcp_runtime_settings(settings: Settings, updates: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    if "access" in updates and updates["access"] in ("rw", "ro"):
        if settings.mcp_read_only and updates["access"] == "rw":
            raise ValueError("MCP_READ_ONLY=true in server environment locks the assistant to read-only mode.")
        clean["mcp_access"] = updates["access"]
    for field, db_key in (
        ("can_parts", "mcp_can_parts"),
        ("can_projects", "mcp_can_projects"),
        ("can_shopping", "mcp_can_shopping"),
        ("can_delete", "mcp_can_delete"),
    ):
        if field in updates and isinstance(updates[field], bool):
            clean[db_key] = updates[field]
    if clean:
        with db_lock:
            with get_connection(settings.db_path) as conn:
                for k, v in clean.items():
                    conn.execute(
                        "INSERT INTO settings (key, value) VALUES (?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (k, json.dumps(v)),
                    )
    return get_mcp_runtime_settings(settings)


def rotate_mcp_token(settings: Settings) -> dict[str, Any]:
    new_token = f"pb_{secrets.token_hex(16)}"
    with db_lock:
        with get_connection(settings.db_path) as conn:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('mcp_api_token', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (json.dumps(new_token),),
            )
    return get_mcp_runtime_settings(settings)


def record_mcp_request(db_path: Path, tool_name: str = "", scope: str = "", summary: str = "") -> None:
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('mcp_last_request_at', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (json.dumps(now),),
            )
            if tool_name and summary:
                conn.execute(
                    "INSERT INTO mcp_activity (id, tool_name, scope, summary, created_at) VALUES (?, ?, ?, ?, ?)",
                    (uuid.uuid4().hex, tool_name[:60], (scope or "Inventory")[:80], summary[:300], now),
                )
                # Keep the newest 100 entries
                conn.execute(
                    "DELETE FROM mcp_activity WHERE id NOT IN "
                    "(SELECT id FROM mcp_activity ORDER BY created_at DESC, rowid DESC LIMIT 100)"
                )


def list_mcp_activity(db_path: Path, limit: int = 25) -> list[dict[str, Any]]:
    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute(
                "SELECT id, tool_name, scope, summary, created_at FROM mcp_activity "
                "ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (max(1, min(100, int(limit))),),
            ).fetchall()
            return [dict(r) for r in rows]


GUEST_COOKIE_NAME = "pinbin_guest"
_guest_pass_cache: dict[str, dict[str, Any]] = {}


def invalidate_guest_pass_cache(db_path: Path | None = None) -> None:
    if db_path is None:
        _guest_pass_cache.clear()
    else:
        _guest_pass_cache.pop(str(db_path.resolve()), None)


def _guest_session_digest(token: str) -> str:
    return hmac.new(token.encode("utf-8"), b"pinbin-guest-session-v1", hashlib.sha256).hexdigest()


def get_guest_pass_settings(db_path: Path) -> dict[str, Any]:
    cache_key = str(db_path.resolve())
    cached = _guest_pass_cache.get(cache_key)
    if cached is not None:
        return dict(cached)
    out: dict[str, Any] = {
        "enabled": False,
        "token": "",
        "created_at": "",
        "last_used_at": "",
    }
    key_map = {
        "guest_pass_enabled": "enabled",
        "guest_pass_token": "token",
        "guest_pass_created_at": "created_at",
        "guest_pass_last_used_at": "last_used_at",
    }
    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute(
                "SELECT key, value FROM settings WHERE key LIKE 'guest_pass_%'"
            ).fetchall()
            for r in rows:
                dest = key_map.get(r["key"])
                if not dest:
                    continue
                try:
                    val = json.loads(r["value"])
                except Exception:
                    val = r["value"]
                out[dest] = val
    out["enabled"] = bool(out.get("enabled"))
    out["token"] = str(out.get("token") or "")
    out["created_at"] = str(out.get("created_at") or "")
    out["last_used_at"] = str(out.get("last_used_at") or "")
    out["path"] = f"/guest/pass/{out['token']}" if out["token"] else ""
    _guest_pass_cache[cache_key] = dict(out)
    return out


def update_guest_pass_settings(db_path: Path, enabled: bool) -> dict[str, Any]:
    now = utc_now_iso()
    with db_lock:
        current = get_guest_pass_settings(db_path)
        updates: dict[str, Any] = {"guest_pass_enabled": bool(enabled)}
        if enabled and not current["token"]:
            updates["guest_pass_token"] = f"pb_guest_{secrets.token_hex(16)}"
            updates["guest_pass_created_at"] = now
            updates["guest_pass_last_used_at"] = ""
        with get_connection(db_path) as conn:
            for k, v in updates.items():
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (k, json.dumps(v)),
                )
        invalidate_guest_pass_cache(db_path)
    return get_guest_pass_settings(db_path)


def rotate_guest_pass_token(db_path: Path) -> dict[str, Any]:
    new_token = f"pb_guest_{secrets.token_hex(16)}"
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            for k, v in (
                ("guest_pass_token", new_token),
                ("guest_pass_created_at", now),
                ("guest_pass_last_used_at", ""),
            ):
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (k, json.dumps(v)),
                )
        invalidate_guest_pass_cache(db_path)
    return get_guest_pass_settings(db_path)


def verify_guest_pass_token(db_path: Path, candidate: str) -> bool:
    cand = (candidate or "").strip()
    if not cand:
        return False
    cfg = get_guest_pass_settings(db_path)
    if not cfg["enabled"] or not cfg["token"]:
        return False
    return hmac.compare_digest(cfg["token"], cand)


def issue_guest_session_cookie_value(db_path: Path) -> str | None:
    cfg = get_guest_pass_settings(db_path)
    if not cfg["enabled"] or not cfg["token"]:
        return None
    return _guest_session_digest(cfg["token"])


def verify_guest_session_cookie(db_path: Path, cookie_val: str) -> bool:
    val = (cookie_val or "").strip()
    if not val:
        return False
    cfg = get_guest_pass_settings(db_path)
    if not cfg["enabled"] or not cfg["token"]:
        return False
    expected = _guest_session_digest(cfg["token"])
    return hmac.compare_digest(expected, val)


def record_guest_pass_use(db_path: Path) -> None:
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('guest_pass_last_used_at', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (json.dumps(now),),
            )
        invalidate_guest_pass_cache(db_path)


def record_backup_timestamp(db_path: Path) -> str:
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('last_backup_at', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (json.dumps(now),),
            )
    return now


def get_storage_stats(settings: Settings) -> dict[str, Any]:
    with db_lock:
        with get_connection(settings.db_path) as conn:
            parts_n = conn.execute("SELECT COUNT(*) FROM parts").fetchone()[0]
            projs_n = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
            shop_n = conn.execute("SELECT COUNT(*) FROM shopping_items").fetchone()[0]
            gloss_n = conn.execute("SELECT COUNT(*) FROM glossary").fetchone()[0]
    img_count, img_bytes = compute_images_stats(settings.images_dir)
    return {
        "parts_count": int(parts_n),
        "projects_count": int(projs_n),
        "shopping_count": int(shop_n),
        "glossary_count": int(gloss_n),
        "images_count": img_count,
        "images_bytes": img_bytes,
    }


def wipe_all_data(settings: Settings) -> dict[str, Any]:
    """Delete all parts, projects, shopping items, retailers, activity logs, and local images."""
    removed_images = 0
    with db_lock:
        with get_connection(settings.db_path) as conn:
            conn.execute("DELETE FROM project_checks")
            conn.execute("DELETE FROM project_nets")
            conn.execute("DELETE FROM project_items")
            conn.execute("DELETE FROM project_variants")
            conn.execute("DELETE FROM projects")
            conn.execute("DELETE FROM shopping_item_offers")
            conn.execute("DELETE FROM shopping_items")
            conn.execute("DELETE FROM retailers")
            conn.execute("DELETE FROM parts")
            conn.execute("DELETE FROM mcp_activity")
        if settings.images_dir.is_dir():
            for entry in list(settings.images_dir.iterdir()):
                if entry.is_file() and not entry.is_symlink() and is_valid_image_filename(entry.name):
                    safe_delete_image(entry.name, settings.images_dir)
                    removed_images += 1
        invalidate_guest_pass_cache(settings.db_path)
    return {"status": "ok", "removed_images": removed_images}
