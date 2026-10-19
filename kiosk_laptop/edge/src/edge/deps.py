"""Request helpers shared by the edge routes."""

import json

from fastapi import Depends, HTTPException, Request

from edge import sessions
from edge.sessions import EdgeSession

ADMIN_RANK = 60


def err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def current_session(request: Request) -> EdgeSession | None:
    token = bearer(request)
    if token is None:
        return None
    st = request.app.state
    return sessions.from_access_token(st.store, st.keys, token)


def require_session(request: Request) -> EdgeSession:
    session = current_session(request)
    if session is None:
        raise err(401, "not_authenticated")
    return session


def online(session: EdgeSession = Depends(require_session)) -> EdgeSession:
    """A session made while the cloud was reachable: work that needs the
    cloud refuses an offline sign-in (503 edge_offline)."""
    if session.offline:
        raise err(503, "edge_offline")
    return session


class TooLarge(Exception):
    pass


async def _capped(request: Request, max_bytes: int) -> bytes:
    length = request.headers.get("content-length")
    if length is not None and length.isdigit() and int(length) > max_bytes:
        raise TooLarge()
    out = bytearray()
    async for chunk in request.stream():
        out += chunk
        if len(out) > max_bytes:
            raise TooLarge()
    return bytes(out)


async def json_object(request: Request, *, empty_ok: bool = False,
                      max_bytes: int | None = None) -> dict:
    """The body as a JSON object; anything else is 422 bad_request. With
    `max_bytes`, a larger body (by Content-Length, or while reading) is 413
    request_too_large before it is parsed."""
    if max_bytes is None:
        raw = await request.body()
    else:
        try:
            raw = await _capped(request, max_bytes)
        except TooLarge:
            raise err(413, "request_too_large") from None
    if empty_ok and not raw.strip():
        return {}
    try:
        body = json.loads(raw)
    except ValueError:
        raise err(422, "bad_request") from None
    if not isinstance(body, dict):
        raise err(422, "bad_request")
    return body


def require_admin(request: Request) -> EdgeSession:
    session = require_session(request)
    if session.max_rank < ADMIN_RANK:
        raise err(403, "forbidden")
    return session
