import asyncio
import json
import subprocess
import sys
import time

import httpx
import pytest
from conftest import FAKE_BASE_URL

from loadtest.events import Events, FeedLine
from loadtest.preflight import Check, CheckReport
from loadtest.runner import Runner, RunnerError
from loadtest.web.app import create_app, event_stream

PAGE = {"X-Loadtest": "1"}
EMAIL = "ops@example.com"
PASSWORD = "portal-pass-1"
MOVE_PASSWORD = "move-pass-1"
ORIGIN = (39.0997, -94.5786)
DESTINATION = (41.2565, -95.9345)


# ── a stub runner with the Runner's public surface ─────────────────────


class StubRunner:
    def __init__(self):
        self.phase = "idle"
        self.events = Events(None)
        self.snap = {"phase": "idle", "check": None}
        self.calls: list[tuple] = []
        self.fail: BaseException | None = None
        self.answer: dict = {"status": "ok"}
        self.report: CheckReport | None = None
        self._result: dict | None = None
        self.shut_down = False

    def _call(self, name, *args):
        self.calls.append((name, *args))
        if self.fail is not None:
            raise self.fail

    def subscribe(self):
        return self.events.subscribe()

    def unsubscribe(self, q):
        self.events.unsubscribe(q)

    def recent(self):
        return self.events.recent()

    def snapshot(self):
        return dict(self.snap, phase=self.phase)

    def result(self):
        return self._result

    async def connect(self, server, email, password, totp_code=None):
        self._call("connect", server, email, password, totp_code)
        return self.answer

    async def check(self, move_id, move_password, speed):
        self._call("check", move_id, move_password, speed)
        return self.report

    async def start(self):
        self._call("start")

    async def stop(self):
        self._call("stop")

    async def continue_run(self, password, move_password, email, totp_code=None):
        self._call("continue", password, move_password, email, totp_code)
        return self.answer

    async def discard_unfinished(self):
        self._call("discard")

    async def shutdown(self):
        self.shut_down = True


def line(n: int, ok: bool = True) -> FeedLine:
    return FeedLine(1_800_000_000.0 + n, f"Load test – Enroll {n}", "RFID enroll",
                    f"SN LOADTEST-{n}", ok, 41.0, "" if ok else "HTTP 500")


@pytest.fixture
def stub():
    return StubRunner()


@pytest.fixture
async def client(stub):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(stub)),
                                 base_url="http://localhost") as c:
        yield c


# ── routes over the stub ───────────────────────────────────────────────


async def test_state_is_the_snapshot_and_not_cached(client, stub):
    stub.snap = {"phase": "idle", "check": None, "move": None}
    got = await client.get("/api/state")
    assert got.status_code == 200
    assert got.json() == {"phase": "idle", "check": None, "move": None}
    assert got.headers["cache-control"] == "no-store"


async def test_page_and_static_files_are_html_and_not_cached(client):
    page = await client.get("/")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert "<title>" in page.text
    assert page.headers["cache-control"] == "no-store"
    static = await client.get("/static/index.html")
    assert static.status_code == 200
    assert static.headers["cache-control"] == "no-store"
    assert (await client.get("/static/nothing.js")).status_code == 404


@pytest.mark.parametrize("path", ["/api/connect", "/api/check", "/api/start", "/api/stop",
                                  "/api/continue", "/api/discard"])
async def test_every_post_needs_the_page_header(client, stub, path):
    got = await client.post(path, json={})
    assert got.status_code == 403
    assert got.json() == {"code": "forbidden",
                          "message": "This request did not come from the load test page."}
    got = await client.post(path, json={}, headers={"X-Loadtest": "0"})
    assert got.status_code == 403
    assert stub.calls == []
    assert "access-control-allow-origin" not in got.headers


async def test_connect_passes_fields_through(client, stub):
    stub.answer = {"status": "ok", "moves": [{"id": "m1", "name": "Move 1",
                                              "status": "in_progress"}]}
    got = await client.post("/api/connect", headers=PAGE, json={
        "server": " https://api.example.com ", "email": EMAIL, "password": "pw-1"})
    assert got.status_code == 200
    assert got.json() == stub.answer
    assert stub.calls == [("connect", "https://api.example.com", EMAIL, "pw-1", None)]
    stub.answer = {"status": "totp_required"}
    got = await client.post("/api/connect", headers=PAGE, json={
        "server": "https://api.example.com", "email": EMAIL, "password": "pw-1",
        "totp_code": " 123456 "})
    assert got.json() == {"status": "totp_required"}
    assert stub.calls[-1][-1] == "123456"


async def test_bad_body_names_fields_without_echoing_values(client, stub):
    got = await client.post("/api/connect", headers=PAGE,
                            json={"server": 5, "password": "SECRET-X"})
    assert got.status_code == 422
    assert "SECRET-X" not in got.text
    body = got.json()
    assert body["code"] == "bad_request"
    assert body["message"] == "Check the fields and try again."
    assert set(body["fields"]) == {"server", "email"}
    assert stub.calls == []


@pytest.mark.parametrize("path,body,field", [
    ("/api/connect", {"server": "x" * 301, "email": EMAIL, "password": "p"}, "server"),
    ("/api/connect", {"server": "s", "email": EMAIL, "password": "SECRET-X" * 30}, "password"),
    ("/api/connect", {"server": "s", "email": EMAIL, "password": "p", "token": "SECRET-X"},
     "token"),
    ("/api/check", {"move_id": "m", "move_password": "SECRET-X", "speed": "slow"}, "speed"),
    ("/api/continue", {"email": EMAIL, "password": "p", "move_password": "m",
                       "totp_code": "SECRET-X12345"}, "totp_code"),
])
async def test_field_rules(client, path, body, field):
    got = await client.post(path, headers=PAGE, json=body)
    assert got.status_code == 422
    assert field in got.json()["fields"]
    assert "SECRET-X" not in got.text


async def test_unreadable_body_is_a_bad_request(client):
    got = await client.post("/api/connect", headers={**PAGE, "Content-Type": "application/json"},
                            content=b'{"password": "SECRET-X"')
    assert got.status_code == 422
    assert got.json()["code"] == "bad_request"
    assert "SECRET-X" not in got.text
    got = await client.post("/api/connect", headers=PAGE, json=["SECRET-X"])
    assert got.status_code == 422
    assert "SECRET-X" not in got.text


async def test_check_answers_checks_and_summary(client, stub):
    stub.report = CheckReport(
        checks=[Check("move_status", "The move is In progress", "pass", "It is."),
                Check("rules", "Status rules", "warn", "No rule for X.")],
        can_start=True, move=None, roster=[], containers=[], trucks=[], route=[])
    stub.snap = {"phase": "checked", "check": {
        "can_start": True, "checks": [], "move": None, "servers": 45, "containers_needed": 3,
        "containers_found": 4, "trucks_needed": 1, "trucks_found": 2}}
    got = await client.post("/api/check", headers=PAGE, json={
        "move_id": " m1 ", "move_password": "mp", "speed": "fast"})
    assert got.status_code == 200
    assert got.json() == {
        "checks": [{"key": "move_status", "label": "The move is In progress",
                    "status": "pass", "detail": "It is."},
                   {"key": "rules", "label": "Status rules", "status": "warn",
                    "detail": "No rule for X."}],
        "can_start": True,
        "summary": {"servers": 45, "containers": 4, "trucks": 2, "containers_needed": 3,
                    "trucks_needed": 1}}
    assert stub.calls == [("check", "m1", "mp", "fast")]


async def test_start_stop_discard_continue(client, stub):
    got = await client.post("/api/start", headers=PAGE)
    assert (got.status_code, got.json()) == (202, {})
    got = await client.post("/api/stop", headers=PAGE)
    assert (got.status_code, got.json()) == (202, {})
    got = await client.post("/api/discard", headers=PAGE)
    assert (got.status_code, got.json()) == (200, {})
    stub.answer = {"status": "totp_required"}
    got = await client.post("/api/continue", headers=PAGE, json={
        "email": EMAIL, "password": "pw", "move_password": "mp"})
    assert got.json() == {"status": "totp_required"}
    assert [c[0] for c in stub.calls] == ["start", "stop", "discard", "continue"]
    assert stub.calls[-1] == ("continue", "pw", "mp", EMAIL, None)


async def test_runner_errors_are_409(client, stub):
    stub.fail = RunnerError("bad_phase")
    got = await client.post("/api/start", headers=PAGE)
    assert got.status_code == 409
    assert got.json() == {"code": "bad_phase", "message": "That cannot be done right now."}
    stub.fail = RunnerError("unfinished_run", "There is an unfinished run.")
    got = await client.post("/api/start", headers=PAGE)
    assert got.json() == {"code": "unfinished_run", "message": "There is an unfinished run."}


async def test_unexpected_errors_are_500_without_detail(client, stub, capsys):
    stub.fail = ValueError("SECRET-Y")
    got = await client.post("/api/connect", headers=PAGE, json={
        "server": "s", "email": EMAIL, "password": "SECRET-Z"})
    assert got.status_code == 500
    assert got.json() == {"code": "internal",
                          "message": "Something went wrong in the load test tool."}
    err = capsys.readouterr().err
    assert "ValueError" in err and "/api/connect" in err
    assert "SECRET-Y" not in err and "SECRET-Z" not in err


async def test_result_or_404(client, stub):
    got = await client.get("/api/result")
    assert got.status_code == 404
    assert got.json() == {"code": "no_result", "message": "There is no result yet."}
    stub._result = {"verdict": "Pass"}
    got = await client.get("/api/result")
    assert (got.status_code, got.json()) == (200, {"verdict": "Pass"})
    assert got.headers["cache-control"] == "no-store"


async def test_shutdown_hook_interrupts_the_run(stub):
    app = create_app(stub)
    async with app.router.lifespan_context(app):
        assert not stub.shut_down
    assert stub.shut_down


# ── who may reach the tool ─────────────────────────────────────────────

KEY = "k3y-" + "A" * 28
LAN = ("192.168.1.50", 12345)


def tool(stub, *, client=("127.0.0.1", 123), base="http://localhost:8795", **kwargs):
    return httpx.AsyncClient(transport=httpx.ASGITransport(create_app(stub, **kwargs),
                                                           client=client),
                             base_url=base)


async def test_a_wrong_host_is_refused(stub):
    async with tool(stub, base="http://evil.example:8795") as c:
        for got in (await c.get("/"), await c.get("/api/state"),
                    await c.post("/api/start", headers=PAGE)):
            assert got.status_code == 400
            assert got.text == ("This address is not allowed. Use the link printed when the "
                                "tool started.")
    assert stub.calls == []


@pytest.mark.parametrize("base", ["http://localhost:8795", "http://LOCALHOST",
                                  "http://127.0.0.1:1", "http://[::1]:8795",
                                  "http://tool.lan:8795", "http://TOOL.lan"])
async def test_allowed_hosts_ignore_case_and_port(stub, base):
    async with tool(stub, base=base, allowed_hosts=["tool.lan"]) as c:
        assert (await c.get("/api/state")).status_code == 200


async def test_only_localhost_names_by_default(stub):
    async with tool(stub, base="http://tool.lan") as c:
        assert (await c.get("/api/state")).status_code == 400


async def test_a_lan_client_needs_the_key(stub):
    async with tool(stub, client=LAN, base="http://192.168.1.10:8795",
                    allowed_hosts=["192.168.1.10"], access_key=KEY) as c:
        need = "Open the link printed when the tool started. It includes a key."
        for path in ("/api/state", "/api/events", "/api/result"):
            got = await c.get(path)
            assert got.status_code == 403
            assert got.json() == {"code": "forbidden", "message": need}
        for path in ("/", "/static/index.html"):
            got = await c.get(path)
            assert got.status_code == 403
            assert got.headers["content-type"].startswith("text/html")
            assert need in got.text
        got = await c.post("/api/start", headers=PAGE)
        assert got.status_code == 403
        assert stub.calls == []


async def test_a_wrong_key_sets_no_cookie(stub):
    async with tool(stub, client=LAN, base="http://192.168.1.10:8795",
                    allowed_hosts=["192.168.1.10"], access_key=KEY) as c:
        for wrong in ("nope", KEY[:-1], "é" * 5, ""):
            got = await c.get("/", params={"key": wrong})
            assert got.status_code == 403
            assert "set-cookie" not in got.headers
        c.cookies.set("loadtest_key", "nope")
        assert (await c.get("/api/state")).status_code == 403


async def test_the_key_link_sets_a_cookie_and_clears_the_address(stub, capsys, caplog):
    async with tool(stub, client=LAN, base="http://192.168.1.10:8795",
                    allowed_hosts=["192.168.1.10"], access_key=KEY) as c:
        got = await c.get("/", params={"key": KEY})
        assert got.status_code == 303 and got.headers["location"] == "/"
        cookie = got.headers["set-cookie"]
        assert cookie.startswith(f"loadtest_key={KEY};")
        parts = {p.strip().lower() for p in cookie.split(";")}
        assert {"httponly", "samesite=strict", "path=/"} <= parts
        assert not any(p.startswith(("secure", "max-age", "expires")) for p in parts)
        bodies = [got.text]
        got = await c.get("/", params={"key": KEY}, follow_redirects=True)
        assert got.status_code == 200 and got.url.path == "/" and not got.url.query
        bodies.append(got.text)
        for path in ("/api/state", "/static/index.html", "/api/result"):
            got = await c.get(path)
            assert got.status_code in (200, 404) and got.status_code != 403
            bodies.append(got.text)
        got = await c.post("/api/start", headers=PAGE)
        assert got.status_code == 202
    assert all(KEY not in b for b in bodies)
    out = capsys.readouterr()
    assert KEY not in out.out + out.err + caplog.text


async def test_the_key_cookie_opens_the_event_stream(stub):
    """Read at ASGI level: the stream never ends on its own."""
    app = create_app(stub, allowed_hosts=["192.168.1.10"], access_key=KEY)
    sent: list[dict] = []
    started = asyncio.Event()
    disconnect = asyncio.Event()

    async def receive():
        await disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.body" and message.get("body"):
            started.set()

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
             "method": "GET", "scheme": "http", "path": "/api/events",
             "raw_path": b"/api/events", "query_string": b"", "root_path": "",
             "headers": [(b"host", b"192.168.1.10:8795"),
                         (b"cookie", f"loadtest_key={KEY}".encode())],
             "client": LAN, "server": ("192.168.1.10", 8795)}
    task = asyncio.create_task(app(scope, receive, send))
    await asyncio.wait_for(started.wait(), 2)
    disconnect.set()
    await asyncio.wait_for(task, 2)
    assert sent[0]["status"] == 200


async def test_this_machine_needs_no_key(stub):
    for client in (("127.0.0.1", 5), ("::1", 5)):
        async with tool(stub, client=client, access_key=KEY) as c:
            assert (await c.get("/")).status_code == 200
            assert (await c.get("/api/state")).status_code == 200
            assert (await c.post("/api/start", headers=PAGE)).status_code == 202
            assert (await c.post("/api/start")).status_code == 403     # header still needed


async def test_a_foreign_origin_is_refused(stub):
    async with tool(stub) as c:
        got = await c.post("/api/start", headers={**PAGE, "Origin": "http://evil.example"})
        assert got.status_code == 403
        assert got.json() == {"code": "forbidden",
                              "message": "This request did not come from the load test page."}
        for origin in ("http://localhost:9999", "null", "http://localhost.evil.example:8795"):
            got = await c.post("/api/start", headers={**PAGE, "Origin": origin})
            assert got.status_code == 403
        assert (await c.get("/api/state",
                            headers={"Origin": "http://evil.example"})).status_code == 403
        assert stub.calls == []
        got = await c.post("/api/start", headers={**PAGE, "Origin": "http://localhost:8795"})
        assert got.status_code == 202
        got = await c.post("/api/start", headers={**PAGE, "Origin": "http://LocalHost:8795"})
        assert got.status_code == 202


async def test_default_port_origin_matches_a_host_without_port(stub):
    async with tool(stub, base="http://localhost") as c:
        got = await c.post("/api/start", headers={**PAGE, "Origin": "http://localhost"})
        assert got.status_code == 202


# ── the event stream ───────────────────────────────────────────────────


def parse(chunk: str) -> tuple[str, object]:
    if chunk.startswith(":"):
        return ("comment", chunk.strip())
    assert chunk.endswith("\n\n") and chunk.count("\n") == 3
    head, data = chunk.rstrip("\n").split("\n")
    assert head.startswith("event: ") and data.startswith("data: ")
    return (head[len("event: "):], json.loads(data[len("data: "):]))


class Stream:
    """One consumer of event_stream, read on its own task."""

    def __init__(self, runner, **pace):
        self.closed = False
        self.got: list[tuple[str, object]] = []

        async def gone():
            return self.closed

        self.gen = event_stream(runner, gone, **pace)
        self.task = asyncio.create_task(self._read())

    async def _read(self):
        async for chunk in self.gen:
            self.got.append(parse(chunk))

    def names(self):
        return [name for name, _ in self.got]

    def feed_subjects(self):
        return [data["subject"] for name, data in self.got if name == "feed"]

    async def close(self):
        self.closed = True
        await asyncio.wait_for(self.task, 2)


async def until(predicate, seconds=2.0):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        await asyncio.sleep(0.01)


async def test_stream_starts_with_snapshot_and_buffered_feed(stub):
    stub.phase = "running"
    stub.snap = {"phase": "running", "elapsed": 3.0}
    stub.events.feed(line(1))
    stub.events.feed(line(2, ok=False))
    s = Stream(stub, active_every=0.05, idle_every=10, keep_alive=10)
    await until(lambda: len(s.got) >= 3)
    assert s.got[0] == ("snapshot", {"phase": "running", "elapsed": 3.0})
    assert s.got[1] == ("feed", {
        "at": 1_800_000_001.0, "time": time.strftime("%H:%M:%S", time.localtime(1_800_000_001)),
        "device": "Load test – Enroll 1", "action": "RFID enroll", "subject": "SN LOADTEST-1",
        "ok": True, "ms": 41.0, "note": ""})
    assert s.got[2][1]["ok"] is False and s.got[2][1]["note"] == "HTTP 500"
    await s.close()


async def test_stream_paces_snapshots_by_phase_and_keeps_alive(stub):
    stub.phase = "idle"
    s = Stream(stub, active_every=0.02, idle_every=0.3, keep_alive=0.1)
    await asyncio.sleep(0.25)
    assert s.names().count("snapshot") == 1            # only the first one while idle
    assert ("comment", ": keep-alive") in s.got
    stub.phase = "running"
    before = s.names().count("snapshot")
    await asyncio.sleep(0.2)
    assert s.names().count("snapshot") - before >= 4
    await s.close()


async def test_stream_ends_on_disconnect_and_unsubscribes(stub):
    s = Stream(stub, active_every=0.05, idle_every=10, keep_alive=10)
    await until(lambda: s.got)
    assert len(stub.events._subscribers) == 1
    await s.close()
    assert len(stub.events._subscribers) == 0


async def test_stream_ends_when_the_app_stops(stub):
    stopping = asyncio.Event()

    async def connected():
        return False

    got = []

    async def read():
        async for chunk in event_stream(stub, connected, stopping=stopping, active_every=10,
                                        idle_every=10, keep_alive=10):
            got.append(chunk)

    task = asyncio.create_task(read())
    await until(lambda: got)
    stopping.set()
    await asyncio.wait_for(task, 1)
    assert stub.events._subscribers == []


async def test_stream_aclose_unsubscribes(stub):
    async def connected():
        return False

    gen = event_stream(stub, connected, active_every=10, idle_every=10, keep_alive=10)
    assert parse(await gen.__anext__())[0] == "snapshot"
    assert len(stub.events._subscribers) == 1
    await gen.aclose()
    assert stub.events._subscribers == []


async def test_two_streams_mid_run(stub):
    """Review Focus 4: two consumers each get the first snapshot and the buffered feed and
    keep receiving; closing one leaves the other working, one subscriber fewer."""
    stub.phase = "running"
    stub.snap = {"phase": "running"}
    for n in range(3):
        stub.events.feed(line(n))
    pace = {"active_every": 0.05, "idle_every": 10, "keep_alive": 10}
    a, b = Stream(stub, **pace), Stream(stub, **pace)
    buffered = ["SN LOADTEST-0", "SN LOADTEST-1", "SN LOADTEST-2"]
    await until(lambda: len(a.got) >= 4 and len(b.got) >= 4)
    for s in (a, b):
        assert s.got[0] == ("snapshot", {"phase": "running"})
        assert s.feed_subjects() == buffered
    assert len(stub.events._subscribers) == 2

    stub.events.feed(line(3))
    await until(lambda: len(a.feed_subjects()) == 4 and len(b.feed_subjects()) == 4)

    await a.close()
    assert len(stub.events._subscribers) == 1
    stub.events.feed(line(4))
    await until(lambda: len(b.feed_subjects()) == 5)
    assert b.feed_subjects()[-2:] == ["SN LOADTEST-3", "SN LOADTEST-4"]
    assert len(a.feed_subjects()) == 4
    await b.close()
    assert stub.events._subscribers == []


async def test_events_route_headers(stub):
    """The route's headers, read from the ASGI messages (the body never ends)."""
    app = create_app(stub)
    started = asyncio.Event()
    sent: list[dict] = []
    disconnect = asyncio.Event()

    async def receive():
        await disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.body" and message.get("body"):
            started.set()

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
             "method": "GET", "scheme": "http", "path": "/api/events", "raw_path": b"/api/events",
             "query_string": b"", "root_path": "", "headers": [(b"host", b"localhost:8795")],
             "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 8795)}
    task = asyncio.create_task(app(scope, receive, send))
    await asyncio.wait_for(started.wait(), 2)
    disconnect.set()
    await asyncio.wait_for(task, 2)
    headers = {k.decode(): v.decode() for k, v in sent[0]["headers"]}
    assert sent[0]["status"] == 200
    assert headers["content-type"].startswith("text/event-stream")
    assert headers["cache-control"] == "no-store"
    assert headers["x-accel-buffering"] == "no"
    assert sent[1]["body"].startswith(b"event: snapshot\ndata: ")
    assert stub.events._subscribers == []


# ── one real run through the routes ────────────────────────────────────


def osrm():
    coords = [[ORIGIN[1] + (DESTINATION[1] - ORIGIN[1]) * i / 10,
               ORIGIN[0] + (DESTINATION[0] - ORIGIN[0]) * i / 10] for i in range(11)]
    body = {"code": "Ok", "routes": [{"geometry": {"coordinates": coords}}]}
    return httpx.MockTransport(lambda request: httpx.Response(200, json=body))


async def test_a_whole_run_through_the_routes(fake, clock, tmp_path):
    move_id = fake.add_move(servers=45, containers=4, trucks=2, password=MOVE_PASSWORD)
    fake.add_portal_user(EMAIL, PASSWORD)
    runner = Runner(runs_dir=tmp_path / "runs", clock=clock, router_url="https://router.test",
                    transport=fake.transport(), router_transport=osrm())

    async def tick():
        while True:
            await clock.sleep(1)
            fake.process_scans()

    ticker = None
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(runner)),
                                     base_url="http://localhost") as c:
            state = (await c.get("/api/state")).json()
            assert state["phase"] == "idle"
            assert (await c.get("/api/result")).status_code == 404

            got = await clock.run(c.post("/api/connect", headers=PAGE, json={
                "server": FAKE_BASE_URL, "email": EMAIL, "password": PASSWORD}))
            assert got.status_code == 200
            assert got.json()["status"] == "ok"
            assert [m["id"] for m in got.json()["moves"]] == [move_id]

            got = await clock.run(c.post("/api/check", headers=PAGE, json={
                "move_id": move_id, "move_password": MOVE_PASSWORD, "speed": "fast"}))
            assert got.status_code == 200
            check = got.json()
            assert check["can_start"] is True, check["checks"]
            assert check["summary"] == {"servers": 45, "containers": 4, "trucks": 2,
                                        "containers_needed": 3, "trucks_needed": 1}
            assert {"key", "label", "status", "detail"} == set(check["checks"][0])

            got = await clock.run(c.post("/api/start", headers=PAGE))
            assert (got.status_code, got.json()) == (202, {})
            again = await clock.run(c.post("/api/start", headers=PAGE))
            assert again.status_code == 409
            assert again.json()["code"] == "bad_phase"

            ticker = asyncio.create_task(tick())
            await clock.run(runner.wait())
            state = (await c.get("/api/state")).json()
            assert state["phase"] == "done"
            got = await c.get("/api/result")
            assert got.status_code == 200
            assert got.json()["verdict"] == "Pass", got.json()["findings"]
            for text in (json.dumps(state), got.text):
                assert PASSWORD not in text and MOVE_PASSWORD not in text
    finally:
        await runner.shutdown()
        if ticker is not None:
            ticker.cancel()
            await asyncio.gather(ticker, return_exceptions=True)


# ── the command ────────────────────────────────────────────────────────


def test_help_exits_without_loading_the_server():
    code = ("import runpy, sys\n"
            "sys.argv = ['loadtest', '--help']\n"
            "try:\n"
            "    runpy.run_module('loadtest', run_name='__main__')\n"
            "except SystemExit as e:\n"
            "    assert e.code in (0, None), e.code\n"
            "print('LOADED', 'uvicorn' in sys.modules, 'loadtest.web.app' in sys.modules)\n")
    got = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                         timeout=30)
    assert got.returncode == 0, got.stderr
    assert "--port" in got.stdout and "--runs-dir" in got.stdout
    assert "LOADED False False" in got.stdout
    plain = subprocess.run([sys.executable, "-m", "loadtest", "--help"], capture_output=True,
                           text=True, timeout=30)
    assert plain.returncode == 0


def test_port_in_use_is_one_line(tmp_path):
    import socket
    taken = socket.socket()
    taken.bind(("127.0.0.1", 0))
    taken.listen()
    port = taken.getsockname()[1]
    try:
        got = subprocess.run([sys.executable, "-m", "loadtest", "--host", "127.0.0.1",
                              "--port", str(port), "--runs-dir", str(tmp_path / "runs")],
                             capture_output=True, text=True, timeout=30)
    finally:
        taken.close()
    assert got.returncode != 0
    out = (got.stdout + got.stderr).strip()
    assert len(out.splitlines()) == 1 and str(port) in out
    assert "Traceback" not in out


def test_allowed_names_and_loopback(monkeypatch):
    from loadtest import __main__ as cli
    monkeypatch.setattr(cli.socket, "gethostname", lambda: "Jimmys-Mac.local")
    names = cli.allowed_hosts("0.0.0.0", "192.168.1.10", ["proxy.example"])
    assert set(names) == {"localhost", "127.0.0.1", "::1", "192.168.1.10", "jimmys-mac",
                          "jimmys-mac.local", "proxy.example"}
    assert "10.0.0.5" in cli.allowed_hosts("10.0.0.5", "192.168.1.10", [])
    assert "0.0.0.0" not in names
    assert all(cli.is_loopback(h) for h in ("127.0.0.1", "::1", "localhost", "[::1]"))
    assert not any(cli.is_loopback(h) for h in ("0.0.0.0", "::", "192.168.1.10", "tool.lan"))


def test_loopback_start_prints_one_line_and_no_key(tmp_path):
    import signal
    import socket
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    proc = subprocess.Popen([sys.executable, "-m", "loadtest", "--host", "127.0.0.1",
                             "--port", str(port), "--runs-dir", str(tmp_path / "runs")],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        first = proc.stdout.readline()
        assert first == f"On this machine: http://localhost:{port}\n"
    finally:
        proc.send_signal(signal.SIGINT)
        out, err = proc.communicate(timeout=20)
    assert "key" not in first + out
    assert "Move load test" not in out
    assert (tmp_path / "runs").is_dir()
