"""Creating a move through the tool's own routes (/api/sites, /api/setup), then checking
and running it, all on the fake."""

import asyncio
import json

import httpx
import pytest
from conftest import FAKE_BASE_URL

from loadtest.journal import JOURNAL_NAME
from loadtest.runner import Runner
from loadtest.setup import STEPS
from loadtest.web.app import create_app, event_stream

PAGE = {"X-Loadtest": "1"}
EMAIL = "ops@example.com"
PASSWORD = "portal-pass-1"
MOVE_PASSWORD = "brand-new-pass-9"
KC = (39.0997, -94.5786)
OMAHA = (41.2565, -95.9345)


def osrm():
    coords = [[KC[1] + (OMAHA[1] - KC[1]) * i / 10, KC[0] + (OMAHA[0] - KC[0]) * i / 10]
              for i in range(11)]
    body = {"code": "Ok", "routes": [{"geometry": {"coordinates": coords}}]}
    return httpx.MockTransport(lambda request: httpx.Response(200, json=body))


class Tool:
    def __init__(self, fake, clock, tmp_path):
        self.fake, self.clock = fake, clock
        self.runs_dir = tmp_path / "runs"
        self.runner = Runner(runs_dir=self.runs_dir, clock=clock,
                             router_url="https://router.test", transport=fake.transport(),
                             router_transport=osrm())
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(create_app(self.runner)),
                                        base_url="http://localhost")
        self.kc = fake.add_site("Kansas City DC", code="KC", lat=KC[0], lng=KC[1])
        self.omaha = fake.add_site("Omaha DC", code="OMA", lat=OMAHA[0], lng=OMAHA[1])
        self.bare = fake.add_site("Annex", lat=None, lng=None)
        fake.add_portal_user(EMAIL, PASSWORD)
        self.ticker: asyncio.Task | None = None

    def work(self, *, jobs=True):
        """The server's workers: jobs and scans, every virtual second."""
        async def tick():
            while True:
                await self.clock.sleep(1)
                if jobs:
                    self.fake.process_jobs()
                self.fake.process_scans()
        self.ticker = asyncio.create_task(tick())

    async def post(self, path, body=None):
        return await self.clock.run(self.client.post(path, headers=PAGE, json=body))

    async def get(self, path):
        return await self.clock.run(self.client.get(path))

    async def connect(self):
        got = await self.post("/api/connect", {"server": FAKE_BASE_URL, "email": EMAIL,
                                               "password": PASSWORD})
        assert got.json()["status"] == "ok", got.json()

    def body(self, **overrides):
        body = {"name": "Load test move KC", "origin_site_id": self.kc,
                "destination_site_id": self.omaha, "servers": 45, "containers": 3,
                "trucks": 1, "move_password": MOVE_PASSWORD}
        body.update(overrides)
        return body

    async def state(self):
        return (await self.get("/api/state")).json()

    async def until_set_up(self):
        async def wait():
            while self.runner.setting_up:
                await self.clock.sleep(0.5)
        await self.clock.run(wait(), limit=3600)

    async def close(self):
        await self.runner.shutdown()
        await self.client.aclose()
        if self.ticker is not None:
            self.ticker.cancel()
            await asyncio.gather(self.ticker, return_exceptions=True)


@pytest.fixture
async def tool(fake, clock, tmp_path):
    t = Tool(fake, clock, tmp_path)
    yield t
    await t.close()


async def test_sites_need_a_sign_in(tool):
    got = await tool.get("/api/sites")
    assert got.status_code == 409
    assert got.json() == {"code": "not_connected", "message": "Sign in to a server first."}


async def test_sites_are_listed_by_name_with_whether_they_have_a_location(tool):
    await tool.connect()
    got = await tool.get("/api/sites")
    assert got.status_code == 200
    assert got.headers["cache-control"] == "no-store"
    assert got.json() == {"sites": [
        {"id": tool.bare, "name": "Annex", "code": None, "has_location": False},
        {"id": tool.kc, "name": "Kansas City DC", "code": "KC", "has_location": True},
        {"id": tool.omaha, "name": "Omaha DC", "code": "OMA", "has_location": True}]}


async def test_set_up_needs_the_page_header_and_a_sign_in(tool):
    got = await tool.clock.run(tool.client.post("/api/setup", json=tool.body()))
    assert got.status_code == 403
    got = await tool.post("/api/setup", tool.body())
    assert (got.status_code, got.json()["code"]) == (409, "not_connected")
    assert tool.fake.import_jobs == {}


@pytest.mark.parametrize("overrides,fields", [
    ({"name": "   "}, ["name"]),
    ({"servers": 0}, ["servers"]),
    ({"move_password": ""}, ["move_password"]),
    ({"containers": "many"}, ["containers"]),
    ({"extra": MOVE_PASSWORD}, ["(unknown field)"]),
])
async def test_bad_bodies_name_their_fields_and_never_the_password(tool, overrides, fields):
    await tool.connect()
    got = await tool.post("/api/setup", tool.body(**overrides))
    assert got.status_code == 422
    assert got.json()["code"] == "bad_request"
    assert got.json()["fields"] == fields
    assert MOVE_PASSWORD not in got.text


async def test_inputs_the_tool_refuses_name_their_fields(tool):
    await tool.connect()
    got = await tool.post("/api/setup", tool.body(containers=2, trucks=0))
    assert got.status_code == 422
    assert got.json() == {
        "code": "setup_input",
        "message": "45 servers need at least 3 containers (20 servers each). 3 containers "
                   "need at least 1 trucks (15 containers each).",
        "fields": ["containers", "trucks"]}
    got = await tool.post("/api/setup", tool.body(origin_site_id=tool.bare))
    assert got.json()["fields"] == ["origin_site_id"]
    assert "Annex has no latitude and longitude" in got.json()["message"]
    got = await tool.post("/api/setup", tool.body(destination_site_id=tool.kc))
    assert got.json()["fields"] == ["origin_site_id", "destination_site_id"]
    assert tool.fake.import_jobs == {} and tool.runner.snapshot()["setup"] is None


async def test_an_unfinished_run_comes_first(tool, tmp_path):
    folder = tmp_path / "runs" / "2027-01-01_00-00-00Z"
    folder.mkdir(parents=True)
    (folder / JOURNAL_NAME).write_text('{"t":"run_started","at":1}\n')
    await tool.connect()
    got = await tool.post("/api/setup", tool.body())
    assert (got.status_code, got.json()["code"]) == (409, "unfinished_run")


async def test_a_move_is_set_up_then_checked_and_run_to_pass(tool, fake):
    await tool.connect()
    got = await tool.post("/api/setup", tool.body())
    assert (got.status_code, got.json()) == (202, {})
    state = await tool.state()
    setup = state["setup"]
    assert setup.pop("step") in STEPS and setup.pop("step_label") in STEPS.values()
    assert setup == {"state": "working", "message": "", "move_id": None,
                     "name": "Load test move KC", "servers": 45, "containers": 3, "trucks": 1}
    # while it works: nothing else that needs the sign-in may begin, and reads still answer
    for path, body in (("/api/setup", tool.body()),
                       ("/api/connect", {"server": FAKE_BASE_URL, "email": EMAIL,
                                         "password": PASSWORD}),
                       ("/api/check", {"move_id": "m", "move_password": "p", "speed": "fast"}),
                       ("/api/start", None)):
        got = await tool.post(path, body)
        assert (got.status_code, got.json()["code"]) == (409, "setup_working"), path
    assert (await tool.get("/api/sites")).status_code == 200

    tool.work()
    await tool.until_set_up()
    state = await tool.state()
    setup = state["setup"]
    assert setup["state"] == "done", setup
    move_id = setup["move_id"]
    assert [m for m in state["moves"] if m["id"] == move_id] == [
        {"id": move_id, "name": "Load test move KC", "status": "in_progress"}]
    assert MOVE_PASSWORD not in json.dumps(state) and PASSWORD not in json.dumps(state)

    got = await tool.post("/api/check", {"move_id": move_id, "move_password": MOVE_PASSWORD,
                                         "speed": "fast"})
    check = got.json()
    assert check["can_start"] is True, check["checks"]
    assert check["summary"] == {"servers": 45, "containers": 3, "trucks": 1,
                                "containers_needed": 3, "trucks_needed": 1}
    assert (await tool.state())["setup"]["state"] == "done"      # kept through the check
    got = await tool.post("/api/start")
    assert got.status_code == 202
    assert (await tool.state())["setup"] is None                 # forgotten once a run starts
    got = await tool.post("/api/setup", tool.body(name="During the run"))
    assert (got.status_code, got.json()["code"]) == (409, "bad_phase")
    await tool.clock.run(tool.runner.wait())
    result = (await tool.get("/api/result")).json()
    assert result["verdict"] == "Pass", result["findings"]
    assert MOVE_PASSWORD not in json.dumps(await tool.state())
    files = [p for p in (tool.runs_dir).rglob("*") if p.is_file()]
    assert files
    for path in files:
        data = path.read_bytes()
        assert MOVE_PASSWORD.encode() not in data and PASSWORD.encode() not in data, path
    assert len(fake.moves) == 1


async def test_an_error_keeps_its_message_until_the_next_sign_in(tool, fake):
    fake.portal_users[EMAIL.lower()].rank = 40
    await tool.connect()
    assert (await tool.post("/api/setup", tool.body())).status_code == 202
    await tool.until_set_up()
    setup = (await tool.state())["setup"]
    assert (setup["state"], setup["step"]) == ("error", "draft")
    assert setup["message"].startswith("The server did not start the move: the portal "
                                       "account is not allowed to do this.")
    await tool.connect()
    assert (await tool.state())["setup"] is None


async def test_shutdown_ends_a_set_up_in_flight(tool):
    await tool.connect()
    assert (await tool.post("/api/setup", tool.body())).status_code == 202
    assert tool.runner.setting_up
    await tool.clock.run(tool.runner.shutdown())
    assert not tool.runner.setting_up


async def test_the_event_stream_paces_snapshots_fast_while_setting_up(tool):
    await tool.connect()
    assert (await tool.post("/api/setup", tool.body())).status_code == 202
    seen: list[str] = []

    async def gone():
        return len(seen) >= 3

    async def read():
        async for chunk in event_stream(tool.runner, gone, active_every=0.01,
                                        idle_every=30.0, keep_alive=60.0):
            seen.append(chunk)

    await asyncio.wait_for(read(), 5)
    assert all(c.startswith("event: snapshot") for c in seen)


# ── fix round 1 ────────────────────────────────────────────────────────


async def test_a_refused_password_then_create_again_uses_the_same_move(tool, fake):
    await tool.connect()
    tool.work()
    assert (await tool.post("/api/setup", tool.body(move_password="short"))).status_code == 202
    await tool.until_set_up()
    state = await tool.state()
    assert state["setup"]["state"] == "error"
    (move_id,) = fake.moves
    # the move is listed, and Planned
    assert [m for m in state["moves"] if m["id"] == move_id] == [
        {"id": move_id, "name": "Load test move KC", "status": "planned"}]
    assert fake.moves[move_id]["status"] == "planned"

    assert (await tool.post("/api/setup", tool.body(move_password="much-better-1"))
            ).status_code == 202
    await tool.until_set_up()
    state = await tool.state()
    assert (state["setup"]["state"], state["setup"]["move_id"]) == ("done", move_id)
    assert list(fake.moves) == [move_id]
    assert (fake.moves[move_id]["status"], fake.moves[move_id]["password"]) == (
        "in_progress", "much-better-1")
    assert [m["status"] for m in state["moves"] if m["id"] == move_id] == ["in_progress"]
    text = json.dumps(state)
    assert "much-better-1" not in text and '"short"' not in text and PASSWORD not in text


async def test_a_new_sign_in_forgets_the_move_to_carry_on(tool, fake):
    await tool.connect()
    tool.work()
    await tool.post("/api/setup", tool.body(move_password="short"))
    await tool.until_set_up()
    await tool.connect()
    await tool.post("/api/setup", tool.body(move_password="much-better-1"))
    await tool.until_set_up()
    assert (await tool.state())["setup"]["state"] == "done"
    assert len(fake.moves) == 2


async def test_two_set_ups_at_once_start_one(tool, fake):
    await tool.connect()
    first, second = await tool.clock.run(asyncio.gather(
        tool.client.post("/api/setup", headers=PAGE, json=tool.body()),
        tool.client.post("/api/setup", headers=PAGE, json=tool.body(name="Other"))))
    assert sorted([first.status_code, second.status_code]) == [202, 409]
    refused = first if first.status_code == 409 else second
    assert refused.json()["code"] in ("bad_phase", "setup_working")
    tool.work()
    await tool.until_set_up()
    assert len(fake.moves) == 1


async def test_a_client_anchored_account_is_told_plainly(tool, fake):
    fake.portal_users[EMAIL.lower()].is_global = False
    await tool.connect()
    await tool.post("/api/setup", tool.body())
    await tool.until_set_up()
    setup = (await tool.state())["setup"]
    assert (setup["state"], setup["step"]) == ("error", "draft")
    assert setup["message"] == (
        "The server did not start the move: the portal account is not allowed to do this. "
        "Creating a move needs an admin account that can add moves, containers and trucks. "
        "Nothing was created.")
    assert fake.import_jobs == {} and fake.moves == {}


async def test_the_stream_sends_a_snapshot_as_soon_as_a_set_up_ends():
    class Stub:
        phase = "connected"
        setting_up = True

        def __init__(self):
            self.n = 0
            self.queue = asyncio.Queue()

        def snapshot(self):
            self.n += 1
            return {"n": self.n, "setting_up": self.setting_up}

        def subscribe(self):
            return self.queue

        def unsubscribe(self, q):
            pass

        def recent(self):
            return []

    stub = Stub()
    seen: list[dict] = []

    async def gone():
        return len(seen) >= 2

    async def read():
        async for chunk in event_stream(stub, gone, active_every=0.05, idle_every=60.0,
                                        keep_alive=60.0):
            if chunk.startswith("event: snapshot"):
                seen.append(json.loads(chunk.split("data: ", 1)[1]))
                if len(seen) == 1:
                    stub.setting_up = False     # the set-up ends right after the first one

    await asyncio.wait_for(read(), 2)        # far less than idle_every
    assert seen[1]["setting_up"] is False
