"""Admin inbox cards for sign-in address blocks (SS-487). When an address
trips a block, every admin gets one `address_blocked` card; Clear block /
Block permanently resolve every admin's copy at once, so a second admin
sees who decided. Adds to the caller's session — never commits.

Admin = the `ensure_admin` rule (api/deps.py): global access and a highest
role rank of at least GATE_BYPASS_RANK. A high-ranked role anchored to a
client or partner does not qualify."""

import uuid
from typing import Literal

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.db.models import AddressBlock, Person, PersonRole, Role, UserAccount
from serversherpa.notifications.inbox import notify

KIND = "address_blocked"
LINK = "/system/blocked-addresses"
CLI_ACTOR = "Server command line"

_DURATIONS = {1: "1 hour", 2: "6 hours", 3: "12 hours", 4: "24 hours"}


async def admin_person_ids(db: AsyncSession) -> list[uuid.UUID]:
    """Active people (sign-in enabled, not archived) with global access and a
    top role rank of at least GATE_BYPASS_RANK."""
    rows = (await db.execute(
        select(PersonRole.person_id, func.max(Role.rank),
               func.bool_or(Role.scope_anchor == "global"))
        .join(Role, Role.name == PersonRole.role)
        .join(UserAccount, UserAccount.person_id == PersonRole.person_id)
        .join(Person, Person.id == PersonRole.person_id)
        .where(PersonRole.revoked_at.is_(None),
               UserAccount.disabled_at.is_(None),
               Person.archived_at.is_(None))
        .group_by(PersonRole.person_id))).all()
    return sorted(pid for pid, top, has_global in rows
                  if has_global and top >= GATE_BYPASS_RANK)


def block_title(block: AddressBlock) -> str:
    when = "permanently" if block.permanent else f"for {_DURATIONS[block.level]}"
    return (f"Sign-ins blocked from {block.address} {when} "
            f"({block.failure_count} failed attempts)")


async def announce_block(db: AsyncSession, block: AddressBlock) -> int:
    payload = {"address": block.address, "level": block.level,
               "ends_at": block.ends_at.isoformat() if block.ends_at else None,
               "failure_count": block.failure_count, "state": "open"}
    title = block_title(block)
    admins = await admin_person_ids(db)
    for pid in admins:
        await notify(db, pid, KIND, title, body="", link=LINK, payload=dict(payload))
    return len(admins)


async def resolve_block(db: AsyncSession, address: str,
                        state: Literal["cleared", "permanent"],
                        decided_by: str) -> None:
    """Mark every open card for this address decided, and read for every
    admin. A card already read keeps its first read time."""
    await db.execute(text(
        "UPDATE notifications SET payload = payload || "
        "jsonb_build_object('state', CAST(:state AS text), "
        "'decided_by', CAST(:by AS text)), "
        "read_at = COALESCE(read_at, now()) "
        "WHERE kind = :kind AND payload ->> 'address' = CAST(:address AS text) "
        "AND payload ->> 'state' = 'open'"),
        {"state": state, "by": decided_by, "kind": KIND, "address": address})


async def decided_by_name(db: AsyncSession, actor_id: uuid.UUID | None) -> str:
    if actor_id is None:
        return CLI_ACTOR
    person = await db.get(Person, actor_id)
    return person.display_name if person is not None else CLI_ACTOR
