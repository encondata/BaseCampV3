"""Sealed secrets: Fernet, keyed by DEVICES_SECRET_KEY. Used for the Apple
certificate, its password and the .p8 key."""

from cryptography.fernet import Fernet, InvalidToken

from serversherpa_devices.config import get_settings


class SecretError(Exception):
    """The sealed data is tampered with, truncated or sealed under another key."""


def _fernet() -> Fernet:
    return Fernet(get_settings().secret_key.get_secret_value().encode())


def seal(data: bytes) -> bytes:
    return _fernet().encrypt(data)


def unseal(token: bytes) -> bytes:
    try:
        return _fernet().decrypt(token)
    except (InvalidToken, ValueError, TypeError):
        raise SecretError("sealed data is invalid") from None
