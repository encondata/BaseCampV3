"""Kiosk 'link with phone' pairing — pure helpers plus the DB rules the
/kiosk/pair routes apply. Codes are 8 Crockford base32 characters (40
bits), live PAIR_TTL_SECONDS, and can only be claimed by the holder of
the poll token handed to the kiosk once at creation (only its sha256 is
stored). PAIR_IP_LIMIT creations per IP per PAIR_IP_WINDOW_SECONDS,
counted from the table (no in-memory state, so every API worker agrees).
Design:
docs/superpowers/specs/2026-09-13-kiosk-web-design.md"""

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import KioskPairRequest

# Crockford base32: no I, L, O, U — nothing a person misreads or mistypes
CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 8
PAIR_TTL_SECONDS = 300
PAIR_IP_LIMIT = 30
PAIR_IP_WINDOW_SECONDS = 300
CLEANUP_AGE_SECONDS = 86400

PairStatus = Literal["pending", "approved", "denied", "expired"]


class PairError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def normalize_code(raw: str) -> str:
    """What a person typed → what we stored: uppercase, no dashes/spaces."""
    return raw.strip().upper().replace("-", "").replace(" ", "")


def generate_poll_token() -> str:
    return secrets.token_urlsafe(32)


def hash_poll_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def poll_token_matches(token: str, hashed: str) -> bool:
    return hmac.compare_digest(hash_poll_token(token), hashed)


def link_url(code: str) -> str:
    return f"{get_settings().portal_origin.rstrip('/')}/link/{code}"


def effective_status(row: KioskPairRequest, now: datetime) -> PairStatus:
    """Stored status + the clock. A claimed row reads as expired: the
    one-shot code is spent and the kiosk must never see 'approved' twice."""
    if row.status == "claimed":
        return "expired"
    if row.status in ("pending", "approved") and now >= row.expires_at:
        return "expired"
    return row.status  # type: ignore[return-value]  # pending | approved | denied


async def create_request(
    db: AsyncSession, *, serial: str, name: str, ip: str,
) -> tuple[KioskPairRequest, str]:
    """Insert a pending request; returns (row, plaintext poll token).
    Raises PairError("pair_rate_limited") past the per-IP cap."""
    now = datetime.now(UTC)
    await db.execute(delete(KioskPairRequest).where(
        KioskPairRequest.created_at < now - timedelta(seconds=CLEANUP_AGE_SECONDS)))
    recent = await db.scalar(
        select(func.count()).select_from(KioskPairRequest).where(
            KioskPairRequest.ip_address == ip,
            KioskPairRequest.created_at >= now - timedelta(seconds=PAIR_IP_WINDOW_SECONDS)))
    if (recent or 0) >= PAIR_IP_LIMIT:
        raise PairError("pair_rate_limited")

    code = generate_code()
    while await db.scalar(select(KioskPairRequest.id).where(KioskPairRequest.code == code)):
        code = generate_code()
    token = generate_poll_token()
    row = KioskPairRequest(
        code=code, poll_token_hash=hash_poll_token(token), serial=serial,
        kiosk_name=name, ip_address=ip,
        expires_at=now + timedelta(seconds=PAIR_TTL_SECONDS),
        created_at=now, updated_at=now)
    db.add(row)
    await db.commit()
    return row, token


async def get_by_code(db: AsyncSession, raw_code: str) -> KioskPairRequest | None:
    code = normalize_code(raw_code)
    if len(code) != CODE_LENGTH:
        return None
    return await db.scalar(select(KioskPairRequest).where(KioskPairRequest.code == code))
