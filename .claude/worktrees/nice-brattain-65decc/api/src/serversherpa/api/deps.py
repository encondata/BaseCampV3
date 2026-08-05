"""FastAPI dependencies: DB session, current user, role guards."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from serversherpa.access.resolver import AccessInfo, resolve_access
from serversherpa.config import get_settings
from serversherpa.db.engine import get_db
from serversherpa.db.models import AuthSession, Person, UserAccount
from serversherpa.security.tokens import TokenError, decode_access_token

_bearer = HTTPBearer(auto_error=False)

DbSession = Annotated[AsyncSession, Depends(get_db)]


@dataclass
class AuthContext:
    person: Person
    account: UserAccount
    roles: list[str]
    session: AuthSession
    access: AccessInfo

    def has_role(self, *names: str) -> bool:
        return bool(set(names) & set(self.roles))


def _unauthorized(code: str) -> HTTPException:
    return HTTPException(status_code=401, detail={"code": code},
                         headers={"WWW-Authenticate": "Bearer"})


async def get_current_user(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthContext:
    if credentials is None:
        raise _unauthorized("missing_token")

    settings = get_settings()
    try:
        claims = decode_access_token(
            credentials.credentials, secret=settings.jwt_secret.get_secret_value())
    except TokenError:
        raise _unauthorized("invalid_token") from None

    # the session must still be live — this makes admin revocation and
    # logout take effect within one access-token lifetime, not eventually
    session = await db.get(AuthSession, uuid.UUID(claims["sid"]))
    if (
        session is None
        or session.revoked_at is not None
        or session.expires_at <= datetime.now(UTC)
    ):
        raise _unauthorized("session_ended")

    account = await db.scalar(
        select(UserAccount)
        .options(joinedload(UserAccount.person))
        .where(UserAccount.person_id == uuid.UUID(claims["sub"]))
    )
    if (
        account is None
        or account.disabled_at is not None
        or account.person.archived_at is not None
    ):
        raise _unauthorized("account_disabled")

    access = await resolve_access(db, account.person_id)
    return AuthContext(
        person=account.person,
        account=account,
        roles=access.role_names,
        session=session,
        access=access,
    )


CurrentUser = Annotated[AuthContext, Depends(get_current_user)]


def require_roles(*names: str):
    """Route guard: require at least one of the given roles."""

    async def guard(user: CurrentUser) -> AuthContext:
        if not user.has_role(*names):
            raise HTTPException(status_code=403, detail={"code": "forbidden"})
        return user

    return Depends(guard)


def require_permission(resource: str, action: str):
    """Route guard: require an effective (resource, action) permission."""

    async def guard(user: CurrentUser) -> AuthContext:
        if not user.access.can(resource, action):
            raise HTTPException(status_code=403, detail={"code": "forbidden"})
        return user

    return Depends(guard)


def client_ip(request: Request) -> str | None:
    """Real client IP. Caddy (our only proxy) sets X-Forwarded-For."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None
