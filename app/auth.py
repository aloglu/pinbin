from __future__ import annotations

import jwt
from jwt import PyJWKClient
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.config import Settings


PUBLIC_ICON_PATHS = frozenset(
    {
        "/manifest.webmanifest",
        "/apple-touch-icon.png",
        "/apple-touch-icon-precomposed.png",
        "/static/brand/apple-touch-icon.png",
        "/static/brand/icon-192.png",
        "/static/brand/icon-512.png",
        "/static/brand/favicon.svg",
    }
)


class CloudflareAccessMiddleware(BaseHTTPMiddleware):
    """Validates Cloudflare Access JWTs on every route except /healthz and public web-app icons when LOCAL_DEV_MODE=false."""

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
        if request.url.path == "/healthz":
            return await call_next(request)

        if request.method in ("GET", "HEAD") and request.url.path in PUBLIC_ICON_PATHS:
            return await call_next(request)

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
