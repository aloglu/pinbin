from __future__ import annotations

import io
import re
import uuid
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_EDGE_PX = 1000
WEBP_QUALITY = 82
FILENAME_RE = re.compile(r"^[a-f0-9-]{8,64}\.webp$")


class ImageError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def is_valid_image_filename(filename: str) -> bool:
    return bool(filename and FILENAME_RE.match(filename))


def process_and_save_image(raw_bytes: bytes, images_dir: Path, max_bytes: int) -> str:
    """Validate, EXIF-orient, resize to max 1000px longest edge, and save as WebP (q=82)."""
    if not raw_bytes:
        raise ImageError("Uploaded image is empty", status_code=400)

    if len(raw_bytes) > max_bytes:
        raise ImageError(
            f"Image exceeds maximum allowed size of {max_bytes // (1024 * 1024)} MB",
            status_code=413,
        )

    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGBA")
            else:
                img = img.convert("RGB")

            if max(img.size) > MAX_EDGE_PX:
                img.thumbnail((MAX_EDGE_PX, MAX_EDGE_PX), Image.Resampling.LANCZOS)

            images_dir.mkdir(parents=True, exist_ok=True)
            filename = f"{uuid.uuid4().hex}.webp"
            dest = images_dir / filename
            img.save(dest, format="WEBP", quality=WEBP_QUALITY, method=4)
            return filename
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as exc:
        raise ImageError("Invalid or unsupported image file", status_code=400) from exc


def resolve_safe_image_path(filename: str, images_dir: Path) -> Path | None:
    if not is_valid_image_filename(filename):
        return None
    base = images_dir.resolve()
    candidate = (base / filename).resolve()
    if candidate.parent != base:
        return None
    if not candidate.is_file():
        return None
    return candidate


def safe_delete_image(filename: str, images_dir: Path) -> None:
    if not filename or not is_valid_image_filename(filename):
        return
    path = resolve_safe_image_path(filename, images_dir)
    if path is not None:
        try:
            path.unlink()
        except OSError:
            pass
