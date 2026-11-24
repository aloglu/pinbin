from __future__ import annotations

import io
import os
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from app.config import Settings
from app.db import db_lock, init_db
from app.images import is_valid_image_filename

SQLITE_MAGIC = b"SQLite format 3\x00"
SYMLINK_MODE = 0o120000
FILE_TYPE_MASK = 0o170000


class BackupError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def create_backup_zip_bytes(settings: Settings) -> bytes:
    """Create a WAL-safe zip archive containing ONLY inventory.db and images/*.webp."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_db = Path(tmpdir) / "inventory.db"

        with db_lock:
            src_conn = sqlite3.connect(str(settings.db_path), timeout=10.0)
            dst_conn = sqlite3.connect(str(tmp_db))
            try:
                src_conn.backup(dst_conn)
            finally:
                dst_conn.close()
                src_conn.close()

            buf = io.BytesIO()
            with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.write(tmp_db, arcname="inventory.db")
                if settings.images_dir.is_dir():
                    for entry in sorted(settings.images_dir.iterdir()):
                        if entry.is_file() and not entry.is_symlink() and is_valid_image_filename(entry.name):
                            zf.write(entry, arcname=f"images/{entry.name}")

            return buf.getvalue()


def _validate_member(info: zipfile.ZipInfo) -> str | None:
    """Validate a zip member. Returns 'db', 'image', or None (ignorable dir). Raises BackupError if unsafe."""
    name = info.filename

    # Reject symlinks
    mode = (info.external_attr >> 16) & FILE_TYPE_MASK
    if mode == SYMLINK_MODE:
        raise BackupError(f"Symlink entries are forbidden in backup archive: {name}")

    # Reject backslashes, absolute paths, drive letters, traversal
    if "\\" in name or name.startswith("/") or ":" in name:
        raise BackupError(f"Unsafe path in backup archive: {name}")

    pure = PurePosixPath(name)
    if any(part in ("..", "") for part in pure.parts):
        raise BackupError(f"Path traversal detected in backup archive: {name}")

    if info.is_dir():
        if pure.parts in (("images",),):
            return None
        raise BackupError(f"Unexpected directory in backup archive: {name}")

    if pure.parts == ("inventory.db",):
        return "db"

    if len(pure.parts) == 2 and pure.parts[0] == "images" and is_valid_image_filename(pure.parts[1]):
        return "image"

    raise BackupError(f"Disallowed file in backup archive: {name}")


def _verify_sqlite_file(db_file: Path) -> int:
    with db_file.open("rb") as fh:
        header = fh.read(16)
    if header != SQLITE_MAGIC:
        raise BackupError("inventory.db is not a valid SQLite 3 database")

    try:
        conn = sqlite3.connect(str(db_file))
        try:
            check = conn.execute("PRAGMA quick_check;").fetchone()
            if not check or check[0] != "ok":
                raise BackupError("SQLite integrity check failed")
            table = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='parts'"
            ).fetchone()
            if not table:
                raise BackupError("Restored database is missing required 'parts' table")
            cnt_row = conn.execute("SELECT COUNT(*) FROM parts").fetchone()
            return int(cnt_row[0]) if cnt_row else 0
        finally:
            conn.close()
    except sqlite3.DatabaseError as exc:
        raise BackupError("inventory.db failed SQLite validation") from exc


def restore_backup_zip_bytes(raw_bytes: bytes, settings: Settings) -> dict[str, Any]:
    if not raw_bytes:
        raise BackupError("Backup file is empty")

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_bytes), mode="r")
    except zipfile.BadZipFile as exc:
        raise BackupError("Uploaded file is not a valid .zip archive") from exc

    with zf:
        infos = zf.infolist()
        if len(infos) > 5000:
            raise BackupError("Backup archive contains too many entries")

        has_db = False
        image_infos: list[zipfile.ZipInfo] = []

        for info in infos:
            kind = _validate_member(info)
            if kind == "db":
                has_db = True
            elif kind == "image":
                image_infos.append(info)

        if not has_db:
            raise BackupError("Backup archive is missing inventory.db")

        max_total_extracted = 512 * 1024 * 1024  # 512 MB uncompressed cap
        extracted_total = 0

        def _copy_bounded(src, dst) -> None:
            nonlocal extracted_total
            while True:
                chunk = src.read(65536)
                if not chunk:
                    break
                extracted_total += len(chunk)
                if extracted_total > max_total_extracted:
                    raise BackupError("Backup archive exceeds maximum uncompressed size limit", status_code=413)
                dst.write(chunk)

        settings.data_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=str(settings.data_dir)) as stage_dir_str:
            stage_dir = Path(stage_dir_str)
            staged_db = stage_dir / "inventory.db"
            staged_images = stage_dir / "images"
            staged_images.mkdir(parents=True, exist_ok=True)

            # Extract inventory.db
            with zf.open("inventory.db", "r") as src, staged_db.open("wb") as dst:
                _copy_bounded(src, dst)

            parts_count = _verify_sqlite_file(staged_db)

            # Extract images
            for info in image_infos:
                fname = PurePosixPath(info.filename).name
                dest = staged_images / fname
                with zf.open(info, "r") as src, dest.open("wb") as dst:
                    _copy_bounded(src, dst)

            # Atomic swap and schema migration under db_lock
            with db_lock:
                # Remove stale WAL/SHM sidecars before replacing DB
                for suffix in ("-wal", "-shm"):
                    sidecar = Path(f"{settings.db_path}{suffix}")
                    if sidecar.exists():
                        try:
                            sidecar.unlink()
                        except OSError:
                            pass

                os.replace(staged_db, settings.db_path)

                old_images = stage_dir / "images_old"
                if settings.images_dir.exists():
                    os.replace(settings.images_dir, old_images)
                os.replace(staged_images, settings.images_dir)

                # Ensure WAL mode and schema tables exist on restored DB before releasing lock
                init_db(settings)

    return {
        "status": "ok",
        "parts_count": parts_count,
        "images_count": len(image_infos),
    }
