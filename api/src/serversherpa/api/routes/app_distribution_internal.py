"""The internal API the separate Devices (app-distribution) service calls —
never the browser. Every route presents the shared service token
(`X-Devices-Service-Token`, SS_DEVICES_SERVICE_TOKEN).

- `GET /app-distribution/internal/authorize` — who is this bearer token,
  and what may they do with apps? The service enforces the kiosk session
  scope and the forced password change itself, from the fields returned,
  so neither is enforced here.
- `POST /app-distribution/internal/audit` — write one audit row.
"""
from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from serversherpa.api.deps import DbSession, authenticate_token, password_change_owed
from serversherpa.api.schemas import AppDistAuditIn, AppDistAuthorizeOut
from serversherpa.config import get_settings
from serversherpa.services.audit import audit
from serversherpa.system.admin_config import read_admin_config

_bearer = HTTPBearer(auto_error=False)


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


async def service_auth(
    x_devices_service_token: Annotated[str | None, Header()] = None,
) -> None:
    """503 `internal_disabled` while no token is configured, 401
    `bad_service_token` for a missing or wrong one (constant-time compare)."""
    expected = get_settings().devices_service_token.get_secret_value()
    if not expected:
        raise _err(503, "internal_disabled", "The devices internal API isn't configured.")
    if not x_devices_service_token or not hmac.compare_digest(
            x_devices_service_token.encode(), expected.encode()):
        raise _err(401, "bad_service_token", "Bad service token.")


router = APIRouter(prefix="/app-distribution/internal",
                   dependencies=[Depends(service_auth)])


@router.get("/authorize", response_model=AppDistAuthorizeOut)
async def authorize(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AppDistAuthorizeOut:
    if credentials is None:
        raise _err(401, "unauthenticated", "Sign in to continue.")
    try:
        user = await authenticate_token(db, credentials.credentials)
    except HTTPException as exc:
        if exc.status_code == 401:
            raise _err(401, "unauthenticated", "Sign in to continue.") from None
        raise
    perms = user.access.perms.get("app_distribution", {})
    cfg = await read_admin_config(db)
    read_only = bool(cfg["read_only"]) and "developer" not in user.roles
    return AppDistAuthorizeOut(
        person_id=user.person.id,
        display_name=user.person.display_name,
        email=user.account.email,
        client="kiosk" if user.session.client == "kiosk" else "portal",
        kiosk_serial=user.session.kiosk_serial,
        actions=[a for a in ("view", "add", "change", "delete") if perms.get(a)],
        password_change_required=await password_change_owed(db, user),
        read_only=read_only,
        read_only_message=cfg["read_only_message"] if read_only else None)


@router.post("/audit", status_code=204)
async def write_audit(body: AppDistAuditIn, db: DbSession) -> Response:
    audit(db, actor_id=body.actor_person_id, entity_type=body.entity_type,
          entity_id=body.entity_id, action=body.action, changes=body.changes,
          ip=body.ip)
    await db.commit()
    return Response(status_code=204)
