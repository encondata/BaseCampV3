"""/edge/rfid/* — reader discovery (spec §2.2) and pairing (spec §2.4) for
Kiosk Setup."""

from fastapi import APIRouter, Depends, Request

from edge.deps import err, require_session
from edge.rfid import pairing
from edge.rfid.ziotc import ReaderError

router = APIRouter(prefix="/edge/rfid", dependencies=[Depends(require_session)])


async def _json_object(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise err(422, "bad_request")
    return body


@router.post("/scan")
async def start_scan(request: Request) -> dict:
    return {"scan_id": request.app.state.discovery.start()}


@router.get("/scan")
async def scan(request: Request) -> dict:
    return request.app.state.discovery.snapshot()


@router.post("/connect")
async def connect(request: Request) -> dict:
    body = await _json_object(request)
    ip = pairing.valid_ipv4(body.get("ip"))
    st = request.app.state
    try:
        return await pairing.connect(st.store, ip, transport=st.reader_transport)
    except ReaderError as exc:
        raise pairing.reader_http_error(exc) from None


@router.post("/pair")
async def pair(request: Request) -> dict:
    body = await _json_object(request)
    ip = pairing.valid_ipv4(body.get("ip"))
    st = request.app.state
    laptop_ip = pairing.laptop_address(st.settings.data_dir, ip, body.get("laptop_ip"))
    async with st.pair_lock:  # one rewrite of a reader's endpoints at a time
        try:
            return await pairing.pair(st.store, st.identity, ip, laptop_ip,
                                      confirm_takeover=body.get("confirm_takeover") is True,
                                      transport=st.reader_transport)
        except ReaderError as exc:
            raise pairing.reader_http_error(exc) from None


@router.get("/reader")
async def reader(request: Request) -> dict | None:
    return pairing.current(request.app.state.store)
