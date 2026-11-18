"""FastAPI dependencies for who is calling and what they may do.

- `current_principal`: any live session (401 / 503 otherwise).
- `require(action)`: the web app's routes. Portal sessions only, no forced
  password change outstanding, the action granted, and no writes while the
  main API is in read-only mode.
- `kiosk_principal`: the kiosk app's routes (/api/updates and its links).
  Kiosk sessions, or portal sessions holding `view`.
"""

from typing import Annotated

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from serversherpa_devices.auth.main_api import (
    MainApiClient,
    MainApiUnavailable,
    Principal,
    get_main_api,
)

_bearer = HTTPBearer(auto_error=False)
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


async def current_principal(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    main_api: Annotated[MainApiClient, Depends(get_main_api)],
) -> Principal:
    if credentials is None or not credentials.credentials:
        raise _err(401, "unauthenticated", "Sign in to continue.")
    try:
        principal = await main_api.authorize(credentials.credentials)
    except MainApiUnavailable:
        raise _err(503, "main_api_unavailable",
                   "Sign-in is unavailable right now. Try again in a minute.") from None
    if principal is None:
        raise _err(401, "unauthenticated", "Sign in to continue.")
    return principal


def require(action: str):
    """A dependency for a web-app route that needs `action`."""

    async def dependency(
        request: Request,
        principal: Annotated[Principal, Depends(current_principal)],
    ) -> Principal:
        if principal.client == "kiosk":
            raise _err(403, "kiosk_session", "Kiosk sessions can't use the Devices web app.")
        if principal.password_change_required:
            raise _err(403, "password_change_required",
                       "Change your password before continuing.")
        if not principal.can(action):
            raise _err(403, "forbidden", "You don't have permission to do that.")
        if principal.read_only and request.method not in _READ_METHODS:
            raise _err(423, "read_only_mode",
                       principal.read_only_message or "ServerSherpa is in read-only mode.")
        return principal

    return dependency


async def kiosk_principal(
    principal: Annotated[Principal, Depends(current_principal)],
) -> Principal:
    if principal.client == "kiosk" or principal.can("view"):
        return principal
    raise _err(403, "forbidden", "You don't have permission to do that.")


def client_ip(request: Request) -> str | None:
    """The caller's IP, for audit rows. X-Forwarded-For is never read here."""
    # uvicorn --proxy-headers --forwarded-allow-ips=<proxy> rewrites request.client from it.
    return request.client.host if request.client else None
