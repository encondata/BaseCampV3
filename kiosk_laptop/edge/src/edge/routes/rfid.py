"""/edge/rfid/* — reader discovery (spec §2.2) and pairing (spec §2.4) for
Kiosk Setup. Connect and pair need an online session: Kiosk Setup can't
finish without the cloud, so an offline sign-in mustn't change a reader
(503 edge_offline). Scanning stays open."""

from fastapi import APIRouter, Depends, Request

from edge.deps import err, require_session
from edge.rfid import checks, pairing
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
        return await pairing.connect(st.store, st.identity, ip,
                                     transport=st.reader_transport,
                                     found_at=st.discovery.endpoint_for(ip))
    except ReaderError as exc:
        raise pairing.reader_http_error(exc) from None


@router.post("/pair", dependencies=[Depends(online)])
async def pair(request: Request) -> dict:
    body = await _json_object(request)
    ip = pairing.valid_ipv4(body.get("ip"))
    st = request.app.state
    laptop_ip = pairing.laptop_address(st.settings.data_dir, ip, body.get("laptop_ip"))
    async with st.pair_lock:  # one rewrite of a reader's endpoints at a time
        try:
            return await pairing.pair(st.store, st.identity, ip, laptop_ip,
                                      confirm_takeover=body.get("confirm_takeover") is True,
                                      transport=st.reader_transport,
                                      found_at=st.discovery.endpoint_for(ip))
        except ReaderError as exc:
            raise pairing.reader_http_error(exc) from None


@router.get("/reader")
async def reader(request: Request) -> dict | None:
    return pairing.current(request.app.state.store)


@router.post("/start", dependencies=[Depends(online)])
async def start(request: Request) -> dict:
    st = request.app.state
    async with st.pair_lock:
        try:
            client, _version, _row = await pairing.open_current(
                st.store, transport=st.reader_transport)
            async with client:
                await client.start()
        except ReaderError as exc:
            raise pairing.reader_http_error(exc) from None
    return {"reading": True}


@router.post("/stop")
async def stop(request: Request) -> dict:
    st = request.app.state
    async with st.pair_lock:
        try:
            client, _version, _row = await pairing.open_current(
                st.store, transport=st.reader_transport)
            async with client:
                await client.stop()
        except ReaderError as exc:
            raise pairing.reader_http_error(exc) from None
    return {"reading": False}


@router.get("/status")
async def status(request: Request) -> dict:
    st = request.app.state
    async with st.pair_lock:
        reader = pairing.current(st.store)
        if reader is None:
            return {"reader": None}
        out = {"reader": reader, "reachable": False, "reading": False, "radio": None}
        try:
            client, _version, _row = await pairing.open_current(
                st.store, transport=st.reader_transport)
            async with client:
                reported = await client.status()
            out.update(reachable=True, reading=reported.get("radioActivitiy") == "active",
                       radio=reported.get("radioConnection"))
        except ReaderError:
            pass
    return out


@router.get("/checks/{name}")
async def check(name: str, request: Request,
                session: EdgeSession = Depends(require_session)) -> dict:
    if name not in checks.CHECK_NAMES:
        raise err(404, "unknown_check")
    return await checks.run(name, request.app.state, session)
