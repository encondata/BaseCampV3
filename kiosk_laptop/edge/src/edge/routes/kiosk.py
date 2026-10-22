"""Kiosk endpoints the edge answers itself rather than proxying."""

import json
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Request, Response

from edge import laptop_setup, outbox
from edge.deps import err, require_session
from edge.rfid import events, pairing, station_key
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


def with_station(body: bytes, store) -> tuple[bytes, str | None]:
    """The browser picks the station type; the edge alone supplies the reader
    (from its current pairing), whatever the browser sent. Returns the body
    and the station type. No pairing for `rfid` is 422 `reader_required`,
    as the cloud answers it."""
    try:
        data = json.loads(body) if body else None
    except ValueError:
        return body, None
    if not isinstance(data, dict):
        return body, None
    data.pop("reader", None)
    station = data.get("station_type")
    if station == "rfid":
        reader = pairing.cloud_reader(store)
        if reader is None:
            raise err(422, "reader_required")
        data["reader"] = reader
    return json.dumps(data).encode(), station if isinstance(station, str) else None


def _station_name(station: str | None) -> str:
    """The setup event's station text."""
    if station == "rfid":
        return "RFID Station"
    if station == "timeclock":
        return "Time Clock Station"
    return "Label Station"


@router.post("/setup")
async def setup(request: Request, session: EdgeSession = Depends(require_session)) -> Response:
    """Kiosk Setup needs the cloud. On success the laptop is now set up for
    that move, so pull it down before answering — the browser's own download
    that follows then reads what the edge just stored. The result is also
    kept for every browser (GET /edge/setup), and a Label Station drops the
    reader pairing — the reader row (password index, token) stays, so
    pairing it again later reuses them. Any new setup drops the station
    key (it covered the previous setup); an RFID, Label or Time Clock
    Station then asks the portal for a new one for this setup, and a failed issue is retried by
    the background loop. A Time Clock Station may have no move (its sync
    target is then empty, and no "Move loaded" event is recorded) and,
    like a Label Station, drops the reader pairing; it uploads no scans,
    so every pending one is rejected `station_changed`. Every setup
    revokes the Time Clock's armed screens (they go with the key)."""
    st = request.app.state
    body, station = with_station(await request.body(), st.store)
    body = rewrite_body("/kiosk/setup", body, st.identity)
    try:
        resp = await st.upstream.as_person(session.person_id, "POST", "/kiosk/setup",
                                           content=body,
                                           headers={"content-type": "application/json"})
    except CloudOffline:
        raise err(503, "edge_offline") from None
    if resp is None:
        raise err(403, "cloud_sign_in_required")  # not 401: the edge session is still good
    if resp.status_code == 200:
        result = resp.json()
        if station in ("label", "timeclock"):
            previous = pairing.current_row(st.store)
            if previous is not None:  # best effort: the reader stops sending here
                async with st.pair_lock:
                    await pairing.release(previous, st.identity, transport=st.reader_transport)
            st.store.run("DELETE FROM rfid_pairing")
            # A Label Station's key uploads Labeled scans only: RFID scans
            # left pending could never upload, so say why instead of leaving
            # them pending forever. Labeled scans (scan_type 'barcode') stay.
            # A Time Clock Station's key uploads no scans at all.
            only_rfid = "AND scan_type IS NOT 'barcode'" if station == "label" else ""
            st.store.run("UPDATE pending_rfid_scans SET upload_state = 'rejected', "
                         "reject_code = 'station_changed', waiting_for_internet = 0, "
                         "next_attempt_at = NULL WHERE upload_state = 'pending' "
                         f"{only_rfid}")
        # a key covers one setup; a station gets a new one. Dropping it also
        # revokes the Time Clock's armed screens: Start Time Clock arms again
        station_key.clear(st.store)
        if isinstance(result, dict):
            laptop_setup.save(st.store, result, station)
            if result.get("initiative_id") is not None:
                events.record(st.store, "move_loaded", "Move loaded",
                              str(result.get("initiative_name") or ""))
            events.record(st.store, "scan_type_selected", "Scan type selected",
                          f"{result.get('scan_status_label') or ''} · {_station_name(station)}")
            if station in station_key.STATION_TYPES:
                await station_key.issue(st, session.person_id)
        move = result["initiative_id"]
        st.syncer.set_target(str(move) if move is not None else None, session.person_id)
        # no label run here: a Label Station's settings stay unconfirmed
        # until setup step 5 saves them (PUT /edge/label-station runs it)
        await st.syncer.run()
    return passthrough(resp)
