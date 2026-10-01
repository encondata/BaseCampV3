"""Effective permissions — the portal's model minus group gates (everyone
in Sirdar is rank >= 60, the portal's gate-bypass tier). Per resource x
action: hard gate (developer_only) -> per-person override -> role union."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resources import ACTIONS, REGISTRY
from sirdar_api.db.models import PermissionOverride, Role, RolePermission, UserRole

TOP_RANK = 100


def can_touch_rank(actor_rank: int, target_rank: int) -> bool:
    """Strictly-below management; the top rank may also manage peers."""
    return actor_rank >= TOP_RANK or target_rank < actor_rank


@dataclass
class AccessInfo:
    perms: dict[str, dict[str, bool]] = field(default_factory=dict)
    sources: dict[str, dict[str, str]] = field(default_factory=dict)
    max_rank: int = 0
    role_names: list[str] = field(default_factory=list)

    def can(self, resource: str, action: str) -> bool:
        return self.perms.get(resource, {}).get(action, False)


def assemble(roles: list[tuple[str, int]], granted: dict[str, set[str]],
             overrides: dict[str, dict[str, bool]]) -> AccessInfo:
    info = AccessInfo()
    role_set = {name for name, _ in roles}
    info.role_names = sorted(role_set)
    info.max_rank = max((rank for _, rank in roles), default=0)
    for res_id, res in REGISTRY.items():
        cells: dict[str, bool] = {}
        sources: dict[str, str] = {}
        for action in ACTIONS:
            if res.developer_only and "developer" not in role_set:
                cells[action], sources[action] = False, "hard_gate"
                continue
            ov = overrides.get(res_id, {}).get(action)
            if ov is not None:
                cells[action], sources[action] = ov, "override"
            else:
                cells[action], sources[action] = action in granted.get(res_id, set()), "role"
        info.perms[res_id] = cells
        info.sources[res_id] = sources
    return info


async def resolve_access(db: AsyncSession, person_id: uuid.UUID) -> AccessInfo:
    roles = [(name, rank) for name, rank in (await db.execute(
        select(UserRole.role, Role.rank).join(Role, Role.name == UserRole.role)
        .where(UserRole.person_id == person_id))).all()]
    granted: dict[str, set[str]] = {}
    if roles:
        for res, action in (await db.execute(
                select(RolePermission.resource, RolePermission.action)
                .where(RolePermission.role.in_([r for r, _ in roles])))).all():
            granted.setdefault(res, set()).add(action)
    overrides: dict[str, dict[str, bool]] = {}
    for res, action, allow in (await db.execute(
            select(PermissionOverride.resource, PermissionOverride.action,
                   PermissionOverride.allow)
            .where(PermissionOverride.person_id == person_id))).all():
        overrides.setdefault(res, {})[action] = allow
    return assemble(roles, granted, overrides)


async def role_matrix(db: AsyncSession) -> dict[str, dict[str, set[str]]]:
    matrix: dict[str, dict[str, set[str]]] = {
        name: {} for name in await db.scalars(select(Role.name))}
    for role, res, action in (await db.execute(
            select(RolePermission.role, RolePermission.resource, RolePermission.action))).all():
        matrix.setdefault(role, {}).setdefault(res, set()).add(action)
    return matrix
