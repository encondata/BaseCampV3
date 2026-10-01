import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import AccessInfo, resolve_access
from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_db
from sirdar_api.db.models import AuthSession, User
from sirdar_api.security.tokens import TokenError, decode_access_token

_bearer = HTTPBearer(auto_error=False)

DbSession = Annotated[AsyncSession, Depends(get_db)]


@dataclass
class AuthContext:
    user: User
    session: AuthSession
    access: AccessInfo


def _unauthorized(code: str) -> HTTPException:
    return HTTPException(status_code=401, detail={"code": code},
                         headers={"WWW-Authenticate": "Bearer"})


async def authenticate_token(db: AsyncSession, token: str) -> AuthContext:
    try:
        claims = decode_access_token(token, secret=get_settings().jwt_secret.get_secret_value())
        session_id, person_id = uuid.UUID(claims["sid"]), uuid.UUID(claims["sub"])
    except (TokenError, ValueError):
        raise _unauthorized("invalid_token") from None
    session = await db.get(AuthSession, session_id)
    if (session is None or session.revoked_at is not None
            or session.expires_at <= datetime.now(UTC)):
        raise _unauthorized("session_ended")
    user = await db.get(User, person_id)
    if user is None or user.disabled_at is not None:
        raise _unauthorized("account_disabled")
    return AuthContext(user=user, session=session,
                       access=await resolve_access(db, user.person_id))


async def get_current_user(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthContext:
    if credentials is None:
        raise _unauthorized("missing_token")
    return await authenticate_token(db, credentials.credentials)


CurrentUser = Annotated[AuthContext, Depends(get_current_user)]


def require_permission(resource: str, action: str):
    """Route guard: require an effective (resource, action) permission."""

    async def guard(user: CurrentUser) -> AuthContext:
        if not user.access.can(resource, action):
            raise HTTPException(status_code=403, detail={"code": "forbidden"})
        return user

    return Depends(guard)


def client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or None
    return request.client.host if request.client else None
