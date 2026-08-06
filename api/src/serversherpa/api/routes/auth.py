"""Auth endpoints. The refresh token travels ONLY in an httpOnly cookie
scoped to /auth — JavaScript never sees it, and it is not sent with
ordinary API requests."""

from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, Request, Response

from serversherpa.api.deps import CurrentUser, DbSession, client_ip
from serversherpa.api.schemas import (
    LoginIn, MeOut, PersonOut, ScopeOut, SessionOut, UiPreferences,
)
from serversherpa.config import get_settings
from serversherpa.services import auth as auth_service
from serversherpa.services.audit import audit, diff
from serversherpa.services.auth import AuthError, AuthResult
from serversherpa.services.storage import presign_get


def person_out(person) -> PersonOut:
    out = PersonOut.model_validate(person)
    out.avatar_url = presign_get(person.avatar_key)
    return out

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "ss_refresh"

# AuthError code -> HTTP status. Everything else is a plain 401.
_STATUS = {"account_locked": 423}


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


def _scope_out(access) -> ScopeOut:
    return ScopeOut(**{"global": access.is_global},
                    client_ids=sorted(access.client_ids),
                    partner_ids=sorted(access.partner_ids))


def _session_response(result: AuthResult, response: Response) -> SessionOut:
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
    )


def _auth_http_error(exc: AuthError) -> HTTPException:
    return HTTPException(
        status_code=_STATUS.get(exc.code, 401), detail={"code": exc.code})


@router.post("/login", response_model=SessionOut)
async def login(
    body: LoginIn, request: Request, response: Response, db: DbSession
) -> SessionOut:
    try:
        result = await auth_service.login(
            db, email=body.email, password=body.password,
            ip=client_ip(request), user_agent=request.headers.get("user-agent"),
        )
    except AuthError as exc:
        raise _auth_http_error(exc) from None
    return _session_response(result, response)


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
    return _session_response(result, response)


@router.post("/logout", status_code=204)
async def logout(
    response: Response, db: DbSession,
    ss_refresh: Annotated[str | None, Cookie()] = None,
) -> None:
    if ss_refresh:
        await auth_service.logout(db, refresh_token=ss_refresh)
    _clear_refresh_cookie(response)


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser) -> MeOut:
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
