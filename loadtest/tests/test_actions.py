import asyncio
import json
import random
from collections import Counter

import httpx
import pytest
from conftest import FAKE_BASE_URL
from pipeline_helpers import fast, real_time
from run_helpers import state_for_move

from loadtest.actions import Actions
from loadtest.client.portal import PortalClient
from loadtest.events import Events, FeedLine
from loadtest.fleet import Fleet, FleetError
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
    """Wraps the fake's transport and keeps (path, JSON body) of every request."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self.inner = inner
        self.sent: list[tuple[str, dict]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        try:
            parsed = json.loads(body) if body else {}
        except ValueError:
            parsed = {}
        self.sent.append((request.url.path, parsed))
        return await self.inner.handle_async_request(request)

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
    assert fleet.devices[0].name in message and "invalid_move_password" in message
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
    assert location.device == f"Truck {truck.name}"
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
    r = await run()

    async def outage():
        await clock.sleep(20)
        fake.down(True)
        await clock.sleep(120)
        fake.down(False)

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
    assert lines[0][:8].count(":") == 2
    assert lines[99].endswith("SN 00100    failed  no answer")
    events.close()

    only_ring = Events(None)
    only_ring.feed(_line(1))
    assert only_ring.recent() == [_line(1)]
    only_ring.close()
