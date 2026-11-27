"""The page's HTTP layer: JSON routes and the live event stream over a `Runner`.

Thin on purpose: every route calls one Runner method and answers with what it returns.
No run logic lives here.
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import sys
import time
import traceback
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.requests import cookie_parser

from ..events import FeedLine
from ..runner import ACTIVE, RunnerError

STATIC = Path(__file__).parent / "static"
NO_STORE = {"Cache-Control": "no-store"}
PAGE_HEADER = b"x-loadtest"
FORBIDDEN = {"code": "forbidden", "message": "This request did not come from the load test page."}
BAD_REQUEST = {"code": "bad_request", "message": "Check the fields and try again."}
INTERNAL = {"code": "internal", "message": "Something went wrong in the load test tool."}
NO_RESULT = {"code": "no_result", "message": "There is no result yet."}
KEEP_ALIVE = ": keep-alive\n\n"


# ── request bodies ─────────────────────────────────────────────────────


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ConnectBody(_Body):
    server: str = Field(max_length=300)
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)
    totp_code: str | None = Field(default=None, max_length=12)


class CheckBody(_Body):
    move_id: str = Field(max_length=64)
    move_password: str = Field(max_length=200)
    speed: Literal["real-time", "fast"]


class ContinueBody(_Body):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)
    move_password: str = Field(max_length=200)
    totp_code: str | None = Field(default=None, max_length=12)


# ── the event stream ───────────────────────────────────────────────────


def feed_event(line: FeedLine) -> dict:
    return {"at": line.at, "time": time.strftime("%H:%M:%S", time.localtime(line.at)),
            "device": line.device, "action": line.action, "subject": line.subject,
            "ok": line.ok, "ms": line.ms, "note": line.note}


def _event(name: str, data: object) -> str:
    return f"event: {name}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


async def event_stream(runner, is_disconnected: Callable[[], Awaitable[bool]], *,
                       stopping: asyncio.Event | None = None, active_every: float = 1.0,
                       idle_every: float = 5.0, keep_alive: float = 15.0) -> AsyncIterator[str]:
    """A `snapshot` event, then one `feed` event per buffered line, then live `feed` events,
    a `snapshot` every `active_every` s while a run is active (every `idle_every` s
    otherwise) and a keep-alive comment every `keep_alive` s. Ends when the client goes or
    `stopping` is set. Pacing is real time, not the run's clock."""
    queue = runner.subscribe()
    getter: asyncio.Future | None = None
    stopper: asyncio.Future | None = None
    try:
        # no await between subscribing and reading the ring: no line is lost or doubled
        first = [_event("snapshot", runner.snapshot())]
        first += [_event("feed", feed_event(line)) for line in runner.recent()]
        loop = asyncio.get_running_loop()
        last_snapshot = last_comment = loop.time()
        for chunk in first:
            yield chunk
        if stopping is not None:
            stopper = asyncio.ensure_future(stopping.wait())
        while not (stopping is not None and stopping.is_set()) and not await is_disconnected():
            now = loop.time()
            every = active_every if runner.phase in ACTIVE else idle_every
            if now - last_snapshot >= every:
                last_snapshot = now
                yield _event("snapshot", runner.snapshot())
                continue
            if now - last_comment >= keep_alive:
                last_comment = now
                yield KEEP_ALIVE
                continue
            if getter is None:
                getter = asyncio.ensure_future(queue.get())
            # wake at least every `active_every` s so a run starting is seen quickly
            timeout = min(last_snapshot + every, last_comment + keep_alive, now + active_every)
            done, _ = await asyncio.wait([t for t in (getter, stopper) if t is not None],
                                         timeout=max(0.0, timeout - now),
                                         return_when=asyncio.FIRST_COMPLETED)
            if getter in done:
                line, getter = getter.result(), None
                yield _event("feed", feed_event(line))
    finally:
        live = [t for t in (getter, stopper) if t is not None]
        for task in live:
            task.cancel()
        runner.unsubscribe(queue)
        if live:
            await asyncio.gather(*live, return_exceptions=True)


# ── guard and errors ───────────────────────────────────────────────────


def _log_internal(scope: dict, exc: BaseException) -> None:
    """The exception's type and where it happened; never its text or the request body."""
    frames = "".join(traceback.format_list(traceback.extract_tb(exc.__traceback__)))
    print(f"loadtest: internal error in {scope.get('method')} {scope.get('path')}: "
          f"{type(exc).__name__}\n{frames}", file=sys.stderr, end="")


def _host_port(host: str, port: int | None, scheme: str) -> tuple[str, int | None]:
    return host, port if port is not None else {"http": 80, "https": 443}.get(scheme)


def _same_origin(origin: str, host_header: str) -> bool:
    """The Origin's host and port equal the Host header's (default ports filled in)."""
    try:
        o = urlsplit(origin.strip().lower())
        h = urlsplit("http://" + host_header.strip().lower())
        if not o.hostname or not h.hostname:
            return False
        return (_host_port(o.hostname, o.port, o.scheme)
                == _host_port(h.hostname, h.port, "http"))
    except ValueError:
        return False


class _Guard:
    """Every POST /api/* must carry `X-Loadtest: 1` (a cross-site page cannot add it
    without a CORS preflight, and the app answers none). Any unexpected exception becomes
    a plain 500."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        if scope["path"].startswith("/api/") and b"origin" in headers:
            if not _same_origin(headers[b"origin"].decode("latin-1"),
                                headers.get(b"host", b"").decode("latin-1")):
                await JSONResponse(FORBIDDEN, status_code=403)(scope, receive, send)
                return
        if scope["method"] == "POST" and scope["path"].startswith("/api/"):
            if headers.get(PAGE_HEADER) != b"1":
                await JSONResponse(FORBIDDEN, status_code=403)(scope, receive, send)
                return
        started = False

        async def tracked(message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracked)
        except Exception as exc:  # noqa: BLE001 - nothing unexpected reaches the page
            _log_internal(scope, exc)
            if not started:
                await JSONResponse(INTERNAL, status_code=500)(scope, receive, send)


LOCAL_NAMES = ("localhost", "127.0.0.1", "::1")
KEY_COOKIE = "loadtest_key"
BAD_HOST = "This address is not allowed. Use the link printed when the tool started."
NEED_KEY = "Open the link printed when the tool started. It includes a key."
NEED_KEY_PAGE = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
                 "<title>Move load test</title></head><body><p>" + NEED_KEY + "</p></body></html>")


def _host_name(value: str) -> str:
    """The host part of a Host header or a name, lower case, without port or brackets."""
    value = value.strip().lower()
    if value.startswith("["):
        return value[1:value.find("]")] if "]" in value else value[1:]
    if value.count(":") == 1:
        return value.split(":", 1)[0]
    return value


def _is_loopback(host: str | None) -> bool:
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return (mapped or address).is_loopback


class _Access:
    """Outermost: the Host header must name this machine (stops DNS rebinding), and when
    an access key is set, a client that is not this machine needs the key's cookie. The
    printed link `/?key=<key>` sets that cookie and redirects to `/`."""

    def __init__(self, app, *, allowed_hosts: set[str], access_key: str | None) -> None:
        self.app = app
        self.allowed = allowed_hosts
        self.key = access_key

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        host = _host_name(headers.get(b"host", b"").decode("latin-1"))
        if not host or host not in self.allowed:
            await PlainTextResponse(BAD_HOST, status_code=400)(scope, receive, send)
            return
        if self.key is None:
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        if scope["method"] == "GET" and path == "/":
            given = parse_qs(scope.get("query_string", b"").decode("latin-1")).get("key")
            if given and self._matches(given[-1]):
                response = RedirectResponse("/", status_code=303)
                response.set_cookie(KEY_COOKIE, self.key, path="/", httponly=True,
                                    samesite="strict")
                await response(scope, receive, send)
                return
        client = scope.get("client")
        cookie = cookie_parser(headers.get(b"cookie", b"").decode("latin-1")).get(KEY_COOKIE)
        if _is_loopback(client[0] if client else None) or (cookie and self._matches(cookie)):
            await self.app(scope, receive, send)
            return
        if path.startswith("/api/"):
            refused = JSONResponse({"code": "forbidden", "message": NEED_KEY}, status_code=403)
        else:
            refused = HTMLResponse(NEED_KEY_PAGE, status_code=403)
        refused.headers.update(NO_STORE)
        await refused(scope, receive, send)

    def _matches(self, given: str) -> bool:
        return hmac.compare_digest(given.encode("utf-8", "replace"), self.key.encode("utf-8"))


def _field_names(exc: RequestValidationError) -> list[str]:
    names: list[str] = []
    for err in exc.errors():
        loc = [str(p) for p in err.get("loc", ()) if isinstance(p, str) and p != "body"]
        name = ".".join(loc) or "body"
        if name not in names:
            names.append(name)
    return names


class _NoStoreFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers.update(NO_STORE)
        return response


# ── the app ────────────────────────────────────────────────────────────


def create_app(runner, *, allowed_hosts: list[str] | None = None,
               access_key: str | None = None) -> FastAPI:
    """`allowed_hosts`: Host names accepted besides this machine's localhost names.
    `access_key`: when set, clients other than this machine need it (see `_Access`)."""
    stopping = asyncio.Event()
    allowed = {_host_name(h) for h in (*LOCAL_NAMES, *(allowed_hosts or ()))}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            yield
        finally:            # Ctrl-C interrupts a run so it can be continued, never lost
            stopping.set()
            await runner.shutdown()

    app = FastAPI(title="Move load test", lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.stopping = stopping
    app.add_middleware(_Guard)
    app.add_middleware(_Access, allowed_hosts=allowed, access_key=access_key)  # outermost

    @app.exception_handler(RunnerError)
    async def runner_error(request: Request, exc: RunnerError) -> JSONResponse:
        return JSONResponse({"code": exc.code, "message": exc.message}, status_code=409)

    @app.exception_handler(RequestValidationError)
    async def bad_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({**BAD_REQUEST, "fields": _field_names(exc)}, status_code=422)

    @app.get("/")
    async def page() -> FileResponse:
        return FileResponse(STATIC / "index.html", headers=NO_STORE)

    @app.get("/api/state")
    async def state() -> JSONResponse:
        return JSONResponse(runner.snapshot(), headers=NO_STORE)

    @app.post("/api/connect")
    async def connect(body: ConnectBody) -> dict:
        return await runner.connect(body.server, body.email, body.password,
                                    body.totp_code or None)

    @app.post("/api/check")
    async def check(body: CheckBody) -> dict:
        report = await runner.check(body.move_id, body.move_password, body.speed)
        last = runner.snapshot().get("check") or {}
        return {
            "checks": [asdict(c) for c in report.checks],
            "can_start": report.can_start,
            "summary": {"servers": last.get("servers", len(report.roster)),
                        "containers": last.get("containers_found", len(report.containers)),
                        "trucks": last.get("trucks_found", len(report.trucks)),
                        "containers_needed": last.get("containers_needed"),
                        "trucks_needed": last.get("trucks_needed")},
        }

    @app.post("/api/start", status_code=202)
    async def start() -> dict:
        await runner.start()
        return {}

    @app.post("/api/stop", status_code=202)
    async def stop() -> dict:
        await runner.stop()
        return {}

    @app.post("/api/continue")
    async def continue_run(body: ContinueBody) -> dict:
        return await runner.continue_run(body.password, body.move_password, body.email,
                                         body.totp_code or None)

    @app.post("/api/discard")
    async def discard() -> dict:
        await runner.discard_unfinished()
        return {}

    @app.get("/api/result")
    async def result() -> JSONResponse:
        got = runner.result()
        if got is None:
            return JSONResponse(NO_RESULT, status_code=404, headers=NO_STORE)
        return JSONResponse(got, headers=NO_STORE)

    @app.get("/api/events")
    async def events(request: Request) -> StreamingResponse:
        return StreamingResponse(
            event_stream(runner, request.is_disconnected, stopping=stopping),
            media_type="text/event-stream",
            headers={**NO_STORE, "X-Accel-Buffering": "no"})

    app.mount("/static", _NoStoreFiles(directory=STATIC), name="static")
    return app
