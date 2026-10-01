"""Request helpers shared by the edge routes."""

from fastapi import HTTPException, Request

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


def require_admin(request: Request) -> EdgeSession:
    session = require_session(request)
    if session.max_rank < ADMIN_RANK:
        raise err(403, "forbidden")
    return session
