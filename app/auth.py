from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import re
import time
from collections import deque
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

import jwt
from jwt import PyJWKClient
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response

from app.config import Settings
from app.db import GUEST_COOKIE_NAME, verify_guest_session_cookie

_STATIC_DIR = Path(__file__).resolve().parent / "static"
_BRAND_FULL_RE = re.compile(r'<svg class="brand-full".*?</svg>', re.DOTALL)
_GUEST_PASS_RATE_WINDOW_SEC = 60.0
_GUEST_PASS_RATE_MAX = 30
_APP_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'; "
    "form-action 'self'"
)

# Static, public brand & font assets only (zero app JS, CSS, images, or user data).
_GUEST_PUBLIC_ASSETS = {
    "/guest/static/fonts/ibm-plex-sans-latin-400-normal.woff2",
    "/guest/static/fonts/ibm-plex-sans-latin-500-normal.woff2",
    "/guest/static/fonts/ibm-plex-sans-latin-600-normal.woff2",
    "/guest/static/fonts/ibm-plex-sans-latin-ext-400-normal.woff2",
    "/guest/static/fonts/ibm-plex-sans-latin-ext-500-normal.woff2",
    "/guest/static/fonts/ibm-plex-sans-latin-ext-600-normal.woff2",
    "/guest/static/brand/favicon.svg",
    "/guest/static/brand/icon-192.png",
}

_GUEST_ALLOWED_EXACT = {
    "/guest",
    "/guest/",
    "/guest/inventory",
    "/guest/projects",
    "/guest/shopping",
    "/guest/glossary",
    "/guest/bench",
    "/guest/manifest.webmanifest",
    "/guest/apple-touch-icon.png",
    "/guest/api/config",
    "/guest/api/parts",
    "/guest/api/projects",
    "/guest/api/shopping",
    "/guest/api/retailers",
    "/guest/api/glossary",
}
_GUEST_PROJECT_DETAIL_RE = re.compile(r"^/guest/projects/([^/]+)(?:/(?:map|focus|metro|parts|list|code|notes))?$")
_GUEST_PROJECT_CODE_API_RE = re.compile(r"^/guest/api/projects/([^/]+)/(?:code|wokwi|wokwi\.zip)$")
_GUEST_BENCH_SUBTAB_RE = re.compile(r"^/guest/bench/([^/]+)$")


@lru_cache(maxsize=4)
def render_guest_locked_html(
    heading: str = "Guest pass required",
    message: str = "This read-only link is missing, invalid, or has been turned off by the owner.",
) -> str:
    brand_svg = ""
    try:
        index_html = (_STATIC_DIR / "index.html").read_text(encoding="utf-8")
        m = _BRAND_FULL_RE.search(index_html)
        if m:
            brand_svg = m.group(0)
    except Exception:
        brand_svg = '<span style="font-weight:600;letter-spacing:-.01em">pinbin</span>'

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Pinbin · Guest Pass</title>
  <link rel="icon" type="image/svg+xml" href="/guest/static/brand/favicon.svg" />
  <link rel="icon" type="image/png" sizes="192x192" href="/guest/static/brand/icon-192.png" />
  <style>
    @font-face {{
      font-family: 'IBM Plex Sans';
      font-style: normal;
      font-display: swap;
      font-weight: 400;
      src: url('/guest/static/fonts/ibm-plex-sans-latin-ext-400-normal.woff2') format('woff2');
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }}
    @font-face {{
      font-family: 'IBM Plex Sans';
      font-style: normal;
      font-display: swap;
      font-weight: 400;
      src: url('/guest/static/fonts/ibm-plex-sans-latin-400-normal.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }}
    @font-face {{
      font-family: 'IBM Plex Sans';
      font-style: normal;
      font-display: swap;
      font-weight: 500;
      src: url('/guest/static/fonts/ibm-plex-sans-latin-ext-500-normal.woff2') format('woff2');
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }}
    @font-face {{
      font-family: 'IBM Plex Sans';
      font-style: normal;
      font-display: swap;
      font-weight: 500;
      src: url('/guest/static/fonts/ibm-plex-sans-latin-500-normal.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }}
    @font-face {{
      font-family: 'IBM Plex Sans';
      font-style: normal;
      font-display: swap;
      font-weight: 600;
      src: url('/guest/static/fonts/ibm-plex-sans-latin-ext-600-normal.woff2') format('woff2');
      unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
    }}
    @font-face {{
      font-family: 'IBM Plex Sans';
      font-style: normal;
      font-display: swap;
      font-weight: 600;
      src: url('/guest/static/fonts/ibm-plex-sans-latin-600-normal.woff2') format('woff2');
      unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
    }}

    :root {{
      --bg: #ECEDEA;
      --surface: #F7F7F5;
      --line: #D3D4CF;
      --hair: #E2E3DF;
      --ink: #141517;
      --ink-2: #44464A;
      --hover: color-mix(in srgb, var(--ink) 7%, transparent);
      --ease: cubic-bezier(.2, .8, .2, 1);
      color-scheme: light;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #1E1D1B;
        --surface: #262522;
        --line: #403E39;
        --hair: #33322E;
        --ink: #EDEAE4;
        --ink-2: #BDB8AE;
        color-scheme: dark;
      }}
    }}

    * {{ box-sizing: border-box; }}
    html {{ background: var(--bg); }}
    body {{
      margin: 0;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--ink);
      font: 400 14px/1.5 'IBM Plex Sans', 'Segoe UI', Arial, system-ui, sans-serif;
      text-rendering: optimizeLegibility;
    }}
    .bar {{
      position: sticky;
      top: 0;
      padding-top: env(safe-area-inset-top, 0px);
      background: var(--bg);
      border-bottom: 1px solid var(--line);
    }}
    .bar-in {{
      height: 42px;
      display: flex;
      align-items: center;
      gap: 20px;
      padding-left: max(16px, env(safe-area-inset-left, 0px));
      padding-right: max(16px, env(safe-area-inset-right, 0px));
    }}
    .mark {{
      display: flex;
      align-items: center;
      padding: 4px 8px;
      margin-left: -8px;
      border-radius: 6px;
      color: var(--ink);
      cursor: pointer;
      transition: background .15s var(--ease);
    }}
    .mark:hover {{ background: var(--hover); }}
    .mark .brand-full {{ width: 74px; height: 28px; display: block; }}
    .mark .pb-hole {{ opacity: .45; }}
    .mark .pb-idot {{ transition: fill .55s ease-in-out; }}
    .mark.pulse .pb-lit {{ animation: pbPower .46s ease-in-out var(--d, 0ms) 1 both; }}
    .mark.pulse .pb-idot {{ transition: none; }}
    @keyframes pbPower {{
      0%, 100% {{ fill: currentColor; }}
      40% {{ fill: var(--pb-cur, #ff0000); }}
    }}
    .right {{ margin-left: auto; display: flex; align-items: center; }}
    .tag {{
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 8px;
      border-radius: 11px;
      background: var(--hair);
      color: var(--ink-2);
      font-size: 12px;
      white-space: nowrap;
      user-select: none;
    }}
    main {{
      flex: 1;
      display: grid;
      place-items: center;
      padding: 24px 16px 64px;
    }}
    .card {{
      max-width: 420px;
      width: 100%;
      padding: 22px 24px;
      border-radius: 8px;
      background: var(--surface);
      border: 1px solid var(--line);
    }}
    h1 {{
      margin: 0 0 6px;
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -.01em;
      color: var(--ink);
    }}
    p {{
      margin: 0;
      color: var(--ink-2);
      line-height: 1.55;
    }}
  </style>
</head>
<body>
  <header class="bar">
    <div class="bar-in">
      <div class="mark" aria-label="Pinbin">{brand_svg}</div>
      <div class="right"><span class="tag">Read-only</span></div>
    </div>
  </header>
  <main>
    <section class="card">
      <h1>{html.escape(heading)}</h1>
      <p>{html.escape(message)}</p>
    </section>
  </main>
  <script>
    (function () {{
      var mark = document.querySelector('.mark');
      var fullSvg = mark && mark.querySelector('.brand-full');
      if (!mark || !fullSvg) return;
      var letters = [
        [[6,22],[6,18],[6,14],[6,10],[10,10],[14,10],[14,14],[14,18],[10,18]],
        [[22,18],[22,14],[22,10],[22,2]],
        [[30,18],[30,14],[30,10],[34,10],[38,10],[38,14],[38,18]],
        [[46,2],[46,6],[46,10],[46,14],[46,18],[50,18],[54,18],[54,14],[54,10],[50,10]],
        [[62,18],[62,14],[62,10],[62,2]],
        [[70,18],[70,14],[70,10],[74,10],[78,10],[78,14],[78,18]]
      ];
      var segs = [], t = 0;
      letters.forEach(function (pts) {{
        pts.forEach(function (p, i) {{
          segs.push({{ x: p[0], y: p[1], d: t }});
          if (i + 1 < pts.length) {{
            var n = pts[i + 1];
            segs.push({{ x: (p[0] + n[0]) / 2, y: (p[1] + n[1]) / 2, d: t + 9 }});
          }}
          t += 18;
        }});
        t += 22;
      }});
      var fullDur = Math.round(t);
      fullSvg.querySelectorAll('circle, rect').forEach(function (el) {{
        var isHole = el.getAttribute('fill') === 'none';
        el.classList.add(isHole ? 'pb-hole' : 'pb-lit');
        if (isHole) return;
        var isCircle = el.tagName.toLowerCase() === 'circle';
        var cx = isCircle ? Number(el.getAttribute('cx') || 0) : Number(el.getAttribute('x') || 0) + Number(el.getAttribute('width') || 0) / 2;
        var cy = isCircle ? Number(el.getAttribute('cy') || 0) : Number(el.getAttribute('y') || 0) + Number(el.getAttribute('height') || 0) / 2;
        var best = segs[0], bestDist = Infinity;
        for (var i = 0; i < segs.length; i++) {{
          var d = Math.hypot(cx - segs[i].x, cy - segs[i].y);
          if (d < bestDist) {{ bestDist = d; best = segs[i]; }}
        }}
        el.style.setProperty('--d', Math.round(best.d) + 'ms');
      }});
      var iDots = Array.prototype.filter.call(fullSvg.querySelectorAll('circle.pb-lit'), function (c) {{
        var cx = Number(c.getAttribute('cx')), cy = Number(c.getAttribute('cy'));
        return cy === 2 && (cx === 22 || cx === 62);
      }});
      iDots.forEach(function (d) {{ d.classList.add('pb-idot'); }});
      var reduced = function () {{ return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }};
      var rand = function () {{
        if (window.crypto && crypto.getRandomValues) {{
          var a = new Uint32Array(1);
          crypto.getRandomValues(a);
          return a[0] / 4294967296;
        }}
        return Math.random();
      }};
      var colors = ['#ff0000', '#00cc00', '#0000ff'];
      var pick = function () {{ return colors[Math.floor(rand() * colors.length)]; }};
      var hovering = false, pulseTimer = null, resets = [];
      var trigger = function () {{
        if (reduced() || mark.classList.contains('pulse')) return;
        mark.style.setProperty('--pb-cur', pick());
        resets.forEach(function (fn) {{ fn(); }});
        mark.classList.add('pulse');
        clearTimeout(pulseTimer);
        pulseTimer = setTimeout(function () {{ mark.classList.remove('pulse'); }}, fullDur + 480);
      }};
      mark.addEventListener('mouseenter', function () {{ hovering = true; trigger(); }});
      mark.addEventListener('mouseleave', function () {{ hovering = false; }});
      mark.addEventListener('click', trigger);
      var firstIdx = iDots.length > 1 && rand() < 0.5 ? 1 : 0;
      iDots.forEach(function (dot, idx) {{
        var t1 = null, t2 = null, t3 = null;
        var clearAll = function () {{ clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); dot.style.fill = ''; }};
        var schedule = function (minW, maxW) {{
          t1 = setTimeout(function () {{
            if (hovering || mark.classList.contains('pulse') || reduced()) {{ schedule(900, 2600); return; }}
            dot.style.fill = pick();
            t2 = setTimeout(function () {{
              dot.style.fill = '';
              t3 = setTimeout(function () {{ schedule(1400, 4800); }}, 620);
            }}, Math.round(850 + rand() * 350));
          }}, Math.round(minW + rand() * (maxW - minW)));
        }};
        resets.push(function () {{
          clearAll();
          var fast = rand() < 0.5;
          schedule(fast ? 900 : 2400, fast ? 2000 : 4800);
        }});
        schedule(idx === firstIdx ? 300 : 1800, idx === firstIdx ? 850 : 3600);
      }});
    }})();
  </script>
</body>
</html>"""


def is_guest_path(path: str) -> bool:
    return path == "/guest" or path.startswith("/guest/")


def is_allowed_guest_resource(path: str) -> bool:
    if path in _GUEST_ALLOWED_EXACT:
        return True
    if path.startswith("/guest/static/") or path.startswith("/guest/images/"):
        return True
    m_proj = _GUEST_PROJECT_DETAIL_RE.match(path)
    if m_proj and m_proj.group(1) != "new":
        return True
    if _GUEST_PROJECT_CODE_API_RE.match(path):
        return True
    if _GUEST_BENCH_SUBTAB_RE.match(path):
        return True
    return False


def _locked_page_csp() -> str:
    page = render_guest_locked_html()
    m = re.search(r"<script>(.*?)</script>", page, re.DOTALL)
    if not m:
        return _APP_CSP
    digest = base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode("ascii")
    return _APP_CSP.replace("script-src 'self';", f"script-src 'self' 'sha256-{digest}';")


def _apply_security_headers(response: Response, path: str, *, is_locked_page: bool = False) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Content-Security-Policy", _locked_page_csp() if is_locked_page else _APP_CSP)
    if path.startswith("/static/js/") or path.startswith("/guest/static/js/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _is_cross_site_csrf(request: Request) -> bool:
    """Block cross-site browser mutations (e.g. HTML form POSTs to multipart/body-less endpoints)."""
    sec_fetch_site = (request.headers.get("sec-fetch-site") or "").strip().lower()
    if sec_fetch_site == "cross-site":
        return True
    origin = (request.headers.get("origin") or "").strip()
    if origin:
        if origin.lower() == "null":
            return True
        try:
            origin_host = urlparse(origin).netloc.lower()
        except Exception:
            return True
        expected_hosts = {
            h.strip().lower()
            for h in (
                request.headers.get("host", ""),
                request.headers.get("x-forwarded-host", "").split(",")[0],
            )
            if h.strip()
        }
        if expected_hosts and origin_host not in expected_hosts:
            return True
    return False


class CloudflareAccessMiddleware(BaseHTTPMiddleware):
    """Validates Cloudflare Access JWTs on owner routes and enforces strict read-only isolation on /guest/*."""

    def __init__(self, app, settings: Settings) -> None:
        super().__init__(app)
        self.settings = settings
        self._jwks_client: PyJWKClient | None = None
        self._guest_pass_hits: dict[str, deque[float]] = {}

    def _get_jwks_client(self) -> PyJWKClient:
        if self._jwks_client is None:
            jwks_url = f"{self.settings.cf_team_domain}/cdn-cgi/access/certs"
            self._jwks_client = PyJWKClient(jwks_url, cache_keys=True, lifespan=3600)
        return self._jwks_client

    def _verify_token(self, token: str) -> dict:
        client = self._get_jwks_client()
        signing_key = client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=self.settings.cf_policy_aud,
            issuer=self.settings.cf_team_domain,
        )

    def _check_guest_pass_rate_limit(self, request: Request) -> bool:
        client_ip = (
            (request.headers.get("cf-connecting-ip") or "").strip()
            or (request.client.host if request.client else "unknown")
        )
        now = time.monotonic()
        cutoff = now - _GUEST_PASS_RATE_WINDOW_SEC
        bucket = self._guest_pass_hits.setdefault(client_ip, deque())
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= _GUEST_PASS_RATE_MAX:
            return False
        bucket.append(now)
        if len(self._guest_pass_hits) > 500:
            for ip_key in list(self._guest_pass_hits.keys()):
                b = self._guest_pass_hits[ip_key]
                while b and b[0] < cutoff:
                    b.popleft()
                if not b:
                    del self._guest_pass_hits[ip_key]
        return True

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if path == "/healthz":
            return _apply_security_headers(await call_next(request), path)

        # Strict, isolated read-only boundary for /guest/* (never grants owner access)
        if is_guest_path(path):
            request.state.is_guest = True
            if request.method not in ("GET", "HEAD"):
                return _apply_security_headers(
                    JSONResponse(status_code=403, content={"detail": "Guest pass is read-only"}),
                    path,
                )

            if path.startswith("/guest/pass/"):
                if not self._check_guest_pass_rate_limit(request):
                    resp = HTMLResponse(
                        status_code=429,
                        content=render_guest_locked_html(
                            "Too many attempts",
                            "Please wait a minute before trying this link again.",
                        ),
                    )
                    resp.headers["Cache-Control"] = "no-store"
                    return _apply_security_headers(resp, path, is_locked_page=True)
                resp = await call_next(request)
                is_locked = resp.status_code in (401, 403, 429) and "text/html" in (resp.headers.get("content-type") or "")
                return _apply_security_headers(resp, path, is_locked_page=is_locked)

            if path == "/guest/logout" or path in _GUEST_PUBLIC_ASSETS:
                return _apply_security_headers(await call_next(request), path)

            cookie_val = request.cookies.get(GUEST_COOKIE_NAME, "")
            if not verify_guest_session_cookie(self.settings.db_path, cookie_val):
                if (
                    path.startswith("/guest/api/")
                    or path.startswith("/guest/static/")
                    or path.startswith("/guest/images/")
                ):
                    return _apply_security_headers(
                        JSONResponse(status_code=401, content={"detail": "Guest pass required or revoked"}),
                        path,
                    )
                resp = HTMLResponse(status_code=401, content=render_guest_locked_html())
                resp.headers["Cache-Control"] = "no-store"
                return _apply_security_headers(resp, path, is_locked_page=True)

            if not is_allowed_guest_resource(path):
                if path.startswith("/guest/api/"):
                    return _apply_security_headers(
                        JSONResponse(status_code=403, content={"detail": "Not available in guest mode"}),
                        path,
                    )
                return _apply_security_headers(
                    JSONResponse(status_code=404, content={"detail": "Not found"}),
                    path,
                )

            return _apply_security_headers(await call_next(request), path)

        request.state.is_guest = False

        # CSRF check on browser state-changing requests (exempt /mcp which authenticates via Bearer/Service Token)
        if request.method not in ("GET", "HEAD", "OPTIONS") and path != "/mcp":
            if _is_cross_site_csrf(request):
                return _apply_security_headers(
                    JSONResponse(status_code=403, content={"detail": "Cross-site request blocked"}),
                    path,
                )

        if self.settings.local_dev_mode:
            return _apply_security_headers(await call_next(request), path)

        token = request.headers.get("Cf-Access-Jwt-Assertion", "").strip()
        if not token:
            return _apply_security_headers(
                JSONResponse(status_code=401, content={"detail": "Missing Cloudflare Access JWT assertion"}),
                path,
            )

        try:
            claims = await asyncio.to_thread(self._verify_token, token)
            request.state.cf_user = claims.get("email") or claims.get("sub")
        except Exception:
            return _apply_security_headers(
                JSONResponse(status_code=401, content={"detail": "Invalid or expired Cloudflare Access token"}),
                path,
            )

        return _apply_security_headers(await call_next(request), path)
