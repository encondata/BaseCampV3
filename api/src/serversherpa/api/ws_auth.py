"""Shared sign-in checks for the portal's WebSockets (the Process Logs live
tail and the live inbox stream). Browsers cannot set Authorization on a
WebSocket, so the access token rides the Sec-WebSocket-Protocol header as the
second entry of the subprotocol list (`ss-bearer, <token>`), never the URL,
because query strings land in access logs and proxy logs. It is validated
with the same machinery as HTTP before the socket is accepted."""

import uuid
from datetime import UTC, datetime

from fastapi import HTTPException, WebSocket
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext, authenticate_token, password_change_owed
from serversherpa.db.models import AuthSession

# The browser opens the socket with the subprotocol list
# ["ss-bearer", "<access token>"], which the handshake carries as
# `Sec-WebSocket-Protocol: ss-bearer, <token>`; the server accepts
# "ss-bearer" so the browser completes the handshake.
WS_AUTH_SUBPROTOCOL = "ss-bearer"

WS_UNAUTHENTICATED = 4401
WS_FORBIDDEN = 4403


def token_from_subprotocols(header: str | None) -> str | None:
    """Pull the access token out of a `Sec-WebSocket-Protocol` header of
    the form `ss-bearer, <token>`. None when the header is missing, the
    first entry is not ss-bearer, or there is no second entry."""
    if not header:
        return None
    parts = [p.strip() for p in header.split(",")]
    if len(parts) < 2 or parts[0] != WS_AUTH_SUBPROTOCOL or not parts[1]:
        return None
    return parts[1]


async def authenticate_portal_ws(db: AsyncSession, ws: WebSocket) -> AuthContext | int:
    """The signed-in portal user behind this socket, or the close code to
    use: 4401 when the token is missing (or offered some other way, such as
    `?token=`), malformed or invalid; 4403 for a kiosk session or a session
    that owes a password change. Route-specific permission checks come
    after this."""
    token = token_from_subprotocols(ws.headers.get("sec-websocket-protocol"))
    if token is None:
        return WS_UNAUTHENTICATED
    try:
        actor = await authenticate_token(db, token)
    except HTTPException:
        return WS_UNAUTHENTICATED
    # Mirror of get_current_user's kiosk-scope guard (403 kiosk_session on
    # HTTP): a kiosk login skips the 2FA challenge, so its session may
    # reach only the kiosk routes, never a portal socket.
    if actor.session.client == "kiosk":
        return WS_FORBIDDEN
    # Mirror of get_current_user's forced-password-change guard (403
    # password_change_required on HTTP): a temp-password session, or one
    # that signed in with an already-expired password, may only finish the
    # auth lifecycle, so it may not open a portal socket either.
    if await password_change_owed(db, actor):
        return WS_FORBIDDEN
    return actor


async def session_still_live(db: AsyncSession, session_id: uuid.UUID) -> bool:
    """False once the socket's session is gone, revoked or expired: an open
    socket can outlive its access token, so long-lived streams re-check."""
    session = await db.get(AuthSession, session_id)
    return not (
        session is None
        or session.revoked_at is not None
        or session.expires_at <= datetime.now(UTC)
    )
