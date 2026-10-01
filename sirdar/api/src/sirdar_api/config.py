"""Sirdar settings. Everything Sirdar-specific is SIRDAR_*; the password
pepper and the TOTP key keep the portal's SS_* names because they MUST
equal the portal's values (copied password hashes and 2FA seeds only
verify with the same ones)."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# sirdar/api/src/sirdar_api/config.py -> sirdar/
_SIRDAR_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SIRDAR_",
        env_file=_SIRDAR_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    env: Literal["development", "staging", "production"] = "production"

    database_url: SecretStr                      # postgresql+asyncpg://…
    database_ssl: Literal["require", "disable"] = "disable"
    # The portal's Postgres, read only. Unset = import disabled.
    source_database_url: SecretStr | None = None

    jwt_secret: SecretStr
    access_token_ttl_seconds: int = 900
    # Absolute session lifetime from login; refresh rotations inherit it.
    session_ttl_seconds: int = 86_400
    max_failed_logins: int = 10
    lockout_seconds: int = 900
    # Same bar as the portal (SS_PASSWORD_MIN_LENGTH, default 8); applies to
    # local passwords set with the CLI. SIRDAR_PASSWORD_MIN_LENGTH overrides.
    password_min_length: int = 8
    cookie_domain: str = ""
    # Built SPA directory; empty = API only (local dev uses Vite).
    static_dir: str = ""

    password_pepper: SecretStr = Field(
        validation_alias=AliasChoices("SS_PASSWORD_PEPPER", "SIRDAR_PASSWORD_PEPPER"))
    totp_encryption_key: SecretStr = Field(
        validation_alias=AliasChoices("SS_TOTP_ENCRYPTION_KEY", "SIRDAR_TOTP_ENCRYPTION_KEY"))

    @field_validator("jwt_secret")
    @classmethod
    def _jwt_secret_long_enough(cls, v: SecretStr) -> SecretStr:
        if len(v.get_secret_value()) < 32:
            raise ValueError("SIRDAR_JWT_SECRET must be at least 32 characters")
        return v

    @field_validator("password_pepper", "totp_encryption_key")
    @classmethod
    def _not_empty(cls, v: SecretStr) -> SecretStr:
        if not v.get_secret_value():
            raise ValueError("must not be empty")
        return v

    @property
    def sync_database_url(self) -> str:
        """Alembic runs synchronously on psycopg."""
        return self.database_url.get_secret_value().replace(
            "postgresql+asyncpg://", "postgresql+psycopg://")


@lru_cache
def get_settings() -> Settings:
    return Settings()
