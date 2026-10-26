"""Who manages learning: anyone holding `learning:<action>`, or a global-
anchored wiki:delete (whoever manages the wiki; a client/partner-scoped
role holding wiki:delete does not count). Every learning route and service
gates on these two helpers and nothing else; `manager_ids` finds the
people they would let in (for notices)."""
import uuid

from fastapi import Depends, HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import AccessInfo, resolve_access_many
from serversherpa.api.deps import AuthContext, CurrentUser
from serversherpa.db.models import (
    PermissionOverride,
    Person,
    PersonRole,
    RolePermission,
    UserAccount,
)


def is_manager(access: AccessInfo, action: str = "view") -> bool:
    return access.can("learning", action) or (
        access.is_global and access.can("wiki", "delete"))


def require_manager(action: str):
    """Route guard: the actor is a learning manager for `action`."""

    async def guard(user: CurrentUser) -> AuthContext:
        if not is_manager(user.access, action):
            raise HTTPException(status_code=403, detail={"code": "forbidden"})
        return user

    return Depends(guard)


async def manager_ids(db: AsyncSession, action: str = "change") -> list[uuid.UUID]:
    """Everyone `is_manager(…, action)` lets in who can sign in: an enabled
    account on a person who isn't archived. Candidates are the people with a
    role or an override touching learning:<action> or wiki:delete; each is
    then checked with their full access (anchors, overrides, gates)."""
    perms = or_(and_(RolePermission.resource == "learning", RolePermission.action == action),
                and_(RolePermission.resource == "wiki", RolePermission.action == "delete"))
    overrides = or_(
        and_(PermissionOverride.resource == "learning", PermissionOverride.action == action),
        and_(PermissionOverride.resource == "wiki", PermissionOverride.action == "delete"))
    by_role = (select(PersonRole.person_id)
               .join(RolePermission, RolePermission.role == PersonRole.role)
               .where(PersonRole.revoked_at.is_(None), perms))
    by_override = select(PermissionOverride.person_id).where(
        PermissionOverride.allow.is_(True), overrides)
    candidates = list(await db.scalars(
        select(Person.id)
        .join(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.archived_at.is_(None), UserAccount.disabled_at.is_(None),
               or_(Person.id.in_(by_role), Person.id.in_(by_override)))
        .order_by(Person.id)))
    access = await resolve_access_many(db, candidates)
    return [pid for pid in candidates if is_manager(access[pid], action)]
