"""/edge/dock/* — what the kiosk's Dock screen polls: the overview, one
closed pass's detail and the settings save. Like /edge/rfid/alarm these need
any edge session, online or offline; they only read and write the laptop's
own store."""

import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request

from edge.deps import err, json_object, require_session
from edge.dock import state, views

router = APIRouter(prefix="/edge/dock", dependencies=[Depends(require_session)])

_ID = re.compile(r"[0-9]{1,18}")   # fits SQLite's integer; anything else is no pass


@router.get("")
async def overview(request: Request) -> dict:
    return views.overview(request.app.state.store, datetime.now(UTC))


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
