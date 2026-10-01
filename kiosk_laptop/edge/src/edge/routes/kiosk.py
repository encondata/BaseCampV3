"""Kiosk endpoints the edge answers itself rather than proxying."""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Request, Response

from edge import outbox
from edge.deps import err, require_session
from edge.routes.auth import passthrough
from edge.routes.proxy import rewrite_body
from edge.sessions import EdgeSession
from edge.upstream import CloudOffline

router = APIRouter(prefix="/kiosk")

SCAN_TYPES = ("rfid", "barcode")
SCANNED_VALUE_MAX = 200   # the cloud's KioskScanIn limit


def _valid_scan(scan: object) -> bool:
    """What the cloud's KioskScanIn would refuse is refused here, before it
    is queued: a 422 from the cloud later would fail the whole batch."""
    if not isinstance(scan, dict):
        return False
    try:
        uuid.UUID(str(scan.get("client_scan_id")))
        datetime.fromisoformat(scan.get("scanned_at"))
    except (ValueError, TypeError, AttributeError):
        return False
    value = scan.get("scanned_value")
    return (scan.get("scan_type") in SCAN_TYPES and isinstance(value, str)
            and bool(value.strip()) and len(value) <= SCANNED_VALUE_MAX)


@router.post("/scans")
async def scans(request: Request, session: EdgeSession = Depends(require_session)) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise err(422, "bad_scans") from None
    items = body.get("scans") if isinstance(body, dict) else None
    if not isinstance(items, list) or not items or len(items) > outbox.SCAN_BATCH \
            or not all(_valid_scan(s) for s in items):
        raise err(422, "bad_scans")
    outbox.enqueue_scans(request.app.state.store, session.person_id, session.person_name, items)
    request.app.state.outbox_wake.set()
    return {"accepted": [s["client_scan_id"] for s in items], "rejected": []}


@router.post("/printer-events", status_code=204)
async def printer_events(request: Request,
                         session: EdgeSession = Depends(require_session)) -> Response:
    try:
        body = await request.json()
    except ValueError:
        raise err(422, "bad_event") from None
    if not isinstance(body, dict):
        raise err(422, "bad_event")
    outbox.enqueue_printer_event(request.app.state.store, session.person_id,
                                 session.person_name, body)
    request.app.state.outbox_wake.set()
    return Response(status_code=204)


@router.post("/setup")
async def setup(request: Request, session: EdgeSession = Depends(require_session)) -> Response:
    """Kiosk Setup needs the cloud. On success the laptop is now set up for
    that move, so pull it down before answering — the browser's own download
    that follows then reads what the edge just stored."""
    st = request.app.state
    body = rewrite_body("/kiosk/setup", await request.body(), st.identity)
    try:
        resp = await st.upstream.as_person(session.person_id, "POST", "/kiosk/setup",
                                           content=body,
                                           headers={"content-type": "application/json"})
    except CloudOffline:
        raise err(503, "edge_offline") from None
    if resp is None:
        raise err(403, "cloud_sign_in_required")  # not 401: the edge session is still good
    if resp.status_code == 200:
        st.syncer.set_target(str(resp.json()["initiative_id"]), session.person_id)
        await st.syncer.run()
    return passthrough(resp)
