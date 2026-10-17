"""/edge/rfid/* — reader discovery (spec §2.2) and pairing (spec §2.4) for
Kiosk Setup. Connect and pair need an online session: Kiosk Setup can't
finish without the cloud, so an offline sign-in mustn't change a reader
(503 edge_offline). Scanning stays open."""

import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request

from edge import config_sync, laptop_setup
from edge.deps import err, require_session
from edge.rfid import alarm, checks, events, pairing, tagreads, ziotc
from edge.rfid.reader_report import current_snapshot
from edge.rfid.ziotc import ReaderError
from edge.sessions import EdgeSession

router = APIRouter(prefix="/edge/rfid", dependencies=[Depends(require_session)])


async def _json_object(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise err(422, "bad_request")
    return body


def online(session: EdgeSession = Depends(require_session)) -> EdgeSession:
    if session.offline:
        raise err(503, "edge_offline")
    return session


@router.post("/scan")
async def start_scan(request: Request) -> dict:
    return {"scan_id": request.app.state.discovery.start()}


@router.get("/scan")
async def scan(request: Request) -> dict:
    return request.app.state.discovery.snapshot()


@router.post("/connect", dependencies=[Depends(online)])
async def connect(request: Request) -> dict:
    body = await _json_object(request)
    ip = pairing.valid_ipv4(body.get("ip"))
    st = request.app.state
    try:
        found = await pairing.connect(st.store, st.identity, ip,
                                      transport=st.reader_transport,
                                      found_at=st.discovery.endpoint_for(ip))
    except ReaderError as exc:
        raise pairing.reader_http_error(exc) from None
    events.record(st.store, "reader_connected", "Reader connected",
                  f"{found.get('model') or 'Reader'} · {ip}")
    return found


@router.post("/pair", dependencies=[Depends(online)])
async def pair(request: Request) -> dict:
    body = await _json_object(request)
    ip = pairing.valid_ipv4(body.get("ip"))
    st = request.app.state
    laptop_ip = pairing.laptop_address(st.settings.data_dir, ip, body.get("laptop_ip"))
    async with st.pair_lock:  # one rewrite of a reader's endpoints at a time
        try:
            paired = await pairing.pair(st.store, st.identity, ip, laptop_ip,
                                        confirm_takeover=body.get("confirm_takeover") is True,
                                        transport=st.reader_transport,
                                        found_at=st.discovery.endpoint_for(ip))
        except ReaderError as exc:
            raise pairing.reader_http_error(exc) from None
    events.record(st.store, "reader_paired", "Reader paired",
                  f"{(paired.get('reader') or paired).get('model') or 'Reader'} "
                  f"· sends to {laptop_ip}")
    return paired


@router.get("/reader")
async def reader(request: Request) -> dict | None:
    return pairing.current(request.app.state.store)


@router.get("/device")
async def device(request: Request) -> dict:
    """What the kiosk Devices tab shows for the paired reader. Reads only the
    edge's own store and cached snapshot; it never contacts the reader."""
    st = request.app.state
    row = pairing.current_row(st.store)
    if row is None:
        return {"reader": None}
    last = st.store.one("SELECT MAX(received_at) AS at FROM raw_tag_reads "
                        "WHERE reader_serial = ?", (row["serial"],))
    return {"reader": {"serial": row["serial"], "model": row["model"], "ip": row["ip"],
                       "paired_at": row["paired_at"]},
            "snapshot": current_snapshot(st),
            "last_read_at": last["at"] if last else None}


def _token(st) -> str | None:
    row = pairing.current_row(st.store)
    return row["token"] if row is not None else None


def _redacted_error(exc: ReaderError, token: str | None):
    """The reader's own message can carry the endpoint URL, and with it the token."""
    return pairing.reader_http_error(
        ReaderError(exc.code, pairing.redact_token(exc.message, token)))


START_ONGOING = re.compile(r"start currently ongoing", re.I)


@router.post("/start", dependencies=[Depends(online)])
async def start(request: Request, session: EdgeSession = Depends(require_session)) -> dict:
    st = request.app.state
    async with st.pair_lock:
        token = _token(st)
        try:
            client, version, row = await pairing.open_current(
                st.store, transport=st.reader_transport)
            async with client:
                await client.start()
        except ReaderError as exc:
            if not START_ONGOING.search(exc.message):
                raise _redacted_error(exc, token) from None
            # the reader is already reading: that's what the caller wanted
            events.record(st.store, "reader_started", "Reader started",
                          f"{version.get('model') or row['model']} · already reading")
            return {"reading": True}
    events.record(st.store, "reader_started", "Reader started",
                  f"{version.get('model') or row['model']} · Started by {session.person_name}")
    return {"reading": True}


@router.post("/stop")
async def stop(request: Request, session: EdgeSession = Depends(require_session)) -> dict:
    st = request.app.state
    async with st.pair_lock:
        token = _token(st)
        try:
            client, _version, _row = await pairing.open_current(
                st.store, transport=st.reader_transport)
            async with client:
                await client.stop()
        except ReaderError as exc:
            raise _redacted_error(exc, token) from None
    events.record(st.store, "reader_stopped", "Reader stopped",
                  f"Stopped by {session.person_name}")
    return {"reading": False}


def connected_antennas(antennas) -> list[str]:
    if not isinstance(antennas, dict):
        return []
    return sorted(str(port) for port, state in antennas.items() if state == "connected")


@router.get("/events")
async def recent_events(request: Request, limit: int = 50) -> dict:
    return {"events": events.recent(request.app.state.store, limit)}


@router.get("/status")
async def status(request: Request) -> dict:
    st = request.app.state
    if st.pair_lock.locked():
        # A start, stop, pair or check holds the reader: answer now instead of
        # queueing polls behind a hung reader.
        reader = pairing.current(st.store)
        if reader is None:
            return {"reader": None}
        return {"reader": reader, "reachable": False, "reading": False, "radio": None,
                "antennas": [], "busy": True}
    async with st.pair_lock:
        reader = pairing.current(st.store)
        if reader is None:
            return {"reader": None}
        out = {"reader": reader, "reachable": False, "reading": False, "radio": None,
               "antennas": []}
        try:
            client, _version, _row = await pairing.open_current(
                st.store, transport=st.reader_transport)
            async with client:
                reported = await client.status()
            out.update(reachable=True, reading=ziotc.is_reading(reported),
                       radio=reported.get("radioConnection"),
                       antennas=connected_antennas(reported.get("antennas")))
        except ReaderError:
            pass
    return out


@router.get("/checks/{name}")
async def check(name: str, request: Request,
                session: EdgeSession = Depends(require_session)) -> dict:
    if name not in checks.CHECK_NAMES:
        raise err(404, "unknown_check")
    return await checks.run(name, request.app.state, session)


@router.get("/reads")
async def reads(request: Request, tz: str = "UTC") -> dict:
    return tagreads.reads_summary(request.app.state.store, tz=tz)


# The "Asset Not Part Of Move" alarm. Like /events (read) and /stop (write),
# these need any edge session, online or offline.

def _is_rfid_station(store) -> bool:
    return (laptop_setup.load(store) or {}).get("station_type") == "rfid"


def _int(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


@router.get("/alarm")
async def open_alarm(request: Request) -> dict:
    store = request.app.state.store
    if not _is_rfid_station(store):
        return alarm.empty(alarm.settings(store))
    return alarm.open_alarm(store, datetime.now(UTC))


@router.post("/alarm/dismiss")
async def dismiss_alarm(request: Request) -> dict:
    up_to_id = _int((await _json_object(request)).get("up_to_id"))
    if up_to_id is None:
        raise err(422, "bad_request")
    return {"dismissed": alarm.dismiss(request.app.state.store, up_to_id)}


@router.get("/alarm/settings")
async def alarm_settings(request: Request) -> dict:
    return alarm.settings(request.app.state.store)


@router.put("/alarm/settings")
async def save_alarm_settings(request: Request) -> dict:
    body = await _json_object(request)
    store = request.app.state.store
    try:
        saved = alarm.save_settings(store, body.get("mode"), body.get("timed_seconds"))
    except ValueError:
        raise err(422, "invalid_alarm_settings") from None
    config_sync.note_alarm_edit(store)  # the config's `alarm` follows, as a local change
    return saved
