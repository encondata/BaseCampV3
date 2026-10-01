"""Auth endpoints — the portal's contract under /api/auth. The refresh
token travels ONLY in the httpOnly sirdar_refresh cookie (path /api/auth)."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import AccessInfo
from sirdar_api.api.deps import CurrentUser, DbSession, client_ip
from sirdar_api.api.schemas import (
    LoginChallengeOut, LoginIn, MeOut, PersonOut, ScopeOut, SessionOut, TotpStatusOut,
    TotpVerifyIn, UiPreferences,
)
from sirdar_api.config import get_settings
from sirdar_api.db.models import User
from sirdar_api.services import auth as auth_service
from sirdar_api.services import totp_enroll
from sirdar_api.services.auth import AuthError, AuthResult, LoginChallenge

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "sirdar_refresh"
COOKIE_PATH = "/api/auth"
_STATUS = {"account_locked": 423, "password_change_required": 403,
           "totp_enrollment_required": 403, "totp_seed_unreadable": 409,
           "totp_already_enrolled": 409, "totp_not_started": 409, "totp_not_enrolled": 409}


def _auth_http_error(exc: AuthError) -> HTTPException:
    return HTTPException(status_code=_STATUS.get(exc.code, 401), detail={"code": exc.code})


def _set_refresh_cookie(response: Response, result: AuthResult) -> None:
    settings = get_settings()
    response.set_cookie(REFRESH_COOKIE, result.refresh_token,
                        expires=result.session_expires_at, httponly=True,
                        secure=settings.env != "development", samesite="lax",
                        domain=settings.cookie_domain or None, path=COOKIE_PATH)


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, domain=get_settings().cookie_domain or None,
                           path=COOKIE_PATH)


def person_out(user: User) -> PersonOut:
    return PersonOut(id=user.person_id, first_name=user.first_name, last_name=user.last_name,
                     preferred_name=user.preferred_name, display_name=user.display_name,
                     email=user.email, job_title=user.job_title)


async def me_fields(db: AsyncSession, user: User, access: AccessInfo,
                    session_expires_at: datetime) -> dict:
    return {
        "person": person_out(user),
        "roles": access.role_names,
        "session_expires_at": session_expires_at,
        "password_expires_at": user.password_expires_at,
        "preferences": UiPreferences.model_validate(user.ui_prefs or {}),
        "perms": access.perms,
        "max_rank": access.max_rank,
        "scope": ScopeOut(**{"global": True}),
        "totp": TotpStatusOut(
            enrolled=user.totp_confirmed_at is not None, enrolled_at=user.totp_confirmed_at,
            required=user.totp_required,
            backup_codes_remaining=await auth_service.backup_codes_remaining(
                db, user.person_id)),
        "password_min_length": get_settings().password_min_length,
        "source": user.source,
    }


async def _session_out(db: AsyncSession, result: AuthResult, response: Response) -> SessionOut:
    _set_refresh_cookie(response, result)
    return SessionOut(access_token=result.access_token,
                      expires_in=get_settings().access_token_ttl_seconds,
                      **await me_fields(db, result.user, result.access,
                                        result.session_expires_at))


@router.post("/login", response_model=SessionOut | LoginChallengeOut)
async def login(body: LoginIn, request: Request, response: Response, db: DbSession):
    try:
        result = await auth_service.login(db, email=body.email, password=body.password,
                                          ip=client_ip(request),
                                          user_agent=request.headers.get("user-agent"))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    if isinstance(result, LoginChallenge):
        return LoginChallengeOut(challenge_token=result.challenge_token,
                                 backup_codes_remaining=result.backup_codes_remaining)
    return await _session_out(db, result, response)


@router.post("/totp/verify", response_model=SessionOut)
async def totp_verify(body: TotpVerifyIn, request: Request, response: Response, db: DbSession,
                      x_totp_challenge: Annotated[str | None, Header()] = None):
    if not x_totp_challenge:
        raise HTTPException(status_code=401, detail={"code": "invalid_challenge"})
    try:
        result = await auth_service.verify_totp(
            db, challenge_token=x_totp_challenge, code=body.code, ip=client_ip(request),
            user_agent=request.headers.get("user-agent"))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return await _session_out(db, result, response)


@router.post("/refresh", response_model=SessionOut)
async def refresh(request: Request, response: Response, db: DbSession,
                  sirdar_refresh: Annotated[str | None, Cookie()] = None):
    if not sirdar_refresh:
        raise HTTPException(status_code=401, detail={"code": "missing_refresh"})
    try:
        result = await auth_service.refresh(db, refresh_token=sirdar_refresh,
                                            ip=client_ip(request),
                                            user_agent=request.headers.get("user-agent"))
    except AuthError as exc:
        failed = JSONResponse(status_code=_STATUS.get(exc.code, 401),
                              content={"detail": {"code": exc.code}})
        _clear_refresh_cookie(failed)
        return failed
    return await _session_out(db, result, response)


@router.post("/logout", status_code=204)
async def logout(db: DbSession, sirdar_refresh: Annotated[str | None, Cookie()] = None):
    if sirdar_refresh:
        await auth_service.logout(db, refresh_token=sirdar_refresh)
    resp = Response(status_code=204)
    _clear_refresh_cookie(resp)
    return resp


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser, db: DbSession):
    return MeOut(**await me_fields(db, user.user, user.access, user.session.expires_at))


@router.put("/me/preferences", response_model=UiPreferences)
async def save_preferences(prefs: UiPreferences, user: CurrentUser, db: DbSession):
    user.user.ui_prefs = prefs.model_dump(mode="json")
    await db.commit()
    return prefs


# ── two-factor enrollment (local users) ──────────────────────────────

class TotpEnrollStartOut(BaseModel):
    secret: str
    otpauth_uri: str


class TotpEnrollConfirmIn(BaseModel):
    code: str = Field(min_length=6, max_length=16)
    remember: bool = False


class TotpEnrollConfirmOut(BaseModel):
    backup_codes: list[str]
    session: None = None


class TotpRegenerateIn(BaseModel):
    code: str = Field(min_length=6, max_length=16)


class BackupCodesOut(BaseModel):
    backup_codes: list[str]


def _local_only(user: User) -> None:
    if user.source != "local":
        raise HTTPException(status_code=403, detail={"code": "managed_in_portal"})


@router.post("/totp/enroll/start", response_model=TotpEnrollStartOut)
async def totp_enroll_start(ctx: CurrentUser, db: DbSession):
    _local_only(ctx.user)
    try:
        out = totp_enroll.start_enrollment(ctx.user)
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    await db.commit()
    return out


@router.post("/totp/enroll/confirm", response_model=TotpEnrollConfirmOut)
async def totp_enroll_confirm(body: TotpEnrollConfirmIn, request: Request, ctx: CurrentUser,
                              db: DbSession):
    _local_only(ctx.user)
    try:
        codes = await totp_enroll.confirm_enrollment(
            db, ctx.user.person_id, body.code, client_ip(request))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return TotpEnrollConfirmOut(backup_codes=codes)


@router.post("/totp/backup-codes/regenerate", response_model=BackupCodesOut)
async def totp_regenerate(body: TotpRegenerateIn, request: Request, ctx: CurrentUser,
                          db: DbSession):
    _local_only(ctx.user)
    try:
        codes = await totp_enroll.regenerate_backup_codes(
            db, ctx.user.person_id, body.code, client_ip(request))
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return BackupCodesOut(backup_codes=codes)
