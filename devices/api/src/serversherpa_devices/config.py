"""Devices service settings. Everything is DEVICES_*; the service token also
accepts the main API's name (SS_DEVICES_SERVICE_TOKEN), since both sides must
hold the same value."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from cryptography.fernet import Fernet
from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# devices/api/src/serversherpa_devices/config.py -> devices/
_DEVICES_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="DEVICES_",
        env_file=_DEVICES_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
        frozen=True,
    )

    env: Literal["development", "staging", "production"] = "production"

    database_url: SecretStr                      # postgresql+asyncpg://…
    database_ssl: Literal["require", "disable"] = "disable"
    # A managed database's CA, base64 PEM (the stack's SS_DATABASE_CA_B64):
    # with "require", the server is verified against it (see db/tls.py).
    database_ca_b64: str = ""

    # The main API, reached internally (e.g. http://localhost:8000).
    main_api_url: str
    # Sent as X-Devices-Service-Token; equals the main API's SS_DEVICES_SERVICE_TOKEN.
    service_token: SecretStr = Field(
        validation_alias=AliasChoices("DEVICES_SERVICE_TOKEN", "SS_DEVICES_SERVICE_TOKEN"))
    # Fernet key: encrypts the Apple secrets and derives the install-link key.
    secret_key: SecretStr
    # This service's own public origin (e.g. https://devices.dev.serversherpa.com).
    public_url: str
    # The stack that owns iPhone installs, when this one doesn't.
    ios_owner_url: str = ""

    spaces_endpoint: str
    spaces_region: str
    spaces_bucket: str = "serversherpa-devices"
    spaces_access_key: SecretStr
    spaces_secret_key: SecretStr
    spaces_use_path_style: bool = False

    # Built SPA directory; empty = API only (local dev uses Vite).
    static_dir: str = ""
    rcodesign_path: str = "rcodesign"
    # How long an authorize answer from the main API may be reused.
    authorize_cache_seconds: int = 60
    # Every request body, on every path (packages go to the bucket directly).
    max_request_body_bytes: int = 1_048_576

    @field_validator("service_token")
    @classmethod
    def _not_empty(cls, v: SecretStr) -> SecretStr:
        if not v.get_secret_value():
            raise ValueError("must not be empty")
        return v

    @field_validator("secret_key")
    @classmethod
    def _secret_key_is_fernet(cls, v: SecretStr) -> SecretStr:
        try:
            Fernet(v.get_secret_value().encode())
        except (ValueError, TypeError):
            raise ValueError("DEVICES_SECRET_KEY must be a Fernet key "
                             "(44 characters of URL-safe base64)") from None
        return v

    @property
    def sync_database_url(self) -> str:
        """Alembic runs synchronously on psycopg."""
        return self.database_url.get_secret_value().replace(
            "postgresql+asyncpg://", "postgresql+psycopg://")


@lru_cache
def get_settings() -> Settings:
    return Settings()
