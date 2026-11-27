import asyncio
import json
import random
import re
from collections import Counter

import httpx
import pytest
from conftest import FAKE_BASE_URL
from pipeline_helpers import fast, real_time
from run_helpers import state_for_move

from loadtest.actions import NO_KEY, NOT_UNDERSTOOD, Actions, truck_label
from loadtest.client.portal import PortalClient
from loadtest.events import Events, FeedLine
from loadtest.fleet import STOPPED, Fleet, FleetError
from loadtest.ids import scan_id
from loadtest.pipeline import Pipeline, Step

MOVE_PASSWORD = "move-pass-1"
EMAIL = "ops@example.com"
PORTAL_PASSWORD = "portal-pass-1"
SERVER_CHECKPOINTS = ("pre_stage", "rfid_1_cage_exit", "labeled", "rfid_2_loading_dock",
                      "in_container", "un_pack", "rfid_3_staging", "rfid_4_into_cage", "qa",
                      "complete")
BACKGROUND = ("heartbeat", "station-heartbeat")


class Recording(httpx.AsyncBaseTransport):
    """Wraps the fake's transport and keeps (path, JSON body) of every request, and in
    `answers` (path, JSON body, status or None when the fake was down)."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self.inner = inner
        self.sent: list[tuple[str, dict]] = []
        self.answers: list[tuple[str, dict, int | None]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        try:
            parsed = json.loads(body) if body else {}
        except ValueError:
            parsed = {}
        self.sent.append((request.url.path, parsed))
        try:
            response = await self.inner.handle_async_request(request)
        except httpx.TransportError:
            self.answers.append((request.url.path, parsed, None))
            raise
        self.answers.append((request.url.path, parsed, response.status_code))
        return response

    async def aclose(self) -> None:
        await self.inner.aclose()


@pytest.fixture
async def run(fake, clock, metrics):
    """Factory: run(profile, servers, containers, trucks) -> a started move run on the fake.
    Everything is stopped and closed after the test."""
    made: list = []

    async def make(profile=None, *, servers=45, containers=3, trucks=1, log_path=None,
                   recording=False):
        profile = profile or fast()
        move_id = fake.add_move(servers=servers, containers=containers, trucks=trucks,
                                password=MOVE_PASSWORD)
        fake.add_portal_user(EMAIL, PORTAL_PASSWORD)
        transport = Recording(fake.transport()) if recording else fake.transport()
        portal = PortalClient(base_url=FAKE_BASE_URL, metrics=metrics, clock=clock,
                              retry=profile.retry, timeout=10.0, transport=fake.transport())
        made.append(portal)
        assert await clock.run(portal.login(EMAIL, PORTAL_PASSWORD)) == "ok"
        move = await clock.run(portal.move(move_id))
        events = Events(log_path)
        fleet = Fleet(profile=profile, base_url=FAKE_BASE_URL, move=move, metrics=metrics,
                      clock=clock, events=events, transport=transport)
        made.append(fleet)
        made.append(events)
        await clock.run(fleet.start(MOVE_PASSWORD))
        state = state_for_move(fake, move_id, profile, clock)
        actions = Actions(profile=profile, state=state, fleet=fleet, portal=portal,
                          events=events, metrics=metrics, clock=clock)
        return type("Run", (), dict(profile=profile, move_id=move_id, portal=portal,
                                    events=events, fleet=fleet, state=state, actions=actions,
                                    transport=transport))

    yield make
    for thing in made:
        if isinstance(thing, Fleet):
            await thing.stop()
        elif isinstance(thing, Events):
            thing.close()
        else:
            await thing.close()


def pipeline_for(r, clock, perform=None) -> Pipeline:
    return Pipeline(r.profile, r.state, perform or r.actions.perform, clock, random.Random(0))


def work_lines(events: Events) -> list[FeedLine]:
    return [line for line in events.recent() if line.action != "ready"]


# ── fleet ─────────────────────────────────────────────────────────────


async def test_fleet_brings_up_32_named_devices(fake, run):
    r = await run()
    assert len(r.fleet.devices) == 32
    assert len(fake.devices) == 32
    assert all(serial.startswith("LOADTEST-") for serial in fake.devices)
    assert all(row["name"].startswith("Load test") for row in fake.devices.values())
    stations = [row for row in fake.devices.values() if row["station_type"] is not None]
    assert len(stations) == 7                       # 4 RFID Stations + 3 Label Stations
    assert all(row["mode"] == "laptop" and row["station_key_hash"] for row in stations)
    ready = [line for line in r.events.recent() if line.action == "ready"]
    assert len(ready) == 32
    assert {line.device for line in ready} == {d.name for d in r.fleet.devices}
    assert all(line.ok and line.ms is None and line.subject == "signed in, set up, move downloaded"
               for line in ready)
    label = r.fleet.device_for("label", 4)
    assert (label.serial, label.name) == ("LOADTEST-LABEL-2", "Load test – Label station 2")
    dest = r.fleet.device_for("qa", 0)
    assert fake.devices[dest.serial]["site_id"] == fake.moves[r.move_id]["destination_site_id"]
    assert fake.devices[dest.serial]["scan_status"] == "qa"


async def test_refused_move_password_is_a_safe_fleet_error(fake, clock, metrics):
    profile = fast()
    move_id = fake.add_move(servers=5, containers=1, trucks=1, password=MOVE_PASSWORD)
    fake.add_portal_user(EMAIL, PORTAL_PASSWORD)
    portal = PortalClient(base_url=FAKE_BASE_URL, metrics=metrics, clock=clock,
                          retry=profile.retry, timeout=10.0, transport=fake.transport())
    await clock.run(portal.login(EMAIL, PORTAL_PASSWORD))
    move = await clock.run(portal.move(move_id))
    await portal.close()
    fleet = Fleet(profile=profile, base_url=FAKE_BASE_URL, move=move, metrics=metrics,
                  clock=clock, events=Events(None), transport=fake.transport())
    wrong = "not-the-password"
    with pytest.raises(FleetError) as caught:
        await clock.run(fleet.start(wrong))
    message = str(caught.value)
    # the readiness check's own wording, never the server's internal code
    assert message == f"{fleet.devices[0].name} could not sign in. The move password was not accepted."
    assert wrong not in message and MOVE_PASSWORD not in message
    assert all(d._client.is_closed for d in fleet.devices)
    await fleet.stop()                               # safe after a failed start


async def test_heartbeats_tick_every_minute(clock, run):
    r = await run(real_time(), servers=5, containers=1, trucks=1, recording=True)
    r.transport.sent.clear()
    await clock.run(clock.sleep(600))
    beats = Counter(body.get("serial") for path, body in r.transport.sent
                    if path in ("/kiosk/heartbeat", "/kiosk/station/heartbeat"))
    for d in r.fleet.devices:
        if d.kind == "label_station":
            assert beats[d.serial] == 0, d.serial
        else:
            assert beats[d.serial] >= 9, d.serial
    assert {path for path, _ in r.transport.sent} <= {"/kiosk/heartbeat",
                                                      "/kiosk/station/heartbeat"}
    await r.fleet.stop()
    await r.fleet.stop()                             # twice is fine


# ── actions ───────────────────────────────────────────────────────────


async def test_whole_move_lands_on_the_fake(fake, clock, run):
    r = await run()
    await clock.run(pipeline_for(r, clock).run())
    fake.process_scans()
    for sid, server in r.state.servers.items():
        assert fake.assets[sid]["rfid_tag"] == server.tag
        statuses = Counter(p["status"] for p in fake.processed_scans if p["asset_id"] == sid)
        assert statuses == Counter(SERVER_CHECKPOINTS), server.serial
    for cid in r.state.containers:
        assert cid not in fake.container_of.values()
        assert cid not in fake.truck_of
        statuses = Counter(p["status"] for p in fake.processed_scans
                           if p["container_id"] == cid)
        assert statuses == Counter({"on_truck": 1, "received": 1})
    for tid in r.state.trucks:
        assert fake.trucks[tid]["status"] == "at_destination"
        assert sum(u["truck_id"] == tid for u in fake.truck_updates) == 68
    assert all(line.ok for line in r.events.recent())


async def test_scan_ids_are_stable_across_a_restart(fake, clock, run, metrics):
    r = await run(recording=True)
    again = Actions(profile=r.profile, state=r.state, fleet=r.fleet, portal=r.portal,
                    events=r.events, metrics=metrics, clock=clock)
    sid = sorted(r.state.servers)[0]
    cart = tuple(sorted(r.state.servers)[:10])
    cid = next(iter(r.state.containers))
    tid = next(iter(r.state.trucks))
    steps = [Step("each", "qa", 0, (sid,)), Step("cart", "cage_exit", 3, cart),
             Step("load", "truck_load", 0, container_id=cid, truck_id=tid)]

    def ids_sent() -> list[str]:
        out = []
        for _, body in r.transport.sent:
            out += [s["client_scan_id"] for s in body.get("scans", [])]
            if "client_scan_id" in body:
                out.append(body["client_scan_id"])
        return out

    firsts, seconds = [], []
    for step in steps:
        r.transport.sent.clear()
        assert await clock.run(r.actions.perform(step))
        firsts.append(ids_sent())
        r.transport.sent.clear()
        assert await clock.run(again.perform(step))
        seconds.append(ids_sent())
    assert firsts == seconds
    assert firsts[0] == [str(scan_id(r.state.run_id, "qa", sid))]
    assert firsts[1] == [str(scan_id(r.state.run_id, "cage_exit", s)) for s in cart]
    assert firsts[2] == [str(scan_id(r.state.run_id, "truck_load", cid))]


async def test_feed_lines_carry_no_secrets_and_read_well(fake, clock, run, tmp_path):
    log = tmp_path / "events.log"
    r = await run(log_path=log)
    steps: list[Step] = []

    async def counted(step: Step) -> bool:
        steps.append(step)
        return await r.actions.perform(step)

    await clock.run(pipeline_for(r, clock, counted).run())
    lines = work_lines(r.events)
    assert len(lines) == len(steps)

    secrets = {MOVE_PASSWORD, PORTAL_PASSWORD, *fake._access, *fake._refresh}
    secrets |= {d._key for d in r.fleet.devices if d._key}
    secrets |= {d._token for d in r.fleet.devices if d._token}
    text = log.read_text(encoding="utf-8")
    for secret in secrets:
        assert secret not in text
        for line in r.events.recent():
            assert all(secret not in str(v) for v in vars(line).values())

    label = next(line for line in lines if line.device == "Load test – Label station 2")
    assert label.action == "Label station" and label.subject.startswith("SN ")
    assert label.ok and label.ms is not None
    cart = next(line for line in lines if line.action == "RFID 1 – Cage Exit")
    assert cart.subject == "10 tags" and cart.device == "Load test – RFID 1 – Cage Exit"
    location = next(line for line in lines if line.action == "location")
    truck = next(iter(r.state.trucks.values()))
    assert location.device == truck.name == truck_label(truck.name)  # fake names say "Truck"
    lat, lng = r.state.route[0]
    assert location.subject == f"{lat:.4f}, {lng:.4f} (1 of 68)"
    assert {"departed", "arrived"} <= {line.action for line in lines}
    load = next(line for line in lines if line.action == "Load truck")
    assert load.subject in {c.name for c in r.state.containers.values()}
    log_lines = text.splitlines()
    assert len(log_lines) == len(r.events.recent())
    assert any("Load test – Label station 2    Label station    SN " in x and " ok  " in x
               and x.endswith(" ms") for x in log_lines)


async def test_partial_cart_is_not_landed_and_says_how_many(fake, clock, run):
    r = await run()
    cart = tuple(sorted(r.state.servers)[:10])
    fake.moves[r.move_id]["status"] = "completed"   # station route rejects move_inactive
    assert not await clock.run(r.actions.perform(Step("cart", "cage_exit", 0, cart)))
    line = r.events.recent()[-1]
    assert not line.ok and line.note == "0 of 10 accepted"


async def test_server_outage_does_not_kill_the_run(fake, clock, run, metrics):
    r = await run(recording=True)
    back = []

    async def outage():
        await clock.sleep(20)
        fake.down(True)
        await clock.sleep(120)
        fake.down(False)
        back.append(len(r.transport.answers))

    await clock.run(asyncio.gather(pipeline_for(r, clock).run(), outage()))
    calls = metrics.calls()
    assert calls["heartbeat"]["failures"] > 0
    assert calls["station-heartbeat"]["failures"] > 0
    assert metrics.failed_calls() == sum(c["failures"] for name, c in calls.items()
                                         if name not in BACKGROUND)
    assert metrics.failed_calls() > 0               # steps tried while down failed
    assert any(not line.ok for line in r.events.recent())
    assert all("complete" in s.done for s in r.state.servers.values())
    assert r.state.servers[sorted(r.state.servers)[-1]].done["complete"] is True
    # heartbeats resumed once the fake came back: every beating device got a 200
    beat_ok = {body["serial"] for path, body, status in r.transport.answers[back[0]:]
               if path in ("/kiosk/heartbeat", "/kiosk/station/heartbeat") and status == 200}
    assert beat_ok == {d.serial for d in r.fleet.devices if d.kind != "label_station"}


# ── events ────────────────────────────────────────────────────────────


def _line(i: int, ok: bool = True) -> FeedLine:
    return FeedLine(at=1_800_000_000.0 + i, device="Load test – QA 1", action="QA",
                    subject=f"SN {i:05d}", ok=ok, ms=12.4 if ok else None,
                    note="" if ok else "no answer")


async def test_events_ring_keeps_500_and_log_keeps_all(tmp_path):
    log = tmp_path / "events.log"
    events = Events(log)
    q = events.subscribe()
    for i in range(1, 1201):
        events.feed(_line(i, ok=i % 100 != 0))
    recent = events.recent()
    assert len(recent) == 500 and recent[0].subject == "SN 00701"
    assert recent[-1] == _line(1200, False)
    assert q.qsize() == 1000 and q.get_nowait().subject == "SN 00201"   # oldest dropped
    events.unsubscribe(q)
    events.feed(_line(1201))
    assert q.qsize() == 999
    lines = log.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1201
    assert lines[0].endswith("  Load test – QA 1    QA    SN 00001    ok  12 ms")
    # a two-day run's log needs the date: YYYY-MM-DD HH:MM:SS
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", lines[0][:19])
    assert lines[99].endswith("SN 00100    failed  no answer")
    events.close()

    only_ring = Events(None)
    only_ring.feed(_line(1))
    assert only_ring.recent() == [_line(1)]
    only_ring.close()


async def test_failed_log_write_keeps_the_feed_going(tmp_path, monkeypatch):
    events = Events(tmp_path / "events.log")
    q = events.subscribe()

    class Broken:
        closed = False
        tries = 0

        def write(self, text):
            Broken.tries += 1
            raise OSError(28, "No space left on device")

        def flush(self):
            pass

        def close(self):
            pass

    real = events._log
    events._log = Broken()
    now = [1000.0]
    monkeypatch.setattr("loadtest.events.time.monotonic", lambda: now[0])
    for i in range(1, 4):
        events.feed(_line(i))                         # never raises
    # not retried on every line; every line not written is counted
    assert events.write_errors == 3 and Broken.tries == 1
    assert len(events.recent()) == 3 and q.qsize() == 3
    now[0] += 5.1
    events.feed(_line(4))
    assert events.write_errors == 4 and Broken.tries == 2
    events._log = real
    now[0] += 5.1
    events.feed(_line(5))
    assert (tmp_path / "events.log").read_text(encoding="utf-8").count("\n") == 1
    events.close()


# ── fix round 1: fleet start and stop ─────────────────────────────────


async def _fleet(fake, clock, metrics, profile=None, transport=None):
    profile = profile or fast()
    move_id = fake.add_move(servers=5, containers=1, trucks=1, password=MOVE_PASSWORD)
    fake.add_portal_user(EMAIL, PORTAL_PASSWORD)
    portal = PortalClient(base_url=FAKE_BASE_URL, metrics=metrics, clock=clock,
                          retry=profile.retry, timeout=10.0, transport=fake.transport())
    await clock.run(portal.login(EMAIL, PORTAL_PASSWORD))
    move = await clock.run(portal.move(move_id))
    await portal.close()
    return Fleet(profile=profile, base_url=FAKE_BASE_URL, move=move, metrics=metrics,
                 clock=clock, events=Events(None), transport=transport or fake.transport())


def _slow_sign_ins(fleet, clock, seconds=30):
    for d in fleet.devices:
        def slow(pw, _orig=d.sign_in):
            async def go():
                await clock.sleep(seconds)
                await _orig(pw)
            return go()
        d.sign_in = slow


def _fleet_tasks() -> list[asyncio.Task]:
    return [t for t in asyncio.all_tasks()
            if not t.done() and "Fleet." in getattr(t.get_coro(), "__qualname__", "")]


async def test_stop_during_start_ends_start_and_leaves_nothing(fake, clock, metrics):
    fleet = await _fleet(fake, clock, metrics)
    _slow_sign_ins(fleet, clock)

    async def scenario():
        starting = asyncio.create_task(fleet.start(MOVE_PASSWORD))
        await clock.sleep(40)            # first device up, the next 8 mid sign-in
        await fleet.stop()
        assert starting.done()
        with pytest.raises(FleetError, match=STOPPED):
            starting.result()
        assert _fleet_tasks() == [] and fleet._beats == []

    await clock.run(scenario())
    assert all(d._client.is_closed for d in fleet.devices)
    assert len(fake.devices) == 1
    await fleet.stop()


async def test_cancel_during_start_closes_every_device(fake, clock, metrics):
    fleet = await _fleet(fake, clock, metrics)
    _slow_sign_ins(fleet, clock)

    async def scenario():
        starting = asyncio.create_task(fleet.start(MOVE_PASSWORD))
        await clock.sleep(40)
        starting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await starting
        assert _fleet_tasks() == [] and fleet._beats == []

    await clock.run(scenario())
    assert all(d._client.is_closed for d in fleet.devices)
    await fleet.stop()


async def test_first_device_alone_then_eight_at_a_time(fake, clock, metrics):
    fleet = await _fleet(fake, clock, metrics)
    log: list[tuple[str, str]] = []
    active = [0, 0]                       # now, most at once

    for d in fleet.devices:
        def track(name, orig, serial=d.serial):
            def call(*a, **k):
                async def go():
                    if name == "sign_in":
                        active[0] += 1
                        active[1] = max(active)
                    log.append((serial, f"{name} start"))
                    await clock.sleep(1)
                    result = await orig(*a, **k)
                    log.append((serial, f"{name} end"))
                    if name == "sync":
                        active[0] -= 1
                    return result
                return go()
            return call
        for name in ("sign_in", "setup", "sync"):
            setattr(d, name, track(name, getattr(d, name)))

    await clock.run(fleet.start(MOVE_PASSWORD))
    first = fleet.devices[0].serial
    first_done = log.index((first, "sync end"))
    assert [e for _, e in log[:first_done + 1]] == ["sign_in start", "sign_in end",
                                                    "setup start", "setup end",
                                                    "sync start", "sync end"]
    assert all(serial == first for serial, _ in log[:first_done + 1])
    assert active[1] == 8
    assert len(_fleet_tasks()) == 32                 # the check sees the heartbeat tasks
    await fleet.stop()
    assert _fleet_tasks() == []


async def test_malformed_sign_in_answer_is_a_safe_fleet_error(fake, clock, metrics):
    fleet = await _fleet(fake, clock, metrics)

    async def broken(pw):
        raise KeyError("access_token")

    fleet.devices[0].sign_in = broken
    with pytest.raises(FleetError) as caught:
        await clock.run(fleet.start(MOVE_PASSWORD))
    assert str(caught.value) == (f"{fleet.devices[0].name} could not sign in. The kiosk "
                                 "sign-in failed: the server sent an answer this tool does "
                                 "not understand. Check the server address.")
    assert all(d._client.is_closed for d in fleet.devices)


async def test_a_heartbeat_that_raises_does_not_end_the_beats(clock, run, metrics):
    r = await run(real_time(), servers=5, containers=1, trucks=1)
    d = r.fleet.device_for("qa", 0)
    calls = []
    orig = d.heartbeat

    async def flaky():
        calls.append(clock.now())
        if len(calls) == 1:
            raise ValueError("not JSON")
        await orig()

    d.heartbeat = flaky
    await clock.run(clock.sleep(300))
    assert metrics.counters()["heartbeat_errors"] == 1
    assert len(calls) >= 4


async def test_heartbeats_keep_to_their_due_times(clock, run):
    r = await run(real_time(), servers=5, containers=1, trucks=1)
    d = r.fleet.device_for("enroll", 0)
    times = []
    orig = d.heartbeat

    async def overrun():
        times.append(clock.now())
        if len(times) == 2:
            await clock.sleep(150)       # this beat overruns two and a half intervals
        else:
            await clock.sleep(7)         # a slow beat does not push the next one back
        await orig()

    d.heartbeat = overrun
    await clock.run(clock.sleep(600))
    phase = [round((t - times[0]) % 60, 6) % 60 for t in times]
    assert all(p == 0 for p in phase), times
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert gaps[0] == 60 and gaps[1] == 180 and all(g == 60 for g in gaps[2:]), gaps


# ── fix round 1: feed notes and names ─────────────────────────────────


async def test_genuinely_partial_cart_says_7_of_10(fake, clock, run):
    r = await run()
    cart = tuple(sorted(r.state.servers)[:10])
    refused = {str(scan_id(r.state.run_id, "cage_exit", sid)) for sid in cart[:3]}
    store = fake._store_scan_batch

    def rejecting(device, scans, **kw):
        out = store(device, [s for s in scans if str(s.client_scan_id) not in refused], **kw)
        out["rejected"] += [{"client_scan_id": i, "code": "bad_status"} for i in refused]
        return out

    fake._store_scan_batch = rejecting
    assert not await clock.run(r.actions.perform(Step("cart", "cage_exit", 0, cart)))
    line = r.events.recent()[-1]
    assert not line.ok and line.note == "7 of 10 accepted" and line.subject == "10 tags"


async def test_keyless_station_says_not_sent(clock, run, metrics):
    r = await run()
    sid = sorted(r.state.servers)[0]
    for stage, step in (("label", Step("each", "label", 0, (sid,))),
                        ("cage_exit", Step("cart", "cage_exit", 0, (sid,)))):
        r.fleet.device_for(stage, 0)._key = None
        assert not await clock.run(r.actions.perform(step))
        line = r.events.recent()[-1]
        assert line.note == NO_KEY == "not sent: this station has no key"
    assert metrics.counters()["scans_not_sent"] == 2


async def test_unexpected_error_line_names_the_device(clock, run, metrics):
    r = await run()
    assert not await clock.run(r.actions.perform(Step("each", "qa", 1, ("no-such-server",))))
    line = r.events.recent()[-1]
    assert (line.device, line.action) == ("Load test – QA 2", "QA")
    assert line.note == NOT_UNDERSTOOD and not line.ok
    assert metrics.counters()["action_errors"] == 1


async def test_truck_names_get_truck_in_front_only_when_missing(clock, run):
    assert truck_label("08") == "Truck 08"
    assert truck_label("Truck 08") == "Truck 08" and truck_label("TRUCK-8") == "TRUCK-8"
    r = await run()
    truck = next(iter(r.state.trucks.values()))
    truck.name = "08"
    assert await clock.run(r.actions.perform(Step("depart", "trip", 0, truck_id=truck.id)))
    assert r.events.recent()[-1].device == "Truck 08"


def _destination_state(profile, s1_packed=True, load_ok=True):
    from pipeline_helpers import make_state
    state = make_state(2, 1, 1, profile)
    s1, s2 = list(state.servers)
    for sid, ok in ((s1, s1_packed), (s2, False)):
        state.apply({"t": "packed", "stage": "pack", "server": sid, "container": "c001",
                     "ok": ok, "at": 1.0})
    state.apply({"t": "loaded", "container": "c001", "truck": "t01", "ok": load_ok, "at": 3.0})
    return state, s1, s2


def _actions(profile, state):
    return Actions(profile=profile, state=state, fleet=None, portal=None, events=None,
                   metrics=None, clock=None)


def _continued(state, at=4.0):
    state.apply({"t": "interrupted", "at": at})
    state.apply({"t": "resumed", "at": at + 1})


UNLOAD = Step("unload", "truck_unload", 0, container_id="c001", truck_id="t01")


def test_already_done_never_counts_on_the_first_try_of_a_run_never_continued():
    profile = fast()
    state, s1, _ = _destination_state(profile)
    state.apply({"t": "arrived", "truck": "t01", "ok": True, "at": 3.5})
    actions = _actions(profile, state)
    assert not actions._resending(UNLOAD)


def test_an_unload_resend_needs_a_crews_first_step_after_an_arrival_journaled_before():
    profile = fast()
    state, _, _ = _destination_state(profile)
    _continued(state)                             # the truck had not arrived when it stopped
    actions = _actions(profile, state)            # built as that run segment starts
    state.apply({"t": "arrived", "truck": "t01", "ok": True, "at": 6.0})
    assert not actions._resending(UNLOAD)
    _continued(state, at=7.0)                     # stopped again, now after the arrival
    actions = _actions(profile, state)
    assert actions._resending(UNLOAD)             # crew 0's first unload after the Continue
    assert not actions._resending(UNLOAD)         # its next one: never
    failed_load, _, _ = _destination_state(profile, load_ok=False)
    failed_load.apply({"t": "arrived", "truck": "t01", "ok": True, "at": 3.5})
    _continued(failed_load)
    assert not _actions(profile, failed_load)._resending(UNLOAD)    # its load never landed


def test_an_unpack_resend_needs_a_crews_first_step_and_a_landed_pack():
    profile = fast()
    state, s1, s2 = _destination_state(profile)
    state.apply({"t": "arrived", "truck": "t01", "ok": True, "at": 3.5})
    state.apply({"t": "unloaded", "container": "c001", "ok": True, "at": 3.7})
    _continued(state)
    actions = _actions(profile, state)
    unpack2 = Step("unpack", "unpack", 1, (s2,), container_id="c001")
    assert not actions._resending(unpack2)        # its pack never landed (crew 1's first)
    unpack1 = Step("unpack", "unpack", 0, (s1,), container_id="c001")
    assert actions._resending(unpack1)            # crew 0's first
    assert not actions._resending(Step("unpack", "unpack", 1, (s1,), container_id="c001"))
    again = _actions(profile, state)              # a second Continue opens it again
    assert again._resending(unpack1)
    assert not again._resending(unpack1)


async def test_each_rfid_station_has_its_own_reader(fake, clock, metrics, run):
    """Numbered across the run's four stations, so the server keeps four fixed readers."""
    r = await run(fast(), servers=5, containers=1, trucks=1)
    stations = [d for d in r.fleet.devices if d.kind == "rfid_station"]
    assert [d._reader() for d in stations] == [
        (f"10.254.0.{n}", f"LOADTEST-READER-{n}", "FX9600") for n in (1, 2, 3, 4)]
    for d in stations:
        await clock.run(d.heartbeat())
    assert sorted(fake.fixed_readers) == [f"LOADTEST-READER-{n}" for n in (1, 2, 3, 4)]
