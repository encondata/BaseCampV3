"""Access control admin API. Reads need access:view (floored on for every
global-anchor role — anti-lockout); writes need access:change + rank rules."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import can_touch_rank, resolve_access
from serversherpa.access.resources import ACTIONS, REGISTRY
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PermissionOverride, Person, PersonRole,
    ResourceGroupGate, Role, RolePermission,
)
from serversherpa.services.audit import audit
from serversherpa.services.storage import presign_get

router = APIRouter(prefix="/access", tags=["access"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _role_matrices(db: DbSession) -> dict[str, dict[str, dict[str, bool]]]:
    out: dict[str, dict[str, dict[str, bool]]] = {}
    for role, res, action in (await db.execute(
        select(RolePermission.role, RolePermission.resource,
               RolePermission.action))).all():
        out.setdefault(role, {}).setdefault(res, {})[action] = True
    return out


@router.get("/summary")
async def summary(
    db: DbSession,
    _actor: AuthContext = require_permission("access", "view"),
) -> dict:
    roles = (await db.scalars(select(Role).order_by(
        Role.rank.desc(), Role.name))).all()
    matrices = await _role_matrices(db)
    member_counts = dict((await db.execute(
        select(PersonRole.role, func.count(func.distinct(PersonRole.person_id)))
        .where(PersonRole.revoked_at.is_(None)).group_by(PersonRole.role))).all())

    groups = (await db.scalars(select(AccessGroup).order_by(AccessGroup.name))).all()
    members_by_group: dict = {}
    rows = (await db.execute(
        select(AccessGroupMember.group_id, Person)
        .join(Person, Person.id == AccessGroupMember.person_id))).all()
    for gid, person in rows:
        members_by_group.setdefault(gid, []).append({
            "person_id": str(person.id), "display_name": person.display_name,
            "avatar_url": presign_get(person.avatar_key)})
    gates: dict[str, list[str]] = {}
    for res, gid in (await db.execute(
        select(ResourceGroupGate.resource, ResourceGroupGate.group_id))).all():
        gates.setdefault(res, []).append(str(gid))

    n_members = (await db.execute(
        select(func.count(func.distinct(PersonRole.person_id)))
        .where(PersonRole.revoked_at.is_(None)))).scalar_one()
    n_overrides = (await db.execute(
        select(func.count()).select_from(PermissionOverride))).scalar_one()

    def matrix_for(name: str) -> dict:
        m = matrices.get(name, {})
        return {res: {a: m.get(res, {}).get(a, False) for a in ACTIONS}
                for res in REGISTRY}

    return {
        "stats": {"members": n_members, "roles": len(roles),
                  "groups": len(groups), "gated_resources": len(gates),
                  "overrides": n_overrides},
        "resources": [
            {"id": r.id, "label": r.label, "developer_only": r.developer_only,
             "always_viewable": r.always_viewable,
             "gated_by": gates.get(r.id, [])}
            for r in REGISTRY.values()],
        "roles": [
            {"name": r.name, "label": r.label or r.name, "color": r.color,
             "description": r.description, "rank": r.rank,
             "scope_anchor": r.scope_anchor, "is_system": r.is_system,
             "member_count": member_counts.get(r.name, 0),
             "matrix": matrix_for(r.name)}
            for r in roles],
        "groups": [
            {"id": str(g.id), "name": g.name, "description": g.description,
             "icon": g.icon,
             "member_count": len(members_by_group.get(g.id, [])),
             "members": members_by_group.get(g.id, [])}
            for g in groups],
    }


@router.get("/effective/{person_id}")
async def effective(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("access", "view"),
) -> dict:
    if actor.access.max_rank < GATE_BYPASS_RANK and person_id != actor.person.id:
        raise _err(403, "not_your_record")
    person = await db.get(Person, person_id)
    if person is None:
        raise _err(404, "person_not_found")

    access = await resolve_access(db, person_id)
    overrides = {(o.resource, o.action): o.allow for o in await db.scalars(
        select(PermissionOverride).where(
            PermissionOverride.person_id == person_id))}
    group_rows = (await db.execute(
        select(AccessGroup.id, AccessGroup.name)
        .join(AccessGroupMember, AccessGroupMember.group_id == AccessGroup.id)
        .where(AccessGroupMember.person_id == person_id))).all()
    gated = {res for (res,) in (await db.execute(
        select(ResourceGroupGate.resource).distinct())).all()}
    member_res = set()
    if group_rows:
        gids = {gid for gid, _ in group_rows}
        member_res = {res for res, gid in (await db.execute(
            select(ResourceGroupGate.resource, ResourceGroupGate.group_id))).all()
            if gid in gids}

    role_set = set(access.role_names)
    granted: dict[str, set[str]] = {}
    if role_set:
        for res, action in (await db.execute(
            select(RolePermission.resource, RolePermission.action)
            .where(RolePermission.role.in_(role_set)))).all():
            granted.setdefault(res, set()).add(action)

    cells: dict = {}
    for res_id, res in REGISTRY.items():
        cells[res_id] = {}
        hard = ((res.developer_only and "developer" not in access.role_names)
                or not (res.visible_to & access.anchors))
        gate_blocks = (res_id in gated and res_id not in member_res
                       and access.max_rank < GATE_BYPASS_RANK)
        for a in ACTIONS:
            value = access.perms[res_id][a]
            if hard:
                source = "hard_gate"
            elif (res_id, a) in overrides:
                # always_viewable floors view=True AFTER overrides (resolver),
                # so a deny override on such a cell is discarded — when the
                # override row disagrees with the final value, the floor is
                # what actually decided it
                source = "override" if overrides[(res_id, a)] == value else "floor"
            elif gate_blocks:
                # gate blocks this action outright, unless always_viewable
                # floors the view cell back on for it
                source = "floor" if (res.always_viewable and a == "view") else "gate"
            elif res.always_viewable and a == "view" and value and (
                    a not in granted.get(res_id, set())):
                # value is true only because always_viewable floored it —
                # no role actually granted view
                source = "floor"
            else:
                source = "role"
            cells[res_id][a] = {"value": value, "source": source}

    return {
        "person_id": str(person_id), "display_name": person.display_name,
        "roles": access.role_names, "max_rank": access.max_rank,
        "groups": [{"id": str(gid), "name": name} for gid, name in group_rows],
        "scope": {"global": access.is_global,
                  "client_ids": [str(c) for c in sorted(access.client_ids)],
                  "partner_ids": [str(p) for p in sorted(access.partner_ids)]},
        "cells": cells,
    }


class MatrixIn(BaseModel):
    matrix: dict[str, dict[str, bool]]


class RoleCloneIn(BaseModel):
    source: str
    name: str
    label: str
    rank: int


async def _load_role_for_edit(
    db: DbSession, actor: AuthContext, name: str,
) -> Role:
    role = await db.get(Role, name)
    if role is None:
        raise _err(404, "role_not_found")
    if not can_touch_rank(actor.access.max_rank, role.rank):
        raise _err(403, "rank_too_low")
    return role


@router.put("/roles/{name}/matrix")
async def put_matrix(
    name: str,
    body: MatrixIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    role = await _load_role_for_edit(db, actor, name)
    if role.name in actor.roles:
        # rank alone doesn't catch this: an actor can outrank a role they
        # also hold (e.g. an admin who was also granted staff), and editing
        # its matrix would self-servingly widen their own effective grants.
        # Scoped to matrix edits only — deleting a role you hold is a
        # different (and already-guarded) operation, see delete_role.
        raise _err(403, "cannot_edit_own_role")
    for res, actions in body.matrix.items():
        if res not in REGISTRY:
            raise _err(422, "unknown_resource")
        for a, on in actions.items():
            if a not in ACTIONS:
                raise _err(422, "unknown_action")
            if on and REGISTRY[res].developer_only and name != "developer":
                raise _err(422, "developer_only_resource")
    if not body.matrix.get("access", {}).get("view", False):
        raise _err(422, "access_view_locked")

    before = {(rp.resource, rp.action) for rp in await db.scalars(
        select(RolePermission).where(RolePermission.role == name))}
    desired = {(res, a) for res, actions in body.matrix.items()
               for a, on in actions.items() if on}
    for res, a in before - desired:
        await db.execute(
            RolePermission.__table__.delete().where(
                RolePermission.role == name,
                RolePermission.resource == res,
                RolePermission.action == a))
    for res, a in desired - before:
        db.add(RolePermission(role=name, resource=res, action=a))
    audit(db, actor_id=actor.person.id, entity_type="role", entity_id=name,
          action="matrix.update",
          changes={"granted": sorted(f"{r}:{a}" for r, a in desired - before),
                   "revoked": sorted(f"{r}:{a}" for r, a in before - desired)})
    await db.commit()
    return {"role": name, "grants": len(desired)}


@router.post("/roles", status_code=201)
async def clone_role(
    body: RoleCloneIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    source = await db.get(Role, body.source)
    if source is None:
        raise _err(404, "role_not_found")
    if not can_touch_rank(actor.access.max_rank, body.rank):
        raise _err(403, "rank_too_low")
    if await db.get(Role, body.name) is not None:
        raise _err(409, "role_exists")
    db.add(Role(name=body.name, description=f"Custom role cloned from {body.source}",
                rank=body.rank, scope_anchor=source.scope_anchor,
                is_system=False, label=body.label, color=source.color))
    await db.flush()
    for rp in await db.scalars(
            select(RolePermission).where(RolePermission.role == body.source)):
        db.add(RolePermission(role=body.name, resource=rp.resource,
                              action=rp.action))
    audit(db, actor_id=actor.person.id, entity_type="role", entity_id=body.name,
          action="role.clone", changes={"source": {"from": None, "to": body.source},
                                        "rank": {"from": None, "to": body.rank}})
    await db.commit()
    return {"name": body.name, "rank": body.rank,
            "scope_anchor": source.scope_anchor}


@router.delete("/roles/{name}", status_code=204)
async def delete_role(
    name: str,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> None:
    role = await _load_role_for_edit(db, actor, name)
    if role.is_system:
        raise _err(422, "system_role")
    # ANY grant row blocks deletion, revoked or not: person_roles keeps
    # revoked grants for history and its FK to roles has no ondelete, so
    # deleting a role with historical grants would raise IntegrityError.
    in_use = await db.scalar(select(PersonRole.id).where(
        PersonRole.role == name).limit(1))
    if in_use:
        raise _err(409, "role_in_use")
    audit(db, actor_id=actor.person.id, entity_type="role", entity_id=name,
          action="role.delete")
    await db.delete(role)
    await db.commit()


class GroupIn(BaseModel):
    name: str
    description: str = ""
    icon: str = "users"


class MembersIn(BaseModel):
    person_ids: list[uuid.UUID]


class GatesIn(BaseModel):
    group_ids: list[uuid.UUID]


NOT_GATEABLE = {"access", "devtools"}


async def _target_max_rank(db: DbSession, person_id: uuid.UUID) -> int:
    rank = await db.scalar(
        select(func.max(Role.rank))
        .join(PersonRole, PersonRole.role == Role.name)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None)))
    return rank or 0


@router.post("/groups", status_code=201)
async def create_group(
    body: GroupIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    exists = await db.scalar(select(AccessGroup.id).where(
        AccessGroup.name == body.name))
    if exists:
        raise _err(409, "group_exists")
    group = AccessGroup(name=body.name, description=body.description,
                        icon=body.icon, created_by=actor.person.id)
    db.add(group)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="access_group",
          entity_id=str(group.id), action="group.create",
          changes={"name": {"from": None, "to": body.name}})
    await db.commit()
    return {"id": str(group.id), "name": group.name}


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(
    group_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> None:
    group = await db.get(AccessGroup, group_id)
    if group is None:
        raise _err(404, "group_not_found")
    audit(db, actor_id=actor.person.id, entity_type="access_group",
          entity_id=str(group_id), action="group.delete",
          changes={"name": {"from": group.name, "to": None}})
    await db.delete(group)   # members + gates cascade
    await db.commit()


@router.put("/groups/{group_id}/members")
async def set_members(
    group_id: uuid.UUID,
    body: MembersIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    if await db.get(AccessGroup, group_id) is None:
        raise _err(404, "group_not_found")
    current = set(await db.scalars(
        select(AccessGroupMember.person_id)
        .where(AccessGroupMember.group_id == group_id)))
    desired = set(body.person_ids)
    for pid in desired - current:
        if not can_touch_rank(actor.access.max_rank,
                              await _target_max_rank(db, pid)):
            raise _err(403, "rank_too_low")
    for pid in current - desired:
        await db.execute(AccessGroupMember.__table__.delete().where(
            AccessGroupMember.group_id == group_id,
            AccessGroupMember.person_id == pid))
    for pid in desired - current:
        db.add(AccessGroupMember(group_id=group_id, person_id=pid,
                                 added_by=actor.person.id))
    audit(db, actor_id=actor.person.id, entity_type="access_group",
          entity_id=str(group_id), action="group.members",
          changes={"added": sorted(str(p) for p in desired - current),
                   "removed": sorted(str(p) for p in current - desired)})
    await db.commit()
    return {"members": len(desired)}


@router.put("/resources/{resource}/gates")
async def set_gates(
    resource: str,
    body: GatesIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    if resource not in REGISTRY:
        raise _err(422, "unknown_resource")
    if resource in NOT_GATEABLE:
        raise _err(422, "resource_not_gateable")
    current = set(await db.scalars(
        select(ResourceGroupGate.group_id)
        .where(ResourceGroupGate.resource == resource)))
    desired = set(body.group_ids)
    for gid in desired - current:
        if await db.get(AccessGroup, gid) is None:
            raise _err(404, "group_not_found")
    for gid in current - desired:
        await db.execute(ResourceGroupGate.__table__.delete().where(
            ResourceGroupGate.resource == resource,
            ResourceGroupGate.group_id == gid))
    for gid in desired - current:
        db.add(ResourceGroupGate(resource=resource, group_id=gid))
    audit(db, actor_id=actor.person.id, entity_type="resource",
          entity_id=resource, action="resource.gates",
          changes={"added": sorted(str(g) for g in desired - current),
                   "removed": sorted(str(g) for g in current - desired)})
    await db.commit()
    return {"resource": resource, "gates": len(desired)}


class OverridesIn(BaseModel):
    overrides: dict[str, dict[str, bool | None]]


@router.get("/overrides/{person_id}")
async def get_overrides(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("access", "view"),
) -> dict:
    # same guard as GET /access/effective/{person_id}: access:view alone
    # doesn't gate WHOSE overrides you can read.
    if actor.access.max_rank < GATE_BYPASS_RANK and person_id != actor.person.id:
        raise _err(403, "not_your_record")
    out: dict = {}
    for o in await db.scalars(select(PermissionOverride).where(
            PermissionOverride.person_id == person_id)):
        out.setdefault(o.resource, {})[o.action] = o.allow
    return {"person_id": str(person_id), "overrides": out}


@router.put("/overrides/{person_id}")
async def put_overrides(
    person_id: uuid.UUID,
    body: OverridesIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> dict:
    if person_id == actor.person.id:
        raise _err(403, "cannot_target_self")
    if await db.get(Person, person_id) is None:
        raise _err(404, "person_not_found")
    if not can_touch_rank(actor.access.max_rank,
                          await _target_max_rank(db, person_id)):
        raise _err(403, "rank_too_low")
    for res, actions in body.overrides.items():
        if res not in REGISTRY:
            raise _err(422, "unknown_resource")
        if REGISTRY[res].developer_only:
            raise _err(422, "developer_only_resource")
        for a in actions:
            if a not in ACTIONS:
                raise _err(422, "unknown_action")

    current = {(o.resource, o.action): o for o in await db.scalars(
        select(PermissionOverride).where(
            PermissionOverride.person_id == person_id))}
    desired = {(res, a): v for res, actions in body.overrides.items()
               for a, v in actions.items() if v is not None}
    changes: dict = {}
    for key, row in current.items():
        if key not in desired:
            changes[f"{key[0]}:{key[1]}"] = {"from": row.allow, "to": None}
            await db.delete(row)
        elif row.allow != desired[key]:
            changes[f"{key[0]}:{key[1]}"] = {"from": row.allow, "to": desired[key]}
            row.allow = desired[key]
            row.set_by = actor.person.id
            row.set_at = datetime.now(UTC)
    for key, value in desired.items():
        if key not in current:
            changes[f"{key[0]}:{key[1]}"] = {"from": None, "to": value}
            db.add(PermissionOverride(person_id=person_id, resource=key[0],
                                      action=key[1], allow=value,
                                      set_by=actor.person.id))
    audit(db, actor_id=actor.person.id, entity_type="person",
          entity_id=str(person_id), action="override.set", changes=changes)
    await db.commit()
    return {"person_id": str(person_id), "overrides": len(desired)}
