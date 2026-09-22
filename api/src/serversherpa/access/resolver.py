"""Effective-permission resolution. Precedence per resource x action:
hard gates (developer_only, anchor visibility) -> override -> group gate
-> role union; always_viewable floors view=true AFTER overrides/gates but
NEVER past a hard gate."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK, TOP_RANK
from serversherpa.access.resources import ACTIONS, REGISTRY
from serversherpa.db.models import (
    AccessGroupMember, PermissionOverride, PersonRole, ResourceGroupGate, Role,
    RolePermission,
)


def can_touch_rank(actor_rank: int, target_rank: int) -> bool:
    """Strictly-below management; top rank may also manage peers."""
    return actor_rank >= TOP_RANK or target_rank < actor_rank


RoleGrants = dict[str, set[tuple[str, str]]]


async def role_grants(db: AsyncSession, role_names: set[str],
                      override: RoleGrants | None = None) -> dict[str, set[str]]:
    """resource -> granted actions for the union of `role_names`. A role
    named in `override` contributes exactly those (resource, action) pairs
    instead of its role_permissions rows — the matrix-preview hook."""
    granted: dict[str, set[str]] = {}
    override = override or {}
    from_table = {r for r in role_names if r not in override}
    if from_table:
        for res, action in (await db.execute(
            select(RolePermission.resource, RolePermission.action)
            .where(RolePermission.role.in_(from_table)))).all():
            granted.setdefault(res, set()).add(action)
    for name in role_names & set(override):
        for res, action in override[name]:
            granted.setdefault(res, set()).add(action)
    return granted


@dataclass
class AccessInfo:
    perms: dict[str, dict[str, bool]] = field(default_factory=dict)
    max_rank: int = 0
    role_names: list[str] = field(default_factory=list)
    anchors: set[str] = field(default_factory=set)
    client_ids: set[uuid.UUID] = field(default_factory=set)
    partner_ids: set[uuid.UUID] = field(default_factory=set)
    is_global: bool = False

    def can(self, resource: str, action: str) -> bool:
        return self.perms.get(resource, {}).get(action, False)


async def resolve_access(db: AsyncSession, person_id: uuid.UUID, *,
                         role_grants_override: RoleGrants | None = None) -> AccessInfo:
    grants = (await db.execute(
        select(PersonRole.role, PersonRole.client_id, PersonRole.partner_id,
               Role.rank, Role.scope_anchor)
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None))
    )).all()

    info = AccessInfo()
    for role, client_id, partner_id, rank, anchor in grants:
        info.role_names.append(role)
        info.max_rank = max(info.max_rank, rank)
        info.anchors.add(anchor)
        if anchor == "client" and client_id:
            info.client_ids.add(client_id)
        elif anchor == "partner" and partner_id:
            info.partner_ids.add(partner_id)
    info.role_names = sorted(set(info.role_names))
    info.is_global = "global" in info.anchors
    role_set = set(info.role_names)

    granted = await role_grants(db, role_set, role_grants_override)

    overrides: dict[str, dict[str, bool]] = {}
    for res, action, allow in (await db.execute(
        select(PermissionOverride.resource, PermissionOverride.action,
               PermissionOverride.allow)
        .where(PermissionOverride.person_id == person_id)
    )).all():
        overrides.setdefault(res, {})[action] = allow

    gated_resources: set[str] = set()
    member_ok: set[str] = set()
    gates = (await db.execute(select(ResourceGroupGate.resource,
                                     ResourceGroupGate.group_id))).all()
    if gates:
        gated_resources = {res for res, _ in gates}
        my_groups = set(await db.scalars(
            select(AccessGroupMember.group_id)
            .where(AccessGroupMember.person_id == person_id)))
        member_ok = {res for res, gid in gates if gid in my_groups}

    for res_id, res in REGISTRY.items():
        cell = {a: False for a in ACTIONS}
        hard_blocked = (
            (res.developer_only and "developer" not in role_set)
            or not (res.visible_to & info.anchors)
        )
        if not hard_blocked:
            gate_blocks = (res_id in gated_resources
                           and res_id not in member_ok
                           and info.max_rank < GATE_BYPASS_RANK)
            for action in ACTIONS:
                ov = overrides.get(res_id, {}).get(action)
                if ov is not None:
                    cell[action] = ov
                elif gate_blocks:
                    cell[action] = False
                else:
                    cell[action] = action in granted.get(res_id, set())
            if res.always_viewable:
                cell["view"] = True
        info.perms[res_id] = cell
    return info
