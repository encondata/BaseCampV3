"""Kiosk endpoints the edge answers itself rather than proxying."""

from fastapi import APIRouter, Depends, Request, Response

from edge import outbox
from edge.deps import err, require_session
from edge.sessions import EdgeSession

router = APIRouter(prefix="/kiosk")


@router.post("/scans")
async def scans(request: Request, session: EdgeSession = Depends(require_session)) -> dict:
    body = await request.json()
    items = body.get("scans") if isinstance(body, dict) else None
    if not isinstance(items, list) or not items or len(items) > outbox.SCAN_BATCH \
            or not all(isinstance(s, dict) and s.get("client_scan_id") for s in items):
        raise err(422, "bad_scans")
    outbox.enqueue_scans(request.app.state.store, session.person_id, session.person_name, items)
    request.app.state.outbox_wake.set()
    return {"accepted": [s["client_scan_id"] for s in items], "rejected": []}


@router.post("/printer-events", status_code=204)
async def printer_events(request: Request,
                         session: EdgeSession = Depends(require_session)) -> Response:
    body = await request.json()
    if not isinstance(body, dict):
        raise err(422, "bad_event")
    outbox.enqueue_printer_event(request.app.state.store, session.person_id,
                                 session.person_name, body)
    request.app.state.outbox_wake.set()
    return Response(status_code=204)
