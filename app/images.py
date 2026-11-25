from __future__ import annotations

import io
import re
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_EDGE_PX = 1000
WEBP_QUALITY = 82
MAX_SVG_BYTES = 512 * 1024
FILENAME_RE = re.compile(r"^[a-f0-9-]{8,64}\.webp$")

_SVG_NS = "http://www.w3.org/2000/svg"
_XLINK_NS = "http://www.w3.org/1999/xlink"
_FORBIDDEN_SVG_TAGS = {
    "script",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "audio",
    "video",
    "meta",
    "link",
    "base",
    "form",
    "input",
    "button",
    "textarea",
    "animate",
    "animatemotion",
    "animatetransform",
    "set",
}
_DANGEROUS_CSS_RE = re.compile(r"(url\s*\(|javascript:|expression\s*\(|@import)", re.IGNORECASE)


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


def compute_images_stats(images_dir: Path) -> tuple[int, int]:
    """Return (image_count, total_bytes) for stored .webp images."""
    if not images_dir.is_dir():
        return 0, 0
    count = 0
    total_bytes = 0
    for entry in images_dir.iterdir():
        if entry.is_file() and not entry.is_symlink() and is_valid_image_filename(entry.name):
            try:
                total_bytes += entry.stat().st_size
                count += 1
            except OSError:
                pass
    return count, total_bytes


def _local_tag(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1].lower()
    return tag.lower()


def _sanitize_svg_element(el: ET.Element) -> None:
    # Remove forbidden child elements
    for child in list(el):
        if _local_tag(child.tag) in _FORBIDDEN_SVG_TAGS:
            el.remove(child)
        else:
            _sanitize_svg_element(child)

    # Clean attributes
    for attr_name in list(el.attrib.keys()):
        local = _local_tag(attr_name)
        val = el.attrib.get(attr_name, "")
        if local.startswith("on"):
            del el.attrib[attr_name]
            continue
        if local in ("href", "src", "action", "formaction"):
            if not val.strip().startswith("#"):
                del el.attrib[attr_name]
                continue
        if local == "style" and _DANGEROUS_CSS_RE.search(val):
            del el.attrib[attr_name]
            continue
        if "javascript:" in val.lower() or "data:text/html" in val.lower():
            del el.attrib[attr_name]
            continue


def sanitize_pinout_svg(raw_svg: str) -> str:
    """Validate and sanitize an SVG string for safe inline rendering."""
    cleaned = str(raw_svg or "").strip()
    if not cleaned:
        return ""
    raw_bytes = cleaned.encode("utf-8")
    if len(raw_bytes) > MAX_SVG_BYTES:
        raise ImageError("Pinout SVG exceeds maximum allowed size (512 KB)", status_code=413)
    # Strip DOCTYPE/ENTITY declarations to prevent XXE/billion-laughs
    if "<!doctype" in cleaned.lower() or "<!entity" in cleaned.lower():
        raise ImageError("SVG must not contain DOCTYPE or ENTITY declarations", status_code=400)
    try:
        ET.register_namespace("", _SVG_NS)
        root = ET.fromstring(cleaned)
    except ET.ParseError as exc:
        raise ImageError("Invalid SVG markup", status_code=400) from exc

    if _local_tag(root.tag) != "svg":
        raise ImageError("Root element must be <svg>", status_code=400)

    _sanitize_svg_element(root)
    return ET.tostring(root, encoding="unicode")
