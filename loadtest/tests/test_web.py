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
from loadtest.web.signin import SignIn

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
        self.stop_gate: asyncio.Event | None = None
        self.stop_fail: BaseException | None = None

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
        if self.stop_gate is not None:
            await self.stop_gate.wait()
        if self.stop_fail is not None:
            raise self.stop_fail

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
    assert got.json() == {"phase": "idle", "check": None, "move": None, "stopping": False}
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
     "(unknown field)"),
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
    stub.phase = "running"
    got = await client.post("/api/stop", headers=PAGE)
    assert (got.status_code, got.json()) == (202, {})
    await asyncio.sleep(0)
    stub.phase = "idle"
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
    stub._result = {"verdict": "Pass", "series": {"waiting": [[1.0, 3]]}}
    got = await client.get("/api/result")
    # the page needs no series (results.json on disk keeps them): a two-day run's are MBs
    assert (got.status_code, got.json()) == (200, {"verdict": "Pass"})
    assert got.headers["cache-control"] == "no-store"
    assert stub._result["series"]                    # the kept result is left whole


async def test_shutdown_hook_interrupts_the_run(stub):
    app = create_app(stub)
    async with app.router.lifespan_context(app):
        assert not stub.shut_down
    assert stub.shut_down


# ── who may reach the tool ─────────────────────────────────────────────

SIGN_IN = SignIn("admin", "s3cret-pass")
NEED_SIGN_IN = {"code": "sign_in", "message": "Sign in to use the load test."}
WRONG = "That username or password is not right."
LAN = ("192.168.1.50", 12345)


def tool(stub, *, client=("127.0.0.1", 123), base="http://localhost:8795", **kwargs):
    return httpx.AsyncClient(transport=httpx.ASGITransport(create_app(stub, **kwargs),
                                                           client=client),
                             base_url=base)


def lan_tool(stub, **kwargs):
    """A visitor from another machine, opening the page by this machine's LAN address."""
    return tool(stub, client=LAN, base="http://192.168.1.10:8795",
                allowed_hosts=["192.168.1.10"], sign_in=SIGN_IN, **kwargs)


async def sign_in(c, username="admin", password="s3cret-pass", **kwargs):
    return await c.post("/login", data={"username": username, "password": password}, **kwargs)


async def test_a_wrong_host_is_refused(stub):
    async with tool(stub, base="http://evil.example:8795", sign_in=SIGN_IN) as c:
        for got in (await c.get("/"), await c.get("/api/state"), await c.get("/login"),
                    await sign_in(c), await c.post("/api/start", headers=PAGE)):
            assert got.status_code == 400
            assert got.text == ("This address is not allowed. Open the page by the address "
                                "the tool printed.")
            assert "set-cookie" not in got.headers
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


async def test_a_lan_client_must_sign_in(stub):
    async with lan_tool(stub) as c:
        for path in ("/api/state", "/api/events", "/api/result"):
            got = await c.get(path)
            assert got.status_code == 401
            assert got.json() == NEED_SIGN_IN
            assert got.headers["cache-control"] == "no-store"
        for path in ("/", "/static/index.html", "/static/simulate.js", "/anything"):
            got = await c.get(path)
            assert got.status_code == 303 and got.headers["location"] == "/login"
            assert got.headers["cache-control"] == "no-store"
        got = await c.post("/api/start", headers=PAGE)
        assert got.status_code == 401
        assert stub.calls == []


async def test_the_sign_in_page_asks_for_a_username_and_password(stub):
    async with lan_tool(stub) as c:
        got = await c.get("/login")
        assert got.status_code == 200
        assert got.headers["content-type"].startswith("text/html")
        assert got.headers["cache-control"] == "no-store"
        page = got.text
        assert '<form method="post" action="/login"' in page
        assert 'name="username"' in page and 'autocomplete="username"' in page
        assert 'name="password" type="password"' in page
        assert 'autocomplete="current-password"' in page
        assert ">Sign in</button>" in page
        assert WRONG not in page
        assert "s3cret-pass" not in page and 'value="admin"' not in page    # nothing prefilled
        assert "data-generator.theme" in page       # follows the page's light or dark
        assert (await c.put("/login")).status_code == 405


@pytest.mark.parametrize("username,password", [
    ("admin", "nope"), ("admin", "s3cret-pas"), ("admin", "s3cret-pass "), ("admin", ""),
    ("Admin", "s3cret-pass"), ("root", "s3cret-pass"), ("", "s3cret-pass"), ("", ""),
    ("admin", "é" * 5), ("s3cret-pass", "admin")])
async def test_a_wrong_username_or_password_signs_nobody_in(stub, username, password):
    async with lan_tool(stub) as c:
        got = await sign_in(c, username, password)
        assert got.status_code == 401
        assert "set-cookie" not in got.headers
        assert WRONG in got.text
        assert (await c.get("/api/state")).status_code == 401
    assert stub.calls == []


async def test_a_wrong_try_shows_the_username_again_and_never_the_password(stub):
    async with lan_tool(stub) as c:
        got = await sign_in(c, 'jim"><script>alert(1)</script>', "typed-pass-9")
        assert got.status_code == 401
        assert 'value="jim&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"' in got.text
        assert "<script>alert" not in got.text
        assert "typed-pass-9" not in got.text


async def test_a_made_up_session_cookie_opens_nothing(stub):
    async with lan_tool(stub) as c:
        for forged in ("nope", "s3cret-pass", "admin", "A" * 43):
            c.cookies.set("loadtest_session", forged)
            assert (await c.get("/api/state")).status_code == 401
            c.cookies.clear()


@pytest.mark.parametrize("body,content_type", [
    (b"username=admin&password=" + b"x" * 5000, "application/x-www-form-urlencoded"),
    (b"", "application/x-www-form-urlencoded"),
    (b"\xff\xfe\x00", "application/x-www-form-urlencoded"),
    (b'{"username": "admin", "password": "s3cret-pass"}', "application/json"),
    (b"password=s3cret-pass", "application/x-www-form-urlencoded")])
async def test_a_form_that_is_not_the_sign_in_form_signs_nobody_in(stub, body, content_type):
    async with lan_tool(stub) as c:
        got = await c.post("/login", content=body, headers={"Content-Type": content_type})
        assert got.status_code == 401 and "set-cookie" not in got.headers


async def test_another_sites_form_cannot_sign_in(stub):
    async with lan_tool(stub) as c:
        got = await sign_in(c, headers={"Origin": "http://evil.example"})
        assert got.status_code == 403 and "set-cookie" not in got.headers
        got = await sign_in(c, headers={"Origin": "http://192.168.1.10:8795"})
        assert got.status_code == 303


async def test_signing_in_sets_a_session_cookie_and_opens_the_page(stub, capsys, caplog):
    async with lan_tool(stub) as c:
        got = await sign_in(c)
        assert got.status_code == 303 and got.headers["location"] == "/"
        assert got.headers["cache-control"] == "no-store"
        cookie = got.headers["set-cookie"]
        assert cookie.startswith("loadtest_session=")
        value = cookie.split(";")[0].split("=", 1)[1]
        assert len(value) >= 32 and "s3cret-pass" not in value and "admin" not in value
        parts = {p.strip().lower() for p in cookie.split(";")}
        assert {"httponly", "samesite=strict", "path=/"} <= parts
        assert not any(p.startswith(("secure", "max-age", "expires")) for p in parts)
        bodies = [got.text]
        for path in ("/", "/api/state", "/static/index.html", "/api/result"):
            got = await c.get(path)
            assert got.status_code in (200, 404)
            bodies.append(got.text)
        got = await c.get("/login")                     # already in: straight to the page
        assert got.status_code == 303 and got.headers["location"] == "/"
        got = await c.post("/api/start", headers=PAGE)
        assert got.status_code == 202
    assert all("s3cret-pass" not in b and value not in b for b in bodies)
    out = capsys.readouterr()
    assert "s3cret-pass" not in out.out + out.err + caplog.text
    assert value not in out.out + out.err + caplog.text


async def test_over_https_the_session_cookie_is_secure(stub):
    async with lan_tool(stub, secure_cookie=True) as c:
        cookie = (await sign_in(c)).headers["set-cookie"]
        assert "secure" in {p.strip().lower() for p in cookie.split(";")}


async def test_a_restart_signs_everyone_out(stub):
    async with lan_tool(stub) as first:
        assert (await sign_in(first)).status_code == 303
        session = first.cookies.get("loadtest_session")
        assert (await first.get("/api/state")).status_code == 200
    async with lan_tool(stub) as second:                # the tool started again
        second.cookies.set("loadtest_session", session)
        assert (await second.get("/api/state")).status_code == 401
        second.cookies.clear()
        assert (await sign_in(second)).status_code == 303
        assert second.cookies.get("loadtest_session") != session


def test_a_sign_in_never_shows_its_password():
    assert "s3cret-pass" not in repr(SIGN_IN) + str(SIGN_IN) + f"{SIGN_IN!r}"
    assert SIGN_IN.matches("admin", "s3cret-pass")
    assert SignIn("ünïcode", "pässwörd").matches("ünïcode", "pässwörd")


async def test_with_no_sign_in_the_sign_in_page_leads_to_the_page(stub):
    async with tool(stub) as c:
        got = await c.get("/login")
        assert got.status_code == 303 and got.headers["location"] == "/"
        assert (await c.get("/api/state")).status_code == 200


async def test_the_session_cookie_opens_the_event_stream(stub):
    """Read at ASGI level: the stream never ends on its own."""
    app = create_app(stub, allowed_hosts=["192.168.1.10"], sign_in=SIGN_IN)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app, client=LAN),
                                 base_url="http://192.168.1.10:8795") as c:
        assert (await sign_in(c)).status_code == 303
        session = c.cookies.get("loadtest_session")
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
                         (b"cookie", f"loadtest_session={session}".encode())],
             "client": LAN, "server": ("192.168.1.10", 8795)}
    task = asyncio.create_task(app(scope, receive, send))
    await asyncio.wait_for(started.wait(), 2)
    disconnect.set()
    await asyncio.wait_for(task, 2)
    assert sent[0]["status"] == 200


async def test_this_machine_needs_no_sign_in(stub):
    for client in (("127.0.0.1", 5), ("::1", 5)):
        async with tool(stub, client=client, sign_in=SIGN_IN) as c:
            assert (await c.get("/")).status_code == 200
            assert (await c.get("/api/state")).status_code == 200
            got = await c.get("/login")
            assert got.status_code == 303 and got.headers["location"] == "/"
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


# ── fix round 1 ────────────────────────────────────────────────────────


async def test_passwords_reach_the_runner_unchanged(client, stub):
    await client.post("/api/connect", headers=PAGE, json={
        "server": " s ", "email": " a@b.c ", "password": "  pw  ", "totp_code": " 1 "})
    assert stub.calls[-1] == ("connect", "s", "a@b.c", "  pw  ", "1")
    stub.report = CheckReport(checks=[], can_start=False, move=None, roster=[], containers=[],
                              trucks=[], route=[])
    stub.snap = {"check": {"servers": 0, "containers_found": 0, "trucks_found": 0,
                           "containers_needed": 0, "trucks_needed": 0}}
    await client.post("/api/check", headers=PAGE, json={
        "move_id": " m ", "move_password": "  mp  ", "speed": "fast"})
    assert stub.calls[-1] == ("check", "m", "  mp  ", "fast")
    await client.post("/api/continue", headers=PAGE, json={
        "email": EMAIL, "password": "  pw  ", "move_password": " mp", "totp_code": None})
    assert stub.calls[-1] == ("continue", "  pw  ", " mp", EMAIL, None)


async def test_unknown_field_names_are_never_echoed(client):
    got = await client.post("/api/connect", headers=PAGE, json={
        "server": "s", "email": "e", "password": "p", "<script>SECRET-N": 1, "x": 2})
    assert got.status_code == 422
    assert got.json()["fields"] == ["(unknown field)"]
    assert "SECRET-N" not in got.text and '"x"' not in got.text


async def test_check_without_a_snapshot_check_is_a_500(client, stub, capsys):
    stub.report = CheckReport(checks=[], can_start=True, move=None, roster=[], containers=[],
                              trucks=[], route=[])
    stub.snap = {"check": None}
    got = await client.post("/api/check", headers=PAGE, json={
        "move_id": "m", "move_password": "mp", "speed": "fast"})
    assert got.status_code == 500
    assert "TypeError" in capsys.readouterr().err


async def test_stop_answers_at_once_and_runs_on(client, stub):
    stub.phase = "running"
    stub.stop_gate = asyncio.Event()
    got = await client.post("/api/stop", headers=PAGE)
    assert (got.status_code, got.json()) == (202, {})
    assert (await client.get("/api/state")).json()["stopping"] is True
    again = await client.post("/api/stop", headers=PAGE)
    assert again.status_code == 202
    await asyncio.sleep(0.01)
    assert [c for c in stub.calls if c[0] == "stop"] == [("stop",)]     # one stop task
    stub.stop_gate.set()
    stub.phase = "stopped"
    for _ in range(50):
        if not (await client.get("/api/state")).json()["stopping"]:
            break
        await asyncio.sleep(0.01)
    assert (await client.get("/api/state")).json()["stopping"] is False


async def test_stop_snapshot_event_says_stopping(stub):
    app = create_app(stub)
    stub.phase = "running"
    stub.stop_gate = asyncio.Event()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),
                                 base_url="http://localhost") as c:
        assert (await c.post("/api/stop", headers=PAGE)).status_code == 202
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
             "headers": [(b"host", b"localhost")], "client": ("127.0.0.1", 1),
             "server": ("127.0.0.1", 80)}
    task = asyncio.create_task(app(scope, receive, send))
    await asyncio.wait_for(started.wait(), 2)
    disconnect.set()
    await asyncio.wait_for(task, 2)
    name, data = parse(sent[1]["body"].decode())
    assert name == "snapshot" and data["stopping"] is True
    stub.stop_gate.set()
    await asyncio.gather(app.state.stop_task)


async def test_stop_with_nothing_to_stop_is_409(client, stub):
    for phase in ("idle", "connected", "checked", "done", "stopped", "error"):
        stub.phase = phase
        got = await client.post("/api/stop", headers=PAGE)
        assert got.status_code == 409
        assert got.json() == {"code": "bad_phase", "message": "That cannot be done right now."}
    assert stub.calls == []


@pytest.mark.parametrize("fail", [RunnerError("bad_phase"), ValueError("SECRET-S")])
async def test_a_failed_background_stop_is_logged_by_type(client, stub, capsys, fail):
    stub.phase = "running"
    stub.stop_fail = fail
    assert (await client.post("/api/stop", headers=PAGE)).status_code == 202
    for _ in range(50):
        await asyncio.sleep(0.01)
        if not (await client.get("/api/state")).json()["stopping"]:
            break
    err = capsys.readouterr().err
    assert type(fail).__name__ in err and "/api/stop" in err
    assert "SECRET-S" not in err


async def test_shutdown_waits_for_a_stop_in_flight(stub):
    app = create_app(stub)
    stub.phase = "running"
    stub.stop_gate = asyncio.Event()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app),
                                     base_url="http://localhost") as c:
            assert (await c.post("/api/stop", headers=PAGE)).status_code == 202
        stub.stop_gate.set()
    assert app.state.stop_task.done() and stub.shut_down


async def test_tls_proxy_origin_matches_a_host_without_port(stub):
    async with tool(stub, base="http://proxy.example", allowed_hosts=["proxy.example"]) as c:
        for origin, ok in (("https://proxy.example", True), ("http://proxy.example", True),
                           ("https://proxy.example:443", True),
                           ("https://proxy.example:8443", False),
                           ("https://other.example", False), ("ftp://proxy.example", False)):
            got = await c.post("/api/start", headers={**PAGE, "Origin": origin})
            assert (got.status_code == 202) is ok, origin
    async with tool(stub, base="http://proxy.example:8443",
                    allowed_hosts=["proxy.example"]) as c:
        got = await c.post("/api/start", headers={**PAGE, "Origin": "https://proxy.example"})
        assert got.status_code == 403


@pytest.mark.parametrize("header", ["X-Forwarded-For", "Forwarded", "X-Real-IP"])
async def test_a_forwarded_loopback_request_must_sign_in(stub, header):
    async with tool(stub, sign_in=SIGN_IN) as c:
        got = await c.get("/api/state", headers={header: "1.2.3.4"})
        assert got.status_code == 401
        assert (await sign_in(c, headers={header: "1.2.3.4"})).status_code == 303
        got = await c.get("/api/state", headers={header: "1.2.3.4"})
        assert got.status_code == 200


async def test_loopback_under_another_name_must_sign_in(stub):
    hosts = ["192.168.1.10", "proxy.example", "jimmys-mac.local"]
    for base in ("http://192.168.1.10:8795", "http://proxy.example", "http://jimmys-mac.local"):
        async with tool(stub, base=base, allowed_hosts=hosts, sign_in=SIGN_IN) as c:
            assert (await c.get("/api/state")).status_code == 401
            got = await c.get("/")
            assert got.status_code == 303 and got.headers["location"] == "/login"
            assert (await sign_in(c)).status_code == 303
            assert (await c.get("/api/state")).status_code == 200
    for base in ("http://localhost:8795", "http://127.0.0.1:8795", "http://[::1]:8795"):
        async with tool(stub, base=base, allowed_hosts=hosts, sign_in=SIGN_IN) as c:
            assert (await c.get("/api/state")).status_code == 200


async def test_the_cookie_name_is_per_port(stub):
    async with lan_tool(stub, cookie_name="loadtest_session_8795") as c:
        got = await sign_in(c)
        assert got.headers["set-cookie"].startswith("loadtest_session_8795=")
        session = c.cookies.get("loadtest_session_8795")
        assert (await c.get("/api/state")).status_code == 200
        c.cookies.clear()
        c.cookies.set("loadtest_session", session)
        assert (await c.get("/api/state")).status_code == 401


@pytest.mark.parametrize("host", ["[::1]evil.com", "[::1]:80x", "[::1", "localhost:abc",
                                  "localhost:", "localhost:80:80", ""])
async def test_malformed_hosts_are_refused(stub, host):
    async with tool(stub) as c:
        got = await c.get("/api/state", headers={"Host": host})
        assert got.status_code == 400


async def test_websocket_and_other_scopes_are_refused(stub):
    app = create_app(stub)
    sent = []

    async def receive():
        return {"type": "websocket.connect"}

    async def send(message):
        sent.append(message)

    await app({"type": "websocket", "path": "/api/events", "headers": [(b"host", b"localhost")],
               "client": ("127.0.0.1", 1), "query_string": b"", "root_path": ""},
              receive, send)
    assert sent == [{"type": "websocket.close", "code": 1008}]
    sent.clear()
    await app({"type": "other"}, receive, send)
    assert sent == []


class Flaky(StubRunner):
    def __init__(self):
        super().__init__()
        self.bad_snapshots = 0
        self.bad_recent = True

    def snapshot(self):
        if self.bad_snapshots:
            self.bad_snapshots -= 1
            raise KeyError("SEC" + "RET-K")
        return super().snapshot()

    def recent(self):
        if self.bad_recent:
            raise OSError("SEC" + "RET-R")
        return super().recent()


async def test_a_failing_read_does_not_end_the_stream(capsys):
    flaky = Flaky()
    flaky.bad_snapshots = 3
    flaky.phase = "running"
    s = Stream(flaky, active_every=0.02, idle_every=10, keep_alive=10)
    await asyncio.sleep(0.1)
    flaky.events.feed(line(7))
    await until(lambda: s.names().count("snapshot") >= 2 and s.feed_subjects())
    assert s.feed_subjects() == ["SN LOADTEST-7"]
    assert flaky.bad_snapshots == 0       # the first snapshot and the next two failed
    await s.close()
    assert flaky.events._subscribers == []
    err = capsys.readouterr().err
    assert err.count("/api/events: KeyError") == 1          # logged once per stream
    assert err.count("/api/events: OSError") == 1
    assert "SECRET" not in err


def test_no_access_log_and_no_proxy_headers(monkeypatch, tmp_path):
    """main() configures uvicorn without an access log and without proxy headers."""
    import socket

    import uvicorn

    from loadtest import __main__ as cli
    seen = {}

    class Fake(uvicorn.Server):
        def run(self, sockets=None):
            seen["config"] = self.config
            for s in sockets or ():
                s.close()

    monkeypatch.setattr(uvicorn, "Server", Fake)
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    cli.main(["--host", "127.0.0.1", "--port", str(port), "--allow-host", "proxy.example",
              "--runs-dir", str(tmp_path / "runs")])
    config = seen["config"]
    assert config.access_log is False and config.proxy_headers is False


@pytest.mark.parametrize("extra,skip", [([], True), (["--allow-host", "proxy.example"], False)])
def test_allow_host_turns_off_the_local_skip(monkeypatch, tmp_path, extra, skip):
    import socket

    import uvicorn

    from loadtest import __main__ as cli
    from loadtest.web import app as web
    seen = {}
    real = web.create_app

    def spy(runner, **kwargs):
        seen.update(kwargs)
        return real(runner, **kwargs)

    class Fake(uvicorn.Server):
        def run(self, sockets=None):
            for s in sockets or ():
                s.close()

    monkeypatch.setattr(uvicorn, "Server", Fake)
    monkeypatch.setattr(web, "create_app", spy)
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    cli.main(["--host", "127.0.0.1", "--port", str(port), *extra,
              "--runs-dir", str(tmp_path / "runs")])
    assert seen["local_skip"] is skip


async def test_without_the_local_skip_this_machine_signs_in_too(stub):
    async with tool(stub, sign_in=SIGN_IN, local_skip=False) as c:
        assert (await c.get("/api/state")).status_code == 401
        got = await c.get("/")
        assert got.status_code == 303 and got.headers["location"] == "/login"
        assert (await c.get("/login")).status_code == 200
        assert (await sign_in(c)).status_code == 303
        assert (await c.get("/api/state")).status_code == 200
        assert (await c.post("/api/start", headers=PAGE)).status_code == 202


async def test_shutdown_gives_up_on_a_stop_that_never_ends(stub, capsys):
    app = create_app(stub, stop_wait=0.05)
    stub.phase = "running"
    stub.stop_gate = asyncio.Event()           # never set: the stop never returns
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app),
                                     base_url="http://localhost") as c:
            assert (await c.post("/api/stop", headers=PAGE)).status_code == 202
    assert app.state.stop_task.cancelled()
    assert stub.shut_down
    assert "TimeoutError" in capsys.readouterr().err


def test_allow_host_on_loopback_says_everyone_signs_in(monkeypatch, tmp_path, capsys):
    import socket

    import uvicorn

    from loadtest import __main__ as cli

    class Fake(uvicorn.Server):
        def run(self, sockets=None):
            for s in sockets or ():
                s.close()

    monkeypatch.setattr(uvicorn, "Server", Fake)
    for name in ("LOADTEST_USERNAME", "LOADTEST_PASSWORD", "LOADTEST_PUBLIC_URL"):
        monkeypatch.delenv(name, raising=False)
    for extra, guarded in (([], False), (["--allow-host", "proxy.example"], True)):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        cli.main(["--host", "127.0.0.1", "--port", str(port), *extra,
                  "--runs-dir", str(tmp_path / "runs")])
        out = capsys.readouterr().out.splitlines()
        if guarded:
            assert out == [f"Move load test: http://localhost:{port}",
                           "A proxy name was allowed, so everyone signs in, on this machine "
                           "too.", cli.DEFAULT_SIGN_IN]
        else:
            assert out == [f"On this machine: http://localhost:{port}"]


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
    assert out == (f"Port {port} is already in use. The load test may already be running on "
                   "this machine; open its page instead, or start this one with --port and "
                   "--runs-dir set to something else.")


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


ANOTHER_COPY = "Another copy of the load test is already using this runs folder."


def test_a_second_copy_on_the_same_runs_folder_exits(tmp_path):
    """Two copies on one runs folder would both drive the same run."""
    import socket

    from loadtest import __main__ as cli
    runs = tmp_path / "runs"
    held = cli.lock_runs_dir(runs)
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    try:
        got = subprocess.run([sys.executable, "-m", "loadtest", "--host", "127.0.0.1",
                              "--port", str(port), "--runs-dir", str(runs)],
                             capture_output=True, text=True, timeout=30)
    finally:
        held.close()
    assert got.returncode != 0
    assert (got.stdout + got.stderr).strip() == ANOTHER_COPY
    again = cli.lock_runs_dir(runs)          # free once the first copy lets go
    again.close()


def test_without_file_locks_the_tool_says_so_once(monkeypatch, tmp_path, capsys):
    from loadtest import __main__ as cli
    monkeypatch.setattr(cli, "_fcntl", lambda: None)
    assert cli.lock_runs_dir(tmp_path / "runs") is None
    assert capsys.readouterr().out.splitlines() == [cli.NO_LOCK]
