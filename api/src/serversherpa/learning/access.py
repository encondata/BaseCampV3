"""Who manages learning: anyone holding `learning:<action>`, or a global
wiki:delete (whoever manages the wiki). Every learning route and service
gates on these two helpers and nothing else."""

from fastapi import Depends, HTTPException

from serversherpa.access.resolver import AccessInfo
from serversherpa.api.deps import AuthContext, CurrentUser


def is_manager(access: AccessInfo, action: str = "view") -> bool:
    return access.can("learning", action) or access.can("wiki", "delete")


def require_manager(action: str):
    """Route guard: the actor is a learning manager for `action`."""

    async def guard(user: CurrentUser) -> AuthContext:
        if not is_manager(user.access, action):
            raise HTTPException(status_code=403, detail={"code": "forbidden"})
        return user

    return Depends(guard)
