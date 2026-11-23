from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

DEFAULT_UI_SETTINGS: dict[str, Any] = {
    "theme": "dark",
    "view_mode": "grid",
    "sort_by": "recent",
    "inline_tooltips": True,
    "show_caution_badge": False,
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
            _seed_glossary_if_empty(conn)


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


def teardown_project(db_path: Path, project_name: str) -> int:
    """Clear in_use_project for all parts assigned to the given project."""
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
            return cur.rowcount


def list_shopping_items(db_path: Path) -> list[dict[str, Any]]:
    with db_lock:
        with get_connection(db_path) as conn:
            rows = conn.execute("SELECT * FROM shopping_items ORDER BY created_at DESC, rowid DESC").fetchall()
            return [dict(r) for r in rows]


def create_shopping_item(db_path: Path, data: dict[str, Any]) -> dict[str, Any]:
    item_id = str(data.get("id") or uuid.uuid4().hex).strip()
    now = utc_now_iso()
    qty = max(1, int(data.get("quantity", 1) or 1))
    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO shopping_items (id, name, url, price, quantity, notes, image_path, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    str(data.get("name", "")).strip(),
                    str(data.get("url", "") or "").strip(),
                    str(data.get("price", "") or "").strip()[:40],
                    qty,
                    str(data.get("notes", "") or "").strip(),
                    str(data.get("image_path", "") or "").strip(),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            return dict(row)


def update_shopping_item(db_path: Path, item_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"name", "url", "price", "quantity", "notes", "image_path"}
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
        else:
            filtered[k] = str(v or "").strip()

    with db_lock:
        with get_connection(db_path) as conn:
            existing = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            if not existing:
                return None
            if not filtered:
                return dict(existing)
            filtered["updated_at"] = utc_now_iso()
            set_clause = ", ".join(f"{k} = ?" for k in filtered.keys())
            conn.execute(
                f"UPDATE shopping_items SET {set_clause} WHERE id = ?",
                list(filtered.values()) + [item_id],
            )
            row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
            return dict(row)


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
            item = dict(row)
            part_id = uuid.uuid4().hex
            now = utc_now_iso()
            conn.execute(
                """
                INSERT INTO parts (
                    id, name, subtitle, category, quantity, low_stock_threshold,
                    location, in_use_project, what_it_does, visual_tell, warning,
                    notes, source_url, image_path, pinout_image_path, pinout_url,
                    specs, created_at, updated_at
                ) VALUES (?, ?, '', 'Sensors', ?, NULL, '', '', '', '', '', ?, ?, ?, '', '', '{}', ?, ?)
                """,
                (
                    part_id,
                    item["name"],
                    max(1, int(item.get("quantity") or 1)),
                    item.get("notes") or "",
                    item.get("url") or "",
                    item.get("image_path") or "",
                    now,
                    now,
                ),
            )
            conn.execute("DELETE FROM shopping_items WHERE id = ?", (item_id,))
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
