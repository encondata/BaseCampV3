"""FastAPI dependencies: DB session, current user, permission guards."""

import ipaddress
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request
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


# A kiosk login (POST /auth/login with client="kiosk") and a kiosk
# pairing claim are both exempt from the 2FA challenge, and "kiosk" is
# self-asserted — anyone holding a password can send it. So the session
# they mint is worth no more than a kiosk: the routes the kiosk apps
# actually call, and nothing else. `/auth/me` is allowed (self-scoped, and
# the caller already proved the password) but its sub-paths (preferences,
# password, sessions) are not. Neither is `/auth/totp/*`: a kiosk session
# must not enroll, verify, or regenerate backup codes for the account it
# never challenged. The three sign-in lifecycle routes never run the
# gate (they authenticate by cookie or body, not by bearer token) — they
# are listed so the allowlist reads as the complete kiosk surface.
KIOSK_SESSION_PREFIXES = ("/kiosk/",)
KIOSK_SESSION_PATHS = frozenset({
    "/auth/login", "/auth/refresh", "/auth/logout", "/auth/me",
    "/system/status",
})


def enforce_session_scope(request: Request, user: AuthContext) -> None:
    """A kiosk login is exempt from 2FA, so its session must be worth no
    more than a kiosk: only the kiosk routes and the sign-in lifecycle."""
    if user.session.client != "kiosk":
        return
    path = request.url.path
    if path in KIOSK_SESSION_PATHS or path.startswith(KIOSK_SESSION_PREFIXES):
        return
    raise HTTPException(status_code=403, detail={"code": "kiosk_session"})


MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# Never frozen: sign-in/out/refresh/password/preferences/session revocation,
# and the admin toggle itself — whoever could turn read-only on can always
# turn it off. Everything else under /auth/me (profile edits) freezes like
# any other write. /kiosk/pair* is a sign-in (approve/deny on the phone) —
# never frozen. /kiosk/heartbeat is NOT exempt.
#
# /kiosk/printer-events is exempt for a different reason: the printer was
# already factory reset out in the warehouse, and the only thing this call
# writes is the append-only audit row that records it. Refusing it during a
# maintenance freeze would not undo the reset — it would just lose the
# trail the feature exists to create. Contrast /kiosk/scans and
# /kiosk/timeclock/*, which stay frozen because their writes are real data
# the kiosk can hold onto and retry once the freeze lifts.
READ_ONLY_EXEMPT_PATHS = frozenset({
    "/auth/login", "/auth/refresh", "/auth/logout",
    "/auth/me/preferences", "/auth/me/password", "/system/admin",
    "/kiosk/printer-events",
    "/auth/totp/verify", "/auth/totp/enroll/start", "/auth/totp/enroll/confirm",
    "/auth/totp/backup-codes/regenerate",
})
READ_ONLY_EXEMPT_PREFIXES = ("/auth/me/sessions/", "/kiosk/pair")


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
# "you must change your password" screen) and GET /auth/me/sessions (self-
# scoped list of what DELETE /auth/me/sessions/{id} lets it revoke) since
# neither is a mutating route and so isn't already covered by
# READ_ONLY_EXEMPT_PATHS. `/system/admin` is deliberately NOT inherited:
# read-only exempts it because whoever can turn read-only on can turn it
# off, which says nothing about a temp-password admin session. Neither is
# `/kiosk/printer-events`: read-only exempts it so an already-performed
# reset still gets recorded, which likewise says nothing about a session
# that has not finished signing in. Nor are the four `/auth/totp/*` sign-in
# routes: they're in READ_ONLY_EXEMPT_PATHS for the sign-in lifecycle during
# a maintenance freeze, but a temp-password session must still change its
# password before it can enroll in 2FA or regenerate backup codes from My
# Profile. This subtraction only bites a signed-in session (must_change_
# password=True); the enroll/verify challenge path is unaffected either
# way because a challenge holder has no session at all — totp_actor never
# calls enforce_forced_password_change for it.
FORCED_CHANGE_EXEMPT_PATHS = (
    (READ_ONLY_EXEMPT_PATHS - {
        "/system/admin", "/kiosk/printer-events",
        "/auth/totp/verify", "/auth/totp/enroll/start",
        "/auth/totp/enroll/confirm", "/auth/totp/backup-codes/regenerate",
    })
    | {"/auth/me", "/auth/me/sessions"}
)
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
    enforce_session_scope(request, user)
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


def rate_limit_ip(request: Request) -> str:
    """The address an unauthenticated abuse cap should key on. Caddy (our
    only proxy) APPENDS the real client to X-Forwarded-For, so the
    rightmost entry is the one it wrote and the leftmost is whatever the
    caller typed; the header is honored only when the direct peer is the
    proxy on this box (loopback or a private network). Never None: an
    unattributable caller shares one 'unknown' bucket."""
    peer = request.client.host if request.client else None
    forwarded = request.headers.get("x-forwarded-for")
    if peer and forwarded:
        try:
            peer_addr = ipaddress.ip_address(peer)
        except ValueError:
            peer_addr = None
        if peer_addr is not None and (peer_addr.is_loopback or peer_addr.is_private):
            rightmost = forwarded.split(",")[-1].strip()
            if rightmost:
                try:
                    ipaddress.ip_address(rightmost)
                except ValueError:
                    return peer or "unknown"
                return rightmost
    return peer or "unknown"


@dataclass
class TotpActor:
    """Who is calling a 2FA endpoint: a half-signed-in challenge holder
    (purpose "verify"/"enroll", no session) or a signed-in user (purpose
    None)."""

    account: UserAccount
    purpose: str | None
    user: AuthContext | None


async def totp_actor(
    request: Request,
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    x_totp_challenge: Annotated[str | None, Header()] = None,
) -> TotpActor:
    if x_totp_challenge:
        from serversherpa.services.totp import decode_challenge_token

        try:
            person_id, purpose = decode_challenge_token(x_totp_challenge)
        except TokenError:
            raise _unauthorized("invalid_challenge") from None
        account = await db.scalar(
            select(UserAccount).options(joinedload(UserAccount.person))
            .where(UserAccount.person_id == person_id))
        if (account is None or account.disabled_at is not None
                or account.person.archived_at is not None):
            raise _unauthorized("account_disabled")
        # the token must still describe the account: an enroll token is
        # spent once enrolled, a verify token is void once reset
        enrolled = account.totp_confirmed_at is not None
        if (purpose == "verify") != enrolled:
            raise _unauthorized("invalid_challenge")
        return TotpActor(account=account, purpose=purpose, user=None)
    if credentials is None:
        raise _unauthorized("missing_token")
    user = await authenticate_token(db, credentials.credentials)
    # totp_actor authenticates outside get_current_user, so it applies the
    # same scope gate: no /auth/totp/* route is in the kiosk allowlist.
    enforce_session_scope(request, user)
    enforce_forced_password_change(request, user)
    await enforce_read_only(db, request, user)
    return TotpActor(account=user.account, purpose=None, user=user)


TotpChallengeOrUser = Annotated[TotpActor, Depends(totp_actor)]
