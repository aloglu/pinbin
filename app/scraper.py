from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from app.images import ImageError, process_and_save_image

REQUEST_TIMEOUT_SEC = 10.0
MAX_REDIRECTS = 5
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Pinbin/1.0"
)


class ScrapeError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _is_blocked_ip(ip_obj: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped is not None:
        if _is_blocked_ip(ip_obj.ipv4_mapped):
            return True
    return (
        not ip_obj.is_global
        or ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
    )


def _validate_url_sync(url: str) -> tuple[str, str, str]:
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        raise ScrapeError("Only http:// and https:// URLs are allowed", status_code=400)

    hostname = parsed.hostname
    if not hostname:
        raise ScrapeError("URL must include a valid hostname", status_code=400)

    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise ScrapeError("URL contains an invalid port number", status_code=400) from exc

    # Immediate check if hostname is an IP literal
    try:
        literal_ip = ipaddress.ip_address(hostname)
        if _is_blocked_ip(literal_ip):
            raise ScrapeError("Access to private or internal network addresses is blocked", status_code=400)
        return parsed.geturl(), hostname, str(literal_ip)
    except ValueError:
        pass

    # Resolve hostname via DNS and validate every returned address
    try:
        addr_info = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ScrapeError(f"Could not resolve hostname: {hostname}", status_code=400) from exc

    if not addr_info:
        raise ScrapeError(f"No IP addresses resolved for hostname: {hostname}", status_code=400)

    first_ip = ""
    for family, _socktype, _proto, _canonname, sockaddr in addr_info:
        ip_str = sockaddr[0]
        try:
            ip_obj = ipaddress.ip_address(ip_str)
        except ValueError as exc:
            raise ScrapeError("Invalid resolved IP address", status_code=400) from exc

        if _is_blocked_ip(ip_obj):
            raise ScrapeError("Access to private or internal network addresses is blocked", status_code=400)
        if not first_ip:
            first_ip = ip_str

    return parsed.geturl(), hostname, first_ip


async def validate_url_ssrf(url: str) -> tuple[str, str, str]:
    return await asyncio.to_thread(_validate_url_sync, url)


def _build_pinned_request(url: str, hostname: str, resolved_ip: str) -> tuple[str, dict[str, str], dict[str, Any]]:
    """Build a DNS-pinned URL connecting directly to resolved_ip with Host + TLS SNI set to hostname."""
    parsed = urlparse(url)
    ip_host = f"[{resolved_ip}]" if ":" in resolved_ip else resolved_ip
    port_suffix = f":{parsed.port}" if parsed.port else ""
    pinned_netloc = f"{ip_host}{port_suffix}"
    pinned_url = parsed._replace(netloc=pinned_netloc).geturl()
    host_header = f"{hostname}{port_suffix}"
    extensions: dict[str, Any] = {"sni_hostname": hostname} if parsed.scheme == "https" else {}
    return pinned_url, {"Host": host_header}, extensions


async def _safe_fetch_bytes(
    client: httpx.AsyncClient, url: str, max_bytes: int
) -> tuple[str, str, bytes]:
    """SSRF-safe GET with DNS pinning, manual redirect validation, and streaming size limit."""
    current_url, hostname, resolved_ip = await validate_url_ssrf(url)

    for _hop in range(MAX_REDIRECTS + 1):
        try:
            pinned_url, extra_headers, extensions = _build_pinned_request(current_url, hostname, resolved_ip)
            async with client.stream("GET", pinned_url, headers=extra_headers, extensions=extensions) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location")
                    if not location:
                        raise ScrapeError("Redirect response missing Location header", status_code=400)
                    next_url = urljoin(current_url, location)
                    current_url, hostname, resolved_ip = await validate_url_ssrf(next_url)
                    continue

                if resp.status_code >= 400:
                    raise ScrapeError(
                        f"Remote server returned HTTP {resp.status_code}",
                        status_code=400,
                    )

                content_length = resp.headers.get("content-length")
                if content_length and content_length.isdigit() and int(content_length) > max_bytes:
                    raise ScrapeError("Remote resource exceeds maximum allowed download size", status_code=413)

                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise ScrapeError("Remote resource exceeds maximum allowed download size", status_code=413)
                    chunks.append(chunk)

                content_type = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                return current_url, content_type, b"".join(chunks)
        except ScrapeError:
            raise
        except httpx.TimeoutException as exc:
            raise ScrapeError("Timed out fetching remote URL", status_code=504) from exc
        except httpx.HTTPError as exc:
            raise ScrapeError(f"Failed to fetch remote URL: {exc.__class__.__name__}", status_code=400) from exc

    raise ScrapeError("Too many redirects while fetching URL", status_code=400)


def _extract_price(soup: BeautifulSoup) -> str:
    """Best-effort extraction of product price from OpenGraph meta or JSON-LD Offer."""
    def meta_val(attr_name: str, val: str) -> str:
        tag = soup.find("meta", attrs={attr_name: val})
        return str(tag["content"]).strip() if tag and tag.get("content") else ""

    amount = (
        meta_val("property", "product:price:amount")
        or meta_val("property", "og:price:amount")
        or meta_val("name", "twitter:data1")
    )
    currency = (
        meta_val("property", "product:price:currency")
        or meta_val("property", "og:price:currency")
    )
    if amount:
        return f"{amount} {currency}".strip()[:40]

    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.string or ""
        if not raw.strip():
            continue
        try:
            ld = json.loads(raw)
        except Exception:
            continue
        items = ld if isinstance(ld, list) else [ld]
        for obj in items:
            if not isinstance(obj, dict):
                continue
            offers = obj.get("offers")
            if isinstance(offers, list) and offers:
                offers = offers[0]
            if isinstance(offers, dict):
                p = offers.get("price") or offers.get("lowPrice")
                cur = offers.get("priceCurrency") or ""
                if p is not None and str(p).strip():
                    return f"{str(p).strip()} {str(cur).strip()}".strip()[:40]
    return ""


def _extract_availability(soup: BeautifulSoup) -> str:
    """Best-effort extraction of stock availability from JSON-LD Offer."""
    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.string or ""
        if not raw.strip():
            continue
        try:
            ld = json.loads(raw)
        except Exception:
            continue
        items = ld if isinstance(ld, list) else [ld]
        for obj in items:
            if not isinstance(obj, dict):
                continue
            offers = obj.get("offers")
            if isinstance(offers, list) and offers:
                offers = offers[0]
            if isinstance(offers, dict):
                avail = str(offers.get("availability") or "").lower()
                if "instock" in avail:
                    return "in_stock"
                if "outofstock" in avail or "soldout" in avail:
                    return "out_of_stock"
    return ""


def _extract_meta(soup: BeautifulSoup) -> tuple[str, str, str, str, str]:
    def meta_content(attr_name: str, attr_val: str) -> str:
        tag = soup.find("meta", attrs={attr_name: attr_val})
        if tag and tag.get("content"):
            return str(tag["content"]).strip()
        return ""

    title = (
        meta_content("property", "og:title")
        or meta_content("name", "twitter:title")
        or (soup.title.get_text(strip=True) if soup.title else "")
        or (soup.find("h1").get_text(strip=True) if soup.find("h1") else "")
    )

    description = (
        meta_content("property", "og:description")
        or meta_content("name", "twitter:description")
        or meta_content("name", "description")
    )

    image_src = (
        meta_content("property", "og:image")
        or meta_content("property", "og:image:secure_url")
        or meta_content("name", "twitter:image")
    )

    if not image_src:
        link_img = soup.find("link", rel="image_src")
        if link_img and link_img.get("href"):
            image_src = str(link_img["href"]).strip()

    if not image_src:
        for img in soup.find_all("img", src=True):
            src = str(img["src"]).strip()
            if src and not src.startswith("data:") and not src.lower().endswith(".svg"):
                image_src = src
                break

    price = _extract_price(soup)
    in_stock = _extract_availability(soup)
    return title[:300], description[:1000], image_src, price, in_stock


async def scrape_url(url: str, images_dir: Path, max_bytes: int) -> dict[str, Any]:
    """Fetch a URL safely, extract title/description, and save main product image as local WebP."""
    timeout = httpx.Timeout(REQUEST_TIMEOUT_SEC, connect=REQUEST_TIMEOUT_SEC)
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
    }

    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        headers=headers,
    ) as client:
        final_url, content_type, body = await _safe_fetch_bytes(client, url, max_bytes)

        # Direct image URL
        if content_type.startswith("image/"):
            try:
                filename = process_and_save_image(body, images_dir, max_bytes)
            except ImageError as exc:
                raise ScrapeError(str(exc), status_code=exc.status_code) from exc
            return {
                "title": "",
                "description": "",
                "image_url": f"/images/{filename}",
                "image_path": filename,
                "source_url": final_url,
            }

        # HTML page
        html_text = body.decode("utf-8", errors="replace")
        soup = BeautifulSoup(html_text, "html.parser")
        title, description, raw_img_url, price, in_stock = _extract_meta(soup)
        retailer = (urlparse(final_url).hostname or "").lower()
        if retailer.startswith("www."):
            retailer = retailer[4:]

        saved_filename = ""
        if raw_img_url:
            abs_img_url = urljoin(final_url, raw_img_url)
            try:
                _img_final, _img_ct, img_bytes = await _safe_fetch_bytes(client, abs_img_url, max_bytes)
                saved_filename = process_and_save_image(img_bytes, images_dir, max_bytes)
            except (ScrapeError, ImageError):
                # Keep extracted text even if product image could not be downloaded
                saved_filename = ""

        return {
            "title": title,
            "description": description,
            "price": price,
            "in_stock": in_stock,
            "retailer": retailer,
            "image_url": f"/images/{saved_filename}" if saved_filename else "",
            "image_path": saved_filename,
            "source_url": final_url,
        }


def _is_likely_ui_asset(url: str) -> bool:
    low = url.lower()
    skip_tokens = (
        "logo", "favicon", "icon", "sprite", "avatar", "banner",
        "badge", "placeholder", "spinner", "loading", "pixel", "1x1",
        "gravatar", "facebook", "twitter", "instagram", "youtube", "pinterest",
    )
    if low.endswith(".svg") or ".svg?" in low or low.startswith("data:"):
        return True
    return any(tok in low for tok in skip_tokens)


def _extract_page_image_urls(soup: BeautifulSoup, base_url: str) -> list[str]:
    """Extract high-signal product/diagram image URLs from an HTML page."""
    found: list[str] = []

    def add_url(raw: str) -> None:
        if not raw:
            return
        abs_url = urljoin(base_url, raw.strip())
        if not (abs_url.startswith("http://") or abs_url.startswith("https://")):
            return
        if _is_likely_ui_asset(abs_url):
            return
        if abs_url not in found:
            found.append(abs_url)

    # 1. OpenGraph & Twitter cards (most reliable product photo)
    for attr_name, attr_val in (
        ("property", "og:image:secure_url"),
        ("property", "og:image"),
        ("name", "twitter:image"),
        ("name", "twitter:image:src"),
    ):
        for tag in soup.find_all("meta", attrs={attr_name: attr_val}):
            if tag.get("content"):
                add_url(str(tag["content"]))

    # 2. JSON-LD Product / Article image fields
    for script in soup.find_all("script", type="application/ld+json"):
        raw_json = script.string or ""
        if not raw_json.strip():
            continue
        try:
            ld = json.loads(raw_json)
        except Exception:
            continue
        items = ld if isinstance(ld, list) else [ld]
        for obj in items:
            if not isinstance(obj, dict):
                continue
            graph = obj.get("@graph")
            if isinstance(graph, list):
                items.extend(g for g in graph if isinstance(g, dict))
            img_field = obj.get("image")
            if isinstance(img_field, str):
                add_url(img_field)
            elif isinstance(img_field, list):
                for entry in img_field[:3]:
                    if isinstance(entry, str):
                        add_url(entry)
                    elif isinstance(entry, dict) and entry.get("url"):
                        add_url(str(entry["url"]))
            elif isinstance(img_field, dict) and img_field.get("url"):
                add_url(str(img_field["url"]))

    # 3. Fallback to first few content <img> tags
    if len(found) < 2:
        for img in soup.find_all("img", src=True):
            src = str(img.get("src") or "").strip()
            if not src:
                continue
            # Skip tiny explicit dimensions
            w = img.get("width")
            h = img.get("height")
            try:
                if (w and int(str(w).rstrip("px")) < 120) or (h and int(str(h).rstrip("px")) < 120):
                    continue
            except ValueError:
                pass
            add_url(src)
            if len(found) >= 3:
                break

    return found[:3]


async def _scrape_candidates_from_page(
    client: httpx.AsyncClient, page_url: str, max_bytes: int
) -> list[dict[str, str]]:
    try:
        final_url, ct, body = await _safe_fetch_bytes(client, page_url, min(max_bytes, 3 * 1024 * 1024))
    except ScrapeError:
        return []

    host = urlparse(final_url).hostname or ""
    host = host.removeprefix("www.")

    if ct.startswith("image/"):
        return [{"url": final_url, "source": host, "title": ""}]

    if "html" not in ct and "xml" not in ct:
        return []

    soup = BeautifulSoup(body.decode("utf-8", errors="replace"), "html.parser")
    page_title = (soup.title.get_text(strip=True) if soup.title else "")[:80]
    urls = _extract_page_image_urls(soup, final_url)
    return [{"url": u, "source": host, "title": page_title} for u in urls]


async def find_image_candidates(
    page_urls: list[str],
    fallback_query: str,
    max_bytes: int,
    limit: int = 6,
) -> list[dict[str, str]]:
    """SSRF-safely scrape candidate product photos from web-search URLs (with Wikimedia fallback)."""
    timeout = httpx.Timeout(6.0, connect=4.0)
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    # Deduplicate input page URLs
    unique_pages: list[str] = []
    for u in page_urls:
        clean = (u or "").strip()
        if clean.startswith(("http://", "https://")) and clean not in unique_pages:
            unique_pages.append(clean)

    candidates: list[dict[str, str]] = []
    seen_img_urls: set[str] = set()

    def add_candidate(item: dict[str, str]) -> None:
        u = item.get("url", "").strip()
        if not u or u in seen_img_urls:
            return
        seen_img_urls.add(u)
        candidates.append(item)

    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=False,
            headers=headers,
        ) as client:
            if unique_pages:
                results = await asyncio.gather(
                    *(_scrape_candidates_from_page(client, u, max_bytes) for u in unique_pages[:5]),
                    return_exceptions=True,
                )
                for res in results:
                    if isinstance(res, list):
                        for item in res:
                            add_candidate(item)
                            if len(candidates) >= limit:
                                return candidates
    except Exception:
        pass

    return candidates[:limit]


