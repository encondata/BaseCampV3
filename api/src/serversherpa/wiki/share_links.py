"""Public share links (spec §8): the non-HTTP rules behind
`routes/wiki/share_links.py` (create/list/revoke, signed in) and
`routes/wiki/public.py` (the unauthenticated read).

A link's token is 32 random bytes (`secrets.token_urlsafe`), shown once
in the URL `POST /wiki/nodes/{id}/share-links` returns and never stored:
the table keeps only its sha256 hex digest, and a public read looks the
link up by that digest.

`public_limiter` is the public read's abuse cap: at most
PUBLIC_RATE_LIMIT requests per PUBLIC_RATE_WINDOW_SECONDS per client
address (`api.deps.rate_limit_ip` picks the address). The API has no
shared rate limiter to reuse — `rate_limit_ip` only chooses the key, and
kiosk pairing counts its own rows — so this is a small fixed-window
counter in process memory: per API process, and reset by a restart. It
is a cap on scraping one process, not an exact global quota."""
from __future__ import annotations

import hashlib
import secrets
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Literal

from serversherpa.config import get_settings
from serversherpa.db.models import WikiShareLink

# what a link may be created with; None = never expires
EXPIRY_DAYS = (1, 7, 30, 90)
DEFAULT_EXPIRY_DAYS = 30

# a token_urlsafe(32) is 43 characters; anything much longer is not one
# of ours and isn't worth hashing
MAX_TOKEN_LENGTH = 128

# presigned URLs a public read hands out live at most this long
PUBLIC_URL_TTL_SECONDS = 600

PUBLIC_RATE_LIMIT = 60
PUBLIC_RATE_WINDOW_SECONDS = 60

LinkStatus = Literal["active", "expired", "revoked"]


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def share_url(token: str) -> str:
    """Where the wiki SPA serves a shared node: `/p/<token>`."""
    return f"{get_settings().wiki_origin.rstrip('/')}/p/{token}"


def expires_at_for(days: int | None, now: datetime) -> datetime | None:
    return None if days is None else now + timedelta(days=days)


def link_status(link: WikiShareLink, now: datetime | None = None) -> LinkStatus:
    """Revoked wins over expired; a link with no expiry never expires."""
    if link.revoked_at is not None:
        return "revoked"
    now = now or datetime.now(UTC)
    if link.expires_at is not None and link.expires_at <= now:
        return "expired"
    return "active"


class IpRateLimiter:
    """At most `limit` hits per key in each fixed `window_seconds` window.
    Keys whose window has passed are swept once the table grows past
    `sweep_at` entries, so a flood of distinct addresses can't grow it
    without bound."""

    def __init__(self, *, limit: int, window_seconds: float, sweep_at: int = 10_000):
        self.limit = limit
        self.window = window_seconds
        self.sweep_at = sweep_at
        self._hits: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, now: float | None = None) -> bool:
        """Count one request from `key`; False when it's over the limit."""
        now = time.monotonic() if now is None else now
        with self._lock:
            if len(self._hits) >= self.sweep_at:
                self._hits = {k: v for k, v in self._hits.items()
                              if now - v[0] < self.window}
            start, count = self._hits.get(key, (now, 0))
            if now - start >= self.window:
                start, count = now, 0
            if count >= self.limit:
                return False
            self._hits[key] = (start, count + 1)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


public_limiter = IpRateLimiter(limit=PUBLIC_RATE_LIMIT,
                               window_seconds=PUBLIC_RATE_WINDOW_SECONDS)
