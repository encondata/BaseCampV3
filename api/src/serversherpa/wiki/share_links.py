"""Public share links (spec §8): the non-HTTP rules behind
`routes/wiki/share_links.py` (create/list/revoke, signed in) and
`routes/wiki/public.py` (the unauthenticated read).

A link's token is 32 random bytes (`secrets.token_urlsafe`), shown once
in the URL `POST /wiki/nodes/{id}/share-links` returns and never stored:
the table keeps only its sha256 hex digest, and a public read looks the
link up by that digest.

`public_limiter` is the public read's abuse cap: at most
PUBLIC_RATE_LIMIT requests per PUBLIC_RATE_WINDOW_SECONDS per client
address (`api.deps.rate_limit_ip` picks the address; an IPv6 one counts
as its /64), in a table of bounded size. The API has no
shared rate limiter to reuse — `rate_limit_ip` only chooses the key, and
kiosk pairing counts its own rows — so this is a small fixed-window
counter in process memory: per API process, and reset by a restart. It
is a cap on scraping one process, not an exact global quota."""
from __future__ import annotations

import hashlib
import ipaddress
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


def bucket_for(address: str) -> str:
    """The rate-limit key for a client address: an IPv6 address counts as
    its /64 (one subscriber usually holds a whole /64, so per-address
    buckets would be free to rotate through); an IPv4 address, an
    IPv4-mapped IPv6 one, and anything unparseable ('unknown') count as
    themselves."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return address
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.IPv6Network((ip, 64), strict=False))
    return str(ip)


class IpRateLimiter:
    """At most `limit` hits per bucket (`bucket_for`) in each fixed
    `window_seconds` window, in a table of at most `max_keys` buckets.

    A new bucket arriving at a full table triggers a sweep of the windows
    that have passed — at most one sweep per window, so a flood of new
    addresses can't make every request pay for one. If the sweep frees
    nothing, the oldest buckets are evicted down to three quarters of the
    cap. Once the window's sweep is spent, a new bucket finding the table
    full is refused (the caller answers 429) until the next window."""

    def __init__(self, *, limit: int, window_seconds: float, max_keys: int = 10_000):
        self.limit = limit
        self.window = window_seconds
        self.max_keys = max_keys
        # insertion order = window-start order: a bucket whose window
        # restarts is moved to the end, so eviction takes the oldest first
        self._hits: dict[str, tuple[float, int]] = {}
        self._last_sweep = float("-inf")
        self._lock = threading.Lock()

    def _sweep(self, now: float) -> None:
        """Drop expired buckets; if the table is still full, the oldest."""
        self._hits = {k: v for k, v in self._hits.items() if now - v[0] < self.window}
        excess = len(self._hits) - self.max_keys * 3 // 4
        if len(self._hits) >= self.max_keys and excess > 0:
            for key in list(self._hits)[:excess]:
                del self._hits[key]

    def hit(self, address: str, now: float | None = None) -> bool:
        """Count one request from `address`; False when it's over the limit
        (or it's a new bucket and the table is full)."""
        now = time.monotonic() if now is None else now
        key = bucket_for(address)
        with self._lock:
            entry = self._hits.get(key)
            if entry is None and len(self._hits) >= self.max_keys:
                if now - self._last_sweep < self.window:
                    return False
                self._last_sweep = now
                self._sweep(now)   # always leaves room: at most 3/4 full
            if entry is not None and now - entry[0] >= self.window:
                del self._hits[key]
                entry = None
            start, count = entry if entry is not None else (now, 0)
            if count >= self.limit:
                return False
            self._hits[key] = (start, count + 1)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
            self._last_sweep = float("-inf")


public_limiter = IpRateLimiter(limit=PUBLIC_RATE_LIMIT,
                               window_seconds=PUBLIC_RATE_WINDOW_SECONDS)
