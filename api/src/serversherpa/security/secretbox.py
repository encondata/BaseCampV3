"""Reversible secrets at rest (2FA seeds, move passwords): Fernet with
SS_TOTP_ENCRYPTION_KEY. Hashing stays in security/passwords.py — this is
only for values that must be read back."""

from cryptography.fernet import Fernet

from serversherpa.config import get_settings


def fernet() -> Fernet:
    key = get_settings().totp_encryption_key.get_secret_value()
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise RuntimeError("SS_TOTP_ENCRYPTION_KEY is not a valid Fernet key") from exc


def encrypt(text: str) -> str:
    return fernet().encrypt(text.encode()).decode()


def decrypt(token: str) -> str:
    return fernet().decrypt(token.encode()).decode()
