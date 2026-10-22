"""Auth endpoints. The refresh token travels ONLY in an httpOnly cookie
scoped to /auth — JavaScript never sees it, and it is not sent with
ordinary API requests."""

import logging
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Cookie, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import (
    CurrentUser, DbSession, TotpActor, TotpChallengeOrUser, client_ip,
    raise_if_reused, rate_limit_ip, require_password_length,
)
from serversherpa.api.schemas import (
    BackupCodesOut, KioskMoveOut, LoginChallengeOut, LoginIn, MeOut, PasswordResetCheckIn,
    PasswordResetCheckOut, PasswordResetConfirmIn, PasswordResetRequestIn, PersonOut, ScopeOut,
    SessionOut,
    TotpEnrollConfirmIn, TotpEnrollConfirmOut, TotpEnrollStartOut, TotpRegenerateIn,
    TotpStatusOut, TotpVerifyIn, UiPreferences,
)
from serversherpa.config import get_settings
from serversherpa.db.models import AuthSession, Initiative, UserAccount
from serversherpa.services import auth as auth_service
from serversherpa.services import password_reset
from serversherpa.services import totp as totp_service
from serversherpa.services.audit import audit, diff
from serversherpa.services.auth import AuthError, AuthResult, LoginChallenge
from serversherpa.services.password_policy import (
    PasswordPolicy, change_reason, expires_at, load_policy,
)
from serversherpa.services.storage import presign_get
from serversherpa.wiki.share_links import IpRateLimiter


def person_out(person) -> PersonOut:
    out = PersonOut.model_validate(person)
    out.avatar_url = presign_get(person.avatar_key)
    return out

logger = logging.getLogger("serversherpa.api.auth")

router = APIRouter(prefix="/auth", tags=["auth"])

# One refresh cookie per app, so a portal and a web kiosk signed in in the
# same browser never adopt each other's session. Kiosk sessions keep the
# original name: the Android/iOS apps and the laptop edge read it by name.
REFRESH_COOKIE = "ss_refresh"                 # kiosk sessions (and every no-`client` caller)
PORTAL_REFRESH_COOKIE = "ss_portal_refresh"   # portal sessions (the portal and the wiki)
TRUST_COOKIE = "ss_trust"

# `?client=` on /auth/refresh and /auth/logout: which app is asking.
# Omitted = the original behavior on ss_refresh (native apps, the edge,
# portal bundles from before the split).
ClientParam = Annotated[Literal["portal", "kiosk"] | None, Query()]

# AuthError code -> HTTP status. Everything else is a plain 401.
_STATUS = {"account_locked": 423, "kiosk_not_allowed": 403,
           "totp_already_enrolled": 409, "totp_disabled": 409, "totp_not_started": 409,
           "totp_seed_unreadable": 409}


def refresh_cookie_name(client: str) -> str:
    """The refresh cookie a session minted for `client` lives in."""
    return PORTAL_REFRESH_COOKIE if client == "portal" else REFRESH_COOKIE


def _set_refresh_cookie(response: Response, result: AuthResult, name: str) -> None:
    settings = get_settings()
    response.set_cookie(
        name,
        result.refresh_token,
        expires=result.session_expires_at,
        httponly=True,
        secure=settings.env != "development",
        samesite="lax",
        domain=settings.cookie_domain or None,
        path="/auth",  # cookie only travels to auth endpoints
    )


def _clear_refresh_cookie(response: Response, name: str = REFRESH_COOKIE) -> None:
    settings = get_settings()
    response.delete_cookie(
        name, domain=settings.cookie_domain or None, path="/auth")


def _cleared_cookie_headers(name: str) -> dict[str, str]:
    """A Set-Cookie header deleting refresh cookie `name`, for an error
    response (an HTTPException carries its own headers)."""
    scratch = Response()
    _clear_refresh_cookie(scratch, name)
    return {"set-cookie": scratch.headers["set-cookie"]}


def _set_trust_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        TRUST_COOKIE, token,
        max_age=settings.totp_trust_days * 86_400,
        httponly=True, secure=settings.env != "development", samesite="lax",
        domain=settings.cookie_domain or None, path="/auth")


def clear_trust_cookie(response: Response) -> None:
    """Delete ss_trust with the same attributes _set_trust_cookie sets it with."""
    settings = get_settings()
    response.delete_cookie(
        TRUST_COOKIE, httponly=True, secure=settings.env != "development", samesite="lax",
        domain=settings.cookie_domain or None, path="/auth")


def _scope_out(access) -> ScopeOut:
    return ScopeOut(**{"global": access.is_global},
                    client_ids=sorted(access.client_ids),
                    partner_ids=sorted(access.partner_ids))


async def totp_status_out(db: AsyncSession, account: UserAccount) -> TotpStatusOut:
    policy = await totp_service.policy_for(db, account)
    return TotpStatusOut(
        enrolled=account.totp_confirmed_at is not None,
        enrolled_at=account.totp_confirmed_at,
        required=policy.required,
        backup_codes_remaining=await totp_service.backup_codes_remaining(db, account.person_id))


async def kiosk_move_out(db: AsyncSession, session: AuthSession | None) -> KioskMoveOut | None:
    """The move a session is locked to (a move-password kiosk sign-in), or
    None for every other session."""
    if session is None or session.initiative_id is None:
        return None
    initiative = await db.get(Initiative, session.initiative_id)
    return KioskMoveOut(initiative_id=initiative.id, name=initiative.name) if initiative else None


async def _kiosk_move_for(db: AsyncSession, result: AuthResult) -> KioskMoveOut | None:
    if result.session_id is None:
        return None
    return await kiosk_move_out(db, await db.get(AuthSession, result.session_id))


def session_response(result: AuthResult, response: Response, totp: TotpStatusOut,
                     policy: PasswordPolicy, kiosk_move: KioskMoveOut | None = None,
                     *, cookie_name: str | None = None) -> SessionOut:
    """`cookie_name` defaults to the issued session's own cookie; a
    no-`client` refresh pins it to ss_refresh (the original behavior)."""
    _set_refresh_cookie(response, result, cookie_name or refresh_cookie_name(result.client))
    reason = change_reason(policy, result.account, datetime.now(UTC))
    return SessionOut(
        access_token=result.access_token,
        expires_in=get_settings().access_token_ttl_seconds,
        session_expires_at=result.session_expires_at,
        person=person_out(result.person),
        roles=result.roles,
        must_change_password=reason is not None,
        must_change_reason=reason,
        password_expires_at=expires_at(policy, result.account),
        preferences=UiPreferences.model_validate(result.account.ui_prefs or {}),
        perms=result.access.perms,
        max_rank=result.access.max_rank,
        scope=_scope_out(result.access),
        password_min_length=get_settings().password_min_length,
        totp=totp,
        kiosk_move=kiosk_move,
    )


def _auth_http_error(exc: AuthError) -> HTTPException:
    return HTTPException(
        status_code=_STATUS.get(exc.code, 401), detail={"code": exc.code})


# ── self-service password reset ─────────────────────────────────────
# Per-process, per-IP (rate_limit_ip, /64 for IPv6), one-hour windows.
# /check and /confirm share one counter: both test a guessed token.
RESET_WINDOW_SECONDS = 3600
reset_request_limiter = IpRateLimiter(
    limit=get_settings().password_reset_rate_limit, window_seconds=RESET_WINDOW_SECONDS)
reset_confirm_limiter = IpRateLimiter(
    limit=get_settings().password_reset_confirm_rate_limit, window_seconds=RESET_WINDOW_SECONDS)


# Real tokens are ~43 chars; anything longer is just an invalid token.
MAX_RESET_TOKEN_LEN = 512


def _limit(limiter: IpRateLimiter, request: Request) -> None:
    if not limiter.hit(rate_limit_ip(request)):
        raise HTTPException(status_code=429, detail={"code": "rate_limited"})


def _invalid_reset() -> HTTPException:
    return HTTPException(status_code=400, detail={"code": "reset_token_invalid"})


@router.post("/password-reset/request", status_code=202)
async def password_reset_request(
    body: PasswordResetRequestIn, request: Request, db: DbSession,
) -> dict:
    """Same answer whether or not the account exists (no enumeration)."""
    _limit(reset_request_limiter, request)
    try:
        await password_reset.request_reset(db, body.email, ip=client_ip(request))
        await db.commit()
    except Exception as exc:
        # a failure for a real account must not look different from the
        # no-op for an unknown one; log the class only (no address/token)
        await db.rollback()
        logger.error("password reset request failed: %s", type(exc).__name__)
    return {"status": "accepted"}


@router.post("/password-reset/check", response_model=PasswordResetCheckOut)
async def password_reset_check(
    body: PasswordResetCheckIn, request: Request, db: DbSession,
) -> PasswordResetCheckOut:
    _limit(reset_confirm_limiter, request)
    if len(body.token) > MAX_RESET_TOKEN_LEN:
        return PasswordResetCheckOut(valid=False, first_password=False)
    found = await password_reset.find_valid(db, body.token)
    # from the same lookup that validated the token: has this account ever
    # had a password? (an invite, or a reset asked for before it was used)
    first_password = found is not None and found[1].password_hash is None
    await db.rollback()          # release the FOR UPDATE lock
    return PasswordResetCheckOut(valid=found is not None, first_password=first_password)


@router.post("/password-reset/confirm", status_code=204)
async def password_reset_confirm(
    body: PasswordResetConfirmIn, request: Request, db: DbSession,
) -> None:
    _limit(reset_confirm_limiter, request)
    if len(body.token) > MAX_RESET_TOKEN_LEN:
        raise _invalid_reset()
    found = await password_reset.find_valid(db, body.token)
    if found is None:
        raise _invalid_reset()
    token, account = found
    require_password_length(body.new_password)
    await raise_if_reused(db, account, body.new_password)
    await password_reset.complete(db, token, account, body.new_password,
                                  ip=client_ip(request))
    await db.commit()


@router.post("/login", response_model=SessionOut | LoginChallengeOut)
async def login(
    body: LoginIn, request: Request, response: Response, db: DbSession,
    ss_trust: Annotated[str | None, Cookie()] = None,
) -> SessionOut | LoginChallengeOut:
    try:
        result = await auth_service.login(
            db, email=body.email, password=body.password,
            ip=client_ip(request), user_agent=request.headers.get("user-agent"),
            client=body.client, trust_token=ss_trust,
        )
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    if isinstance(result, LoginChallenge):
        return LoginChallengeOut(
            status="totp_verify" if result.purpose == "verify" else "totp_enroll",
            challenge_token=totp_service.make_challenge_token(
                result.account.person_id, result.purpose),
            backup_codes_remaining=result.backup_codes_remaining)
    return session_response(result, response, await totp_status_out(db, result.account),
                            await load_policy(db))


@router.post("/refresh", response_model=SessionOut)
async def refresh(
    request: Request, response: Response, db: DbSession,
    client: ClientParam = None,
    ss_refresh: Annotated[str | None, Cookie()] = None,
    ss_portal_refresh: Annotated[str | None, Cookie()] = None,
) -> SessionOut:
    """No `client`: ss_refresh, exactly as before the split. `client=kiosk`:
    ss_refresh, kiosk sessions only. `client=portal`: ss_portal_refresh, or
    a portal session still filed under ss_refresh (signed in before the
    split), which moves to ss_portal_refresh. A session of the other app
    answers 401 wrong_client and is left alone, cookie included."""
    token, cookie, legacy = ss_refresh, REFRESH_COOKIE, False
    if client == "portal" and ss_portal_refresh:
        token, cookie = ss_portal_refresh, PORTAL_REFRESH_COOKIE
    elif client == "portal" and ss_refresh:
        legacy = await auth_service.session_client(db, ss_refresh) == "portal"
    if not token:
        raise HTTPException(status_code=401, detail={"code": "missing_refresh"})
    try:
        result = await auth_service.refresh(
            db, refresh_token=token,
            ip=client_ip(request), user_agent=request.headers.get("user-agent"),
            expect_client=client,
        )
    except AuthError as exc:
        error = _auth_http_error(exc)
        if client is None:
            _clear_refresh_cookie(response)  # as before the split
        elif exc.code != "wrong_client" and (cookie == PORTAL_REFRESH_COOKIE
                                             or legacy or client == "kiosk"):
            # the failed cookie is the caller's own: clear it on the error
            # response itself (headers set on `response` don't survive a
            # raised HTTPException). A wrong_client token, or an unknown
            # token under ss_refresh on a portal refresh, may be the other
            # app's — never cleared.
            error.headers = _cleared_cookie_headers(cookie)
        raise error from None
    out = session_response(
        result, response, await totp_status_out(db, result.account), await load_policy(db),
        await _kiosk_move_for(db, result),
        cookie_name=REFRESH_COOKIE if client is None else refresh_cookie_name(result.client))
    if legacy:
        _clear_refresh_cookie(response, REFRESH_COOKIE)   # moved to ss_portal_refresh
    return out


@router.post("/logout", status_code=204)
async def logout(
    response: Response, db: DbSession,
    client: ClientParam = None,
    ss_refresh: Annotated[str | None, Cookie()] = None,
    ss_portal_refresh: Annotated[str | None, Cookie()] = None,
) -> None:
    """No `client`: end ss_refresh's session, exactly as before the split.
    With `client`, only that app's sessions are revoked and only its own
    cookies cleared; a session of the other app is left alone."""
    if client is None:
        if ss_refresh:
            await auth_service.logout(db, refresh_token=ss_refresh)
        _clear_refresh_cookie(response)
        return
    if client == "portal":
        if ss_portal_refresh:
            await auth_service.logout(
                db, refresh_token=ss_portal_refresh, expect_client="portal")
        _clear_refresh_cookie(response, PORTAL_REFRESH_COOKIE)
    # ss_refresh: the kiosk's cookie, or a portal session from before the split
    owner = None
    if ss_refresh:
        owner = await auth_service.logout(db, refresh_token=ss_refresh, expect_client=client)
    if owner == client or (client == "kiosk" and owner is None):
        _clear_refresh_cookie(response, REFRESH_COOKIE)


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser, db: DbSession) -> MeOut:
    policy = await load_policy(db)
    reason = change_reason(policy, user.account, datetime.now(UTC))
    return MeOut(
        person=person_out(user.person),
        roles=user.roles,
        session_expires_at=user.session.expires_at,
        must_change_password=reason is not None,
        must_change_reason=reason,
        password_expires_at=expires_at(policy, user.account),
        preferences=UiPreferences.model_validate(user.account.ui_prefs or {}),
        perms=user.access.perms,
        max_rank=user.access.max_rank,
        scope=_scope_out(user.access),
        password_min_length=get_settings().password_min_length,
        totp=await totp_status_out(db, user.account),
        kiosk_move=await kiosk_move_out(db, user.session),
    )


@router.put("/me/preferences", response_model=UiPreferences)
async def save_preferences(
    body: UiPreferences, user: CurrentUser, db: DbSession
) -> UiPreferences:
    """Persist UI preferences on the account, so every device the user
    signs in on gets their normal display."""
    before = user.account.ui_prefs or {}
    after = body.model_dump()
    user.account.ui_prefs = after
    audit(db, actor_id=user.person.id, entity_type="user_account",
          entity_id=str(user.person.id), action="preferences.update",
          changes=diff(before, after))
    await db.commit()
    return body


# ── two-factor ──────────────────────────────────────────────────────

async def _finish_challenge(
    db: AsyncSession, actor: TotpActor, request: Request, response: Response, *,
    remember: bool,
) -> SessionOut:
    """The second factor passed on a challenge: mint the real session and,
    when asked, remember this browser."""
    ip = client_ip(request)
    ua = request.headers.get("user-agent")
    result = await auth_service.start_session(db, actor.account, ip=ip, user_agent=ua)
    if remember:
        _set_trust_cookie(response, await totp_service.issue_trust(
            db, actor.account, user_agent=ua, ip=ip))
    return session_response(result, response, await totp_status_out(db, actor.account),
                            await load_policy(db))


@router.post("/totp/verify", response_model=SessionOut)
async def totp_verify(
    body: TotpVerifyIn, request: Request, response: Response, db: DbSession,
    actor: TotpChallengeOrUser,
) -> SessionOut:
    if actor.purpose != "verify":
        raise HTTPException(status_code=401, detail={"code": "invalid_challenge"})
    try:
        await totp_service.verify_code(db, actor.account, body.code, ip=client_ip(request))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return await _finish_challenge(db, actor, request, response, remember=body.remember)


async def _enrollment_allowed(db: AsyncSession, actor: TotpActor) -> None:
    if actor.purpose == "verify":
        raise HTTPException(status_code=401, detail={"code": "invalid_challenge"})
    if not (await totp_service.policy_for(db, actor.account)).enabled:
        raise HTTPException(status_code=409, detail={"code": "totp_disabled"})


@router.post("/totp/enroll/start", response_model=TotpEnrollStartOut)
async def totp_enroll_start(
    request: Request, db: DbSession, actor: TotpChallengeOrUser,
) -> TotpEnrollStartOut:
    await _enrollment_allowed(db, actor)
    try:
        secret, uri = await totp_service.begin_enrollment(
            db, actor.account, actor_id=actor.account.person_id, ip=client_ip(request))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return TotpEnrollStartOut(secret=secret, otpauth_uri=uri)


@router.post("/totp/enroll/confirm", response_model=TotpEnrollConfirmOut)
async def totp_enroll_confirm(
    body: TotpEnrollConfirmIn, request: Request, response: Response, db: DbSession,
    actor: TotpChallengeOrUser,
) -> TotpEnrollConfirmOut:
    await _enrollment_allowed(db, actor)
    try:
        codes = await totp_service.confirm_enrollment(
            db, actor.account, body.code, actor_id=actor.account.person_id,
            ip=client_ip(request), user_agent=request.headers.get("user-agent"))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    session = None
    if actor.purpose == "enroll":
        session = await _finish_challenge(db, actor, request, response, remember=body.remember)
    return TotpEnrollConfirmOut(backup_codes=codes, session=session)


@router.post("/totp/backup-codes/regenerate", response_model=BackupCodesOut)
async def totp_regenerate(
    body: TotpRegenerateIn, request: Request, db: DbSession, user: CurrentUser,
) -> BackupCodesOut:
    ip = client_ip(request)
    try:
        await totp_service.verify_code(db, user.account, body.code, ip=ip)
        codes = await totp_service.regenerate_backup_codes(
            db, user.account, actor_id=user.person.id, ip=ip)
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return BackupCodesOut(backup_codes=codes)
