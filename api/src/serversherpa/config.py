"""Application configuration.

All configuration is read from environment variables (prefix ``SS_``),
falling back to the repository-root ``.env`` file in development.
This module is the ONLY place configuration is read; the rest of the
codebase imports ``get_settings()``.
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# repo root = two levels up from api/src/serversherpa/config.py -> api/ -> root
_REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SS_",
        env_file=_REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",  # .env also holds compose-only vars (POSTGRES_*, MINIO_*)
        frozen=True,
    )

    # ── Runtime ────────────────────────────────────────────
    env: Literal["development", "staging", "production"]
    log_level: str = "INFO"
    api_base_url: str
    # portal origin probed by the log-service for the 'web' registry row
    portal_origin: str = "http://localhost:5173"

    # ── Database ───────────────────────────────────────────
    database_url: SecretStr
    database_ssl: Literal["require", "disable"] = "require"
    database_pool_size: int = 10
    database_pool_max_overflow: int = 20

    # ── Auth / crypto ──────────────────────────────────────
    jwt_secret: SecretStr
    access_token_ttl_seconds: int = 900
    # Absolute session lifetime from login; refresh tokens rotate within the
    # window but every rotation inherits the original login's deadline.
    session_ttl_seconds: int = 86_400
    totp_encryption_key: SecretStr
    password_pepper: SecretStr
    # one bar for every password the API accepts (self-change, admin reset,
    # temp passwords); SS_PASSWORD_MIN_LENGTH overrides
    password_min_length: int = 8
    max_failed_logins: int = 10       # failures before temporary lockout
    lockout_seconds: int = 900        # lockout duration (15 min)

    # ── Scans ──────────────────────────────────────────────
    scans_history_default: int = Field(100, ge=1)  # history rows when caller omits limit

    # ── God mode ───────────────────────────────────────────
    # Comma-separated secret words that reveal the developer nav section.
    # MUST stay server-side: a VITE_* equivalent is inlined into the JS
    # bundle and greppable from devtools. Empty = feature disabled.
    god_mode_words: SecretStr = SecretStr("")
    god_mode_nav_color: str = "#00c853"

    # ── CORS / cookies ─────────────────────────────────────
    allowed_origins: str = ""
    cookie_domain: str = ""

    # ── Object storage ─────────────────────────────────────
    spaces_endpoint: str
    spaces_region: str
    spaces_bucket: str
    spaces_access_key: SecretStr
    spaces_secret_key: SecretStr
    spaces_presign_ttl_seconds: int = 600
    spaces_use_path_style: bool = False

    # ── Email ──────────────────────────────────────────────
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_starttls: bool = True
    smtp_from: str = ""

    # ── Observability ──────────────────────────────────────
    sentry_dsn: str = ""

    # ── Labels ─────────────────────────────────────────────
    labelary_base_url: str = "https://api.labelary.com"

    # ── AI assistant ───────────────────────────────────────
    ai_enabled: bool = False
    ai_base_url: str = "http://localhost:11434/v1"
    ai_model: str = "qwen3:8b"
    ai_timeout_seconds: float = 60.0

    @property
    def sync_database_url(self) -> str:
        """Database URL for synchronous drivers (Alembic uses psycopg)."""
        return self.database_url.get_secret_value().replace(
            "postgresql+asyncpg://", "postgresql+psycopg://"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
