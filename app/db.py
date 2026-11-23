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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
    usage_date TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
);
"""

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


def seed_if_empty(settings: Settings) -> int:
    if not settings.seed_file.exists():
        return 0

    with db_lock:
        with get_connection(settings.db_path) as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM parts").fetchone()
            if row and row["cnt"] > 0:
                return 0

            raw = json.loads(settings.seed_file.read_text(encoding="utf-8"))
            if not isinstance(raw, list):
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

                conn.execute(
                    """
                    INSERT OR IGNORE INTO parts (
                        id, name, subtitle, category, quantity, low_stock_threshold,
                        location, in_use_project, what_it_does, visual_tell, warning,
                        notes, source_url, image_path, pinout_image_path, pinout_url,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        now,
                        now,
                    ),
                )
                inserted += 1
            return inserted


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


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

    with db_lock:
        with get_connection(db_path) as conn:
            conn.execute(
                """
                INSERT INTO parts (
                    id, name, subtitle, category, quantity, low_stock_threshold,
                    location, in_use_project, what_it_does, visual_tell, warning,
                    notes, source_url, image_path, pinout_image_path, pinout_url,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
