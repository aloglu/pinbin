from __future__ import annotations

import io
import os
import sqlite3
import tempfile
import zipfile
import zlib
from dataclasses import replace
from pathlib import Path, PurePosixPath
from typing import Any

from app.config import Settings
from app.db import db_lock, init_db, invalidate_guest_pass_cache
from app.images import is_valid_image_filename, is_valid_webp_bytes

SQLITE_MAGIC = b"SQLite format 3\x00"
SYMLINK_MODE = 0o120000
FILE_TYPE_MASK = 0o170000

# Live auth tokens and guest-pass secrets are never exported into backups and are preserved across restore
_SENSITIVE_SETTING_KEYS = (
    "mcp_api_token",
    "guest_pass_token",
    "guest_pass_enabled",
    "guest_pass_created_at",
)


class BackupError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _strip_sensitive_settings(db_file: Path) -> None:
    conn = sqlite3.connect(str(db_file))
    try:
        has_settings = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
        ).fetchone()
        if has_settings:
            placeholders = ",".join("?" for _ in _SENSITIVE_SETTING_KEYS)
            conn.execute(
                f"DELETE FROM settings WHERE key IN ({placeholders})",
                _SENSITIVE_SETTING_KEYS,
            )
            conn.commit()
    finally:
        conn.close()


def _read_sensitive_settings(db_file: Path) -> list[tuple[str, str]]:
    if not db_file.is_file():
        return []
    conn = sqlite3.connect(str(db_file), timeout=10.0)
    try:
        has_settings = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
        ).fetchone()
        if not has_settings:
            return []
        placeholders = ",".join("?" for _ in _SENSITIVE_SETTING_KEYS)
        rows = conn.execute(
            f"SELECT key, value FROM settings WHERE key IN ({placeholders})",
            _SENSITIVE_SETTING_KEYS,
        ).fetchall()
        return [(str(r[0]), str(r[1])) for r in rows]
    except sqlite3.DatabaseError:
        return []
    finally:
        conn.close()


def _apply_sensitive_settings(db_file: Path, preserved: list[tuple[str, str]]) -> None:
    conn = sqlite3.connect(str(db_file))
    try:
        has_settings = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
        ).fetchone()
        if not has_settings:
            return
        placeholders = ",".join("?" for _ in _SENSITIVE_SETTING_KEYS)
        conn.execute(
            f"DELETE FROM settings WHERE key IN ({placeholders})",
            _SENSITIVE_SETTING_KEYS,
        )
        for key, value in preserved:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, value),
            )
        conn.commit()
    finally:
        conn.close()


def create_backup_zip_bytes(settings: Settings) -> bytes:
    """Create a WAL-safe zip archive containing ONLY inventory.db (without live auth secrets) and images/*.webp."""
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

            _strip_sensitive_settings(tmp_db)

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

        def _read_bounded(info_or_name: zipfile.ZipInfo | str) -> bytes:
            nonlocal extracted_total
            out = bytearray()
            try:
                with zf.open(info_or_name, "r") as src:
                    while True:
                        chunk = src.read(65536)
                        if not chunk:
                            break
                        extracted_total += len(chunk)
                        if extracted_total > max_total_extracted:
                            raise BackupError(
                                "Backup archive exceeds maximum uncompressed size limit",
                                status_code=413,
                            )
                        out.extend(chunk)
            except BackupError:
                raise
            except (zipfile.BadZipFile, zlib.error, RuntimeError, NotImplementedError, OSError) as exc:
                raise BackupError("Backup archive is corrupted or uses unsupported encryption/compression") from exc
            return bytes(out)

        settings.data_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=str(settings.data_dir)) as stage_dir_str:
            stage_dir = Path(stage_dir_str)
            staged_db = stage_dir / "inventory.db"
            staged_images = stage_dir / "images"
            staged_images.mkdir(parents=True, exist_ok=True)

            # Extract and verify inventory.db
            staged_db.write_bytes(_read_bounded("inventory.db"))
            parts_count = _verify_sqlite_file(staged_db)

            # Extract and verify WebP images
            for info in image_infos:
                fname = PurePosixPath(info.filename).name
                img_bytes = _read_bounded(info)
                if not is_valid_webp_bytes(img_bytes):
                    raise BackupError(f"Invalid WebP image in backup archive: {fname}")
                (staged_images / fname).write_bytes(img_bytes)

            # Run schema validation/migrations on staged DB BEFORE touching live data
            staged_settings = replace(settings, data_dir=stage_dir, seed_file=stage_dir / "__no_seed__.json")
            try:
                init_db(staged_settings)
            except Exception as exc:
                raise BackupError("Restored database failed schema migration") from exc

            # Remove staged WAL/SHM after checkpointing so only the clean DB file is swapped
            try:
                chk_conn = sqlite3.connect(str(staged_db))
                try:
                    chk_conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
                finally:
                    chk_conn.close()
            except sqlite3.DatabaseError:
                pass
            for suffix in ("-wal", "-shm"):
                sc = Path(f"{staged_db}{suffix}")
                if sc.exists():
                    try:
                        sc.unlink()
                    except OSError:
                        pass

            # Atomic swap under db_lock with rollback if image swap fails
            with db_lock:
                # Preserve active auth/guest-pass secrets instead of reinstating revoked tokens from backup
                preserved_secrets = _read_sensitive_settings(settings.db_path)
                _apply_sensitive_settings(staged_db, preserved_secrets)

                old_db = stage_dir / "inventory_old.db"
                old_images = stage_dir / "images_old"
                had_live_db = settings.db_path.exists()
                had_live_images = settings.images_dir.exists()

                for suffix in ("-wal", "-shm"):
                    sidecar = Path(f"{settings.db_path}{suffix}")
                    if sidecar.exists():
                        try:
                            sidecar.unlink()
                        except OSError:
                            pass

                try:
                    if had_live_db:
                        os.replace(settings.db_path, old_db)
                    os.replace(staged_db, settings.db_path)

                    if had_live_images:
                        os.replace(settings.images_dir, old_images)
                    os.replace(staged_images, settings.images_dir)
                except OSError as exc:
                    # Best-effort rollback of live DB & images on swap failure
                    if old_db.exists():
                        try:
                            os.replace(old_db, settings.db_path)
                        except OSError:
                            pass
                    if old_images.exists() and not settings.images_dir.exists():
                        try:
                            os.replace(old_images, settings.images_dir)
                        except OSError:
                            pass
                    raise BackupError("Failed to swap restored database and images") from exc

                # Ensure WAL mode is active on live DB before releasing lock
                init_db(settings)
                invalidate_guest_pass_cache(settings.db_path)

    return {
        "status": "ok",
        "parts_count": parts_count,
        "images_count": len(image_infos),
    }
