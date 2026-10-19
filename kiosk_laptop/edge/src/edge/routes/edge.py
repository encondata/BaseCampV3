"""/edge/* — the laptop's own endpoints: identity, status for the footer and
the Edge settings tab, and the operator/admin actions."""


from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from edge import config_sync, laptop_setup, outbox
from edge.deps import current_session, err, require_admin, require_session
from edge.deps import json_object as _json_object
from edge.identity import rename
from edge.rfid import uploader
from edge.rfid.tagreads import note_cache_write
from edge.sessions import EdgeSession

router = APIRouter(prefix="/edge")

AUTH_TABLES = ("cloud_sessions", "offline_logins", "edge_sessions", "login_failures",
               "move_passwords")
MOVE_TABLES = ("cache", "outbox", "laptop_setup", "rfid_events",
              "raw_tag_reads", "rfid_tags_seen", "station_key", "pending_rfid_scans",
              "rfid_unmatched", "alarm_open", "alarm_last", "station_labels", "label_run")


def _status(request: Request, session: EdgeSession | None) -> dict:
    st = request.app.state
    meta = st.syncer.meta()
    return {
        "version": st.settings.version,
        "cloud": {"online": st.upstream.online, "last_contact": st.upstream.last_contact},
        "sync": {"initiative_id": meta["initiative_id"], "synced_at": meta["synced_at"],
                 "last_error": meta["last_error"]},
        "outbox": outbox.counts(st.store),
        "rfid_uploads": uploader.counts(st.store),
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


@router.get("/config")
async def get_config(request: Request, _: EdgeSession = Depends(require_session)) -> dict:
    """The laptop's kiosk config for its browsers: `{doc, version, changed_at}`
    (doc null until a browser seeds it or the portal sends one)."""
    return config_sync.get(request.app.state.store)


@router.put("/config")
async def put_config(request: Request, _: EdgeSession = Depends(require_session)) -> dict:
    """`{doc, base_version?, seed?}` from a browser (config_sync.put). 409
    `config_changed` carries the current copy when base_version is stale."""
    body = await _json_object(request)
    doc = body.get("doc")
    base = body.get("base_version")
    seed = body.get("seed", False)
    if not isinstance(doc, dict) or not isinstance(seed, bool) \
            or (base is not None and (not isinstance(base, int) or isinstance(base, bool))):
        raise err(422, "bad_request")
    if not config_sync.fits(doc):
        raise err(422, "config_too_large")
    try:
        return config_sync.put(request.app.state.store, doc, base, seed=seed)
    except config_sync.ConfigConflict as exc:
        raise err(409, "config_changed", **exc.current) from None


@router.post("/outbox/retry")
async def retry(request: Request, _: EdgeSession = Depends(require_session)) -> dict:
    n = outbox.retry_failed(request.app.state.store)
    request.app.state.outbox_wake.set()
    return {"requeued": n}


@router.post("/wipe")
async def wipe(request: Request, _: EdgeSession = Depends(require_admin)) -> JSONResponse:
    st = request.app.state
    body = await _json_object(request, empty_ok=True)
    # unsent data: queued kiosk writes and RFID scans not yet uploaded
    pending = outbox.pending_count(st.store) + st.store.one(
        "SELECT COUNT(*) AS n FROM pending_rfid_scans WHERE upload_state = 'pending'")["n"]
    if pending and body.get("confirm") != "WIPE":
        raise err(409, "outbox_not_empty", pending=pending)
    with st.store.tx() as c:
        had_label_station = laptop_setup.label_station_in(c) is not None
        for table in AUTH_TABLES + MOVE_TABLES:
            c.execute(f"DELETE FROM {table}")
        # the processor starts after whatever raw reads remain (none: ids keep counting up)
        c.execute("INSERT INTO rfid_processing_meta (id, last_raw_id) "
                  "VALUES (1, (SELECT COALESCE(MAX(id), 0) FROM raw_tag_reads)) "
                  "ON CONFLICT (id) DO UPDATE SET last_raw_id = excluded.last_raw_id")
        c.execute("UPDATE sync_meta SET initiative_id = NULL, actor_person_id = NULL, "
                  "synced_at = NULL, last_error = NULL WHERE id = 1")
        if had_label_station:  # the config's mirror drops it too
            config_sync.note_label_station(c)
    note_cache_write()  # the cache table was emptied: drop memoized tag indexes
    st.label_runner.forget()
    response = JSONResponse({"cleared_move_data": True})
    response.delete_cookie("ss_refresh", path="/auth")
    return response
