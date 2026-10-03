"""Per-environment secrets, encrypted with SIRDAR_SECRETS_KEY (Fernet).
decrypt() is the only way a value comes back; its callers hand values
only to the target's .env. Exceptions here carry no message."""

import base64
import os
import secrets

from cryptography.fernet import Fernet, InvalidToken

from sirdar_api.config import Settings
from sirdar_api.deploy import envfile


class SecretsKeyMissing(Exception):
    """SIRDAR_SECRETS_KEY isn't set."""


class SecretUnreadable(Exception):
    """A stored secret doesn't open with the current key."""


def is_configured(settings: Settings) -> bool:
    return settings.secrets_key is not None


def _fernet(settings: Settings) -> Fernet:
    if settings.secrets_key is None:
        raise SecretsKeyMissing()
    return Fernet(settings.secrets_key.get_secret_value().encode())


def encrypt(settings: Settings, value: str) -> bytes:
    return _fernet(settings).encrypt(value.encode())


def decrypt(settings: Settings, token: bytes) -> str:
    try:
        return _fernet(settings).decrypt(bytes(token)).decode()
    except InvalidToken:
        raise SecretUnreadable() from None


def hex_secret() -> str:
    return secrets.token_hex(32)


def fernet_key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode()


def generate_env_secrets() -> dict[str, str]:
    """A new environment's required secrets: hex (safe inside URLs, e.g. the
    Postgres password) or a Fernet key where the app needs one."""
    return {key: fernet_key() if key in envfile.FERNET_SECRETS else hex_secret()
            for key in envfile.REQUIRED_SECRETS}
