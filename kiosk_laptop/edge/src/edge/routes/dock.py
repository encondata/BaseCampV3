"""/edge/dock/* — what the kiosk's Dock screen polls and does: the overview,
one closed pass's detail, the settings save and the Start, Pause and Stop
control. Like /edge/rfid/alarm these need any edge session, online or
offline; only Start needs an online one (as /edge/rfid/start does). Apart
from the control's reader calls, they only read and write the laptop's own
store."""

import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request

from edge.deps import err, json_object, online, require_session
from edge.dock import grouper, state, views
from edge.routes.rfid import start_reader, stop_reader
from edge.sessions import EdgeSession

router = APIRouter(prefix="/edge/dock", dependencies=[Depends(require_session)])

_ID = re.compile(r"[0-9]{1,18}")   # fits SQLite's integer; anything else is no pass
CONTROLS = ("start", "pause", "stop")


@router.get("")
async def overview(request: Request) -> dict:
    st = request.app.state
    return {**views.overview(st.store, datetime.now(UTC)), "control": st.dock_control}


@router.get("/passes/{pass_id}")
async def pass_detail(request: Request, pass_id: str) -> dict:
    found = views.detail(request.app.state.store, int(pass_id)) if _ID.fullmatch(pass_id) else None
    if found is None:
        raise err(404, "pass_not_found")
    return found


@router.put("/settings")
async def save_settings(request: Request) -> dict:
    body = await json_object(request)
    try:
        return state.save_settings(request.app.state.store, dry_run=body.get("dry_run"),
                                   quiet_gap_s=body.get("quiet_gap_s"))
    except ValueError:
        raise err(422, "invalid_dock_settings") from None


@router.post("/control")
async def control(request: Request, session: EdgeSession = Depends(require_session)) -> dict:
    """Start starts the reader. Pause stops it and leaves the open burst to
    its own rule. Stop decides the open burst at once, before it stops the
    reader, so a stuck reader (or a reader call holding `pair_lock`) never
    holds the decision up; the reader's error, if any, is raised after it.
    Reads posted in between open a new burst. The button is remembered as
    the overview's `control` whatever the reader answers."""
    action = (await json_object(request)).get("action")
    if action not in CONTROLS:
        raise err(422, "bad_request")
    st = request.app.state
    st.dock_control = action
    if action == "start":
        online(session)
        return {**await start_reader(st, session), "control": action, "decided": 0}
    if action == "pause":
        return {**await stop_reader(st, session), "control": action, "decided": 0}
    decided = _decide_now(st)
    return {**await stop_reader(st, session), "control": action, "decided": decided}


def _decide_now(st) -> int:
    """Decide the open burst now (passes decided), waking the sender for a
    pass waiting to be sent."""
    result = grouper.decide_now(st.store)
    if result.to_send:
        st.dock_send_wake.set()
    return result.closed
