"""Access tokens (short-lived JWT), 2FA challenge tokens, and opaque
refresh tokens (only their SHA-256 is stored). Issuer "sirdar", so a
portal token never verifies here even if someone reused the secret."""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt

ISSUER = "sirdar"
CHALLENGE_TTL_SECONDS = 300


class TokenError(Exception):
    pass


def create_access_token(*, person_id: uuid.UUID, session_id: uuid.UUID, secret: str,
                        ttl_seconds: int) -> str:
    now = datetime.now(UTC)
    return jwt.encode({"iss": ISSUER, "sub": str(person_id), "sid": str(session_id),
                       "iat": now, "exp": now + timedelta(seconds=ttl_seconds),
                       "typ": "access"}, secret, algorithm="HS256")


def decode_access_token(token: str, *, secret: str) -> dict:
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"], issuer=ISSUER,
                            options={"require": ["exp", "iat", "sub", "sid"]}, leeway=10)
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    if claims.get("typ") != "access":
        raise TokenError("wrong token type")
    return claims


def create_challenge_token(*, person_id: uuid.UUID, secret: str) -> str:
    now = datetime.now(UTC)
    return jwt.encode({"iss": ISSUER, "sub": str(person_id), "purpose": "verify",
                       "iat": now, "exp": now + timedelta(seconds=CHALLENGE_TTL_SECONDS),
                       "typ": "totp"}, secret, algorithm="HS256")


def decode_challenge_token(token: str, *, secret: str) -> uuid.UUID:
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"], issuer=ISSUER,
                            options={"require": ["exp", "iat", "sub", "purpose"]}, leeway=10)
        if claims.get("typ") != "totp" or claims["purpose"] != "verify":
            raise TokenError("wrong token type")
        return uuid.UUID(claims["sub"])
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    except ValueError as exc:
        raise TokenError("invalid subject") from exc


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(32)  # 256 bits


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
