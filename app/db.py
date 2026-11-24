from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

from app.config import CATEGORIES, Settings
from app.glossary_seed import GLOSSARY_CATEGORIES, GLOSSARY_SEED

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
    specs TEXT DEFAULT '{}',
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
    in_stock TEXT DEFAULT '',
    why_needed TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
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
    quantity_needed INTEGER NOT NULL DEFAULT 1,
    project_notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

PROJECT_STATUSES = ("planning", "active", "completed", "archived")

DEFAULT_UI_SETTINGS: dict[str, Any] = {
    "theme": "dark",
    "view_mode": "grid",
    "sort_by": "recent",
    "inline_tooltips": True,
    "show_caution_badge": False,
    "logo_color": "#00e676",
}

# Logo tile colours offered in Settings. The logo itself is drawn in black or
# white, whichever reads better on the chosen colour (see static/brand.js).
ALLOWED_LOGO_COLORS = {
    "#00e676", "#ffcc00", "#111111", "#ffffff", "#c0392b",
    "#6c3cff", "#2962ff", "#ff2d55", "#ff3b30", "#ff69b4",
}

ALLOWED_SORT_VALUES = {"recent", "name", "location", "qty_asc", "qty_desc", "needs_photo"}

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
    "specs",
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
        conn.execute("PRAGMA journal_mode=WAL;")
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
            conn.executescript(SCHEMA_SQL)
            # Safe migration for existing databases lacking the specs column
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(parts)").fetchall()}
            if "specs" not in cols:
                conn.execute("ALTER TABLE parts ADD COLUMN specs TEXT DEFAULT '{}'")

            # Safe migration for enhanced shopping_items columns
            shop_cols = {row["name"] for row in conn.execute("PRAGMA table_info(shopping_items)").fetchall()}
            shop_migrations = [
                ("retailer", "TEXT DEFAULT ''"),
                ("tag", "TEXT DEFAULT ''"),
                ("category", "TEXT DEFAULT ''"),
                ("specs", "TEXT DEFAULT '{}'"),
                ("in_stock", "TEXT DEFAULT ''"),
                ("why_needed", "TEXT DEFAULT ''"),
            ]
            for col_name, col_def in shop_migrations:
                if col_name not in shop_cols:
                    conn.execute(f"ALTER TABLE shopping_items ADD COLUMN {col_name} {col_def}")

            _migrate_legacy_in_use_projects(conn)
            _seed_glossary_if_empty(conn)


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
    """Insert any missing starter glossary terms without overwriting user edits."""
    now = utc_now_iso()
    for item in GLOSSARY_SEED:
        conn.execute(
            """
            INSERT OR IGNORE INTO glossary (
                id, term, category, summary, rule_of_thumb, keywords, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item["id"],
                item["term"],
                item["category"],
                item["summary"],
                item["rule_of_thumb"],
                item["keywords"],
                now,
                now,
            ),
        )


def upsert_suggested_glossary_terms(
    db_path: Path, suggestions: list[dict[str, str]]
) -> list[dict[str, Any]]:
    """Automatically add AI-suggested glossary terms that do not already exist."""
    if not suggestions:
        return []
    added: list[dict[str, Any]] = []
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            existing_rows = conn.execute("SELECT LOWER(TRIM(term)) AS t FROM glossary").fetchall()
            existing_terms = {r["t"] for r in existing_rows}

            for item in suggestions[:3]:
                term = str(item.get("term") or "").strip()
                summary = str(item.get("summary") or "").strip()
                if not term or not summary:
                    continue
                base_norm = term.lower().split("(")[0].strip()
                if term.lower() in existing_terms or any(
                    et.split("(")[0].strip() == base_norm for et in existing_terms
                ):
                    continue

                cat = str(item.get("category") or "Circuit Basics").strip()
                if cat not in GLOSSARY_CATEGORIES:
                    cat = "Circuit Basics"

                term_id = uuid.uuid4().hex
                conn.execute(
                    """
                    INSERT INTO glossary (
                        id, term, category, summary, rule_of_thumb, keywords, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        term_id,
                        term[:120],
                        cat,
                        summary[:500],
                        str(item.get("rule_of_thumb") or "").strip()[:400],
                        str(item.get("keywords") or term.lower()).strip()[:300],
                        now,
                        now,
                    ),
                )
                row = conn.execute("SELECT * FROM glossary WHERE id = ?", (term_id,)).fetchone()
                if row:
                    added.append(dict(row))
                    existing_terms.add(term.lower())
    return added


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


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    if "specs" in d:
        d["specs"] = _normalize_specs(d["specs"])
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

    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO parts (
                    id, name, subtitle, category, quantity, low_stock_threshold,
                    location, in_use_project, what_it_does, visual_tell, warning,
                    notes, source_url, image_path, pinout_image_path, pinout_url,
                    specs, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    str(data.get("warning", "") or "").strip(),
                    str(data.get("notes", "") or "").strip(),
                    str(data.get("source_url", "") or "").strip(),
                    str(data.get("image_path", "") or "").strip(),
                    str(data.get("pinout_image_path", "") or "").strip(),
                    str(data.get("pinout_url", "") or "").strip(),
                    specs_json,
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
        else:
            filtered[key] = str(val or "").strip()

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


def delete_part(db_path: Path, part_id: str) -> dict[str, Any] | None:
    with db_lock:
        with get_connection(db_path) as conn:
            row = conn.execute("SELECT * FROM parts WHERE id = ?", (part_id,)).fetchone()
            if not row:
                return None
            part = _row_to_dict(row)
            conn.execute("DELETE FROM parts WHERE id = ?", (part_id,))
            return part


def get_ai_usage_today(db_path: Path) -> int:
    today = utc_today_str()
    with db_lock:
        with get_connection(db_path) as conn:
            row = conn.execute(
                "SELECT count FROM ai_usage WHERE usage_date = ?", (today,)
            ).fetchone()
            return int(row["count"]) if row else 0


def consume_ai_quota(db_path: Path, daily_limit: int) -> tuple[bool, int]:
    """Atomically check and increment today's AI usage count. Returns (allowed, remaining)."""
    if daily_limit <= 0:
        return False, 0

    today = utc_today_str()
    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO ai_usage (usage_date, count) VALUES (?, 0)",
                (today,),
            )
            row = conn.execute(
                "SELECT count FROM ai_usage WHERE usage_date = ?", (today,)
            ).fetchone()
            current = int(row["count"]) if row else 0
            if current >= daily_limit:
                return False, 0
            new_count = current + 1
            conn.execute(
                "UPDATE ai_usage SET count = ? WHERE usage_date = ?",
                (new_count, today),
            )
            return True, max(0, daily_limit - new_count)


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
        if k == "theme" and v in ("dark", "light"):
            clean[k] = v
        elif k == "view_mode" and v in ("grid", "list"):
            clean[k] = v
        elif k == "sort_by" and v in ALLOWED_SORT_VALUES:
            clean[k] = v
        elif k in ("inline_tooltips", "show_caution_badge") and isinstance(v, bool):
            clean[k] = v
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
            return [dict(r) for r in rows]


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
                INSERT INTO glossary (id, term, category, summary, rule_of_thumb, keywords, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    term_id,
                    str(data.get("term", "")).strip(),
                    cat,
                    str(data.get("summary", "") or "").strip(),
                    str(data.get("rule_of_thumb", "") or "").strip(),
                    str(data.get("keywords", "") or "").strip(),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM glossary WHERE id = ?", (term_id,)).fetchone()
            return dict(row)


def update_glossary_term(db_path: Path, term_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"term", "category", "summary", "rule_of_thumb", "keywords"}
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
        else:
            filtered[k] = str(v or "").strip()

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute("SELECT * FROM glossary WHERE id = ?", (term_id,)).fetchone()
            if not existing:
                return None
            if not filtered:
                return dict(existing)
            filtered["updated_at"] = utc_now_iso()
            set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
            conn.execute(
                f"UPDATE glossary SET {set_clause} WHERE id = ?",
                list(filtered.values()) + [term_id],
            )
            row = conn.execute("SELECT * FROM glossary WHERE id = ?", (term_id,)).fetchone()
            return dict(row)


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


def _parse_price_amount(price_str: str) -> tuple[float | None, str]:
    """Parse a human-formatted price string like '232.36 TL' or '1,107.25 TL + KDV'."""
    raw = str(price_str or "").strip()
    if not raw:
        return None, ""
    m = re.search(r"([0-9][0-9.,]*)", raw)
    if not m:
        return None, ""
    num_s = m.group(1)
    # Handle European/Turkish format like 1.107,25 vs US 1,107.25
    if "," in num_s and "." in num_s:
        if num_s.rfind(",") > num_s.rfind("."):
            num_s = num_s.replace(".", "").replace(",", ".")
        else:
            num_s = num_s.replace(",", "")
    elif "," in num_s:
        parts_comma = num_s.split(",")
        if len(parts_comma[-1]) == 2:
            num_s = num_s.replace(",", ".")
        else:
            num_s = num_s.replace(",", "")
    try:
        val = float(num_s)
    except ValueError:
        return None, ""
    up = raw.upper()
    if "TL" in up or "TRY" in up or "₺" in raw:
        cur = "TL"
    elif "USD" in up or "$" in raw:
        cur = "USD"
    elif "EUR" in up or "€" in raw:
        cur = "EUR"
    else:
        cur = ""
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

    # Find selected variant (if any)
    sel_var = conn.execute(
        "SELECT id FROM project_variants WHERE project_id = ? AND is_selected = 1 LIMIT 1",
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
    proj = dict(proj_row)
    pid = proj["id"]

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
            item["why_needed"] = ""
            item["specs"] = p.get("specs") or {}
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
            item["price"] = s.get("price") or ""
            item["retailer"] = s.get("retailer") or _extract_retailer(s.get("url") or "")
            item["url"] = s.get("url") or ""
            item["in_stock"] = s.get("in_stock") or ""
            item["why_needed"] = s.get("why_needed") or s.get("notes") or ""
            item["specs"] = s.get("specs") or {}
        else:
            continue
        items.append(item)

    # Compute readiness for Core + selected variant (or all items if no variants)
    active_items = [
        it
        for it in items
        if it.get("variant_id") is None or (selected_variant_id and it.get("variant_id") == selected_variant_id)
    ]
    owned_count = sum(1 for it in active_items if it["item_type"] == "part" and it["owned_quantity"] > 0)
    to_buy_count = sum(1 for it in active_items if it["item_type"] == "shopping")
    cost_totals: dict[str, float] = {}
    for it in active_items:
        if it["item_type"] == "shopping":
            val, cur = _parse_price_amount(it.get("price") or "")
            if val is not None:
                key = cur or "TL"
                cost_totals[key] = round(cost_totals.get(key, 0.0) + val * max(1, int(it.get("quantity_needed") or 1)), 2)

    proj["variants"] = variants
    proj["selected_variant_id"] = selected_variant_id
    proj["items"] = items
    proj["readiness"] = {
        "owned_count": owned_count,
        "to_buy_count": to_buy_count,
        "total_count": len(active_items),
        "remaining_cost": cost_totals,
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


def get_project(db_path: Path, project_id: str) -> dict[str, Any] | None:
    with db_lock:
        with get_connection(db_path) as conn:
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            return _hydrate_project(conn, row) if row else None


def create_project(db_path: Path, data: dict[str, Any]) -> dict[str, Any]:
    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError("Project name cannot be empty")
    status = str(data.get("status") or "planning").strip().lower()
    if status not in PROJECT_STATUSES:
        status = "planning"
    proj_id = str(data.get("id") or uuid.uuid4().hex).strip()
    now = utc_now_iso()
    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO projects (id, name, description, status, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    proj_id,
                    name[:160],
                    str(data.get("description") or "").strip(),
                    status,
                    str(data.get("notes") or "").strip(),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (proj_id,)).fetchone()
            return _hydrate_project(conn, row)


def update_project(db_path: Path, project_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"name", "description", "status", "notes"}
    filtered: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "name":
            nv = str(v or "").strip()
            if not nv:
                raise ValueError("Project name cannot be empty")
            filtered[k] = nv[:160]
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
                INSERT INTO project_variants (id, project_id, name, description, is_selected, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    var_id,
                    project_id,
                    name[:120],
                    str(data.get("description") or "").strip(),
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
    allowed = {"name", "description", "is_selected", "sort_order"}
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


def add_project_item(db_path: Path, project_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    part_id = str(data.get("part_id") or "").strip() or None
    shop_id = str(data.get("shopping_item_id") or "").strip() or None
    if bool(part_id) == bool(shop_id):
        raise ValueError("Provide exactly one of part_id or shopping_item_id")
    variant_id = str(data.get("variant_id") or "").strip() or None
    qty = max(1, int(data.get("quantity_needed", 1) or 1))
    notes = str(data.get("project_notes") or "").strip()
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
                p_ok = conn.execute("SELECT id FROM parts WHERE id = ?", (part_id,)).fetchone()
                if not p_ok:
                    raise ValueError(f"Part not found: {part_id}")
                dup = conn.execute(
                    "SELECT id FROM project_items WHERE project_id = ? AND part_id = ? AND COALESCE(variant_id, '') = ?",
                    (project_id, part_id, variant_id or ""),
                ).fetchone()
                if dup:
                    conn.execute(
                        "UPDATE project_items SET quantity_needed = ?, project_notes = ?, updated_at = ? WHERE id = ?",
                        (qty, notes, now, dup["id"]),
                    )
                    item_id = dup["id"]
                else:
                    item_id = uuid.uuid4().hex
                    conn.execute(
                        """
                        INSERT INTO project_items (
                            id, project_id, variant_id, part_id, shopping_item_id,
                            quantity_needed, project_notes, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
                        """,
                        (item_id, project_id, variant_id, part_id, qty, notes, now, now),
                    )
            else:
                s_ok = conn.execute("SELECT id FROM shopping_items WHERE id = ?", (shop_id,)).fetchone()
                if not s_ok:
                    raise ValueError(f"Shopping item not found: {shop_id}")
                dup = conn.execute(
                    "SELECT id FROM project_items WHERE project_id = ? AND shopping_item_id = ? AND COALESCE(variant_id, '') = ?",
                    (project_id, shop_id, variant_id or ""),
                ).fetchone()
                if dup:
                    conn.execute(
                        "UPDATE project_items SET quantity_needed = ?, project_notes = ?, updated_at = ? WHERE id = ?",
                        (qty, notes, now, dup["id"]),
                    )
                    item_id = dup["id"]
                else:
                    item_id = uuid.uuid4().hex
                    conn.execute(
                        """
                        INSERT INTO project_items (
                            id, project_id, variant_id, part_id, shopping_item_id,
                            quantity_needed, project_notes, created_at, updated_at
                        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
                        """,
                        (item_id, project_id, variant_id, shop_id, qty, notes, now, now),
                    )
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
            _sync_project_in_use_flags(conn, project_id)
            row = conn.execute("SELECT * FROM project_items WHERE id = ?", (item_id,)).fetchone()
            return dict(row)


def update_project_item(
    db_path: Path, project_id: str, item_id: str, updates: dict[str, Any]
) -> dict[str, Any] | None:
    allowed = {"variant_id", "quantity_needed", "project_notes"}
    filtered: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "quantity_needed":
            filtered[k] = max(1, int(v))
        elif k == "variant_id":
            filtered[k] = str(v or "").strip() or None
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


def _hydrate_shopping_item(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    item = _row_to_dict(row)
    if not item.get("retailer") and item.get("url"):
        item["retailer"] = _extract_retailer(item["url"])
    links = conn.execute(
        """
        SELECT pi.id AS project_item_id, pi.project_id, p.name AS project_name,
               pi.variant_id, pv.name AS variant_name, pi.project_notes
        FROM project_items pi
        JOIN projects p ON p.id = pi.project_id
        LEFT JOIN project_variants pv ON pv.id = pi.variant_id
        WHERE pi.shopping_item_id = ?
        """,
        (item["id"],),
    ).fetchall()
    item["project_links"] = [dict(lk) for lk in links]
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
    url = str(data.get("url", "") or "").strip()
    retailer = str(data.get("retailer", "") or "").strip() or _extract_retailer(url)
    cat = str(data.get("category", "") or "").strip()
    if cat and cat not in CATEGORIES:
        cat = ""
    specs_json = json.dumps(_normalize_specs(data.get("specs")))
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
                    retailer, tag, category, specs, in_stock, why_needed,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    in_stock,
                    why_needed,
                    now,
                    now,
                ),
            )
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
        elif k == "in_stock":
            sv = str(v or "").strip().lower()
            filtered[k] = sv if sv in ("in_stock", "out_of_stock", "") else ""
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
                    specs, created_at, updated_at
                ) VALUES (?, ?, '', ?, ?, NULL, '', '', '', '', '', ?, ?, ?, '', '', ?, ?, ?)
                """,
                (
                    part_id,
                    item["name"],
                    cat,
                    max(1, int(item.get("quantity") or 1)),
                    item.get("notes") or "",
                    item.get("url") or "",
                    item.get("image_path") or "",
                    specs_json,
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
                existing = conn.execute("SELECT id FROM parts WHERE id = ?", (part_id,)).fetchone()
                if existing:
                    conn.execute(
                        """
                        UPDATE parts SET
                            name=?, subtitle=?, category=?, quantity=?, low_stock_threshold=?,
                            location=?, in_use_project=?, what_it_does=?, visual_tell=?,
                            warning=?, notes=?, source_url=?, pinout_url=?, specs=?, updated_at=?
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
                            str(item.get("warning") or "").strip(),
                            str(item.get("notes") or "").strip(),
                            str(item.get("source_url") or "").strip(),
                            str(item.get("pinout_url") or "").strip(),
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
                            location, in_use_project, what_it_does, visual_tell, warning,
                            notes, source_url, image_path, pinout_image_path, pinout_url,
                            specs, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?)
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
                            str(item.get("warning") or "").strip(),
                            str(item.get("notes") or "").strip(),
                            str(item.get("source_url") or "").strip(),
                            str(item.get("pinout_url") or "").strip(),
                            specs_json,
                            now,
                            now,
                        ),
                    )
                count += 1
    return count
