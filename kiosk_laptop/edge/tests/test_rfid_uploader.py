"""The RFID uploader (spec §4): pending_rfid_scans go to the portal's
POST /kiosk/station/scans in batches of at most 50 under the station key,
with expanding retries, an internet gate before 30-minute retries, and an
`rfid_uploads` block on /edge/status."""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime

import httpx

from edge import laptop_setup
from edge.db import iso
from edge.rfid import station_key
from edge.rfid.uploader import GAPS, Uploader
from tests.conftest import make_session

RAW = "stationkey-uploader-SECRET-0123"
PATH = "/kiosk/station/scans"
T0 = datetime(2026, 10, 16, 14, 0, tzinfo=UTC).timestamp()


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def at(t):
    return iso(datetime.fromtimestamp(t, UTC))


_raw_ids = iter(range(1, 10_000_000))


def add_scans(store, n, *, kind="asset", **cols):
    ids = []
    for _ in range(n):
        raw_id = next(_raw_ids)
        sid = str(uuid.uuid4())
        store.run(
            "INSERT INTO pending_rfid_scans (raw_read_id, client_scan_id, epc, matched_kind, "
            "matched_id, off_move, scanned_at, initiative_id, site_id, scan_status, created_at) "
            "VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'received', ?)",
            (raw_id, sid, f"{raw_id:024X}", kind, str(uuid.uuid4()), at(T0 - 60),
             str(uuid.UUID(int=1)), str(uuid.UUID(int=2)), at(T0 - 60)))
        if cols:
            sets = ", ".join(f"{k} = ?" for k in cols)
            store.run(f"UPDATE pending_rfid_scans SET {sets} WHERE client_scan_id = ?",
                      (*cols.values(), sid))
        ids.append(sid)
    return ids


def rows(store):
    return {r["client_scan_id"]: r for r in store.all("SELECT * FROM pending_rfid_scans")}


def with_key(app):
    station_key.store_key(app.state.store, app.state.keys, RAW)


def accept_all(request):
    body = json.loads(request.content)
    return httpx.Response(200, json={"accepted": [s["client_scan_id"] for s in body["scans"]],
                                     "rejected": [], "clear_setup": None})


async def _up():
    return True


async def _down():
    return False


def uploader(app, clock=None, probe=_up):
    return Uploader(app.state.store, app.state, clock=clock or Clock(), probe=probe)


async def test_accepted_rows_marked_with_time(app, cloud):
    with_key(app)
    ids = add_scans(app.state.store, 3)
    route = cloud.post(PATH).mock(side_effect=accept_all)
    clock = Clock()
    assert await uploader(app, clock).drain_once() == 3
    sent = json.loads(route.calls[0].request.content)
    assert sent["serial"] == app.state.identity.serial
    scan = sent["scans"][0]
    assert set(scan) == {"client_scan_id", "scanned_value", "scan_type", "scanned_at", "asset_id",
                         "site_id", "initiative_id", "scan_status", "off_move"}
    assert scan["scan_type"] == "rfid" and len(scan["scanned_value"]) == 24
    assert scan["off_move"] is False
    assert route.calls[0].request.headers["authorization"] == f"Station {RAW}"
    for sid in ids:
        r = rows(app.state.store)[sid]
        assert r["upload_state"] == "accepted" and r["was_accepted"] == 1
        assert r["accepted_at"] == at(clock.t)
        assert r["last_error"] is None


async def test_container_scan_sends_no_asset_id(app, cloud):
    with_key(app)
    add_scans(app.state.store, 1, kind="container")
    route = cloud.post(PATH).mock(side_effect=accept_all)
    await uploader(app).drain_once()
    assert "asset_id" not in json.loads(route.calls[0].request.content)["scans"][0]


async def test_rejected_rows_never_retried(app, cloud):
    with_key(app)
    good, bad = add_scans(app.state.store, 2)
    route = cloud.post(PATH).respond(200, json={
        "accepted": [good], "rejected": [{"client_scan_id": bad, "code": "move_locked"}],
        "clear_setup": None})
    clock = Clock()
    up = uploader(app, clock)
    assert await up.drain_once() == 2
    r = rows(app.state.store)[bad]
    assert r["upload_state"] == "rejected" and r["reject_code"] == "move_locked"
    assert r["was_accepted"] == 0
    clock.t += 10_000
    assert up.due_rows() == []
    assert await up.drain_once() == 0
    assert route.call_count == 1


async def test_batch_is_at_most_50(app, cloud):
    with_key(app)
    add_scans(app.state.store, 120)
    route = cloud.post(PATH).mock(side_effect=accept_all)
    up = uploader(app)
    assert len(up.due_rows()) == 50
    assert await up.drain_once() == 50
    assert len(json.loads(route.calls[0].request.content)["scans"]) == 50
    assert await up.drain_once() == 50
    assert await up.drain_once() == 20
    assert await up.drain_once() == 0
    assert route.call_count == 3


async def test_oldest_rows_first(app, cloud):
    with_key(app)
    first = add_scans(app.state.store, 1)
    add_scans(app.state.store, 60)
    route = cloud.post(PATH).mock(side_effect=accept_all)
    await uploader(app).drain_once()
    assert json.loads(route.calls[0].request.content)["scans"][0]["client_scan_id"] == first[0]


async def test_backoff_sequence(app, cloud):
    with_key(app)
    [sid] = add_scans(app.state.store, 1)
    cloud.post(PATH).respond(500, json={"detail": {"code": "boom"}})
    clock = Clock()
    up = uploader(app, clock)
    gaps = []
    for _ in range(7):
        assert await up.drain_once() == 1
        r = rows(app.state.store)[sid]
        due = datetime.fromisoformat(r["next_attempt_at"]).timestamp()
        gaps.append(round(due - clock.t))
        assert await up.drain_once() == 0          # not due yet
        clock.t = due
    assert gaps == [30, 60, 120, 300, 600, 1800, 1800]
    assert GAPS == (30, 60, 120, 300, 600, 1800)
    r = rows(app.state.store)[sid]
    assert r["attempts"] == 7 and r["upload_state"] == "pending"
    assert r["last_error"] == "boom"


async def test_network_error_and_429_and_4xx_count_attempts(app, cloud):
    with_key(app)
    [sid] = add_scans(app.state.store, 1)
    clock = Clock()
    up = uploader(app, clock)
    for answer, expect in ((httpx.ConnectError("down"), "CloudOffline"),
                           (httpx.Response(429), "http_429"),
                           (httpx.Response(422, json={"detail": "x"}), "http_422"),
                           (httpx.Response(503), "CloudOffline")):
        cloud.post(PATH).mock(side_effect=[answer])
        assert await up.drain_once() == 1
        r = rows(app.state.store)[sid]
        assert r["last_error"] == expect
        clock.t = datetime.fromisoformat(r["next_attempt_at"]).timestamp()
    assert rows(app.state.store)[sid]["attempts"] == 4


async def test_probe_gate_waits_for_internet_without_spending_attempts(app, cloud):
    with_key(app)
    [sid] = add_scans(app.state.store, 1, attempts=5)
    route = cloud.post(PATH).mock(side_effect=accept_all)
    probes = []

    async def down():
        probes.append(1)
        return False

    clock = Clock()
    up = uploader(app, clock, probe=down)
    assert await up.drain_once() == 0
    r = rows(app.state.store)[sid]
    assert r["waiting_for_internet"] == 1 and r["attempts"] == 5
    assert r["next_attempt_at"] == at(clock.t + 30)
    assert not route.called and probes == [1]
    assert await up.drain_once() == 0              # inside the 30 s: no probe
    assert probes == [1]
    clock.t += 30
    assert await up.drain_once() == 0              # probes again every 30 s
    assert probes == [1, 1]
    assert rows(app.state.store)[sid]["attempts"] == 5


async def test_rows_under_five_attempts_never_probe(app, cloud):
    with_key(app)
    add_scans(app.state.store, 1, attempts=4)
    cloud.post(PATH).mock(side_effect=accept_all)

    async def boom():
        raise AssertionError("probed")

    assert await uploader(app, probe=boom).drain_once() == 1


async def test_waiting_rows_send_as_soon_as_probe_succeeds(app, cloud):
    with_key(app)
    clock = Clock()
    [sid] = add_scans(app.state.store, 1, attempts=6, waiting_for_internet=1,
                      next_attempt_at=at(clock.t))
    route = cloud.post(PATH).mock(side_effect=accept_all)
    assert await uploader(app, clock).drain_once() == 1
    assert route.call_count == 1
    r = rows(app.state.store)[sid]
    assert r["upload_state"] == "accepted" and r["waiting_for_internet"] == 0


async def test_failed_send_after_probe_clears_flag_and_counts(app, cloud):
    with_key(app)
    clock = Clock()
    [sid] = add_scans(app.state.store, 1, attempts=6, waiting_for_internet=1)
    cloud.post(PATH).respond(500)
    assert await uploader(app, clock).drain_once() == 1
    r = rows(app.state.store)[sid]
    assert r["waiting_for_internet"] == 0 and r["attempts"] == 7
    assert r["next_attempt_at"] == at(clock.t + 1800)


async def test_default_probe_needs_a_200(app, cloud):
    with_key(app)
    [sid] = add_scans(app.state.store, 1, attempts=5)
    cloud.get("/system/status").respond(500)
    route = cloud.post(PATH).mock(side_effect=accept_all)
    up = Uploader(app.state.store, app.state, clock=Clock())
    assert await up.drain_once() == 0
    assert not route.called and rows(app.state.store)[sid]["waiting_for_internet"] == 1


async def test_401_pauses_without_attempts(app, cloud):
    with_key(app)
    [sid] = add_scans(app.state.store, 1)
    cloud.post(PATH).respond(401, json={"detail": {"code": "station_key_invalid"}})
    clock = Clock()
    up = uploader(app, clock)
    assert await up.drain_once() == 0
    r = rows(app.state.store)[sid]
    assert r["attempts"] == 0 and r["upload_state"] == "pending"
    assert r["last_error"] == "station_key_invalid"
    assert r["next_attempt_at"] == at(clock.t + 60)
    assert not station_key.has_key(app.state.store)  # Task 5 drops a refused key


async def test_no_key_counts_no_attempt(app, cloud):
    [sid] = add_scans(app.state.store, 1)
    route = cloud.post(PATH).mock(side_effect=accept_all)
    up = uploader(app)
    assert await up.drain_once() == 0
    assert not route.called
    r = rows(app.state.store)[sid]
    assert r["attempts"] == 0 and r["last_error"] == "no_station_key"
    with_key(app)                                  # a key arrives: sends at once
    assert await up.drain_once() == 1


async def test_423_read_only_does_not_spend_attempts(app, cloud):
    with_key(app)
    [sid] = add_scans(app.state.store, 1, attempts=2)
    cloud.post(PATH).respond(423, json={"detail": {"code": "read_only_mode"}})
    clock = Clock()
    assert await uploader(app, clock).drain_once() == 0
    r = rows(app.state.store)[sid]
    assert r["attempts"] == 2 and r["last_error"] == "read_only_mode"
    assert r["next_attempt_at"] == at(clock.t + 60)


async def test_clear_setup_in_reply_drops_key(app, cloud):
    with_key(app)
    laptop_setup.save(app.state.store, {"initiative_id": "m-1"}, "rfid")
    first = add_scans(app.state.store, 50)
    rest = add_scans(app.state.store, 5)
    route = cloud.post(PATH).respond(200, json={"accepted": first, "rejected": [],
                                                "clear_setup": str(uuid.uuid4())})
    up = uploader(app)
    assert await up.drain_once() == 50
    assert not station_key.has_key(app.state.store)
    assert laptop_setup.load(app.state.store) is None
    assert all(rows(app.state.store)[s]["upload_state"] == "accepted" for s in first)
    assert await up.drain_once() == 0              # uploads stop: no key
    assert route.call_count == 1
    assert all(rows(app.state.store)[s]["upload_state"] == "pending" for s in rest)


async def test_resend_after_timeout_is_idempotent(app, cloud):
    with_key(app)
    ids = add_scans(app.state.store, 3)
    route = cloud.post(PATH).mock(side_effect=[httpx.ReadTimeout("slow"), accept_all])
    clock = Clock()
    up = uploader(app, clock)
    assert await up.drain_once() == 3
    assert rows(app.state.store)[ids[0]]["last_error"] == "CloudOffline"
    clock.t += 30
    assert await up.drain_once() == 3
    sent = [[s["client_scan_id"] for s in json.loads(c.request.content)["scans"]]
            for c in route.calls]
    assert sent[0] == sent[1] == ids
    assert all(r["upload_state"] == "accepted" for r in rows(app.state.store).values())


async def test_no_overlapping_batches(app, cloud):
    with_key(app)
    add_scans(app.state.store, 60)
    inflight = 0
    peak = 0

    async def slow(request):
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        await asyncio.sleep(0.02)
        inflight -= 1
        return accept_all(request)

    route = cloud.post(PATH).mock(side_effect=slow)
    up = uploader(app)
    counts = await asyncio.gather(up.drain_once(), up.drain_once())
    assert peak == 1
    assert sorted(counts) == [10, 50]
    sent = [s["client_scan_id"] for c in route.calls
            for s in json.loads(c.request.content)["scans"]]
    assert len(sent) == len(set(sent)) == 60


async def test_uploads_with_no_person_session(app, cloud):
    with_key(app)
    assert app.state.store.one("SELECT COUNT(*) AS n FROM cloud_sessions")["n"] == 0
    assert app.state.store.one("SELECT COUNT(*) AS n FROM edge_sessions")["n"] == 0
    add_scans(app.state.store, 2)
    route = cloud.post(PATH).mock(side_effect=accept_all)
    assert await uploader(app).drain_once() == 2
    assert route.calls[0].request.headers["authorization"].startswith("Station ")


async def test_edge_status_rfid_uploads_counts(app, client, cloud):
    store = app.state.store
    add_scans(store, 3)
    add_scans(store, 2, waiting_for_internet=1, attempts=5)
    add_scans(store, 4, upload_state="accepted", was_accepted=1)
    add_scans(store, 1, upload_state="rejected", reject_code="move_locked")
    r = await client.get("/edge/status", headers=make_session(app))
    assert r.json()["rfid_uploads"] == {"pending": 5, "waiting_for_internet": 2,
                                        "accepted": 4, "rejected": 1}


async def test_key_not_in_last_error_or_logs(app, client, cloud, caplog):
    caplog.set_level(logging.DEBUG)
    with_key(app)
    add_scans(app.state.store, 2)
    clock = Clock()
    up = uploader(app, clock)
    for answer in (httpx.Response(500, text=f"echo {RAW}"),
                   httpx.ConnectError(f"refused {RAW}"),
                   httpx.Response(400, json={"detail": {"code": RAW}}),
                   httpx.Response(401, json={"detail": {"code": f"x {RAW}"}})):
        cloud.post(PATH).mock(side_effect=[answer])
        await up.drain_once()
        clock.t += 10_000
        if not station_key.has_key(app.state.store):
            with_key(app)
    status = await client.get("/edge/status", headers=make_session(app))
    errors = [r["last_error"] for r in rows(app.state.store).values()]
    for text in (caplog.text, status.text, json.dumps(errors)):
        assert RAW not in text


async def test_background_runs_uploader_and_processor_wakes_it(app, cloud):
    from edge.background import Background
    cloud.get("/system/status").respond(200, json={})
    bg = Background(app.state)
    calls = []

    class Fake:
        async def drain_once(self):
            calls.append(1)
            return 0

    bg.uploader = Fake()
    bg.start()
    try:
        for _ in range(50):
            await asyncio.sleep(0.01)
            if calls:
                break
        assert calls
        n = len(calls)
        app.state.rfid_upload_wake.set()
        for _ in range(50):
            await asyncio.sleep(0.01)
            if len(calls) > n:
                break
        assert len(calls) > n
    finally:
        await bg.stop()
