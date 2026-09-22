"""Resolved effective access for one person, with per-cell sourcing.

Shared by GET /access/effective/{id} (the Access Explorer tab) and
GET /users/{id} (the user detail page) so the sourcing rules — hard gate,
override, gate, floor, role — have exactly one implementation."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import AccessInfo, resolve_access, role_grants
from serversherpa.access.resources import ACTIONS, REGISTRY
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, PermissionOverride, ResourceGroupGate,
)


@dataclass
class EffectiveAccess:
    access: AccessInfo
    groups: list[tuple[uuid.UUID, str]] = field(default_factory=list)   # (id, name)
    cells: dict = field(default_factory=dict)

    @property
    def scope(self) -> dict:
        return {
            "global": self.access.is_global,
            "client_ids": [str(c) for c in sorted(self.access.client_ids)],
            "partner_ids": [str(p) for p in sorted(self.access.partner_ids)],
        }


async def effective_cells(db: AsyncSession, person_id: uuid.UUID, *,
                          role_grants_override=None) -> EffectiveAccess:
    access = await resolve_access(db, person_id,
                                  role_grants_override=role_grants_override)
    overrides = {(o.resource, o.action): o.allow for o in await db.scalars(
        select(PermissionOverride).where(
            PermissionOverride.person_id == person_id))}
    group_rows = (await db.execute(
        select(AccessGroup.id, AccessGroup.name)
        .join(AccessGroupMember, AccessGroupMember.group_id == AccessGroup.id)
        .where(AccessGroupMember.person_id == person_id))).all()
    gated = {res for (res,) in (await db.execute(
        select(ResourceGroupGate.resource).distinct())).all()}
    member_res: set[str] = set()
    if group_rows:
        gids = {gid for gid, _ in group_rows}
        member_res = {res for res, gid in (await db.execute(
            select(ResourceGroupGate.resource, ResourceGroupGate.group_id))).all()
            if gid in gids}

    role_set = set(access.role_names)
    granted = await role_grants(db, role_set, role_grants_override)

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

    return EffectiveAccess(access=access, groups=list(group_rows), cells=cells)
