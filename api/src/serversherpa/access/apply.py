"""Per-person access writes shared by the users/access routes and the
copy-access endpoint: the diff-and-apply for global roles, access group
membership and per-cell overrides. Callers validate, audit and commit."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PermissionOverride, PersonRole, Role,
)

ORG_ANCHORS = ("client", "partner")


async def current_roles(db: AsyncSession, person_id: uuid.UUID) -> set[str]:
    return set(await db.scalars(
        select(PersonRole.role).where(PersonRole.person_id == person_id,
                                      PersonRole.revoked_at.is_(None))))


async def current_global_roles(db: AsyncSession, person_id: uuid.UUID) -> set[str]:
    return set(await db.scalars(
        select(PersonRole.role)
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None),
               Role.scope_anchor.not_in(ORG_ANCHORS))))


async def current_groups(db: AsyncSession, person_id: uuid.UUID) -> set[uuid.UUID]:
    return set(await db.scalars(
        select(AccessGroupMember.group_id)
        .where(AccessGroupMember.person_id == person_id)))


async def current_overrides(db: AsyncSession,
                            person_id: uuid.UUID) -> dict[tuple[str, str], bool]:
    return {(o.resource, o.action): o.allow for o in await db.scalars(
        select(PermissionOverride).where(PermissionOverride.person_id == person_id))}


async def apply_global_roles(
    db: AsyncSession, *, actor_id: uuid.UUID, person_id: uuid.UUID,
    desired: set[str], role_rows: dict[str, Role],
) -> dict | None:
    """Make the person's revocable (non org-anchored) roles equal `desired`.
    Org-anchored grants are managed by the contact flows and never revoked
    here. `role_rows` must cover every current and desired role name."""
    current = await current_roles(db, person_id)
    revocable_current = {
        name for name in current
        if role_rows.get(name) is None or role_rows[name].scope_anchor not in ORG_ANCHORS
    }
    if revocable_current == desired:
        return None
    now = datetime.now(UTC)
    for role in revocable_current - desired:
        await db.execute(
            update(PersonRole)
            .where(PersonRole.person_id == person_id, PersonRole.role == role,
                   PersonRole.revoked_at.is_(None))
            .values(revoked_at=now, revoked_by=actor_id, updated_at=now))
    for role in desired - current:
        db.add(PersonRole(person_id=person_id, role=role, granted_by=actor_id))
    return {"from": sorted(current), "to": sorted(desired)}


async def apply_groups(
    db: AsyncSession, *, actor_id: uuid.UUID, person_id: uuid.UUID,
    desired: set[uuid.UUID],
) -> dict | None:
    current = await current_groups(db, person_id)
    names = {g.id: g.name for g in await db.scalars(
        select(AccessGroup).where(AccessGroup.id.in_((desired | current) or {uuid.uuid4()})))}
    for gid in desired:
        if gid not in names:
            raise KeyError(gid)
    if desired == current:
        return None
    for gid in current - desired:
        await db.execute(AccessGroupMember.__table__.delete().where(
            AccessGroupMember.group_id == gid,
            AccessGroupMember.person_id == person_id))
    for gid in desired - current:
        db.add(AccessGroupMember(group_id=gid, person_id=person_id, added_by=actor_id))
    return {"from": sorted(names[g] for g in current),
            "to": sorted(names[g] for g in desired)}


async def apply_overrides(
    db: AsyncSession, *, actor_id: uuid.UUID, person_id: uuid.UUID,
    desired: dict[tuple[str, str], bool],
) -> dict:
    current = {(o.resource, o.action): o for o in await db.scalars(
        select(PermissionOverride).where(PermissionOverride.person_id == person_id))}
    changes: dict = {}
    for key, row in current.items():
        if key not in desired:
            changes[f"{key[0]}:{key[1]}"] = {"from": row.allow, "to": None}
            await db.delete(row)
        elif row.allow != desired[key]:
            changes[f"{key[0]}:{key[1]}"] = {"from": row.allow, "to": desired[key]}
            row.allow = desired[key]
            row.set_by = actor_id
            row.set_at = datetime.now(UTC)
    for key, value in desired.items():
        if key not in current:
            changes[f"{key[0]}:{key[1]}"] = {"from": None, "to": value}
            db.add(PermissionOverride(person_id=person_id, resource=key[0],
                                      action=key[1], allow=value, set_by=actor_id))
    return changes
