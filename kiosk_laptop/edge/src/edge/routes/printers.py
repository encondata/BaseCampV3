"""/edge/printers/* — network Zebra printers for a Label Station (phase 1):
the subnet scan, a raw query, a raw send and a font download, all on port
9100 to a private LAN address only (edge/printers.py). /edge/label-station —
the station's label settings in the laptop's shared setup.

Every route needs an edge session. A font download also needs the cloud
(the font comes from the move-scoped kiosk font route, fetched as the
signed-in person), so an offline sign-in gets 503 edge_offline."""

import re
from email.message import Message
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from edge import laptop_setup
from edge.deps import err, json_object, online, require_session
from edge.printers import PrinterError, font_header
from edge.sessions import EdgeSession
from edge.upstream import CloudOffline

router = APIRouter(dependencies=[Depends(require_session)])

MAX_COMMAND = 4096              # a query: ~HI, ~HS, ^XA^HWE:*.*^XZ, the peeler getvar
# The only queries the kiosk sends (identity, status, the E: listing, and
# the SGD read of whether a peeler is fitted), byte for byte; anything else
# (settings, setvar, other getvars, deletes, resets) is refused here.
ALLOWED_QUERIES = frozenset({
    "~HI", "~HS", "^XA^HWE:*.*^XZ",
    '! U1 getvar "sensor.peeler_present"\r\n',
})
MAX_ZPL = 8 * 1024 * 1024       # a label job (graphics can be large)
BODY_OVERHEAD = 64 * 1024       # the JSON around it (ip, escapes of a few characters)
MAX_FONT = 16 * 1024 * 1024     # a TrueType font
FONT_NAME = re.compile(r"[A-Za-z0-9_\-]{1,64}\.TTF", re.IGNORECASE)
CLOUD_ID = re.compile(r"[A-Za-z0-9\-]{1,64}")


async def _ip(request: Request, value) -> str:
    try:
        await request.app.state.printers.check(value)
    except PrinterError as exc:
        raise _printer_error(exc) from None
    return value


def _text(body: dict, key: str, limit: int) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value or len(value) > limit:
        raise err(422, "bad_request")
    return value


_STATUS = {"bad_printer_ip": 422, "printer_timeout": 504, "printer_busy": 503,
           "printer_guard_unavailable": 503}


def _printer_error(exc: PrinterError):
    return err(_STATUS.get(exc.code, 502), exc.code)


@router.post("/edge/printers/scan")
async def start_scan(request: Request) -> dict:
    # the lookup in a thread first, so the scan's guard never looks up on the loop
    await request.app.state.printers.guard_ready()
    return {"scan_id": request.app.state.printers.start()}


@router.get("/edge/printers/scan")
async def scan(request: Request) -> dict:
    return request.app.state.printers.snapshot()


@router.post("/edge/printers/query")
async def query(request: Request) -> dict:
    """`{ip, command}` → `{response, truncated}`: the reply as text (bytes
    0-255 as latin-1), at most 64 KB, ending at 2 s idle or 5 s in all.
    `command` must be one of ALLOWED_QUERIES (422 command_not_allowed)."""
    body = await json_object(request)
    ip = await _ip(request, body.get("ip"))
    command = _text(body, "command", MAX_COMMAND)
    if command not in ALLOWED_QUERIES:
        raise err(422, "command_not_allowed")
    try:
        data, truncated = await request.app.state.printers.query(ip, command.encode("utf-8"))
    except PrinterError as exc:
        raise _printer_error(exc) from None
    return {"response": data.decode("latin-1"), "truncated": truncated}


@router.post("/edge/printers/send")
async def send(request: Request) -> dict:
    """`{ip, zpl}` → `{ok}`: the ZPL as UTF-8, the same bytes WebUSB sends. A
    body over MAX_ZPL plus overhead is 413 request_too_large, unparsed."""
    body = await json_object(request, max_bytes=MAX_ZPL + BODY_OVERHEAD)
    ip = await _ip(request, body.get("ip"))
    zpl = _text(body, "zpl", MAX_ZPL)
    try:
        await request.app.state.printers.send(ip, zpl.encode("utf-8"))
    except PrinterError as exc:
        raise _printer_error(exc) from None
    return {"ok": True}


def _filename(disposition: str | None) -> str | None:
    if not disposition:
        return None
    msg = Message()
    msg["content-disposition"] = disposition
    name = msg.get_filename()
    return name if isinstance(name, str) else None


@router.post("/edge/printers/send-font", dependencies=[Depends(online)])
async def send_font(request: Request,
                    session: Annotated[EdgeSession, Depends(require_session)]) -> dict:
    """`{ip, font_id, name, initiative_id}` → `{ok}`: the font's bytes from
    the cloud's kiosk font route (only fonts the move's templates use), sent
    as `~DYE:{name},B,T,{len},,` plus the bytes. `name` must be the font's
    own name, as the cloud names it (409 font_name_mismatch, also when the
    cloud names none); a cloud refusal keeps its status and
    code."""
    body = await json_object(request)
    ip = await _ip(request, body.get("ip"))
    name = body.get("name")
    font_id, move_id = body.get("font_id"), body.get("initiative_id")
    if not isinstance(name, str) or not FONT_NAME.fullmatch(name) \
            or not all(isinstance(v, str) and CLOUD_ID.fullmatch(v) for v in (font_id, move_id)):
        raise err(422, "bad_request")
    st = request.app.state
    try:
        resp = await st.upstream.as_person(session.person_id, "GET",
                                           f"/kiosk/labels/fonts/{font_id}/content",
                                           params={"initiative_id": move_id})
    except CloudOffline:
        raise err(503, "edge_offline") from None
    if resp is None:
        raise err(403, "cloud_sign_in_required")
    if resp.status_code != 200:
        code = "font_download_failed"
        try:
            detail = resp.json().get("detail")
            if isinstance(detail, dict) and isinstance(detail.get("code"), str):
                code = detail["code"]
        except (ValueError, AttributeError):
            pass
        raise err(resp.status_code if 400 <= resp.status_code < 500 else 502, code)
    data = resp.content
    if not data or len(data) > MAX_FONT:
        raise err(422, "font_too_large" if data else "font_empty")
    cloud_name = _filename(resp.headers.get("content-disposition"))
    if cloud_name is None or cloud_name.upper() != name.upper():
        raise err(409, "font_name_mismatch")
    try:
        await st.printers.send(ip, font_header(name, len(data)), data)
    except PrinterError as exc:
        raise _printer_error(exc) from None
    return {"ok": True}


# ── the station's label settings ───────────────────────────────────

@router.get("/edge/label-station")
async def get_label_station(request: Request) -> dict | None:
    """The Label Station's settings, or null (not set up as one, or not yet
    saved)."""
    return laptop_setup.label_station(request.app.state.store)


@router.put("/edge/label-station")
async def put_label_station(request: Request) -> dict:
    """`{label_kind, printer: {type, ip?, model, serial?}, dpi, offset_x,
    offset_y, peel?}` → the stored copy (`peel` false when left out). 409 not_label_station until the laptop is
    set up as a Label Station."""
    body = await json_object(request)
    st = request.app.state
    printer = body.get("printer")
    if isinstance(printer, dict) and printer.get("type") == "network" \
            and (await st.printers.guard_ready()).unavailable:
        raise err(503, "printer_guard_unavailable")
    try:
        settings = laptop_setup.normalize_label_station(body, st.printers.allowed)
    except laptop_setup.BadLabelStation as exc:
        raise err(422, exc.code) from None
    try:
        return laptop_setup.save_label_station(st.store, settings)
    except LookupError:
        raise err(409, "not_label_station") from None
