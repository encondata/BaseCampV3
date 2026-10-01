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
`edge_offline`, so the kiosk keeps its last registration state."""

import json
from urllib.parse import parse_qs

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from edge.db import Store, now_iso
from edge.deps import current_session, err
from edge.identity import Identity
from edge.sessions import EdgeSession
from edge.upstream import CloudOffline

CACHEABLE = ("/kiosk/sync/", "/kiosk/setup-options", "/kiosk/labels/vocab", "/system/status")
ANONYMOUS_OK = ("/system/status",)
OFFLINE_OK_WRITES = {"/kiosk/sign-out"}
HEARTBEAT = "/kiosk/heartbeat"
DROP_HEADERS = {"content-length", "transfer-encoding", "connection", "set-cookie",
                "content-encoding", "keep-alive"}


def cache_key(path: str, query: str) -> str:
    return f"{path}?{query}" if query else path


def store_cache(store: Store, key: str, status: int, body: str) -> None:
    store.run("INSERT INTO cache (key, status, body, stored_at) VALUES (?, ?, ?, ?) "
              "ON CONFLICT(key) DO UPDATE SET status = excluded.status, body = excluded.body, "
              "stored_at = excluded.stored_at", (key, status, body, now_iso()))


def rewrite_body(path: str, body: bytes, identity: Identity) -> bytes:
    """The laptop's identity is the edge's, whatever the browser thinks."""
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
    return json.dumps(data).encode()


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


async def forward(request: Request, path: str) -> Response:
    st = request.app.state
    session = current_session(request)
    method = request.method
    query = request.url.query
    cacheable = method == "GET" and path.startswith(CACHEABLE)
    if cacheable and session is None and not path.startswith(ANONYMOUS_OK):
        raise err(401, "not_authenticated")
    body = rewrite_body(path, await request.body(), st.identity)
    headers = {"content-type": request.headers.get("content-type", "application/json")} \
        if body else {}
    target = cache_key(path, query)
    try:
        if session is not None:
            if not st.upstream.has_session(session.person_id):
                if method != "GET" and path in OFFLINE_OK_WRITES:
                    return Response(status_code=204)
                if cacheable and (hit := _cached(st.store, session, path, query)) is not None:
                    return hit
                if st.upstream.online:
                    raise _no_cloud_session(path)
                raise err(503, "edge_offline")
            resp = await st.upstream.as_person(session.person_id, method, target,
                                               content=body, headers=headers)
            if resp is None:
                raise _no_cloud_session(path)
        else:
            if auth := request.headers.get("authorization"):
                headers["authorization"] = auth
            resp = await st.upstream.request(method, target, content=body, headers=headers)
    except CloudOffline:
        return _offline_answer(st.store, session, method, path, query, cacheable)
    if cacheable and resp.status_code == 200:
        store_cache(st.store, target, 200, resp.text)
    out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in DROP_HEADERS}
    return Response(content=resp.content, status_code=resp.status_code, headers=out_headers)
