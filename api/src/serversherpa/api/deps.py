"""FastAPI dependencies: DB session, current user, permission guards."""

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


def _unauthorized(code: str) -> HTTPException:
    return HTTPException(status_code=401, detail={"code": code},
                         headers={"WWW-Authenticate": "Bearer"})


async def authenticate_token(db: AsyncSession, token: str) -> AuthContext:
    """Validate an access token end-to-end (JWT, live session, active
    account) and build the AuthContext. Raises the same 401s as
    get_current_user — the WS route maps them to close codes."""
    settings = get_settings()
    try:
        claims = decode_access_token(
            token, secret=settings.jwt_secret.get_secret_value())
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
        person=account.person, account=account, roles=access.role_names,
        session=session, access=access,
    )


MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# Never frozen: sign-in/out/refresh/password/preferences/session revocation,
# and the admin toggle itself — whoever could turn read-only on can always
# turn it off. Everything else under /auth/me (profile edits) freezes like
# any other write.
READ_ONLY_EXEMPT_PATHS = frozenset({
    "/auth/login", "/auth/refresh", "/auth/logout",
    "/auth/me/preferences", "/auth/me/password", "/system/admin",
})
READ_ONLY_EXEMPT_PREFIXES = ("/auth/me/sessions/",)


def _read_only_exempt(path: str) -> bool:
    return path in READ_ONLY_EXEMPT_PATHS or path.startswith(READ_ONLY_EXEMPT_PREFIXES)


async def enforce_read_only(db: AsyncSession, request: Request,
                            user: AuthContext) -> None:
    """Read-only maintenance mode: reject mutating calls from everyone but
    developers with 423. Only mutating methods pay the one-row lookup."""
    if (request.method not in MUTATING_METHODS
            or _read_only_exempt(request.url.path)
            or "developer" in user.roles):
        return
    from serversherpa.system.admin_config import read_admin_config

    cfg = await read_admin_config(db)
    if cfg["read_only"]:
        raise HTTPException(
            status_code=423,
            detail={"code": "read_only_mode",
                    "message": cfg["read_only_message"]})


# A temp-password session must be able to finish the auth lifecycle and
# change its own password, and nothing else — same auth-lifecycle set
# read-only mode exempts, plus GET /auth/me (so the portal can render the
# "you must change your password" screen) since it's not a mutating route
# and so isn't already covered by READ_ONLY_EXEMPT_PATHS.
FORCED_CHANGE_EXEMPT_PATHS = READ_ONLY_EXEMPT_PATHS | {"/auth/me"}
FORCED_CHANGE_EXEMPT_PREFIXES = READ_ONLY_EXEMPT_PREFIXES


def _forced_change_exempt(path: str) -> bool:
    return (path in FORCED_CHANGE_EXEMPT_PATHS
            or path.startswith(FORCED_CHANGE_EXEMPT_PREFIXES))


def enforce_forced_password_change(request: Request, user: AuthContext) -> None:
    """Server-side mirror of the portal's forced-change screen: a temp
    password (must_change_password=True) can reach only the auth-lifecycle
    routes and the self password-change route — every other route 403s
    until the password is changed. Previously this was enforced only in
    the portal UI, so a temp-password session could drive the API directly
    and never be forced to change it."""
    if not user.account.must_change_password or _forced_change_exempt(request.url.path):
        return
    raise HTTPException(status_code=403,
                        detail={"code": "password_change_required"})


async def get_current_user(
    request: Request,
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthContext:
    if credentials is None:
        raise _unauthorized("missing_token")
    user = await authenticate_token(db, credentials.credentials)
    enforce_forced_password_change(request, user)
    await enforce_read_only(db, request, user)
    return user


CurrentUser = Annotated[AuthContext, Depends(get_current_user)]


def require_permission(resource: str, action: str):
    """Route guard: require an effective (resource, action) permission."""

    async def guard(user: CurrentUser) -> AuthContext:
        if not user.access.can(resource, action):
            raise HTTPException(status_code=403, detail={"code": "forbidden"})
        return user

    return Depends(guard)


def require_password_length(password: str) -> None:
    """One policy gate for every password the API accepts. The schemas keep
    only a non-empty floor — the real bar lives in settings so ops can
    raise it without a deploy."""
    min_length = get_settings().password_min_length
    if len(password) < min_length:
        raise HTTPException(
            status_code=422,
            detail={"code": "password_too_short", "min_length": min_length})


def client_ip(request: Request) -> str | None:
    """Real client IP. Caddy (our only proxy) sets X-Forwarded-For."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None
