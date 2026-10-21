"""Everything under /auth, /kiosk and /system that the edge doesn't answer
itself goes to the cloud — as the signed-in person when there is an edge
session, verbatim otherwise (2FA challenge tokens, anonymous status).

Reads the kiosk needs offline are cached on the way back (one shared copy:
move data is the same for everyone signed in to this kiosk) and served
from SQLite when the cloud is unreachable — never across a move lock.
Writes have no offline fallback here: the outbox handles scans and
printer events; everything else answers 503 `edge_offline`, which the
kiosk shows as its normal offline message.

A person signed in offline (or whose cloud session was refused) has no
usable cloud session. Their edge session is still good, so the answer is
403 `cloud_sign_in_required` — never 401, which the kiosk reads as "your
session ended" and signs them out. The heartbeat in that state answers 503
`edge_offline`, so the kiosk keeps its last registration state.

The laptop's kiosk config rides the person heartbeat here (config_sync.py):
the edge replaces whatever config fields the browser sent with its own and
handles the reply, unless the laptop holds a station key (then only the
station heartbeat syncs it). Sounds (`/kiosk/sounds…`) go as the person.
Only a download (GET /kiosk/sounds/{id}) by a signed-in person with no cloud
session at all (an offline sign-in) goes under the station key instead; an
upload never does (503 `edge_offline` without a usable cloud session), and a
person whose cloud session the portal refused never falls back. An upload's
`serial` form field is always the edge's."""

import json
import logging
import re
from urllib.parse import parse_qs, quote

import httpx
from fastapi import Request, Response
from fastapi.responses import JSONResponse

from edge import config_sync, laptop_setup
from edge.db import Store, now_iso
from edge.deps import current_session, err
from edge.identity import Identity
from edge.rfid import station_key
from edge.rfid.tagreads import note_cache_write
from edge.sessions import EdgeSession
from edge.upstream import CloudOffline

log = logging.getLogger(__name__)


CACHEABLE = ("/kiosk/sync/", "/kiosk/setup-options", "/kiosk/labels/vocab", "/system/status")
ANONYMOUS_OK = ("/system/status",)
OFFLINE_OK_WRITES = {"/kiosk/sign-out"}
HEARTBEAT = "/kiosk/heartbeat"
SOUNDS = "/kiosk/sounds"
SERIAL_PART = re.compile(rb'content-disposition:[^\r\n]*[;\s]name="serial"', re.I)
BOUNDARY = re.compile(r'boundary="?([^";\s]+)"?', re.I)
DROP_HEADERS = {"content-length", "transfer-encoding", "connection", "set-cookie",
                "content-encoding", "keep-alive"}


def cache_key(path: str, query: str) -> str:
    return f"{path}?{query}" if query else path


def store_cache(store: Store, key: str, status: int, body: str) -> None:
    store.run("INSERT INTO cache (key, status, body, stored_at) VALUES (?, ?, ?, ?) "
              "ON CONFLICT(key) DO UPDATE SET status = excluded.status, body = excluded.body, "
              "stored_at = excluded.stored_at", (key, status, body, now_iso()))
    note_cache_write()


def rewrite_body(path: str, body: bytes, identity: Identity) -> bytes:
    """The laptop's identity is the edge's, whatever the browser thinks. A
    `reader` on the person heartbeat is dropped: the reader snapshot rides
    only the station heartbeat (`reader_report.send_station_heartbeat`)."""
    if not body:
        return body
    try:
        data = json.loads(body)
    except ValueError:
        return body
    if not isinstance(data, dict):
        return body
    if "serial" in data:
        data["serial"] = identity.serial
    if path in ("/kiosk/heartbeat", "/kiosk/pair"):
        data["name"] = identity.name
    if path == "/kiosk/heartbeat":
        data["mode"] = "laptop"
        data.pop("reader", None)  # telemetry goes only under the station key
        for key in config_sync.BEAT_FIELDS:  # the edge holds the laptop's config
            data.pop(key, None)
    return json.dumps(data).encode()


def rewrite_multipart_serial(body: bytes, content_type: str, serial: str) -> bytes:
    """A multipart body with its `serial` field set to `serial` (added when
    missing). A body that doesn't parse as multipart is returned as is."""
    match = BOUNDARY.search(content_type or "")
    if not match or not body:
        return body
    delim = b"--" + match.group(1).encode("latin-1")
    pieces = body.split(delim)
    if len(pieces) < 2 or not pieces[-1].startswith(b"--"):
        return body
    kept = [p for p in pieces[1:-1] if not SERIAL_PART.search(p.split(b"\r\n\r\n", 1)[0])]
    field = (b'\r\nContent-Disposition: form-data; name="serial"\r\n\r\n'
             + serial.encode() + b"\r\n")
    return delim.join([pieces[0], *kept, field, pieces[-1]])


def is_sound_path(path: str) -> bool:
    return path == SOUNDS or path.startswith(SOUNDS + "/")


def is_sound_download(method: str, path: str) -> bool:
    """GET /kiosk/sounds/{id}: the only call the station key may stand in for."""
    return method == "GET" and path.startswith(SOUNDS + "/")


async def _download_as_station(st, path: str, headers: dict):
    """A sound download under the station key (None without one): the
    station key names its kiosk by serial in the query. Never used for an
    upload or any other write: a malformed upload's 401 would drop the key."""
    target = f"{path}?serial={quote(st.identity.serial)}"
    return await station_key.request_as_station(st.upstream, "GET", target, headers=headers)


async def _person_heartbeat(st, person_id: str, target: str, body: bytes, headers: dict):
    """The person heartbeat with the laptop's config fields (none while an
    RFID Station holds its key: the station heartbeat syncs then; a Label
    Station sends no station heartbeat, so it syncs here), and the reply's
    config, clock and scan type handled."""
    async with config_sync.lock(st):
        station_beats = station_key.has_key(st.store) and station_key.is_rfid_setup(st.store)
        beat = None if station_beats else config_sync.prepare_beat(st.store)
        if beat is not None:
            body = config_sync.add_fields(body, beat)
            headers = {**headers, "content-type": "application/json"}
        resp = await st.upstream.as_person(person_id, "POST", target, content=body,
                                           headers=headers)
        if resp is not None and resp.status_code == 200:
            try:
                data = resp.json()
            except ValueError:
                data = None
            try:
                if beat is not None:
                    config_sync.handle_reply(st.store, beat, data)
                elif isinstance(data, dict):  # scan type still applies on a station-keyed laptop
                    laptop_setup.set_scan_type(st.store, data.get("scan_status"),
                                               data.get("scan_status_label"))
            except Exception as exc:  # noqa: BLE001 — never break the beat over the config
                log.warning("person heartbeat config reply failed: %s", type(exc).__name__)
        return resp


def _cached(store: Store, session: EdgeSession | None, path: str, query: str) -> Response | None:
    row = store.one("SELECT status, body FROM cache WHERE key = ?", (cache_key(path, query),))
    if row is None:
        return None
    hit = {"X-Edge-Cache": "hit"}
    if session is not None and session.move_id is not None:
        # The cloud reads the LAST duplicate; accept only exactly the locked move.
        values = parse_qs(query).get("initiative_id", [])
        if path.startswith("/kiosk/sync/") and path != "/kiosk/sync/people" \
                and values != [session.move_id]:
            raise err(403, "move_locked")
        if path == "/kiosk/setup-options":
            data = json.loads(row["body"])
            data["initiatives"] = [i for i in data.get("initiatives", [])
                                   if str(i.get("id")) == session.move_id]
            data["sites"] = []  # as the portal answers a move-password session
            return JSONResponse(data, status_code=row["status"], headers=hit)
    return Response(row["body"], status_code=row["status"], media_type="application/json",
                    headers=hit)


def _no_cloud_session(path: str):
    if path == HEARTBEAT:
        return err(503, "edge_offline")
    return err(403, "cloud_sign_in_required")


def _offline_answer(store, session, method, path, query, cacheable) -> Response:
    if cacheable and (cached := _cached(store, session, path, query)) is not None:
        return cached
    if method != "GET" and path in OFFLINE_OK_WRITES:
        return Response(status_code=204)
    raise err(503, "edge_offline")


def _apply_clear_setup(store: Store, resp: httpx.Response) -> None:
    """Clear Setup from the portal arrives on a heartbeat reply. The browser
    drops its own setup; the edge drops the laptop's shared copy and the
    station key (`station_key.apply_clear_setup`)."""
    try:
        data = resp.json()
    except ValueError:
        return
    if isinstance(data, dict) and data.get("clear_setup"):
        station_key.apply_clear_setup(store)


async def forward(request: Request, path: str) -> Response:
    st = request.app.state
    session = current_session(request)
    method = request.method
    query = request.url.query
    cacheable = method == "GET" and path.startswith(CACHEABLE)
    if cacheable and session is None and not path.startswith(ANONYMOUS_OK):
        raise err(401, "not_authenticated")
    body = rewrite_body(path, await request.body(), st.identity)
    content_type = request.headers.get("content-type", "application/json")
    sound = is_sound_path(path)
    if sound and method == "POST" and content_type.lower().startswith("multipart/"):
        body = rewrite_multipart_serial(body, content_type, st.identity.serial)
    headers = {"content-type": content_type} if body else {}
    target = cache_key(path, query)
    try:
        if session is not None:
            has_cloud = st.upstream.has_session(session.person_id)
            resp = None
            if has_cloud:
                if path == HEARTBEAT and method == "POST":
                    resp = await _person_heartbeat(st, session.person_id, target, body, headers)
                else:
                    resp = await st.upstream.as_person(session.person_id, method, target,
                                                       content=body, headers=headers)
            if resp is None and sound and not is_sound_download(method, path):
                # an upload goes only as the person; never under the station key
                raise err(503, "edge_offline")
            if resp is None and has_cloud:
                raise _no_cloud_session(path)  # the cloud refused this person's session
            if resp is None and sound:
                # a download with no cloud session at all (an offline sign-in)
                resp = await _download_as_station(st, path, {})
            if resp is None:
                if method != "GET" and path in OFFLINE_OK_WRITES:
                    return Response(status_code=204)
                if cacheable and (hit := _cached(st.store, session, path, query)) is not None:
                    return hit
                if st.upstream.online:
                    raise _no_cloud_session(path)
                raise err(503, "edge_offline")
        else:
            if auth := request.headers.get("authorization"):
                headers["authorization"] = auth
            resp = await st.upstream.request(method, target, content=body, headers=headers)
    except CloudOffline:
        return _offline_answer(st.store, session, method, path, query, cacheable)
    if cacheable and resp.status_code == 200:
        store_cache(st.store, target, 200, resp.text)
    if path == HEARTBEAT and resp.status_code == 200:
        _apply_clear_setup(st.store, resp)
    out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in DROP_HEADERS}
    return Response(content=resp.content, status_code=resp.status_code, headers=out_headers)
