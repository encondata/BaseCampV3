"""Auth endpoints. The refresh token travels ONLY in an httpOnly cookie
scoped to /auth — JavaScript never sees it, and it is not sent with
ordinary API requests."""

from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import (
    CurrentUser, DbSession, TotpActor, TotpChallengeOrUser, client_ip,
)
from serversherpa.api.schemas import (
    BackupCodesOut, LoginChallengeOut, LoginIn, MeOut, PersonOut, ScopeOut, SessionOut,
    TotpEnrollConfirmIn, TotpEnrollConfirmOut, TotpEnrollStartOut, TotpRegenerateIn,
    TotpStatusOut, TotpVerifyIn, UiPreferences,
)
from serversherpa.config import get_settings
from serversherpa.db.models import UserAccount
from serversherpa.services import auth as auth_service
from serversherpa.services import totp as totp_service
from serversherpa.services.audit import audit, diff
from serversherpa.services.auth import AuthError, AuthResult, LoginChallenge
from serversherpa.services.storage import presign_get


def person_out(person) -> PersonOut:
    out = PersonOut.model_validate(person)
    out.avatar_url = presign_get(person.avatar_key)
    return out

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "ss_refresh"
TRUST_COOKIE = "ss_trust"

# AuthError code -> HTTP status. Everything else is a plain 401.
_STATUS = {"account_locked": 423, "kiosk_not_allowed": 403,
           "totp_already_enrolled": 409, "totp_disabled": 409, "totp_not_started": 409}


def _set_refresh_cookie(response: Response, result: AuthResult) -> None:
    settings = get_settings()
    response.set_cookie(
        REFRESH_COOKIE,
        result.refresh_token,
        expires=result.session_expires_at,
        httponly=True,
        secure=settings.env != "development",
        samesite="lax",
        domain=settings.cookie_domain or None,
        path="/auth",  # cookie only travels to auth endpoints
    )


def _clear_refresh_cookie(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(
        REFRESH_COOKIE, domain=settings.cookie_domain or None, path="/auth")


def _set_trust_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        TRUST_COOKIE, token,
        max_age=settings.totp_trust_days * 86_400,
        httponly=True, secure=settings.env != "development", samesite="lax",
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


def session_response(result: AuthResult, response: Response, totp: TotpStatusOut) -> SessionOut:
    _set_refresh_cookie(response, result)
    return SessionOut(
        access_token=result.access_token,
        expires_in=get_settings().access_token_ttl_seconds,
        session_expires_at=result.session_expires_at,
        person=person_out(result.person),
        roles=result.roles,
        must_change_password=result.account.must_change_password,
        preferences=UiPreferences.model_validate(result.account.ui_prefs or {}),
        perms=result.access.perms,
        max_rank=result.access.max_rank,
        scope=_scope_out(result.access),
        password_min_length=get_settings().password_min_length,
        totp=totp,
    )


def _auth_http_error(exc: AuthError) -> HTTPException:
    return HTTPException(
        status_code=_STATUS.get(exc.code, 401), detail={"code": exc.code})


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
    return session_response(result, response, await totp_status_out(db, result.account))


@router.post("/refresh", response_model=SessionOut)
async def refresh(
    request: Request, response: Response, db: DbSession,
    ss_refresh: Annotated[str | None, Cookie()] = None,
) -> SessionOut:
    if not ss_refresh:
        raise HTTPException(status_code=401, detail={"code": "missing_refresh"})
    try:
        result = await auth_service.refresh(
            db, refresh_token=ss_refresh,
            ip=client_ip(request), user_agent=request.headers.get("user-agent"),
        )
    except AuthError as exc:
        _clear_refresh_cookie(response)
        raise _auth_http_error(exc) from None
    return session_response(result, response, await totp_status_out(db, result.account))


@router.post("/logout", status_code=204)
async def logout(
    response: Response, db: DbSession,
    ss_refresh: Annotated[str | None, Cookie()] = None,
) -> None:
    if ss_refresh:
        await auth_service.logout(db, refresh_token=ss_refresh)
    _clear_refresh_cookie(response)


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser, db: DbSession) -> MeOut:
    return MeOut(
        person=person_out(user.person),
        roles=user.roles,
        session_expires_at=user.session.expires_at,
        must_change_password=user.account.must_change_password,
        preferences=UiPreferences.model_validate(user.account.ui_prefs or {}),
        perms=user.access.perms,
        max_rank=user.access.max_rank,
        scope=_scope_out(user.access),
        password_min_length=get_settings().password_min_length,
        totp=await totp_status_out(db, user.account),
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
    return session_response(result, response, await totp_status_out(db, actor.account))


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
            ip=client_ip(request))
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
