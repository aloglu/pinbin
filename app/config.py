from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

CATEGORIES: list[str] = [
    "Microcontrollers",
    "Sensors",
    "Displays",
    "Actuators",
    "Passives",
    "Prototyping",
    "Tools",
]


def _parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _parse_int(value: str | None, default: int, minimum: int = 0) -> int:
    if value is None or not value.strip():
        return default
    try:
        parsed = int(value.strip())
        return max(minimum, parsed)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    local_dev_mode: bool
    cf_team_domain: str
    cf_policy_aud: str
    ai_provider: str
    ai_api_key: str
    ai_model: str
    ai_base_url: str
    ai_reasoning_effort: str
    ai_daily_limit: int
    data_dir: Path
    seed_file: Path
    max_upload_mb: int
    mcp_enabled: bool = False
    mcp_read_only: bool = False
    mcp_api_token: str = ""

    @property
    def db_path(self) -> Path:
        return self.data_dir / "inventory.db"

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def ai_enabled(self) -> bool:
        return bool(self.ai_api_key.strip())

    def validate_security(self) -> None:
        """Fail closed if Cloudflare Access is required but not configured."""
        if not self.local_dev_mode:
            missing = []
            if not self.cf_team_domain:
                missing.append("CF_TEAM_DOMAIN")
            if not self.cf_policy_aud:
                missing.append("CF_POLICY_AUD")
            if missing:
                raise RuntimeError(
                    f"Refusing to start: LOCAL_DEV_MODE is false, but required Cloudflare Access "
                    f"settings are missing: {', '.join(missing)}. Set LOCAL_DEV_MODE=true only "
                    f"for local development."
                )
            if not self.cf_team_domain.startswith("https://"):
                raise RuntimeError("Refusing to start: CF_TEAM_DOMAIN must start with https://")

    def __repr__(self) -> str:
        # Ensure AI_API_KEY and MCP_API_TOKEN are never accidentally exposed in logs or tracebacks
        return (
            f"Settings(local_dev_mode={self.local_dev_mode}, "
            f"cf_team_domain={self.cf_team_domain!r}, "
            f"ai_provider={self.ai_provider!r}, "
            f"ai_enabled={self.ai_enabled}, "
            f"ai_daily_limit={self.ai_daily_limit}, "
            f"mcp_enabled={self.mcp_enabled}, "
            f"mcp_read_only={self.mcp_read_only}, "
            f"mcp_token_configured={bool(self.mcp_api_token)}, "
            f"data_dir={str(self.data_dir)!r})"
        )


def load_settings() -> Settings:
    load_dotenv(override=False)

    cf_team_domain = os.environ.get("CF_TEAM_DOMAIN", "").strip().rstrip("/")
    cf_policy_aud = os.environ.get("CF_POLICY_AUD", "").strip()
    ai_provider = os.environ.get("AI_PROVIDER", "gemini").strip().lower() or "gemini"
    ai_api_key = os.environ.get("AI_API_KEY", "").strip()
    ai_model = os.environ.get("AI_MODEL", "gemini-3.5-flash-lite").strip() or "gemini-3.5-flash-lite"
    ai_base_url = os.environ.get("AI_BASE_URL", "").strip().rstrip("/")
    ai_reasoning_effort = os.environ.get("AI_REASONING_EFFORT", "").strip().lower()

    return Settings(
        local_dev_mode=_parse_bool(os.environ.get("LOCAL_DEV_MODE"), default=False),
        cf_team_domain=cf_team_domain,
        cf_policy_aud=cf_policy_aud,
        ai_provider=ai_provider,
        ai_api_key=ai_api_key,
        ai_model=ai_model,
        ai_base_url=ai_base_url,
        ai_reasoning_effort=ai_reasoning_effort,
        ai_daily_limit=_parse_int(os.environ.get("AI_DAILY_LIMIT"), default=30, minimum=0),
        data_dir=Path(os.environ.get("DATA_DIR", "/data").strip() or "/data"),
        seed_file=Path(os.environ.get("SEED_FILE", "/app/seed.json").strip() or "/app/seed.json"),
        max_upload_mb=_parse_int(os.environ.get("MAX_UPLOAD_MB"), default=10, minimum=1),
        mcp_enabled=_parse_bool(os.environ.get("MCP_ENABLED"), default=False),
        mcp_read_only=_parse_bool(os.environ.get("MCP_READ_ONLY"), default=False),
        mcp_api_token=os.environ.get("MCP_API_TOKEN", "").strip(),
    )
