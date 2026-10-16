"""The tag-data listener (port 8091): the paired FX reader POSTs its tag events
to `/rfid/<reader-serial>/<token>`. That is the only route; everything else, and
every rejected request, gets a 404 with an empty body so a device on the LAN
learns nothing. The path (it carries the token) is never logged."""

import hmac
import json
import logging
import time

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from edge import laptop_setup
from edge.rfid import events, pairing, tagreads

log = logging.getLogger("edge.rfid.ingest")

MAX_BODY = 5 * 1024 * 1024
QUIET_SECONDS = 300


def _not_found() -> Response:
    return Response(status_code=404)


def create_ingest_app(state, *, clock=time.monotonic) -> Starlette:
    store = state.store
    last_accepted: list[float | None] = [None]

    async def ingest(request: Request) -> Response:
        if request.method != "POST":
            return _not_found()
        serial = request.path_params["reader_serial"]
        token = request.path_params["token"]
        row = pairing.current_row(store)
        if (row is None or row["serial"] != serial
                or not hmac.compare_digest((row["token"] or "").encode(), token.encode())):
            log.info("rejected tag data for reader %s", serial)
            return _not_found()

        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > MAX_BODY:
            return JSONResponse({"error": "too_large"}, status_code=413)
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY:
                return JSONResponse({"error": "too_large"}, status_code=413)

        try:
            parsed = json.loads(bytes(body).decode("utf-8"))
            batch, skipped = tagreads.parse_events(parsed)
        except (ValueError, RecursionError):  # includes UnicodeDecodeError
            return JSONResponse({"error": "bad_json"}, status_code=400)

        try:
            stored = tagreads.store_batch(store, reader_serial=serial, rows=batch,
                                          setup=laptop_setup.load(store))
        except Exception as exc:  # noqa: BLE001 — the batch rolled back; the reader retries
            log.error("tag batch for reader %s failed: %s", serial, type(exc).__name__)
            return JSONResponse({"error": "store_failed"}, status_code=500)

        if stored > 0:
            now = clock()
            last = last_accepted[0]
            if last is None or now - last >= QUIET_SECONDS:
                events.record(store, "tag_data_receiving", "Tag data receiving",
                              f"{row['model'] or 'Reader'} · {stored} reads")
            last_accepted[0] = now
        log.debug("reader %s: stored %d, skipped %d", serial, stored, skipped)
        return JSONResponse({"stored": stored, "skipped": skipped})

    methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    return Starlette(routes=[Route("/rfid/{reader_serial}/{token}", ingest, methods=methods)],
                     exception_handlers={404: lambda request, exc: _not_found(),
                                         405: lambda request, exc: _not_found()})
