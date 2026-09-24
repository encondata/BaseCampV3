"""Access tokens (short-lived JWT) and refresh tokens (opaque random).

Refresh tokens are 256-bit random values; only their SHA-256 lands in the
database. Plain SHA-256 (not Argon2) is deliberate: the input is pure
randomness, so the hash cannot be brute-forced, and refresh is a hot path.
"""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt

ISSUER = "serversherpa"


class TokenError(Exception):
    pass


def create_access_token(
    *, person_id: uuid.UUID, session_id: uuid.UUID, secret: str, ttl_seconds: int,
    client: str = "portal",
) -> str:
    """`client` ("portal" | "kiosk") rides along as the `cli` claim. It is
    only a convenience for readers of the token — the authority is
    `auth_sessions.client`, which the gate in deps.py reads on every
    request; tokens minted before this claim existed are portal."""
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "iss": ISSUER,
            "sub": str(person_id),
            "sid": str(session_id),
            "iat": now,
            "exp": now + timedelta(seconds=ttl_seconds),
            "typ": "access",
            "cli": client,
        },
        secret,
        algorithm="HS256",
    )


def decode_access_token(token: str, *, secret: str) -> dict:
    try:
        claims = jwt.decode(
            token, secret, algorithms=["HS256"], issuer=ISSUER,
            options={"require": ["exp", "iat", "sub", "sid"]}, leeway=10,
        )
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    if claims.get("typ") != "access":
        raise TokenError("wrong token type")
    return claims


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(32)  # 256 bits


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
