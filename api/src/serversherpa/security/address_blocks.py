"""Sign-in address blocking (SS-487).

Ten failed sign-in attempts from one address within a rolling hour block
that address from the sign-in routes. Each new block climbs a ladder:
1 h, 6 h, 12 h, 24 h, then permanent until an admin clears it. The ladder
starts over once 7 days pass after the last block started, or when an
admin clears the block.

The address is the caller's address bucketed by `bucket_for`: IPv4 as
itself, IPv6 by its /64, an IPv4-mapped IPv6 address as the IPv4.
X-Forwarded-For is honored only when the direct peer is loopback or a
trusted proxy from FORWARDED_ALLOW_IPS (the same list uvicorn's
--proxy-headers trusts); any other peer, private or not, is keyed on
itself, so a LAN caller cannot pick the address it is counted as. With
FORWARDED_ALLOW_IPS="*" the older `rate_limit_ip` private-peer rule
applies. Loopback, the trusted proxies themselves and the shared
`unknown` bucket are never counted or blocked: if the proxy stops sending
X-Forwarded-For every caller looks like the proxy, and a block there
would shut everyone out.

Only failures count, and only on the sign-in routes listed below; sessions
already signed in from a blocked address keep working.

Concurrency: `record_failure` holds a per-address advisory lock for its
transaction, so simultaneous failures from one address trip exactly one
block. The global prune and the failure-row deletes use SKIP LOCKED, so
two addresses' transactions never wait on each other's rows."""
from __future__ import annotations

import functools
import ipaddress
import logging
import math
import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import HTTPException, Request
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import DbSession, rate_limit_ip
from serversherpa.db.models import AddressBlock, SignInFailure
from serversherpa.wiki.share_links import bucket_for

TRIP_FAILURES = 10
TRIP_WINDOW = timedelta(hours=1)
RESET_AFTER = timedelta(days=7)
ENDED_WINDOW = timedelta(days=30)
LADDER: dict[int, timedelta | None] = {
    1: timedelta(hours=1),
    2: timedelta(hours=6),
    3: timedelta(hours=12),
    4: timedelta(hours=24),
    5: None,
}

# Route keys: the only values `sign_in_failures.route` / `last_route` take.
LOGIN = "login"
TOTP_VERIFY = "totp_verify"
MOVE_LOGIN = "move_login"
BIOMETRIC_SIGN_IN = "biometric_sign_in"
RESET_CHECK = "password_reset_check"
RESET_CONFIRM = "password_reset_confirm"

BlockState = Literal["blocked", "permanent", "ended"]

_LOCK_SQL = text("SELECT pg_advisory_xact_lock(hashtext(:address))")
# Never wait on a row another transaction holds: a locked old row is being
# pruned by that transaction already.
_PRUNE_SQL = text(
    "DELETE FROM sign_in_failures WHERE id IN ("
    " SELECT id FROM sign_in_failures WHERE at < :cutoff"
    " FOR UPDATE SKIP LOCKED)")
_DELETE_ADDRESS_SQL = text(
    "DELETE FROM sign_in_failures WHERE id IN ("
    " SELECT id FROM sign_in_failures WHERE address = :address"
    " FOR UPDATE SKIP LOCKED)")
_LOOPBACK_V6 = ipaddress.IPv6Address("::1")

logger = logging.getLogger(__name__)

IpNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


class BlockNotFound(Exception):
    """No block row exists for that address."""


class BlockNotActive(Exception):
    """The block has ended (or, for make_permanent, is already permanent)."""


def _now(now: datetime | None) -> datetime:
    return now if now is not None else datetime.now(UTC)


@functools.lru_cache(maxsize=8)
def _parse_trusted(raw: str) -> tuple[bool, tuple[IpNetwork, ...]]:
    wildcard = False
    nets: list[IpNetwork] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if entry == "*":
            wildcard = True
            continue
        try:
            nets.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            continue  # a hostname or typo: uvicorn's problem, not ours
    return wildcard, tuple(nets)


def trusted_proxies() -> tuple[bool, tuple[IpNetwork, ...]]:
    """(wildcard, networks) parsed from FORWARDED_ALLOW_IPS (uvicorn's
    default 127.0.0.1 when unset). Entries are IPs or CIDR networks;
    unparseable ones are skipped. Read on every call (the parse is cached
    per value), so a changed environment takes effect at once."""
    return _parse_trusted(os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1"))


def _unmapped(ip: ipaddress.IPv4Address | ipaddress.IPv6Address):
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def _is_trusted_proxy(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    _, nets = trusted_proxies()
    return any(ip.version == net.version and ip in net for net in nets)


def is_exempt(address: str) -> bool:
    """True for addresses never counted or blocked: `unknown`, anything
    unparseable, loopback (127.0.0.0/8, ::1, IPv4-mapped loopback) and the
    trusted proxies from FORWARDED_ALLOW_IPS (never `*`). Accepts a raw
    address or a bucket (an IPv6 /64)."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        try:
            net = ipaddress.ip_network(address, strict=False)
        except ValueError:
            return True
        if isinstance(net, ipaddress.IPv6Network) and _LOOPBACK_V6 in net:
            return True
        if net.is_loopback:
            return True
        _, nets = trusted_proxies()
        return any(net.version == t.version and net.overlaps(t) for t in nets)
    ip = _unmapped(ip)
    return ip.is_loopback or _is_trusted_proxy(ip)


def _client_address(request: Request) -> str:
    """The caller's address. X-Forwarded-For (its rightmost entry, the one
    our proxy appended) is honored only when the direct peer is loopback or
    a trusted proxy; with FORWARDED_ALLOW_IPS="*" it falls back to
    `rate_limit_ip`'s private-peer rule."""
    wildcard, _ = trusted_proxies()
    if wildcard:
        return rate_limit_ip(request)
    peer = request.client.host if request.client else None
    if not peer:
        return "unknown"
    forwarded = request.headers.get("x-forwarded-for")
    if not forwarded:
        return peer
    try:
        peer_ip = _unmapped(ipaddress.ip_address(peer))
    except ValueError:
        return peer
    if not (peer_ip.is_loopback or _is_trusted_proxy(peer_ip)):
        return peer
    rightmost = forwarded.split(",")[-1].strip()
    try:
        ipaddress.ip_address(rightmost)
    except ValueError:
        return peer
    return rightmost


def address_for(request: Request) -> str | None:
    """The block key for this request, or None when the address is exempt."""
    raw = _client_address(request)
    if is_exempt(raw):
        return None
    bucket = bucket_for(raw)
    return None if is_exempt(bucket) else bucket


def block_state(block: AddressBlock, now: datetime) -> BlockState:
    if block.cleared_at is not None:
        return "ended"
    if block.permanent:
        return "permanent"
    if block.ends_at is not None and block.ends_at > now:
        return "blocked"
    return "ended"


def ended_at(block: AddressBlock, now: datetime) -> datetime | None:
    """When the block ended: the clear, or the end of a timed block that
    has passed. None while it is still active."""
    if block.cleared_at is not None:
        return block.cleared_at
    if not block.permanent and block.ends_at is not None and block.ends_at <= now:
        return block.ends_at
    return None


def next_level(block: AddressBlock | None, now: datetime) -> int:
    """The ladder step a new block on this address starts at."""
    if block is None or block.level == 0 or now - block.blocked_at >= RESET_AFTER:
        return 1
    return min(block.level + 1, 5)


def _active_clause(now: datetime):
    return and_(AddressBlock.cleared_at.is_(None),
                or_(AddressBlock.permanent.is_(True), AddressBlock.ends_at > now))


async def _load(db: AsyncSession, address: str, *, lock: bool) -> AddressBlock | None:
    stmt = (select(AddressBlock).where(AddressBlock.address == address)
            .execution_options(populate_existing=True))
    if lock:
        stmt = stmt.with_for_update()
    return await db.scalar(stmt)


async def active_block(db: AsyncSession, address: str,
                       now: datetime | None = None) -> AddressBlock | None:
    now = _now(now)
    return await db.scalar(
        select(AddressBlock)
        .where(AddressBlock.address == address, _active_clause(now))
        .execution_options(populate_existing=True))


def blocked_error(block: AddressBlock, now: datetime) -> HTTPException:
    """The 429 a blocked address gets on a sign-in route: the same whether
    or not the account exists or the credential is right."""
    if block.permanent or block.ends_at is None:
        return HTTPException(
            status_code=429,
            detail={"code": "address_blocked", "retry_after": None})
    retry_after = max(1, math.ceil((block.ends_at - now).total_seconds()))
    return HTTPException(
        status_code=429,
        detail={"code": "address_blocked", "retry_after": retry_after},
        headers={"Retry-After": str(retry_after)})


async def raise_if_blocked(db: AsyncSession, request: Request) -> None:
    """Raise the address_blocked 429 when the caller's address is blocked.
    A no-op for exempt addresses."""
    address = address_for(request)
    if address is None:
        return
    now = _now(None)
    block = await active_block(db, address, now)
    if block is not None:
        raise blocked_error(block, now)


async def guard_sign_in(request: Request, db: DbSession) -> None:
    """Dependency form of `raise_if_blocked`, for a route whose other
    dependencies (the 2FA challenge check) must not run first: declare it
    ahead of them."""
    await raise_if_blocked(db, request)


async def _on_trip(db: AsyncSession, block: AddressBlock) -> None:
    """Called inside record_failure's transaction when a block trips: one
    inbox card per admin."""
    from serversherpa.notifications.address_blocks import announce_block
    await announce_block(db, block)


async def record_failure(db: AsyncSession, request: Request, route: str,
                         now: datetime | None = None) -> AddressBlock | None:
    """Record one failed sign-in from the caller's address and trip a block
    when it is the TRIP_FAILURES-th within TRIP_WINDOW. Commits. Returns the
    block when this call tripped it, else None (also None when exempt)."""
    address = address_for(request)
    if address is None:
        return None
    now = _now(now)
    await db.execute(_LOCK_SQL, {"address": address})
    await db.execute(_PRUNE_SQL, {"cutoff": now - TRIP_WINDOW})
    db.add(SignInFailure(address=address, route=route, at=now))
    await db.flush()
    count = await db.scalar(
        select(func.count()).select_from(SignInFailure)
        .where(SignInFailure.address == address,
               SignInFailure.at >= now - TRIP_WINDOW))
    if count < TRIP_FAILURES:
        await db.commit()
        return None

    block = await _load(db, address, lock=True)
    if block is not None and block_state(block, now) != "ended":
        await db.commit()
        return None

    level = next_level(block, now)
    duration = LADDER[level]
    if block is None:
        block = AddressBlock(address=address, first_blocked_at=now, times_blocked=1)
        db.add(block)
    else:
        block.times_blocked += 1
    block.level = level
    block.permanent = duration is None
    block.blocked_at = now
    block.ends_at = None if duration is None else now + duration
    block.failure_count = count
    block.last_route = route
    block.cleared_at = None
    block.cleared_by = None
    block.made_permanent_at = None
    block.made_permanent_by = None
    await db.flush()
    await db.execute(_DELETE_ADDRESS_SQL, {"address": address})
    # A failed announcement must not lose the block: the cards roll back
    # to the savepoint and the block commits without them.
    try:
        async with db.begin_nested():
            await _on_trip(db, block)
    except Exception as exc:  # noqa: BLE001 (any announce error, logged)
        logger.error("address block announce failed for %s: %s: %s",
                     address, type(exc).__name__, exc)
    await db.commit()
    return block


async def _resolve_cards(db: AsyncSession, block: AddressBlock,
                         state: Literal["cleared", "permanent"],
                         actor_id: uuid.UUID | None) -> None:
    from serversherpa.notifications.address_blocks import decided_by_name, resolve_block
    await resolve_block(db, block.address, block.blocked_at, state,
                        await decided_by_name(db, actor_id))


async def clear(db: AsyncSession, address: str, *, actor_id: uuid.UUID | None,
                now: datetime | None = None) -> AddressBlock:
    """End an active block now and reset the ladder (level 0). Deletes the
    address's failure rows so the next wrong password does not re-trip at
    once. Does not commit."""
    now = _now(now)
    await db.execute(_LOCK_SQL, {"address": address})
    block = await _load(db, address, lock=True)
    if block is None:
        raise BlockNotFound(address)
    if block_state(block, now) == "ended":
        raise BlockNotActive(address)
    block.cleared_at = now
    block.cleared_by = actor_id
    block.level = 0
    await db.execute(_DELETE_ADDRESS_SQL, {"address": address})
    await db.flush()
    await _resolve_cards(db, block, "cleared", actor_id)
    return block


async def make_permanent(db: AsyncSession, address: str, *,
                         actor_id: uuid.UUID | None,
                         now: datetime | None = None) -> AddressBlock:
    """Make an active timed block permanent now. Does not commit."""
    now = _now(now)
    await db.execute(_LOCK_SQL, {"address": address})
    block = await _load(db, address, lock=True)
    if block is None:
        raise BlockNotFound(address)
    if block_state(block, now) != "blocked":
        raise BlockNotActive(address)
    block.permanent = True
    block.ends_at = None
    block.made_permanent_at = now
    block.made_permanent_by = actor_id
    await db.flush()
    await _resolve_cards(db, block, "permanent", actor_id)
    return block


async def list_blocks(db: AsyncSession, show: Literal["active", "ended"],
                      now: datetime | None = None) -> list[AddressBlock]:
    """Active blocks (timed and permanent), or blocks that ended within
    ENDED_WINDOW. Newest `blocked_at` first."""
    now = _now(now)
    if show == "active":
        where = _active_clause(now)
    else:
        since = now - ENDED_WINDOW
        where = or_(
            AddressBlock.cleared_at >= since,
            and_(AddressBlock.cleared_at.is_(None),
                 AddressBlock.permanent.is_(False),
                 AddressBlock.ends_at <= now,
                 AddressBlock.ends_at >= since))
    rows = await db.scalars(
        select(AddressBlock).where(where)
        .order_by(AddressBlock.blocked_at.desc(), AddressBlock.address)
        .execution_options(populate_existing=True))
    return list(rows)
