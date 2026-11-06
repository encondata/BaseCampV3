"""The Dock pass sender (dock station spec, offline sending): closed live
`pack` passes go to the portal's POST /kiosk/station/dock/passes under the
station key, one at a time and strictly in order, with the scan uploader's
retry rules; the portal's per-asset answer is kept on the pass's tags."""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime

import httpx

from edge import laptop_setup
from edge.db import iso
from edge.dock import sender, state
from edge.dock.sender import DockSender
from edge.rfid import station_key
from edge.rfid.uploader import GAPS, PAUSE_S, WAIT_S

RAW = "stationkey-dock-sender-SECRET-0123"
PATH = "/kiosk/station/dock/passes"
MOVE = str(uuid.UUID(int=1))
CRATE = str(uuid.UUID(int=7))
T0 = datetime(2026, 10, 16, 14, 0, tzinfo=UTC).timestamp()
CLOSED = "2026-10-16T13:59:00.250+00:00"   # the grouper's form: milliseconds, UTC


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def at(t):
    return iso(datetime.fromtimestamp(t, UTC))


async def _up():
    return True


async def _down():
    return False


def dock(app, *, dry_run=False, key=True):
    """A Dock setup on MOVE, dry run off unless asked, with a station key."""
    laptop_setup.save(app.state.store, {"initiative_id": MOVE}, "dock")
    state.save_settings(app.state.store, dry_run=dry_run)
    if key:
        station_key.store_key(app.state.store, app.state.keys, RAW)


def add_pass(store, assets, *, closed_at=CLOSED, **cols) -> dict:
    """A closed live pack waiting to be sent. `assets`: (asset uuid, first
    read) pairs; the crate's tag and a person's are added around them."""
    pass_id = str(uuid.uuid4())
    with store.tx() as c:
        pid = c.execute(
            "INSERT INTO dock_passes (pass_id, initiative_id, opened_at, last_new_at, "
            "last_new_received_at, last_received_at, closed_at, quiet_gap_s, outcome, "
            "container_id, container_name, asset_count, send_state, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 5, 'pack', ?, 'Crate A', ?, 'pending', ?)",
            (pass_id, MOVE, CLOSED, CLOSED, at(T0 - 60), at(T0 - 60), closed_at, CRATE,
             len({a for a, _ in assets}), at(T0 - 60))).lastrowid
        c.execute("INSERT INTO dock_pass_tags (pass_id, epc, kind, matched_id, label, "
                  "first_read_at) VALUES (?, 'CC01', 'container', ?, 'Crate A', ?)",
                  (pid, CRATE, CLOSED))
        c.execute("INSERT INTO dock_pass_tags (pass_id, epc, kind, matched_id, label, "
                  "first_read_at) VALUES (?, 'BB01', 'person', 'p-1', 'Jane Doe', ?)",
                  (pid, CLOSED))
        for n, (asset_id, first) in enumerate(assets):
            c.execute("INSERT INTO dock_pass_tags (pass_id, epc, kind, matched_id, label, "
                      "first_read_at) VALUES (?, ?, 'asset', ?, ?, ?)",
                      (pid, f"AA{pid:02d}{n:02d}", asset_id, f"Server {n}", first))
    if cols:
        sets = ", ".join(f"{k} = ?" for k in cols)
        store.run(f"UPDATE dock_passes SET {sets} WHERE id = ?", (*cols.values(), pid))
    return dict(store.one("SELECT * FROM dock_passes WHERE id = ?", (pid,)))


def one(store, pass_row) -> dict:
    return dict(store.one("SELECT * FROM dock_passes WHERE id = ?", (pass_row["id"],)))


def asset_tags(store, pass_row) -> dict:
    return {r["matched_id"]: (r["result"], r["moved_from"], r["reason"]) for r in store.all(
        "SELECT matched_id, result, moved_from, reason FROM dock_pass_tags "
        "WHERE pass_id = ? AND kind = 'asset'", (pass_row["id"],))}


def ids(n):
    return [str(uuid.uuid4()) for _ in range(n)]


def packed_all(request):
    body = json.loads(request.content)
    return httpx.Response(200, json={
        "pass_id": body["pass_id"], "container": {"id": body["container_id"], "name": "Crate A"},
        "assets": [{"asset_id": a, "result": "packed", "moved_from": None, "reason": None}
                   for a in body["asset_ids"]],
        "replayed": False, "clear_setup": None})


def sent_pass_ids(route):
    return [json.loads(c.request.content)["pass_id"] for c in route.calls]


def make(app, clock=None, probe=_up):
    return DockSender(app.state.store, app.state, clock=clock or Clock(), probe=probe)


def test_constants():
    assert sender.PATH == PATH and sender.INTERVAL_S == 5.0


async def test_sends_pass_under_station_key(app, cloud):
    dock(app)
    store = app.state.store
    store.run("INSERT INTO device_config (id, server_offset_ms) VALUES (1, 1500)")
    a1, a2, a3 = ids(3)
    # stored out of read order, with a second tag on a1: sent once, by first read
    p = add_pass(store, [(a2, "2026-10-16T13:58:55.500+00:00"),
                         (a1, "2026-10-16T13:58:55.100+00:00"),
                         (a3, "2026-10-16T13:58:56.000+00:00"),
                         (a1, "2026-10-16T13:58:57.000+00:00")])
    route = cloud.post(PATH).respond(200, json={
        "pass_id": p["pass_id"], "container": {"id": CRATE, "name": "Crate A"},
        "assets": [
            {"asset_id": a1, "result": "packed", "moved_from": None, "reason": None},
            {"asset_id": a2, "result": "moved",
             "moved_from": {"id": str(uuid.uuid4()), "name": "Crate B"}, "reason": None},
            {"asset_id": a3, "result": "refused", "moved_from": None,
             "reason": "changed_since_pass"}],
        "replayed": False, "clear_setup": None})
    clock = Clock()
    assert await make(app, clock).send_once() is True
    request = route.calls[0].request
    assert request.headers["authorization"] == f"Station {RAW}"
    assert json.loads(request.content) == {
        "serial": app.state.identity.serial, "pass_id": p["pass_id"], "container_id": CRATE,
        "closed_at": "2026-10-16T13:59:01.750+00:00", "asset_ids": [a1, a2, a3]}
    assert asset_tags(store, p) == {a1: ("packed", None, None), a2: ("moved", "Crate B", None),
                                    a3: ("refused", None, "changed_since_pass")}
    r = one(store, p)
    assert (r["packed_count"], r["moved_count"], r["refused_count"]) == (2, 1, 1)
    assert r["send_state"] == "sent" and r["sent_at"] == at(clock.t)
    assert r["attempts"] == 0 and r["last_error"] is None and r["refuse_code"] is None


async def test_unknown_offset_sends_reader_close_time(app, cloud):
    dock(app)
    assert app.state.store.one("SELECT 1 FROM device_config") is None
    p = add_pass(app.state.store, [(ids(1)[0], CLOSED)])
    route = cloud.post(PATH).mock(side_effect=packed_all)
    assert await make(app).send_once() is True
    assert json.loads(route.calls[0].request.content)["closed_at"] == CLOSED
    assert one(app.state.store, p)["send_state"] == "sent"


async def test_one_at_a_time_in_order(app, cloud):
    dock(app)
    store = app.state.store
    older = add_pass(store, [(ids(1)[0], CLOSED)])
    newer = add_pass(store, [(ids(1)[0], CLOSED)])
    route = cloud.post(PATH).mock(side_effect=packed_all)
    up = make(app)
    assert await up.send_once() is True
    assert sent_pass_ids(route) == [older["pass_id"]]
    assert one(store, older)["send_state"] == "sent"
    assert one(store, newer)["send_state"] == "pending"
    assert await up.send_once() is True
    assert sent_pass_ids(route) == [older["pass_id"], newer["pass_id"]]
    assert await up.send_once() is False             # nothing left
    assert route.call_count == 2


async def test_failure_holds_order(app, cloud):
    dock(app)
    store = app.state.store
    older = add_pass(store, [(ids(1)[0], CLOSED)])
    newer = add_pass(store, [(ids(1)[0], CLOSED)])
    route = cloud.post(PATH).mock(side_effect=[
        httpx.Response(500, json={"detail": {"code": "boom"}}), packed_all, packed_all])
    clock = Clock()
    up = make(app, clock)
    assert await up.send_once() is False
    r = one(store, older)
    assert r["attempts"] == 1 and r["last_error"] == "boom" and r["send_state"] == "pending"
    assert r["next_attempt_at"] == at(clock.t + GAPS[0])
    clock.t += GAPS[0] - 1
    assert await up.send_once() is False             # the newer pass waits behind it
    assert route.call_count == 1
    assert one(store, newer)["attempts"] == 0
    clock.t += 1
    assert await up.send_once() is True
    assert await up.send_once() is True
    assert sent_pass_ids(route) == [older["pass_id"], older["pass_id"], newer["pass_id"]]


async def test_failures_spend_attempts(app, cloud, caplog):
    caplog.set_level(logging.DEBUG)
    dock(app)
    p = add_pass(app.state.store, [(ids(1)[0], CLOSED)])
    clock = Clock()
    up = make(app, clock)
    for answer, expect in ((httpx.ConnectError(f"down {RAW}"), "CloudOffline"),
                           (httpx.Response(503), "CloudOffline"),
                           (httpx.Response(429), "http_429"),
                           (httpx.Response(500, text=f"echo {RAW}"), "http_500"),
                           (httpx.Response(200, text="not json"), "bad_answer")):
        cloud.post(PATH).mock(side_effect=[answer])
        assert await up.send_once() is False
        r = one(app.state.store, p)
        assert r["last_error"] == expect and r["send_state"] == "pending"
        clock.t = datetime.fromisoformat(r["next_attempt_at"]).timestamp()
    r = one(app.state.store, p)
    assert r["attempts"] == 5
    assert RAW not in caplog.text


async def test_refused_for_good_skips_to_next(app, cloud):
    dock(app)
    store = app.state.store
    older = add_pass(store, [(ids(1)[0], CLOSED)])
    newer = add_pass(store, [(ids(1)[0], CLOSED)])
    route = cloud.post(PATH).mock(side_effect=[
        httpx.Response(404, json={"detail": {"code": "container_not_found"}}), packed_all])
    up = make(app)
    assert await up.send_once() is True
    r = one(store, older)
    assert r["send_state"] == "refused" and r["refuse_code"] == "container_not_found"
    assert r["attempts"] == 0 and r["next_attempt_at"] is None
    assert await up.send_once() is True              # the next pass goes at once
    assert sent_pass_ids(route) == [older["pass_id"], newer["pass_id"]]
    assert one(store, newer)["send_state"] == "sent"


async def test_pause_codes_spend_no_attempt(app, cloud):
    dock(app)
    store = app.state.store
    p = add_pass(store, [(ids(1)[0], CLOSED)])
    clock = Clock()
    up = make(app, clock)
    for status, code in ((401, "station_key_invalid"), (423, "read_only_mode"),
                         (403, "kiosk_not_registered")):
        if not station_key.has_key(store):           # a 401 drops the key
            station_key.store_key(store, app.state.keys, RAW)
        cloud.post(PATH).respond(status, json={"detail": {"code": code}})
        assert await up.send_once() is False
        r = one(store, p)
        assert r["attempts"] == 0 and r["send_state"] == "pending"
        assert r["last_error"] == code
        assert r["next_attempt_at"] == at(clock.t + PAUSE_S)
        clock.t += PAUSE_S


async def test_probe_gate_after_five_failures(app, cloud):
    dock(app)
    store = app.state.store
    p = add_pass(store, [(ids(1)[0], CLOSED)], attempts=5)
    route = cloud.post(PATH).mock(side_effect=packed_all)
    clock = Clock()
    assert await make(app, clock, probe=_down).send_once() is False
    r = one(store, p)
    assert r["waiting_for_internet"] == 1 and r["attempts"] == 5
    assert r["next_attempt_at"] == at(clock.t + WAIT_S)
    assert not route.called
    clock.t += WAIT_S
    assert await make(app, clock, probe=_up).send_once() is True
    r = one(store, p)
    assert r["send_state"] == "sent" and r["waiting_for_internet"] == 0


async def test_under_five_attempts_never_probes(app, cloud):
    dock(app)
    add_pass(app.state.store, [(ids(1)[0], CLOSED)], attempts=4)
    cloud.post(PATH).mock(side_effect=packed_all)

    async def boom():
        raise AssertionError("probed")

    assert await make(app, probe=boom).send_once() is True


async def test_idle_while_dry_run_on(app, cloud):
    dock(app, dry_run=True)
    p = add_pass(app.state.store, [(ids(1)[0], CLOSED)])
    route = cloud.post(PATH).mock(side_effect=packed_all)
    assert await make(app).send_once() is False
    assert not route.called
    assert one(app.state.store, p) == p


async def test_idle_without_key(app, cloud):
    dock(app, key=False)
    p = add_pass(app.state.store, [(ids(1)[0], CLOSED)])
    route = cloud.post(PATH).mock(side_effect=packed_all)
    assert await make(app).send_once() is False
    assert not route.called
    assert one(app.state.store, p) == p


async def test_idle_when_not_dock(app, cloud):
    dock(app)
    laptop_setup.save(app.state.store, {"initiative_id": MOVE}, "rfid")
    station_key.store_key(app.state.store, app.state.keys, RAW)
    p = add_pass(app.state.store, [(ids(1)[0], CLOSED)])
    route = cloud.post(PATH).mock(side_effect=packed_all)
    assert await make(app).send_once() is False
    assert not route.called
    assert one(app.state.store, p) == p


async def test_clear_setup_in_reply_applies(app, cloud):
    dock(app)
    store = app.state.store
    add_pass(store, [(ids(1)[0], CLOSED)])
    add_pass(store, [(ids(1)[0], CLOSED)])

    def with_clear(request):
        resp = packed_all(request)
        return httpx.Response(200, json={**resp.json(), "clear_setup": str(uuid.uuid4())})

    route = cloud.post(PATH).mock(side_effect=with_clear)
    up = make(app)
    assert await up.send_once() is True
    assert laptop_setup.load(store) is None
    assert not station_key.has_key(store)
    assert await up.send_once() is False             # sending stops
    assert route.call_count == 1


async def test_background_runs_sender_and_wake_starts_it(app, cloud):
    from edge.background import Background
    cloud.get("/system/status").respond(200, json={})
    bg = Background(app.state)
    answers = [True, True, False]                   # a backlog of two, then idle
    calls = []

    class Fake:
        async def send_once(self):
            calls.append(1)
            return answers.pop(0) if answers else False

    async def idle(now):
        return None

    bg.tick = idle
    bg.dock_sender = Fake()
    bg.start()
    try:
        for _ in range(50):
            await asyncio.sleep(0.01)
            if len(calls) >= 3:
                break
        assert len(calls) == 3                       # straight on while True, then waits
        app.state.dock_send_wake.set()
        for _ in range(50):
            await asyncio.sleep(0.01)
            if len(calls) > 3:
                break
        assert len(calls) == 4
    finally:
        await bg.stop()
