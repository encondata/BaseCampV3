"""System › Blocked addresses (SS-487): admins list the addresses blocked
from signing in, clear a block, or make a timed block permanent. The
address travels in the body because an IPv6 key holds a "/"."""
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select

from serversherpa.api.deps import (
    AuthContext, DbSession, client_ip, ensure_admin, require_permission,
)
from serversherpa.api.schemas import BlockedAddressActionIn, BlockedAddressOut
from serversherpa.db.models import AddressBlock, Person
from serversherpa.security import address_blocks as ab
from serversherpa.services.audit import audit

router = APIRouter(prefix="/system/blocked-addresses", tags=["system"])


async def _names(db, blocks: list[AddressBlock]) -> dict[uuid.UUID, str]:
    ids = {i for b in blocks for i in (b.cleared_by, b.made_permanent_by) if i}
    if not ids:
        return {}
    people = await db.scalars(select(Person).where(Person.id.in_(ids)))
    return {p.id: p.display_name for p in people}


def _out(block: AddressBlock, names: dict[uuid.UUID, str],
         now: datetime) -> BlockedAddressOut:
    return BlockedAddressOut(
        address=block.address, status=ab.block_state(block, now), level=block.level,
        blocked_at=block.blocked_at, ends_at=block.ends_at,
        ended_at=ab.ended_at(block, now), times_blocked=block.times_blocked,
        failure_count=block.failure_count, last_route=block.last_route,
        first_blocked_at=block.first_blocked_at, cleared_at=block.cleared_at,
        cleared_by_name=names.get(block.cleared_by) if block.cleared_by else None,
        made_permanent_at=block.made_permanent_at,
        made_permanent_by_name=(names.get(block.made_permanent_by)
                                if block.made_permanent_by else None))


@router.get("", response_model=list[BlockedAddressOut])
async def list_blocked_addresses(
    db: DbSession,
    show: Literal["active", "ended"] = "active",
    actor: AuthContext = require_permission("dashboard", "view"),
) -> list[BlockedAddressOut]:
    ensure_admin(actor)
    now = datetime.now(UTC)
    blocks = await ab.list_blocks(db, show, now)
    names = await _names(db, blocks)
    return [_out(b, names, now) for b in blocks]


async def _act(db, request: Request, actor: AuthContext, address: str,
               action: str, audit_action: str) -> BlockedAddressOut:
    now = datetime.now(UTC)
    func = ab.clear if action == "clear" else ab.make_permanent
    existing = await db.get(AddressBlock, address)
    level = existing.level if existing is not None else 0   # clear() resets it to 0
    try:
        block = await func(db, address, actor_id=actor.person.id, now=now)
    except ab.BlockNotFound:
        raise HTTPException(status_code=404, detail={"code": "block_not_found"})
    except ab.BlockNotActive:
        raise HTTPException(status_code=409, detail={"code": "block_not_active"})
    audit(db, actor_id=actor.person.id, entity_type="address_block", entity_id=address,
          action=audit_action, changes={"address": address, "level": level},
          ip=client_ip(request))
    names = await _names(db, [block])
    out = _out(block, names, now)
    await db.commit()
    return out


@router.post("/clear", response_model=BlockedAddressOut)
async def clear_block(
    body: BlockedAddressActionIn, request: Request, db: DbSession,
    actor: AuthContext = require_permission("dashboard", "view"),
) -> BlockedAddressOut:
    ensure_admin(actor)
    return await _act(db, request, actor, body.address, "clear", "address_block_cleared")


@router.post("/permanent", response_model=BlockedAddressOut)
async def make_block_permanent(
    body: BlockedAddressActionIn, request: Request, db: DbSession,
    actor: AuthContext = require_permission("dashboard", "view"),
) -> BlockedAddressOut:
    ensure_admin(actor)
    return await _act(db, request, actor, body.address, "permanent",
                      "address_block_made_permanent")
