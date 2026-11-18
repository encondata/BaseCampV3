"""Signed install-link tokens (APK download, iOS manifest, IPA): HS256 over
a key derived from DEVICES_SECRET_KEY, so the raw key never signs anything."""

import hashlib
import hmac
import time
import uuid
from typing import Literal

import jwt

from serversherpa_devices.config import get_settings


class LinkError(Exception):
    """The install token is expired, for another kind of link, or not ours."""


def _key() -> bytes:
    return hmac.new(get_settings().secret_key.get_secret_value().encode(),
                    b"devices-install-links", hashlib.sha256).digest()


def make_install_token(*, kind: Literal["apk", "manifest", "ipa"], ref: uuid.UUID,
                       ttl_seconds: int = 1800) -> str:
    return jwt.encode({"k": kind, "r": str(ref), "exp": int(time.time()) + ttl_seconds},
                      _key(), algorithm="HS256")


def read_install_token(token: str, *, kind: str) -> uuid.UUID:
    try:
        claims = jwt.decode(token, _key(), algorithms=["HS256"],
                            options={"require": ["exp", "k", "r"]})
        if claims["k"] != kind:
            raise LinkError("wrong kind of link")
        return uuid.UUID(claims["r"])
    except (jwt.InvalidTokenError, ValueError, TypeError):
        raise LinkError("invalid install link") from None
