from __future__ import annotations

import re

import jwt
from jwt import PyJWKClient
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response

from app.config import Settings
from app.db import GUEST_COOKIE_NAME, verify_guest_session_cookie

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
_GUEST_PROJECT_DETAIL_RE = re.compile(r"^/guest/projects/([^/]+)$")
_GUEST_BENCH_SUBTAB_RE = re.compile(r"^/guest/bench/([^/]+)$")

GUEST_LOCKED_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Pinbin · Guest Pass</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #ECEDEA; color: #191918;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1E1D1B; color: #ECEBE8; }
      .card { background: #262522; border-color: #383632; }
      p { color: #A6A49E; }
    }
    .card {
      max-width: 420px; width: 100%; padding: 24px; border-radius: 10px;
      background: #F7F7F5; border: 1px solid #D9DBD5;
    }
    h1 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
    p { margin: 0; color: #565853; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Guest pass required</h1>
    <p>This read-only link is missing, invalid, or has been turned off by the owner.</p>
  </main>
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
    if _GUEST_BENCH_SUBTAB_RE.match(path):
        return True
    return False


class CloudflareAccessMiddleware(BaseHTTPMiddleware):
    """Validates Cloudflare Access JWTs on owner routes and enforces strict read-only isolation on /guest/*."""

    def __init__(self, app, settings: Settings) -> None:
        super().__init__(app)
        self.settings = settings
        self._jwks_client: PyJWKClient | None = None

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

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if path == "/healthz":
            return await call_next(request)

        # Strict, isolated read-only boundary for /guest/* (never grants owner access)
        if is_guest_path(path):
            request.state.is_guest = True
            if request.method not in ("GET", "HEAD"):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Guest pass is read-only"},
                )

            if path.startswith("/guest/pass/") or path == "/guest/logout":
                return await call_next(request)

            cookie_val = request.cookies.get(GUEST_COOKIE_NAME, "")
            if not verify_guest_session_cookie(self.settings.db_path, cookie_val):
                if (
                    path.startswith("/guest/api/")
                    or path.startswith("/guest/static/")
                    or path.startswith("/guest/images/")
                ):
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "Guest pass required or revoked"},
                    )
                resp = HTMLResponse(status_code=401, content=GUEST_LOCKED_HTML)
                resp.headers["Cache-Control"] = "no-store"
                return resp

            if not is_allowed_guest_resource(path):
                if path.startswith("/guest/api/"):
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "Not available in guest mode"},
                    )
                return JSONResponse(
                    status_code=404,
                    content={"detail": "Not found"},
                )

            return await call_next(request)

        request.state.is_guest = False
        if self.settings.local_dev_mode:
            return await call_next(request)

        token = request.headers.get("Cf-Access-Jwt-Assertion", "").strip()
        if not token:
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing Cloudflare Access JWT assertion"},
            )

        try:
            claims = self._verify_token(token)
            request.state.cf_user = claims.get("email") or claims.get("sub")
        except Exception:
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or expired Cloudflare Access token"},
            )

        return await call_next(request)
