"""TOTP pieces ported from the portal (serversherpa/services/totp.py):
seeds are Fernet tokens under SS_TOTP_ENCRYPTION_KEY, codes are 6 digits
/ 30 s with ±1 step of drift and no replays, backup codes are 10
lowercase alphanumerics hashed like passwords."""

import hmac
from datetime import UTC, datetime

import pyotp
from cryptography.fernet import Fernet, InvalidToken

BACKUP_CODE_LENGTH = 10


class TotpSeedError(Exception):
    """The stored seed does not decrypt with the configured key."""


def _fernet(key: str) -> Fernet:
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise TotpSeedError("SS_TOTP_ENCRYPTION_KEY is not a valid Fernet key") from exc


def encrypt_secret(secret: str, *, key: str) -> bytes:
    return _fernet(key).encrypt(secret.encode())


def decrypt_secret(blob: bytes, *, key: str) -> str:
    try:
        return _fernet(key).decrypt(bytes(blob)).decode()
    except InvalidToken as exc:
        raise TotpSeedError("stored TOTP seed does not decrypt with SS_TOTP_ENCRYPTION_KEY") from exc


def match_counter(secret: str, code: str, last_counter: int | None, *,
                  now: datetime | None = None) -> int | None:
    """The time-step counter `code` belongs to (±1 step), or None when it
    matches nothing new. A counter at or below `last_counter` is a replay."""
    otp = pyotp.TOTP(secret, digits=6, interval=30)
    base = otp.timecode(now or datetime.now(UTC))
    for offset in (0, -1, 1):
        counter = base + offset
        if hmac.compare_digest(otp.generate_otp(counter), code):
            if last_counter is not None and counter <= last_counter:
                return None
            return counter
    return None


def compact_code(code: str) -> str:
    """Authenticator apps often show "123 456"."""
    return "".join(code.split())


def is_app_code(compact: str) -> bool:
    return compact.isdigit() and len(compact) == 6


def normalize_backup(code: str) -> str:
    return "".join(ch for ch in code.lower() if ch.isalnum())
