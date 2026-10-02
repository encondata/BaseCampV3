"""/edge/* — the laptop's own endpoints: identity, status for the footer and
the Edge settings tab, and the operator/admin actions."""

import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from edge import laptop_setup, outbox
from edge.deps import current_session, err, require_admin, require_session
from edge.identity import rename
from edge.sessions import EdgeSession

router = APIRouter(prefix="/edge")

AUTH_TABLES = ("cloud_sessions", "offline_logins", "edge_sessions", "login_failures",
               "move_passwords")
MOVE_TABLES = ("cache", "outbox", "laptop_setup", "rfid_events")


async def _json_object(request: Request, *, empty_ok: bool = False) -> dict:
    """The body as a JSON object; anything else is 422 bad_request."""
    raw = await request.body()
    if empty_ok and not raw.strip():
        return {}
    try:
        body = json.loads(raw)
    except ValueError:
        raise err(422, "bad_request") from None
    if not isinstance(body, dict):
        raise err(422, "bad_request")
    return body


def _status(request: Request, session: EdgeSession | None) -> dict:
    st = request.app.state
    meta = st.syncer.meta()
    return {
        "version": st.settings.version,
        "cloud": {"online": st.upstream.online, "last_contact": st.upstream.last_contact},
        "sync": {"initiative_id": meta["initiative_id"], "synced_at": meta["synced_at"],
                 "last_error": meta["last_error"]},
        "outbox": outbox.counts(st.store),
        "waiting": outbox.waiting(st.store) if session else [],
        "session": {"offline": session.offline} if session else None,
        "identity": {"serial": st.identity.serial, "name": st.identity.name},
    }


@router.get("/identity")
async def get_identity(request: Request) -> dict:
    ident = request.app.state.identity
    return {"serial": ident.serial, "name": ident.name}


@router.post("/identity")
async def set_identity(request: Request, _: EdgeSession = Depends(require_admin)) -> dict:
    body = await _json_object(request)
    st = request.app.state
    try:
        st.identity = rename(st.settings.data_dir, st.identity, str(body.get("name", "")))
    except ValueError:
        raise err(422, "bad_name") from None
    return {"serial": st.identity.serial, "name": st.identity.name}


@router.get("/status")
async def status(request: Request) -> dict:
    return _status(request, current_session(request))


@router.post("/sync")
async def sync_now(request: Request, session: EdgeSession = Depends(require_session)) -> dict:
    await request.app.state.syncer.run()
    return _status(request, session)


@router.get("/setup")
async def shared_setup(request: Request, _: EdgeSession = Depends(require_session)) -> dict | None:
    """The laptop's finished Kiosk Setup, for any browser; null before the
    first one (or after Wipe)."""
    return laptop_setup.load(request.app.state.store)


@router.post("/outbox/retry")
async def retry(request: Request, _: EdgeSession = Depends(require_session)) -> dict:
    n = outbox.retry_failed(request.app.state.store)
    request.app.state.outbox_wake.set()
    return {"requeued": n}


@router.post("/wipe")
async def wipe(request: Request, _: EdgeSession = Depends(require_admin)) -> JSONResponse:
    st = request.app.state
    body = await _json_object(request, empty_ok=True)
    pending = outbox.pending_count(st.store)
    if pending and body.get("confirm") != "WIPE":
        raise err(409, "outbox_not_empty", pending=pending)
    with st.store.tx() as c:
        for table in AUTH_TABLES + MOVE_TABLES:
            c.execute(f"DELETE FROM {table}")
        c.execute("UPDATE sync_meta SET initiative_id = NULL, actor_person_id = NULL, "
                  "synced_at = NULL, last_error = NULL WHERE id = 1")
    response = JSONResponse({"cleared_move_data": True})
    response.delete_cookie("ss_refresh", path="/auth")
    return response
