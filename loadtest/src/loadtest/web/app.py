"""The page's HTTP layer: JSON routes and the live event stream over a `Runner`.

Thin on purpose: every route calls one Runner method and answers with what it returns.
No run logic lives here.
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import secrets
import sys
import time
import traceback
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

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
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from starlette.requests import cookie_parser

from ..events import FeedLine
from ..runner import ACTIVE, MESSAGES, RunnerError
from .signin import NEED_SIGN_IN, WRONG, SignIn, read_form, sign_in_page

STATIC = Path(__file__).parent / "static"
NO_STORE = {"Cache-Control": "no-store"}
PAGE_HEADER = b"x-loadtest"
FORBIDDEN = {"code": "forbidden", "message": "This request did not come from the load test page."}
BAD_REQUEST = {"code": "bad_request", "message": "Check the fields and try again."}
INTERNAL = {"code": "internal", "message": "Something went wrong in the load test tool."}
NO_RESULT = {"code": "no_result", "message": "There is no result yet."}
KEEP_ALIVE = ": keep-alive\n\n"


# ── request bodies ─────────────────────────────────────────────────────


def _text(max_length: int):
    """A string field, stripped of surrounding spaces."""
    return Annotated[str, StringConstraints(strip_whitespace=True, max_length=max_length)]


Password = Annotated[str, Field(max_length=200)]    # never altered: spaces may be part of it


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConnectBody(_Body):
    server: _text(300)
    email: _text(200)
    password: Password
    totp_code: _text(12) | None = None


class CheckBody(_Body):
    move_id: _text(64)
    move_password: Password
    speed: Literal["real-time", "fast"]


class ContinueBody(_Body):
    email: _text(200)
    password: Password
    move_password: Password
    totp_code: _text(12) | None = None


class SetupBody(_Body):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                           max_length=200)]
    origin_site_id: _text(64)
    destination_site_id: _text(64)
    servers: Annotated[int, Field(ge=1)]
    containers: int
    trucks: int
    # never altered; not empty, since an empty move password clears the move's
    move_password: Annotated[str, Field(min_length=1, max_length=200)]


FIELD_NAMES = {name for model in (ConnectBody, CheckBody, ContinueBody, SetupBody)
               for name in model.model_fields}
UNKNOWN_FIELD = "(unknown field)"


# ── the event stream ───────────────────────────────────────────────────


def feed_event(line: FeedLine) -> dict:
    return {"at": line.at, "time": time.strftime("%H:%M:%S", time.localtime(line.at)),
            "device": line.device, "action": line.action, "subject": line.subject,
            "ok": line.ok, "ms": line.ms, "note": line.note}


def _event(name: str, data: object) -> str:
    return f"event: {name}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


async def event_stream(runner, is_disconnected: Callable[[], Awaitable[bool]], *,
                       stopping: asyncio.Event | None = None,
                       snapshot: Callable[[], dict] | None = None, active_every: float = 1.0,
                       idle_every: float = 5.0, keep_alive: float = 15.0) -> AsyncIterator[str]:
    """A `snapshot` event, then one `feed` event per buffered line, then live `feed` events,
    a `snapshot` every `active_every` s while a run is active (every `idle_every` s
    otherwise) and a keep-alive comment every `keep_alive` s. Ends when the client goes or
    `stopping` is set. Pacing is real time, not the run's clock. A snapshot or ring read
    that fails is skipped (its type logged once per stream); the stream carries on."""
    take_snapshot = snapshot or runner.snapshot
    logged: set[str] = set()

    def safely(read: Callable[[], object], default):
        try:
            return read()
        except Exception as exc:  # noqa: BLE001 - one bad read must not end the stream
            if type(exc).__name__ not in logged:
                logged.add(type(exc).__name__)
                _log_internal({"method": "GET", "path": "/api/events"}, exc)
            return default

    def snapshot_event() -> list[str]:
        snap = safely(take_snapshot, None)
        return [] if snap is None else [_event("snapshot", snap)]

    queue = runner.subscribe()
    getter: asyncio.Future | None = None
    stopper: asyncio.Future | None = None
    try:
        # no await between subscribing and reading the ring: no line is lost or doubled
        first = snapshot_event()
        first += [_event("feed", feed_event(line)) for line in safely(runner.recent, [])]
        loop = asyncio.get_running_loop()
        last_snapshot = last_comment = loop.time()
        was_busy = runner.phase in ACTIVE or getattr(runner, "setting_up", False)
        for chunk in first:
            yield chunk
        if stopping is not None:
            stopper = asyncio.ensure_future(stopping.wait())
        while not (stopping is not None and stopping.is_set()) and not await is_disconnected():
            now = loop.time()
            busy = runner.phase in ACTIVE or getattr(runner, "setting_up", False)
            every = active_every if busy else idle_every
            ended, was_busy = was_busy and not busy, busy     # a run or set-up just ended
            if ended or now - last_snapshot >= every:
                last_snapshot = now
                for chunk in snapshot_event():
                    yield chunk
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


DEFAULT_PORTS = {"http": 80, "https": 443}


def _same_origin(origin: str, host_header: str) -> bool:
    """The Origin's host and port equal the Host header's. A missing port is the Origin
    scheme's default on both sides, so `Host: proxy.example` matches
    `Origin: https://proxy.example` behind a TLS-terminating proxy."""
    try:
        o = urlsplit(origin.strip().lower())
        h = urlsplit("//" + host_header.strip().lower())
        default = DEFAULT_PORTS.get(o.scheme)
        if not o.hostname or not h.hostname or default is None:
            return False
        return (o.hostname, o.port or default) == (h.hostname, h.port or default)
    except ValueError:
        return False


class _Guard:
    """Every POST /api/* must carry `X-Loadtest: 1` (a cross-site page cannot add it
    without a CORS preflight, and the app answers none). Any unexpected exception becomes
    a plain 500."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":     # _Access lets only lifespan through
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
SESSION_COOKIE = "loadtest_session"
SIGN_IN_PATH = "/login"
PROXY_HEADERS = (b"x-forwarded-for", b"forwarded", b"x-real-ip")
BAD_HOST = "This address is not allowed. Open the page by the address the tool printed."


def _host_name(value: str) -> str:
    """The host part of a Host header or a name, lower case, without port or brackets;
    "" when anything but `:<digits>` follows the host."""
    value = value.strip().lower()
    if value.startswith("["):
        host, bracket, rest = value[1:].partition("]")
        return host if bracket and _port_part(rest) else ""
    if value.count(":") == 1:
        host, _, port = value.partition(":")
        return host if port.isdigit() else ""
    return value


def _port_part(rest: str) -> bool:
    return rest == "" or (rest.startswith(":") and rest[1:].isdigit())


def _is_loopback(host: str | None) -> bool:
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return (mapped or address).is_loopback


class _Access:
    """Outermost: the Host header must name this machine (stops DNS rebinding), and when
    a sign-in is set, a client that is not this machine needs this launch's session
    cookie. `/login` shows the sign-in page; the right username and password set the
    cookie and lead to `/`."""

    def __init__(self, app, *, allowed_hosts: set[str], sign_in: SignIn | None,
                 cookie_name: str, local_skip: bool, secure_cookie: bool) -> None:
        self.app = app
        self.local_skip = local_skip
        self.allowed = allowed_hosts
        self.sign_in = sign_in
        self.cookie = cookie_name
        self.secure = secure_cookie
        # one per launch, kept in memory only: a restart signs everyone out
        self.session = secrets.token_urlsafe(32)

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":     # no websocket or other routes: refuse, fail closed
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return
        headers = dict(scope["headers"])
        host = _host_name(headers.get(b"host", b"").decode("latin-1"))
        if not host or host not in self.allowed:
            await PlainTextResponse(BAD_HOST, status_code=400)(scope, receive, send)
            return
        path = scope["path"]
        if self.sign_in is None:
            if path == SIGN_IN_PATH:    # nothing to sign in to: the page itself
                await RedirectResponse("/", status_code=303)(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        # this machine: a loopback client, not forwarded by a proxy, under a local name
        here = (self.local_skip and _is_loopback(client[0] if client else None)
                and not any(h in headers for h in PROXY_HEADERS)
                and host in LOCAL_NAMES)
        cookie = cookie_parser(headers.get(b"cookie", b"").decode("latin-1")).get(self.cookie)
        signed_in = here or bool(cookie and self._is_session(cookie))
        if path == SIGN_IN_PATH:
            await self._sign_in(scope, receive, send, headers, signed_in)
            return
        if signed_in:
            await self.app(scope, receive, send)
            return
        if path.startswith("/api/"):
            refused = JSONResponse(NEED_SIGN_IN, status_code=401)
        elif scope["method"] in ("GET", "HEAD"):
            refused = RedirectResponse(SIGN_IN_PATH, status_code=303)
        else:
            refused = PlainTextResponse(NEED_SIGN_IN["message"], status_code=401)
        refused.headers.update(NO_STORE)
        await refused(scope, receive, send)

    async def _sign_in(self, scope, receive, send, headers: dict, signed_in: bool) -> None:
        method = scope["method"]
        if method in ("GET", "HEAD"):
            if signed_in:
                response = RedirectResponse("/", status_code=303)
            else:
                response = HTMLResponse(sign_in_page())
        elif method != "POST":
            response = PlainTextResponse("Method not allowed.", status_code=405,
                                         headers={"Allow": "GET, POST"})
        elif b"origin" in headers and not _same_origin(
                headers[b"origin"].decode("latin-1"), headers.get(b"host", b"").decode("latin-1")):
            response = JSONResponse(FORBIDDEN, status_code=403)     # another site's form
        else:
            form = await read_form(receive)
            username = (form or {}).get("username", "")
            if form is not None and self.sign_in.matches(username, form.get("password", "")):
                response = RedirectResponse("/", status_code=303)
                response.set_cookie(self.cookie, self.session, path="/", httponly=True,
                                    samesite="strict", secure=self.secure)
            else:
                response = HTMLResponse(sign_in_page(error=WRONG, username=username),
                                        status_code=401)
        response.headers.update(NO_STORE)
        await response(scope, receive, send)

    def _is_session(self, given: str) -> bool:
        return hmac.compare_digest(given.encode("utf-8", "replace"),
                                   self.session.encode("utf-8"))


def _field_names(exc: RequestValidationError) -> list[str]:
    names: list[str] = []
    for err in exc.errors():
        loc = [p for p in err.get("loc", ()) if isinstance(p, str) and p != "body"]
        if not loc:
            name = "body"
        elif err.get("type") == "extra_forbidden" or loc[0] not in FIELD_NAMES:
            name = UNKNOWN_FIELD        # never echo a name the client chose
        else:
            name = loc[0]
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
               sign_in: SignIn | None = None, cookie_name: str = SESSION_COOKIE,
               local_skip: bool = True, secure_cookie: bool = False,
               stop_wait: float = 35.0) -> FastAPI:
    """`allowed_hosts`: Host names accepted besides this machine's localhost names.
    `sign_in`: when set, clients other than this machine sign in with it (see `_Access`).
    `cookie_name`: the session's cookie (one per port, since cookies ignore ports).
    `local_skip`: False when a proxy is declared; then this machine signs in too, since
    a proxy on this machine makes every visitor look local.
    `secure_cookie`: True when the page is opened over https, so the cookie stays there.
    `stop_wait`: seconds shutdown waits for a stop in flight before cancelling it."""
    stopping = asyncio.Event()
    allowed = {_host_name(h) for h in (*LOCAL_NAMES, *(allowed_hosts or ()))}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            yield
        finally:            # Ctrl-C interrupts a run so it can be continued, never lost
            stopping.set()
            await runner.shutdown()
            task = app.state.stop_task
            if task is not None and not task.done():
                await asyncio.wait({task}, timeout=stop_wait)
                if not task.done():
                    task.cancel()
                    _log_internal({"method": "POST", "path": "/api/stop"},
                                  TimeoutError("stop did not end"))
                await asyncio.gather(task, return_exceptions=True)

    app = FastAPI(title="Move load test", lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.stopping = stopping
    app.state.stop_task = None          # the stop in flight, kept so it is never lost
    app.add_middleware(_Guard)
    app.add_middleware(_Access, allowed_hosts=allowed, sign_in=sign_in,
                       cookie_name=cookie_name, local_skip=local_skip,
                       secure_cookie=secure_cookie)                     # outermost

    def stop_in_flight() -> bool:
        return app.state.stop_task is not None and not app.state.stop_task.done()

    def snapshot() -> dict:
        return {**runner.snapshot(), "stopping": stop_in_flight()}

    async def run_stop() -> None:
        try:
            await runner.stop()
        except Exception as exc:  # noqa: BLE001 - logged by type; the page reads the phase
            _log_internal({"method": "POST", "path": "/api/stop"}, exc)

    @app.exception_handler(RunnerError)
    async def runner_error(request: Request, exc: RunnerError) -> JSONResponse:
        if exc.fields:          # a problem in what was typed, like a bad body
            return JSONResponse({"code": exc.code, "message": exc.message,
                                 "fields": list(exc.fields)}, status_code=422)
        return JSONResponse({"code": exc.code, "message": exc.message}, status_code=409)

    @app.exception_handler(RequestValidationError)
    async def bad_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({**BAD_REQUEST, "fields": _field_names(exc)}, status_code=422)

    @app.get("/")
    async def page() -> FileResponse:
        return FileResponse(STATIC / "index.html", headers=NO_STORE)

    @app.get("/api/state")
    async def state() -> JSONResponse:
        return JSONResponse(snapshot(), headers=NO_STORE)

    @app.post("/api/connect")
    async def connect(body: ConnectBody) -> dict:
        return await runner.connect(body.server, body.email, body.password,
                                    body.totp_code or None)

    @app.post("/api/check")
    async def check(body: CheckBody) -> dict:
        report = await runner.check(body.move_id, body.move_password, body.speed)
        last = runner.snapshot()["check"]      # absent after a check is a bug: a 500
        return {
            "checks": [asdict(c) for c in report.checks],
            "can_start": report.can_start,
            "summary": {"servers": last["servers"],
                        "containers": last["containers_found"],
                        "trucks": last["trucks_found"],
                        "containers_needed": last["containers_needed"],
                        "trucks_needed": last["trucks_needed"]},
        }

    @app.post("/api/start", status_code=202)
    async def start() -> dict:
        await runner.start()
        return {}

    @app.post("/api/stop", status_code=202)
    async def stop() -> dict:
        """Answers at once; the stop runs on. The snapshot says `stopping` meanwhile."""
        if not stop_in_flight():
            if runner.phase not in ACTIVE:
                raise RunnerError("bad_phase", MESSAGES["bad_phase"])
            app.state.stop_task = asyncio.create_task(run_stop())
        return {}

    @app.post("/api/continue")
    async def continue_run(body: ContinueBody) -> dict:
        return await runner.continue_run(body.password, body.move_password, body.email,
                                         body.totp_code or None)

    @app.get("/api/sites")
    async def sites() -> JSONResponse:
        return JSONResponse(await runner.sites(), headers=NO_STORE)

    @app.post("/api/setup", status_code=202)
    async def setup(body: SetupBody) -> dict:
        """Answers once the move's creation has begun; the snapshot's `setup` follows it."""
        await runner.start_setup(
            name=body.name, origin_site_id=body.origin_site_id,
            destination_site_id=body.destination_site_id, servers=body.servers,
            containers=body.containers, trucks=body.trucks, move_password=body.move_password)
        return {}

    @app.post("/api/discard")
    async def discard() -> dict:
        await runner.discard_unfinished()
        return {}

    @app.get("/api/result")
    async def result() -> JSONResponse:
        got = runner.result()
        if got is None:
            return JSONResponse(NO_RESULT, status_code=404, headers=NO_STORE)
        # the samples stay in results.json: the page draws none, and a two-day run's are MBs
        return JSONResponse({k: v for k, v in got.items() if k != "series"}, headers=NO_STORE)

    @app.get("/api/events")
    async def events(request: Request) -> StreamingResponse:
        return StreamingResponse(
            event_stream(runner, request.is_disconnected, stopping=stopping,
                         snapshot=snapshot),
            media_type="text/event-stream",
            headers={**NO_STORE, "X-Accel-Buffering": "no"})

    app.mount("/static", _NoStoreFiles(directory=STATIC), name="static")
    return app
