import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import can_touch_rank, resolve_access, role_matrix
from sirdar_api.access.resources import ACTIONS, REGISTRY
from sirdar_api.api.deps import AuthContext, DbSession, require_permission
from sirdar_api.db.models import PermissionOverride, Role, RolePermission, User, UserRole
from sirdar_api.services.audit import audit

# The developer role can never lose these: every devtools action, plus the
# ability to see and change Roles & access (so it can always repair itself).
DEVELOPER_CORE = {("devtools", a) for a in ACTIONS} | {("access", "view"), ("access", "change")}

router = APIRouter(prefix="/access", tags=["access"])


class MatrixIn(BaseModel):
    matrix: dict[str, dict[str, bool]]


class OverridesIn(BaseModel):
    overrides: dict[str, dict[str, bool | None]]


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _check_names(cells: dict[str, dict]) -> None:
    for res, acts in cells.items():
        if res not in REGISTRY:
            raise _err(422, "unknown_resource")
        for action in acts:
            if action not in ACTIONS:
                raise _err(422, "unknown_action")


@router.get("/summary")
async def summary(db: DbSession, actor: AuthContext = require_permission("access", "view")):
    matrix = await role_matrix(db)
    counts = dict((await db.execute(
        select(UserRole.role, func.count()).group_by(UserRole.role))).all())
    roles = await db.scalars(select(Role).order_by(Role.rank.desc(), Role.name))
    return {
        "resources": [{"id": r.id, "label": r.label, "developer_only": r.developer_only,
                       "always_viewable": False, "gated_by": []} for r in REGISTRY.values()],
        "roles": [{"name": r.name, "label": r.label, "color": r.color, "rank": r.rank,
                   "member_count": counts.get(r.name, 0),
                   "matrix": {res: {a: a in matrix.get(r.name, {}).get(res, set())
                                    for a in ACTIONS} for res in REGISTRY}}
                  for r in roles],
    }


@router.put("/roles/{name}/matrix")
async def put_role_matrix(name: str, body: MatrixIn, db: DbSession,
                          actor: AuthContext = require_permission("access", "change")):
    role = (await db.execute(select(Role).where(Role.name == name).with_for_update())
            ).scalar_one_or_none()
    if role is None:
        raise _err(404, "role_not_found")
    is_developer_role = name == "developer"
    if is_developer_role and "developer" not in actor.access.role_names:
        raise _err(403, "developer_role_locked")
    # The developer role is the one exception to the own-role and rank rules:
    # only developers can edit it, and they hold it.
    if not is_developer_role:
        if name in actor.access.role_names:
            raise _err(403, "cannot_edit_own_role")
        if not can_touch_rank(actor.access.max_rank, role.rank):
            raise _err(403, "rank_too_low")
    _check_names(body.matrix)
    desired = {(res, a) for res, acts in body.matrix.items() for a, on in acts.items() if on}
    if name != "developer" and any(REGISTRY[res].developer_only for res, _ in desired):
        raise _err(422, "developer_only_resource")
    if is_developer_role and not DEVELOPER_CORE <= desired:
        raise _err(422, "developer_role_core")
    if ("access", "view") not in desired:
        raise _err(422, "access_view_locked")
    current = set((await db.execute(select(RolePermission.resource, RolePermission.action)
                                    .where(RolePermission.role == name))).all())
    granted, revoked = desired - current, current - desired
    if any(not actor.access.can(res, a) for res, a in granted):
        raise _err(403, "grant_exceeds_own")
    for res, a in revoked:
        await db.execute(delete(RolePermission).where(
            RolePermission.role == name, RolePermission.resource == res,
            RolePermission.action == a))
    for res, a in granted:
        db.add(RolePermission(role=name, resource=res, action=a))
    audit(db, actor_id=actor.user.person_id, action="matrix.update", entity_type="role",
          entity_id=name, changes={"granted": sorted(f"{r}:{a}" for r, a in granted),
                                   "revoked": sorted(f"{r}:{a}" for r, a in revoked)})
    await db.commit()
    return {"role": name, "grants": len(desired)}


async def _overrides(db: AsyncSession, person_id: uuid.UUID) -> dict[str, dict[str, bool]]:
    out: dict[str, dict[str, bool]] = {}
    for res, a, allow in (await db.execute(
            select(PermissionOverride.resource, PermissionOverride.action,
                   PermissionOverride.allow)
            .where(PermissionOverride.person_id == person_id))).all():
        out.setdefault(res, {})[a] = allow
    return out


@router.get("/overrides/{person_id}")
async def get_overrides(person_id: uuid.UUID, db: DbSession,
                        actor: AuthContext = require_permission("access", "view")):
    if await db.get(User, person_id) is None:
        raise _err(404, "person_not_found")
    return {"person_id": str(person_id), "overrides": await _overrides(db, person_id)}


@router.put("/overrides/{person_id}")
async def put_overrides(person_id: uuid.UUID, body: OverridesIn, db: DbSession,
                        actor: AuthContext = require_permission("access", "change")):
    if await db.get(User, person_id) is None:
        raise _err(404, "person_not_found")
    if person_id == actor.user.person_id:
        raise _err(403, "cannot_target_self")
    if not can_touch_rank(actor.access.max_rank, (await resolve_access(db, person_id)).max_rank):
        raise _err(403, "rank_too_low")
    _check_names(body.overrides)
    wanted = {(res, a): allow for res, acts in body.overrides.items()
              for a, allow in acts.items() if allow is not None}
    if any(REGISTRY[res].developer_only for res, _ in wanted):
        raise _err(422, "developer_only_resource")
    before = await _overrides(db, person_id)
    # Only cells that are newly allowed (or flipped to allow) count against the
    # actor; an allow that was already there is not theirs to re-vouch for.
    if any(allow and before.get(res, {}).get(a) is not True and not actor.access.can(res, a)
           for (res, a), allow in wanted.items()):
        raise _err(403, "grant_exceeds_own")
    await db.execute(delete(PermissionOverride).where(PermissionOverride.person_id == person_id))
    for (res, a), allow in wanted.items():
        db.add(PermissionOverride(person_id=person_id, resource=res, action=a, allow=allow,
                                  set_by=actor.user.person_id))
    audit(db, actor_id=actor.user.person_id, action="override.set", entity_type="user",
          entity_id=str(person_id),
          changes={"before": before, "after": {f"{r}:{a}": v for (r, a), v in wanted.items()}})
    await db.commit()
    return {"person_id": str(person_id), "overrides": len(wanted)}
