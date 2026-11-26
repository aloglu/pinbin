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
ALLOWED_PORTS = {80, 443}
_NAT64_WELL_KNOWN = ipaddress.IPv6Network("64:ff9b::/96")
_NAT64_LOCAL = ipaddress.IPv6Network("64:ff9b:1::/48")
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Pinbin/1.0"
)


class ScrapeError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _is_blocked_ip(ip_obj: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip_obj, ipaddress.IPv6Address):
        if ip_obj.ipv4_mapped is not None and _is_blocked_ip(ip_obj.ipv4_mapped):
            return True
        if ip_obj in _NAT64_WELL_KNOWN or ip_obj in _NAT64_LOCAL:
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


def _validate_url_sync(url: str) -> tuple[str, str, list[str]]:
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

    if port not in ALLOWED_PORTS:
        raise ScrapeError("Only standard HTTP/HTTPS ports (80, 443) are allowed", status_code=400)

    # Immediate check if hostname is an IP literal
    try:
        literal_ip = ipaddress.ip_address(hostname)
        if _is_blocked_ip(literal_ip):
            raise ScrapeError("Access to private or internal network addresses is blocked", status_code=400)
        return parsed.geturl(), hostname, [str(literal_ip)]
    except ValueError:
        pass

    # Resolve hostname via DNS and validate every returned address
    try:
        addr_info = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ScrapeError(f"Could not resolve hostname: {hostname}", status_code=400) from exc

    if not addr_info:
        raise ScrapeError(f"No IP addresses resolved for hostname: {hostname}", status_code=400)

    ipv4_list: list[str] = []
    ipv6_list: list[str] = []
    for _family, _socktype, _proto, _canonname, sockaddr in addr_info:
        ip_str = sockaddr[0]
        try:
            ip_obj = ipaddress.ip_address(ip_str)
        except ValueError as exc:
            raise ScrapeError("Invalid resolved IP address", status_code=400) from exc

        if _is_blocked_ip(ip_obj):
            raise ScrapeError("Access to private or internal network addresses is blocked", status_code=400)
        if isinstance(ip_obj, ipaddress.IPv4Address):
            if ip_str not in ipv4_list:
                ipv4_list.append(ip_str)
        else:
            if ip_str not in ipv6_list:
                ipv6_list.append(ip_str)

    # Prefer IPv4 first for dual-stack hosts inside IPv4-only containers, then fall back to IPv6
    return parsed.geturl(), hostname, ipv4_list + ipv6_list


async def validate_url_ssrf(url: str) -> tuple[str, str, list[str]]:
    return await asyncio.to_thread(_validate_url_sync, url)


def _build_pinned_request(url: str, hostname: str, resolved_ip: str) -> tuple[str, dict[str, str], dict[str, Any]]:
    """Build a DNS-pinned URL connecting directly to resolved_ip with Host + TLS SNI set to hostname."""
    parsed = urlparse(url)
    ip_host = f"[{resolved_ip}]" if ":" in resolved_ip else resolved_ip
    host_for_hdr = f"[{hostname}]" if ":" in hostname else hostname
    port_suffix = f":{parsed.port}" if parsed.port else ""
    pinned_netloc = f"{ip_host}{port_suffix}"
    pinned_url = parsed._replace(netloc=pinned_netloc).geturl()
    host_header = f"{host_for_hdr}{port_suffix}"
    extensions: dict[str, Any] = {"sni_hostname": hostname} if parsed.scheme == "https" else {}
    return pinned_url, {"Host": host_header}, extensions


async def _safe_fetch_bytes(
    client: httpx.AsyncClient, url: str, max_bytes: int
) -> tuple[str, str, bytes]:
    """SSRF-safe GET with DNS pinning, manual redirect validation, and streaming size limit."""
    current_url, hostname, resolved_ips = await validate_url_ssrf(url)

    for _hop in range(MAX_REDIRECTS + 1):
        last_connect_err: httpx.HTTPError | None = None
        redirected = False

        for resolved_ip in resolved_ips:
            try:
                pinned_url, extra_headers, extensions = _build_pinned_request(current_url, hostname, resolved_ip)
                async with client.stream("GET", pinned_url, headers=extra_headers, extensions=extensions) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        location = resp.headers.get("location")
                        if not location:
                            raise ScrapeError("Redirect response missing Location header", status_code=400)
                        next_url = urljoin(current_url, location)
                        current_url, hostname, resolved_ips = await validate_url_ssrf(next_url)
                        redirected = True
                        break

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
            except httpx.ConnectError as exc:
                last_connect_err = exc
                continue
            except httpx.TimeoutException as exc:
                raise ScrapeError("Timed out fetching remote URL", status_code=504) from exc
            except httpx.HTTPError as exc:
                raise ScrapeError(f"Failed to fetch remote URL: {exc.__class__.__name__}", status_code=400) from exc

        if redirected:
            continue
        if last_connect_err is not None:
            raise ScrapeError(
                f"Failed to fetch remote URL: {last_connect_err.__class__.__name__}",
                status_code=400,
            ) from last_connect_err

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

    def _iter_jsonld_objects() -> list[dict[str, Any]]:
        objs: list[dict[str, Any]] = []
        for script in soup.find_all("script", type="application/ld+json"):
            raw = script.get_text() or ""
            if not raw.strip():
                continue
            try:
                ld = json.loads(raw)
            except Exception:
                continue
            queue = ld if isinstance(ld, list) else [ld]
            while queue:
                obj = queue.pop(0)
                if not isinstance(obj, dict):
                    continue
                objs.append(obj)
                graph = obj.get("@graph")
                if isinstance(graph, list):
                    queue.extend(graph)
        return objs

    for obj in _iter_jsonld_objects():
        offers = obj.get("offers")
        if isinstance(offers, list) and offers:
            offers = offers[0]
        if isinstance(offers, dict):
            p = offers.get("price") or offers.get("lowPrice")
            cur = offers.get("priceCurrency") or ""
            if p is not None and str(p).strip():
                return f"{str(p).strip()} {str(cur).strip()}".strip()[:40]

    ip_price = soup.find(attrs={"itemprop": "price"})
    if ip_price:
        p_val = str(ip_price.get("content") or ip_price.get_text(strip=True) or "").strip()
        ip_cur = soup.find(attrs={"itemprop": "priceCurrency"})
        c_val = str(ip_cur.get("content") or ip_cur.get_text(strip=True) or "").strip() if ip_cur else ""
        if p_val:
            return f"{p_val} {c_val}".strip()[:40]

    for sel in (".spanFiyat", "#indirimliFiyat", ".product-price-not-discounted", ".product-price", ".current-price", ".urun-fiyat"):
        el = soup.select_one(sel)
        if el:
            txt = el.get_text(" ", strip=True)
            if txt and any(ch.isdigit() for ch in txt):
                return txt[:40]
    return ""


def _extract_availability(soup: BeautifulSoup) -> str:
    """Best-effort extraction of stock availability from JSON-LD Offer or microdata."""
    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.get_text() or ""
        if not raw.strip():
            continue
        try:
            ld = json.loads(raw)
        except Exception:
            continue
        queue = ld if isinstance(ld, list) else [ld]
        while queue:
            obj = queue.pop(0)
            if not isinstance(obj, dict):
                continue
            graph = obj.get("@graph")
            if isinstance(graph, list):
                queue.extend(graph)
            offers = obj.get("offers")
            if isinstance(offers, list) and offers:
                offers = offers[0]
            if isinstance(offers, dict):
                avail = str(offers.get("availability") or "").lower()
                if "instock" in avail:
                    return "in_stock"
                if "outofstock" in avail or "soldout" in avail:
                    return "out_of_stock"
    ip_avail = soup.find(attrs={"itemprop": "availability"})
    if ip_avail:
        avail = str(ip_avail.get("href") or ip_avail.get("content") or ip_avail.get_text(strip=True) or "").lower()
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


async def scrape_url(
    url: str,
    images_dir: Path,
    max_bytes: int,
    *,
    download_image: bool = True,
) -> dict[str, Any]:
    """Fetch a URL safely, extract metadata, and optionally save main product image as local WebP."""
    timeout = httpx.Timeout(REQUEST_TIMEOUT_SEC, connect=REQUEST_TIMEOUT_SEC)
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
    }

    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        headers=headers,
        trust_env=False,
    ) as client:
        final_url, content_type, body = await _safe_fetch_bytes(client, url, max_bytes)

        # Direct image URL
        if content_type.startswith("image/"):
            filename = ""
            if download_image:
                try:
                    filename = await asyncio.to_thread(process_and_save_image, body, images_dir, max_bytes)
                except ImageError as exc:
                    raise ScrapeError(str(exc), status_code=exc.status_code) from exc
            return {
                "title": "",
                "description": "",
                "image_url": f"/images/{filename}" if filename else "",
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
        if download_image and raw_img_url:
            abs_img_url = urljoin(final_url, raw_img_url)
            try:
                _img_final, _img_ct, img_bytes = await _safe_fetch_bytes(client, abs_img_url, max_bytes)
                saved_filename = await asyncio.to_thread(process_and_save_image, img_bytes, images_dir, max_bytes)
            except (ScrapeError, ImageError):
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
