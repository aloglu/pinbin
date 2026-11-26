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
_ALLOWED_SVG_TAGS = {
    "svg",
    "g",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "path",
    "text",
    "tspan",
    "defs",
    "lineargradient",
    "radialgradient",
    "stop",
    "clippath",
    "title",
    "desc",
}
_ALLOWED_SVG_ATTRS = {
    "xmlns",
    "viewbox",
    "width",
    "height",
    "preserveaspectratio",
    "id",
    "class",
    "transform",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "d",
    "points",
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline",
    "letter-spacing",
    "dx",
    "dy",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientunits",
    "gradienttransform",
    "clip-path",
    "clip-rule",
    "aria-label",
    "aria-hidden",
    "role",
}
_SAFE_LOCAL_URL_RE = re.compile(r"^url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*\)$")
_URL_TOKEN_RE = re.compile(r"url\s*\(|javascript:|data:", re.IGNORECASE)


class ImageError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def is_valid_image_filename(filename: str) -> bool:
    return bool(filename and FILENAME_RE.match(filename))


def is_valid_webp_bytes(raw_bytes: bytes) -> bool:
    """Verify raw bytes represent a real, decodable WebP image."""
    if not raw_bytes or len(raw_bytes) < 12:
        return False
    if raw_bytes[:4] != b"RIFF" or raw_bytes[8:12] != b"WEBP":
        return False
    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            if img.format != "WEBP":
                return False
            img.verify()
        return True
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        return False


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
    # Strict allowlist of safe SVG drawing elements (drops <script>, <style>, <foreignObject>, etc.)
    for child in list(el):
        if _local_tag(child.tag) not in _ALLOWED_SVG_TAGS:
            el.remove(child)
        else:
            _sanitize_svg_element(child)

    # Strict allowlist of safe geometry & presentation attributes
    for attr_name in list(el.attrib.keys()):
        local = _local_tag(attr_name)
        val = (el.attrib.get(attr_name) or "").strip()
        if local not in _ALLOWED_SVG_ATTRS:
            del el.attrib[attr_name]
            continue
        if _URL_TOKEN_RE.search(val):
            # Only allow local fragment refs like fill="url(#grad1)" or clip-path="url(#c1)"
            if local in ("fill", "stroke", "clip-path") and _SAFE_LOCAL_URL_RE.match(val):
                continue
            del el.attrib[attr_name]


def sanitize_pinout_svg(raw_svg: str) -> str:
    """Validate and sanitize an SVG string using a strict element & attribute allowlist."""
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
