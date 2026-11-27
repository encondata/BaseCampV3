import asyncio
import gc
import json
import re
import shutil
import types
from collections import Counter
from pathlib import Path

import httpx
import pytest
from conftest import FAKE_BASE_URL
from fakeserver import FakeBaseCamp

from loadtest.clock import FakeClock
from loadtest.journal import JOURNAL_NAME, load_state
from loadtest.runner import MESSAGES, Runner, RunnerError

EMAIL = "ops@example.com"
PASSWORD = "portal-pass-1"
MOVE_PASSWORD = "move-pass-1"
CODE = "123456"
SERVERS = 45
ORIGIN = (39.0997, -94.5786)
DESTINATION = (41.2565, -95.9345)


def osrm():
    coords = [[ORIGIN[1] + (DESTINATION[1] - ORIGIN[1]) * i / 10,
               ORIGIN[0] + (DESTINATION[0] - ORIGIN[0]) * i / 10] for i in range(11)]
    body = {"code": "Ok", "routes": [{"geometry": {"coordinates": coords}}]}
    return httpx.MockTransport(lambda request: httpx.Response(200, json=body))


class Recording(httpx.AsyncBaseTransport):
    """Passes calls to the fake and keeps every token, key and cookie value it issues."""

    def __init__(self, inner):
        self.inner = inner
        self.issued: set[str] = set()

    async def handle_async_request(self, request):
        response = await self.inner.handle_async_request(request)
        body = await response.aread()
        try:
            data = json.loads(body)
        except ValueError:
            data = None
        if isinstance(data, dict):
            for key in ("access_token", "key", "challenge_token"):
                if isinstance(data.get(key), str):
                    self.issued.add(data[key])
        for name, value in response.headers.raw:
            if name.lower() == b"set-cookie":
                self.issued.add(value.decode().split(";")[0].partition("=")[2])
        return httpx.Response(response.status_code, headers=response.headers.raw, content=body)


class World:
    def __init__(self, fake, clock, tmp_path):
        self.fake, self.clock = fake, clock
        self.tmp = tmp_path
        self.runs_dir = tmp_path / "runs"
        self.crashes = 0
        self.transport = Recording(fake.transport())
        self.move_id = fake.add_move(servers=SERVERS, containers=4, trucks=2,
                                     password=MOVE_PASSWORD)
        self.runners: list[Runner] = []
        self.tickers: list[asyncio.Task] = []

    def runner(self) -> Runner:
        r = Runner(runs_dir=self.runs_dir, clock=self.clock, router_url="https://router.test",
                   transport=self.transport, router_transport=osrm())
        self.runners.append(r)
        return r

    def process_scans(self, *, duplicate_on_replay=True):
        """Processes the fake's scans every virtual second while something is driven."""
        async def tick():
            while True:
                await self.clock.sleep(1)
                self.fake.process_scans(duplicate_on_replay=duplicate_on_replay)
        self.tickers.append(asyncio.create_task(tick()))

    async def ready(self, runner: Runner, *, totp=None) -> None:
        self.fake.add_portal_user(EMAIL, PASSWORD, totp=totp)
        got = await self.clock.run(runner.connect(FAKE_BASE_URL + "/", EMAIL, PASSWORD))
        assert got["status"] == "ok"
        report = await self.clock.run(runner.check(self.move_id, MOVE_PASSWORD, "fast"))
        assert report.can_start, report.checks
        assert runner.phase == "checked"

    def secrets(self) -> list[str]:
        return [PASSWORD, MOVE_PASSWORD, CODE, *self.transport.issued]


@pytest.fixture
async def world(fake, clock, tmp_path):
    w = World(fake, clock, tmp_path)
    yield w
    for r in w.runners:
        await r.shutdown()
    for ticker in w.tickers:
        ticker.cancel()
    await asyncio.gather(*w.tickers, return_exceptions=True)


def run_dirs(world) -> list[Path]:
    return sorted(p for p in world.runs_dir.iterdir() if p.is_dir())


def journal_entries(run_dir: Path) -> list[dict]:
    return [json.loads(line) for line in (run_dir / JOURNAL_NAME).read_text().splitlines()]


def assert_no_secrets(world, snapshot: dict, issued: int = 7) -> None:
    text = json.dumps(snapshot)
    secrets = world.secrets()
    assert len(secrets) > issued        # portal and kiosk tokens, station keys, cookies
    for secret in secrets:
        assert secret not in text
    for path in world.tmp.rglob("*"):
        if path.is_file():
            content = path.read_text(encoding="utf-8")
            for secret in secrets:
                assert secret not in content, path.name


async def hard_crash(world, runner: Runner) -> Path:
    """The process dies at this instant. The run folder as it is now goes to a fresh runs
    folder, and later runners use that one; the old runner is then shut down, which writes
    only to its own (abandoned) folder."""
    src = runner._driver.run.run_dir
    world.crashes += 1
    world.runs_dir = world.tmp / f"runs-after-crash-{world.crashes}"
    copy = world.runs_dir / src.name
    shutil.copytree(src, copy)
    await world.clock.run(runner.shutdown())
    return copy


# ── connect ────────────────────────────────────────────────────────────


async def test_connect_lists_moves_in_progress_first(world, fake, clock):
    fake.add_move(servers=1, containers=1, trucks=1, status="planned", password="other-1")
    fake.moves[world.move_id]["name"] = "Z move"
    fake.add_portal_user(EMAIL, PASSWORD)
    runner = world.runner()
    got = await clock.run(runner.connect(" " + FAKE_BASE_URL + "/ ", EMAIL, PASSWORD))
    assert got["status"] == "ok"
    assert [m["status"] for m in got["moves"]] == ["in_progress", "planned"]
    assert got["moves"][0] == {"id": world.move_id, "name": "Z move", "status": "in_progress"}
    assert runner.phase == "connected"
    assert runner.snapshot()["connected"] == {"server": FAKE_BASE_URL, "email": EMAIL}


async def test_connect_with_2fa_asks_for_the_code_then_connects(world, fake, clock):
    fake.add_portal_user(EMAIL, PASSWORD, totp="verify", code=CODE)
    runner = world.runner()
    assert await clock.run(runner.connect(FAKE_BASE_URL, EMAIL, PASSWORD)) == {
        "status": "totp_required"}
    assert runner.snapshot()["needs_totp"] is True
    assert runner.phase == "idle"
    with pytest.raises(RunnerError) as err:
        await clock.run(runner.connect(FAKE_BASE_URL, EMAIL, PASSWORD, "000000"))
    assert (err.value.code, err.value.message) == ("sign_in_failed",
                                                   "The 2FA code was not accepted.")
    got = await clock.run(runner.connect(FAKE_BASE_URL, EMAIL, PASSWORD, CODE))
    assert got["status"] == "ok" and got["moves"]
    assert runner.snapshot()["needs_totp"] is False
    assert runner._conn.used_totp is True


async def test_connect_for_an_account_without_2fa_set_up(world, fake, clock):
    fake.add_portal_user(EMAIL, PASSWORD, totp="enroll")
    with pytest.raises(RunnerError) as err:
        await clock.run(world.runner().connect(FAKE_BASE_URL, EMAIL, PASSWORD))
    assert err.value.code == "totp_enroll"
    assert "Finish that in the portal" in err.value.message


@pytest.mark.parametrize("server", ["api.example.com", "ftp://x.test", "https://", "",
                                    "https://u:p@x.test", "https://x.test/?a=1",
                                    "https://x.test/#top", "https://x.test:99999"])
async def test_connect_refuses_a_bad_address(world, clock, server):
    with pytest.raises(RunnerError) as err:
        await clock.run(world.runner().connect(server, EMAIL, PASSWORD))
    assert (err.value.code, err.value.message) == (
        "bad_server", "Enter the server's address, like https://api.example.com")


async def test_connect_failures_have_safe_messages(world, fake, clock):
    fake.add_portal_user(EMAIL, PASSWORD)
    runner = world.runner()
    with pytest.raises(RunnerError) as err:
        await clock.run(runner.connect(FAKE_BASE_URL, EMAIL, "wrong-pass"))
    assert err.value.message == "The email or password was not accepted."
    fake.down(True)
    with pytest.raises(RunnerError) as err:
        await clock.run(runner.connect(FAKE_BASE_URL, EMAIL, PASSWORD))
    assert err.value.message == MESSAGES["unreachable"]
    fake.down(False)
    fake.fail("POST", "/auth/login", status=307)
    with pytest.raises(RunnerError) as err:
        await clock.run(runner.connect(FAKE_BASE_URL, EMAIL, PASSWORD))
    assert err.value.message == MESSAGES["redirected"]
    assert runner.phase == "idle" and runner.snapshot()["connected"] is None


# ── check and start ────────────────────────────────────────────────────


async def test_start_needs_a_passing_check(world, fake, clock):
    fake.add_portal_user(EMAIL, PASSWORD)
    runner = world.runner()
    with pytest.raises(RunnerError) as err:
        await runner.start()
    assert err.value.code == "bad_phase"
    await clock.run(runner.connect(FAKE_BASE_URL, EMAIL, PASSWORD))
    with pytest.raises(RunnerError) as err:
        await runner.start()
    assert err.value.code == "not_ready"
    report = await clock.run(runner.check(world.move_id, "wrong-move-pass", "fast"))
    assert report.can_start is False and runner.phase == "connected"
    assert runner.snapshot()["check"]["can_start"] is False
    with pytest.raises(RunnerError) as err:
        await runner.start()
    assert err.value.code == "not_ready"
    with pytest.raises(RunnerError) as err:
        await clock.run(runner.check(world.move_id, MOVE_PASSWORD, "slow"))
    assert err.value.code == "bad_profile"
    assert not world.runs_dir.exists()


async def test_two_starts_at_once_make_one_run(world, clock):
    runner = world.runner()
    await world.ready(runner)
    got = await clock.run(asyncio.gather(runner.start(), runner.start(),
                                         return_exceptions=True))
    errors = [g for g in got if isinstance(g, RunnerError)]
    assert len(errors) == 1 and errors[0].code == "bad_phase"
    assert got.count(None) == 1
    assert len(run_dirs(world)) == 1
    await clock.run(runner.stop())
    assert runner.phase == "stopped"


async def test_a_whole_run_passes(world, fake, clock):
    runner = world.runner()
    queue = runner.subscribe()
    await world.ready(runner)
    await runner.start()
    assert runner.phase == "starting"
    assert runner.snapshot()["stages"][0] == {"key": "enroll", "label": "RFID enroll",
                                              "done": 0, "total": SERVERS}
    world.process_scans()
    with pytest.raises(TimeoutError):
        await clock.run(runner.wait(), limit=30)
    mid = runner.snapshot()
    assert mid["phase"] == "running"
    assert mid["move"] == {"name": fake.moves[world.move_id]["name"], "servers": SERVERS,
                           "containers": 3, "trucks": 1}
    assert 0 < mid["elapsed"] <= 31
    assert any(s["done"] for s in mid["stages"])
    assert_no_secrets(world, mid)

    await clock.run(runner.wait())
    snap = runner.snapshot()
    assert runner.phase == "done" and snap["error"] is None
    result = runner.result()
    assert result["verdict"] == "Pass", result["findings"]
    assert snap["verdict"] == "Pass"
    assert snap["overall"] == {"done": SERVERS, "total": SERVERS}
    assert snap["trucks"] == {"loaded": 1, "on_road": 0, "arrived": 1, "furthest": None}
    assert all(s["done"] == s["total"] for s in snap["stages"])
    assert snap["counters"].get("action_errors", 0) == 0
    [run_dir] = run_dirs(world)
    assert snap["run_dir"] == str(run_dir)
    for name in ("results.json", "events.log", JOURNAL_NAME):
        assert (run_dir / name).is_file()
    assert json.loads((run_dir / "results.json").read_text())["verdict"] == "Pass"
    assert journal_entries(run_dir)[-1]["reason"] == "completed"
    assert result["run"]["containers"] == 3 and result["run"]["trucks"] == 1
    # the 4th crate and 2nd truck were spares and were left alone
    crates = sorted(c["name"] for c in fake.containers.values()
                    if c["initiative_id"] == world.move_id)
    assert sorted(load_state(run_dir / JOURNAL_NAME).containers.values(),
                  key=lambda c: c.name)[-1].name == crates[2]
    assert_no_secrets(world, snap)
    lines = [(line.device, line.action) for line in runner.recent() if line.device == "Runner"]
    assert [a for _, a in lines] == [
        "Run started", "Devices ready", "Move finished; waiting for the server to catch up",
        "Server caught up", "Final check", "Result"]
    assert queue.qsize() > 0
    assert runner.unfinished() is None
    assert runner.snapshot()["connected"] is None      # the portal closes with the run
    assert runner._conn.password is None and runner._move_password is None


async def test_stop_mid_run(world, clock):
    runner = world.runner()
    await world.ready(runner)
    await runner.start()
    world.process_scans()
    with pytest.raises(TimeoutError):
        await clock.run(runner.wait(), limit=20)
    await clock.run(runner.stop())
    assert runner.phase == "stopped"
    assert runner.result()["verdict"] == "Fail"
    assert runner.result()["run"]["reason"] == "stopped"
    [run_dir] = run_dirs(world)
    last = journal_entries(run_dir)[-1]
    assert (last["t"], last["reason"]) == ("run_finished", "stopped")
    assert runner.unfinished() is None
    with pytest.raises(RunnerError) as err:
        await runner.stop()
    assert err.value.code == "bad_phase"
    assert all(t.done() for t in runner._driver.run.tasks.values())


async def test_stop_while_devices_start(world, clock):
    runner = world.runner()
    await world.ready(runner)
    await runner.start()
    await clock.run(runner.stop())
    assert runner.phase == "stopped"
    assert runner.result()["verdict"] == "Fail"
    [run_dir] = run_dirs(world)
    assert journal_entries(run_dir)[-1]["reason"] == "stopped"




CONTINUABLE = " The run can be continued."


async def until_phase(runner: Runner, clock, phase: str, step: float = 2) -> None:
    """Drives the run a little at a time until it reaches `phase`."""
    for _ in range(500):
        if runner.phase == phase:
            return
        with pytest.raises(TimeoutError):
            await clock.run(runner.wait(), limit=step)
    raise AssertionError(f"the run never reached {phase}; it is {runner.phase}")


def assert_interrupted(run_dir: Path) -> None:
    kinds = [e["t"] for e in journal_entries(run_dir)]
    assert kinds[-1] == "interrupted" and "run_finished" not in kinds


async def test_fleet_failure_leaves_the_run_continuable(world, fake, clock):
    runner = world.runner()
    await world.ready(runner)
    fake.fail("POST", "/kiosk/setup", status=422, times=100)
    await runner.start()
    await clock.run(runner.wait())
    assert runner.phase == "error"
    error = runner.snapshot()["error"]
    assert error.startswith("Load test – RFID enroll") and error.endswith("." + CONTINUABLE)
    [run_dir] = run_dirs(world)
    assert_interrupted(run_dir)
    result = runner.result()
    assert result["verdict"] == "Fail"
    assert result["run"]["reason"] == error.removesuffix(CONTINUABLE).rstrip(".")
    assert (run_dir / "results.json").is_file()
    assert runner.unfinished()["run_dir"] == str(run_dir)
    fake._failures.clear()
    await world.ready(runner)
    with pytest.raises(RunnerError) as err:     # the run must be continued or discarded
        await runner.start()
    assert (err.value.code, err.value.message) == (
        "unfinished_run", "A run was interrupted. Continue it, or choose Start new run first.")
    assert run_dirs(world) == [run_dir]


async def test_unexpected_problem_is_named_by_type_only(world, clock, monkeypatch):
    runner = world.runner()
    await world.ready(runner)

    async def boom(self):
        raise RuntimeError("secret detail " + PASSWORD)

    monkeypatch.setattr("loadtest.pipeline.Pipeline.run", boom)
    await runner.start()
    await clock.run(runner.wait())
    assert runner.phase == "error"
    assert runner.snapshot()["error"] == (
        "The run stopped because of an unexpected problem: RuntimeError." + CONTINUABLE)
    assert_interrupted(run_dirs(world)[0])
    assert_no_secrets(world, runner.snapshot())


async def test_a_fleet_start_problem_that_is_not_a_fleet_error(world, clock, monkeypatch):
    runner = world.runner()
    await world.ready(runner)

    async def boom(self, move_password):
        raise KeyError(move_password)

    monkeypatch.setattr("loadtest.fleet.Fleet.start", boom)
    await runner.start()
    await clock.run(runner.wait())
    assert runner.snapshot()["error"] == (
        "The run stopped because of an unexpected problem: KeyError." + CONTINUABLE)
    assert_interrupted(run_dirs(world)[0])
    assert_no_secrets(world, runner.snapshot(), issued=3)   # no device signed in


async def test_a_failing_final_check_can_be_continued(world, fake, clock, monkeypatch):
    runner = world.runner()
    await world.ready(runner)

    async def boom(**kwargs):
        raise RuntimeError("no")

    monkeypatch.setattr("loadtest.run_driver.final_check", boom)
    world.process_scans()
    await runner.start()
    await clock.run(runner.wait())
    assert runner.phase == "error"
    assert runner.snapshot()["error"] == (
        "The run stopped because of an unexpected problem: RuntimeError." + CONTINUABLE)
    [run_dir] = run_dirs(world)
    assert_interrupted(run_dir)
    assert runner.result()["verdict"] == "Fail"
    monkeypatch.undo()
    again = world.runner()
    assert await clock.run(again.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL)) == {
        "status": "ok"}
    await clock.run(again.wait())
    assert again.phase == "done" and again.result()["verdict"] == "Pass"
    assert journal_entries(run_dir)[-1]["reason"] == "completed"


async def test_a_failure_while_saving_the_result_never_leaves_the_runner_stuck(
        world, clock, monkeypatch):
    unseen = []
    asyncio.get_running_loop().set_exception_handler(lambda loop, ctx: unseen.append(ctx))
    runner = world.runner()
    await world.ready(runner)

    def boom(**kwargs):
        raise TypeError("detail " + PASSWORD)

    monkeypatch.setattr("loadtest.run_driver.build_results", boom)
    world.process_scans()
    await runner.start()
    await clock.run(runner.wait())
    assert runner.phase == "error"
    assert runner.snapshot()["error"] == (
        "The run stopped because of an unexpected problem: TypeError." + CONTINUABLE)
    [run_dir] = run_dirs(world)
    assert_interrupted(run_dir)
    assert runner._driver.run.journal._fh.closed
    assert runner.snapshot()["connected"] is None and runner._conn.password is None
    monkeypatch.undo()
    got = await clock.run(runner.connect(FAKE_BASE_URL, EMAIL, PASSWORD))
    assert got["status"] == "ok"
    gc.collect()
    assert unseen == []


async def test_stop_while_finishing_ends_only_the_wait(world, fake, clock):
    runner = world.runner()
    await world.ready(runner)
    await runner.start()
    await until_phase(runner, clock, "finishing")   # no scan is processed: the wait goes on
    fake.process_scans()
    await clock.run(runner.stop())
    assert runner.phase == "done"
    result = runner.result()
    assert result["verdict"] == "Pass with warnings"
    assert result["findings"] == [
        {"level": "warn", "text": "The wait for the server to catch up was ended early."}]
    assert result["run"]["reason"] == "completed"
    assert journal_entries(run_dirs(world)[0])[-1]["reason"] == "completed"
    assert "Catch-up wait ended early" in [line.action for line in runner.recent()]


async def test_shutdown_while_finishing_interrupts(world, clock):
    runner = world.runner()
    await world.ready(runner)
    await runner.start()
    await until_phase(runner, clock, "finishing")
    await clock.run(runner.shutdown())
    [run_dir] = run_dirs(world)
    assert_interrupted(run_dir)
    assert runner.unfinished()["run_dir"] == str(run_dir)
    assert runner.result() is None


async def test_an_outside_cancel_interrupts(world, clock):
    runner = world.runner()
    await world.ready(runner)
    await runner.start()
    with pytest.raises(TimeoutError):
        await clock.run(runner.wait(), limit=20)
    runner._driver.task.cancel()
    await clock.run(asyncio.wait({runner._driver.task}))
    assert runner.phase == "idle"
    [run_dir] = run_dirs(world)
    assert_interrupted(run_dir)
    assert all(t.done() for t in runner._driver.run.tasks.values())
    assert runner.unfinished()["run_dir"] == str(run_dir)


async def test_nothing_reachable_from_the_runner_holds_a_password(world, clock):
    runner = world.runner()
    await world.ready(runner)
    await runner.start()
    world.process_scans()
    await clock.run(runner.wait())
    assert runner.phase == "done"
    found = strings_reachable(runner)
    assert len(found) > 100
    assert PASSWORD not in found and MOVE_PASSWORD not in found


def strings_reachable(root, depth: int = 12) -> set[str]:
    """Every str reachable from `root` through instances, containers and bound methods;
    stops at classes, modules, functions, the event loop and HTTP transports (the fake
    server behind them holds the passwords by design)."""
    stop = (type, types.ModuleType, types.FunctionType, types.BuiltinFunctionType,
            types.CodeType, asyncio.AbstractEventLoop, httpx.AsyncBaseTransport)
    seen: set[int] = set()
    found: set[str] = set()
    frontier = [root]
    for _ in range(depth):
        nxt = []
        for obj in frontier:
            if id(obj) in seen or isinstance(obj, stop):
                continue
            seen.add(id(obj))
            if isinstance(obj, str):
                found.add(obj)
                continue
            nxt.extend(gc.get_referents(obj))
        frontier = nxt
    return found


async def test_sampler_that_dies_is_logged_once_and_started_again(world, clock, monkeypatch,
                                                                    capsys):
    from loadtest.sampler import Sampler
    real, calls = Sampler._tick, []

    async def flaky(self):
        calls.append(1)
        if len(calls) <= 2:
            raise RuntimeError("no")
        await real(self)

    monkeypatch.setattr(Sampler, "_tick", flaky)
    runner = world.runner()
    await world.ready(runner)
    world.process_scans()
    await runner.start()
    await clock.run(runner.wait())
    assert runner.phase == "done" and len(calls) > 3
    assert capsys.readouterr().err.count("the sampler stopped") == 1
    assert runner.result()["series"]["workers_running"]


async def test_a_failed_start_leaves_no_empty_run_folder(world, clock, monkeypatch):
    runner = world.runner()
    await world.ready(runner)

    def refuse(self, **kwargs):
        raise RunnerError("cannot_write")

    monkeypatch.setattr("loadtest.run_driver.RunDriver.open_run", refuse)
    with pytest.raises(RunnerError) as err:
        await runner.start()
    assert err.value.code == "cannot_write"
    assert run_dirs(world) == []
    assert runner.phase == "checked"


async def test_shutdown_during_a_connect_closes_the_sign_in_it_opens(world, fake, clock):
    fake.add_portal_user(EMAIL, PASSWORD)
    runner = world.runner()
    gate, sign_in = asyncio.Event(), runner._conn.sign_in

    async def held(*args):
        await gate.wait()
        return await sign_in(*args)

    runner._conn.sign_in = held
    connecting = asyncio.create_task(runner.connect(FAKE_BASE_URL, EMAIL, PASSWORD))
    await asyncio.sleep(0)
    assert runner._busy
    await runner.shutdown()
    gate.set()
    await clock.run(connecting)
    assert runner._conn.portal is None and runner.snapshot()["connected"] is None
    with pytest.raises(RunnerError) as err:
        await clock.run(runner.connect(FAKE_BASE_URL, EMAIL, PASSWORD))
    assert err.value.code == "bad_phase"


# ── crash, continue, discard ───────────────────────────────────────────


async def crashed_run(world, clock, limit: float = 40) -> Path:
    first = world.runner()
    await world.ready(first)
    await first.start()
    world.process_scans(duplicate_on_replay=False)
    with pytest.raises(TimeoutError):
        await clock.run(first.wait(), limit=limit)
    run_dir = await hard_crash(world, first)
    assert journal_entries(run_dir)[-1]["t"] not in ("run_finished", "interrupted")
    return run_dir


def scans_once_each(fake) -> None:
    fake.process_scans(duplicate_on_replay=False)
    per = Counter((p["asset_id"], p["status"]) for p in fake.processed_scans
                  if p["match_type"] == "asset")
    assert len(per) == SERVERS * 10
    assert set(per.values()) == {1}


async def test_continue_after_a_crash_finishes_the_move(world, fake, clock):
    run_dir = await crashed_run(world, clock)
    await clock.run(clock.sleep(120))           # the machine was down two minutes
    runner = world.runner()
    summary = runner.unfinished()
    assert summary["run_dir"] == str(run_dir) and summary["damaged"] is False
    assert summary["server"] == FAKE_BASE_URL and summary["speed"] == "fast"
    assert summary["servers"] == SERVERS and 0 <= summary["done"] < SERVERS
    assert summary["move_name"] == fake.moves[world.move_id]["name"]

    with pytest.raises(RunnerError) as err:
        await clock.run(runner.continue_run(PASSWORD, "wrong-move-pass", EMAIL))
    assert (err.value.code, err.value.message) == ("move_password",
                                                   "The move password was not accepted.")
    assert await clock.run(runner.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL)) == {
        "status": "ok"}
    assert runner.unfinished() is None
    await clock.run(runner.wait())
    assert runner.phase == "done", runner.snapshot()["error"]
    result = runner.result()
    assert result["verdict"] in ("Pass", "Pass with warnings"), result["findings"]
    assert len(result["run"]["interruptions"]) == 1
    assert result["run"]["interruptions"][0]["resumed_at"] is not None
    scans_once_each(fake)
    continued = [line for line in runner.recent() if line.action == "Run continued"]
    # down from the last journaled step (just before the crash) until now
    assert continued and re.fullmatch(r"after 2 min 0\d s down", continued[0].subject)
    kinds = [e["t"] for e in journal_entries(run_dir)]
    assert kinds.count("interrupted") == 1 and kinds.count("resumed") == 1
    assert kinds[-1] == "run_finished"
    assert_no_secrets(world, runner.snapshot())


class TickingClock(FakeClock):
    """Virtual time whose `now()` moves on a little with every reading, like a real one."""

    def __init__(self) -> None:
        super().__init__()
        self._reads = 0

    def now(self) -> float:
        self._reads += 1
        return super().now() + self._reads * 1e-6


async def test_downtime_is_measured_on_a_clock_that_moves(tmp_path):
    clock = TickingClock()
    fake = FakeBaseCamp(clock)
    world = World(fake, clock, tmp_path)
    try:
        await crashed_run(world, clock)
        await clock.run(clock.sleep(120))
        runner = world.runner()
        await clock.run(runner.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL))
        [line] = [line for line in runner.recent() if line.action == "Run continued"]
        assert re.fullmatch(r"after 2 min 0\d s down", line.subject), line.subject
        await clock.run(runner.stop())
    finally:
        for r in world.runners:
            await r.shutdown()
        for ticker in world.tickers:
            ticker.cancel()
        await asyncio.gather(*world.tickers, return_exceptions=True)


async def test_two_interruptions_in_a_row(world, fake, clock):
    await crashed_run(world, clock, limit=30)
    second = world.runner()
    await clock.run(second.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL))
    with pytest.raises(TimeoutError):
        await clock.run(second.wait(), limit=30)
    run_dir = await hard_crash(world, second)
    third = world.runner()
    await clock.run(third.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL))
    await clock.run(third.wait())
    assert third.phase == "done", third.snapshot()["error"]
    assert len(third.result()["run"]["interruptions"]) == 2
    kinds = [e["t"] for e in journal_entries(run_dir)]
    assert kinds.count("interrupted") == 2 and kinds.count("resumed") == 2
    scans_once_each(fake)


async def test_a_crash_after_the_result_and_before_run_finished(world, fake, clock):
    runner = world.runner()
    await world.ready(runner)
    await runner.start()
    world.process_scans(duplicate_on_replay=False)
    await clock.run(runner.wait())
    src = runner._driver.run.run_dir
    world.runs_dir = world.tmp / "runs-copy"
    run_dir = world.runs_dir / src.name
    shutil.copytree(src, run_dir)
    lines = (run_dir / JOURNAL_NAME).read_text().splitlines()
    assert json.loads(lines[-1])["t"] == "run_finished"
    (run_dir / JOURNAL_NAME).write_text("\n".join(lines[:-1]) + "\n")
    again = world.runner()
    assert again.unfinished()["done"] == SERVERS
    await clock.run(again.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL))
    await clock.run(again.wait())
    assert again.phase == "done" and again.result()["verdict"] == "Pass"
    assert len(again.result()["run"]["interruptions"]) == 1
    scans_once_each(fake)


async def test_continue_with_a_password_for_another_move_changes_nothing(world, fake, clock):
    fake.add_move(servers=1, containers=1, trucks=1, password="other-move-pass")
    run_dir = await crashed_run(world, clock)
    before = (run_dir / JOURNAL_NAME).read_bytes()
    runner = world.runner()
    with pytest.raises(RunnerError) as err:
        await clock.run(runner.continue_run(PASSWORD, "other-move-pass", EMAIL))
    assert err.value.code == "move_password"
    assert err.value.message == ("That password signs in to a different move. Enter the "
                                 f"password for {fake.moves[world.move_id]['name']}.")
    assert (run_dir / JOURNAL_NAME).read_bytes() == before
    assert runner.unfinished()["run_dir"] == str(run_dir)
    assert runner.phase == "idle" and runner.snapshot()["connected"] is None


async def test_continue_with_2fa_asks_for_the_code(world, fake, clock):
    await crashed_run(world, clock)
    fake.portal_users[EMAIL].totp = "verify"
    runner = world.runner()      # a new process: no remembered browser
    assert await clock.run(runner.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL)) == {
        "status": "totp_required"}
    assert runner.phase == "idle"
    assert await clock.run(runner.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL, CODE)) == {
        "status": "ok"}
    await clock.run(runner.stop())
    assert runner.phase == "stopped"


async def test_discard_unfinished(world, clock):
    await crashed_run(world, clock)
    runner = world.runner()
    assert runner.unfinished() is not None
    await runner.discard_unfinished()
    assert runner.unfinished() is None
    with pytest.raises(RunnerError) as err:
        await runner.discard_unfinished()
    assert err.value.code == "no_unfinished_run"
    with pytest.raises(RunnerError) as err:
        await clock.run(runner.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL))
    assert err.value.code == "no_unfinished_run"


async def test_shutdown_interrupts_without_finishing(world, clock):
    runner = world.runner()
    await world.ready(runner)
    await runner.start()
    world.process_scans()
    with pytest.raises(TimeoutError):
        await clock.run(runner.wait(), limit=20)
    await clock.run(runner.shutdown())
    [run_dir] = run_dirs(world)
    assert_interrupted(run_dir)
    assert runner.unfinished()["run_dir"] == str(run_dir)
    assert runner.result() is None
    await runner.shutdown()     # idle: nothing to do


async def test_a_damaged_journal_can_be_discarded(world, clock, capsys):
    folder = world.runs_dir / "2027-01-01_00-00-00Z"
    folder.mkdir(parents=True)
    (folder / JOURNAL_NAME).write_text('{"t":"run_started","at":1}\n{"t":"stage_done"}\n')
    runner = world.runner()
    summary = runner.unfinished()
    assert summary["run_dir"] == str(folder) and summary["damaged"] is True
    assert runner.unfinished() == summary
    assert capsys.readouterr().err.count("could not read the unfinished run") == 1
    with pytest.raises(RunnerError) as err:
        await clock.run(runner.continue_run(PASSWORD, MOVE_PASSWORD, EMAIL))
    assert (err.value.code, err.value.message) == (
        "damaged_run", "This run's record cannot be read, so it cannot be continued. "
                       "Choose Start new run.")
    await world.ready(runner)
    with pytest.raises(RunnerError) as err:
        await runner.start()
    assert err.value.code == "unfinished_run"
    await runner.discard_unfinished()
    assert runner.unfinished() is None
    await runner.start()
    await clock.run(runner.stop())


async def test_the_unfinished_summary_is_read_once_until_the_folder_changes(
        world, clock, monkeypatch):
    await crashed_run(world, clock)
    import loadtest.unfinished as unfinished
    real, calls = unfinished.find_unfinished, []
    monkeypatch.setattr(unfinished, "find_unfinished",
                        lambda d: calls.append(1) or real(d))
    runner = world.runner()
    first = runner.unfinished()
    for _ in range(5):
        assert runner.snapshot()["unfinished"] == first
    assert len(calls) == 1
    (world.runs_dir / "2000-01-01_00-00-00Z").mkdir()
    assert runner.unfinished() == first
    assert len(calls) == 2


async def test_feed_subscription_survives_runs(world, clock):
    runner = world.runner()
    queue = runner.subscribe()
    await world.ready(runner)
    await runner.start()
    await clock.run(runner.stop())
    first = queue.qsize()
    assert first > 0
    await world.ready(runner)
    await runner.start()
    await clock.run(runner.stop())
    assert queue.qsize() > first
    assert len(run_dirs(world)) == 2
    runner.unsubscribe(queue)
