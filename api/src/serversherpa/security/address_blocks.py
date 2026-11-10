"""Sign-in address blocking (SS-487).

Ten failed sign-in attempts from one address within a rolling hour block
that address from the sign-in routes. Each new block climbs a ladder:
1 h, 6 h, 12 h, 24 h, then permanent until an admin clears it. The ladder
starts over once 7 days pass after the last block started, or when an
admin clears the block.

The address is `bucket_for(rate_limit_ip(request))`: IPv4 as itself, IPv6
by its /64, an IPv4-mapped IPv6 address as the IPv4. Loopback and the
shared `unknown` bucket are never counted or blocked: if the proxy stops
sending X-Forwarded-For every caller looks like loopback, and a block
there would shut everyone out.

Only failures count, and only on the sign-in routes listed below; sessions
already signed in from a blocked address keep working.

Concurrency: `record_failure` holds a per-address advisory lock for its
transaction, so simultaneous failures from one address trip exactly one
block. The global prune and the failure-row deletes use SKIP LOCKED, so
two addresses' transactions never wait on each other's rows."""
from __future__ import annotations

import ipaddress
import math
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import HTTPException, Request
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import rate_limit_ip
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


class BlockNotFound(Exception):
    """No block row exists for that address."""


class BlockNotActive(Exception):
    """The block has ended (or, for make_permanent, is already permanent)."""


def _now(now: datetime | None) -> datetime:
    return now if now is not None else datetime.now(UTC)


def is_exempt(address: str) -> bool:
    """True for addresses never counted or blocked: `unknown`, anything
    unparseable, and loopback (127.0.0.0/8, ::1, IPv4-mapped loopback).
    Accepts a raw address or a bucket (an IPv6 /64)."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        try:
            net = ipaddress.ip_network(address, strict=False)
        except ValueError:
            return True
        if isinstance(net, ipaddress.IPv6Network) and _LOOPBACK_V6 in net:
            return True
        return net.is_loopback
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def address_for(request: Request) -> str | None:
    """The block key for this request, or None when the address is exempt."""
    raw = rate_limit_ip(request)
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
    await _on_trip(db, block)
    await db.commit()
    return block


async def _resolve_cards(db: AsyncSession, address: str,
                         state: Literal["cleared", "permanent"],
                         actor_id: uuid.UUID | None) -> None:
    from serversherpa.notifications.address_blocks import decided_by_name, resolve_block
    await resolve_block(db, address, state, await decided_by_name(db, actor_id))


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
    await _resolve_cards(db, address, "cleared", actor_id)
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
    await _resolve_cards(db, address, "permanent", actor_id)
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
