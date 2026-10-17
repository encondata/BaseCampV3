import asyncio
import dataclasses
import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from edge import outbox
from edge.app import create_app
from edge.background import Background
from edge.db import Store, iso
from edge.rfid import processing, tagreads
from edge.rfid.tagreads import parse_events, store_batch
from edge.sync import sync_paths
from tests.conftest import make_session
from tests.fake_reader import tag_event

MOVE = "m-1"
SETUP = {"initiative_id": MOVE, "site_id": "s-1", "scan_status": "received"}
RECEIVED = "2026-10-16T14:00:00+00:00"


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "edge.db")
    yield s
    s.close()


def _key(name, move=MOVE):
    return next(p for p in sync_paths(move) if p.startswith(f"/kiosk/sync/{name}"))


def set_cache(store, name, body, move=MOVE):
    store.run("INSERT INTO cache (key, status, body, stored_at) VALUES (?, 200, ?, ?) "
              "ON CONFLICT(key) DO UPDATE SET body = excluded.body, stored_at = excluded.stored_at",
              (_key(name, move), json.dumps(body), RECEIVED))
    tagreads.note_cache_write()


def set_setup(store, move=MOVE):
    store.run("INSERT INTO laptop_setup (id, setup_json, updated_at) VALUES (1, ?, 'now') "
              "ON CONFLICT (id) DO UPDATE SET setup_json = excluded.setup_json",
              (json.dumps({**SETUP, "initiative_id": move}),))


def seed(store, *, assets=(), containers=(), people=(), client=(), move=MOVE):
    set_setup(store, move)
    set_cache(store, "assets", {"initiative_id": move, "assets": list(assets)}, move)
    set_cache(store, "containers", {"initiative_id": move, "containers": list(containers)}, move)
    set_cache(store, "people", {"people": list(people)}, move)
    set_cache(store, "client-assets", {"initiative_id": move, "assets": list(client)}, move)


def read(store, epc, *, setup=SETUP, received_at=RECEIVED):
    rows, _ = parse_events(tag_event(epc))
    store_batch(store, reader_serial="R1", rows=rows, setup=setup, received_at=received_at)
    return store.one("SELECT MAX(id) AS id FROM raw_tag_reads")["id"]


def pending(store):
    return store.all("SELECT * FROM pending_rfid_scans ORDER BY raw_read_id")


def cursor(store):
    return store.one("SELECT last_raw_id FROM rfid_processing_meta WHERE id = 1")["last_raw_id"]


def unmatched(store):
    return [r["raw_read_id"] for r in store.all("SELECT raw_read_id FROM rfid_unmatched "
                                                "ORDER BY raw_read_id")]


def test_matches_asset_container_person_in_order(store):
    seed(store,
         assets=[{"id": "a-1", "rfid": "aa 01"}],
         containers=[{"id": "c-1", "rfid_tag": "AA01"}, {"id": "c-2", "rfid_tag": "BB02"}],
         people=[{"id": "p-1", "rfid_tag": "bb02"}, {"id": "p-2", "rfid_tag": "CC03"}],
         client=[{"id": "x-1", "rfid": "CC03", "initiative_id": "m-2",
                  "initiative_name": "Other"}])
    ids = [read(store, epc) for epc in ("AA01", "BB02", "CC03")]
    assert processing.run_once(store) == 3
    rows = pending(store)
    assert [(r["raw_read_id"], r["matched_kind"], r["matched_id"], r["off_move"]) for r in rows] \
        == [(ids[0], "asset", "a-1", 0), (ids[1], "container", "c-2", 0),
            (ids[2], "person", "p-2", 0)]
    first = rows[0]
    assert first["epc"] == "AA01" and first["upload_state"] == "pending"
    assert first["initiative_id"] == MOVE and first["site_id"] == "s-1"
    assert first["scan_status"] == "received"
    assert first["off_move_initiative_id"] is None and first["attempts"] == 0
    assert first["was_accepted"] == 0 and first["waiting_for_internet"] == 0
    assert uuid.UUID(first["client_scan_id"]).version == 4
    assert len({r["client_scan_id"] for r in rows}) == 3
    assert cursor(store) == ids[-1]


def test_container_beats_person(store):
    seed(store, containers=[{"id": "c-1", "rfid_tag": "DD04"}],
         people=[{"id": "p-1", "rfid_tag": "DD04"}])
    read(store, "DD04")
    processing.run_once(store)
    assert pending(store)[0]["matched_kind"] == "container"


def test_off_move_asset_from_client_list(store):
    seed(store, client=[{"id": "x-1", "asset_id": "A-9", "rfid": "EE05", "serial_number": "S",
                         "initiative_id": "m-2", "initiative_name": "Dallas move"}])
    read(store, "EE05")
    assert processing.run_once(store) == 1
    row = pending(store)[0]
    assert row["matched_kind"] == "asset" and row["matched_id"] == "x-1"
    assert row["off_move"] == 1
    assert row["off_move_initiative_id"] == "m-2"
    assert row["off_move_initiative_name"] == "Dallas move"
    assert row["initiative_id"] == MOVE          # the read's move, not the asset's


def test_unmatched_read_skipped_cursor_advances(store):
    seed(store)
    rid = read(store, "FF06")
    assert processing.run_once(store) == 0
    assert pending(store) == [] and cursor(store) == rid
    assert unmatched(store) == [rid]
    assert processing.run_once(store) == 0       # nothing new, nothing repeated
    assert unmatched(store) == [rid]


def test_read_without_move_and_old_move_skipped(store):
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    none_id = read(store, "AA01", setup=None)
    old_id = read(store, "AA01", setup={**SETUP, "initiative_id": "m-old"})
    assert processing.run_once(store) == 0
    assert cursor(store) == old_id > none_id
    assert pending(store) == [] and unmatched(store) == []
    assert store.one("SELECT COUNT(*) AS n FROM raw_tag_reads")["n"] == 2


def test_waits_for_missing_current_move_cache_then_resumes(store):
    set_setup(store)
    skipped = read(store, "AA01", setup=None)
    rid = read(store, "AA01")
    assert processing.run_once(store) == 0
    assert cursor(store) == skipped              # stopped AT the current-move read
    assert processing.run_once(store) == 0 and cursor(store) == skipped
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    assert processing.run_once(store) == 1
    assert cursor(store) == rid and pending(store)[0]["raw_read_id"] == rid


def test_waits_until_every_source_is_cached(store):
    set_setup(store)
    set_cache(store, "assets", {"assets": [{"id": "a-1", "rfid": "AA01"}]})
    read(store, "AA01")
    assert processing.run_once(store) == 0 and cursor(store) == 0


def test_cursor_survives_restart(tmp_path):
    s = Store(tmp_path / "edge.db")
    seed(s, assets=[{"id": "a-1", "rfid": "AA01"}])
    first = read(s, "AA01")
    assert processing.run_once(s) == 1
    s.close()
    s = Store(tmp_path / "edge.db")
    try:
        assert cursor(s) == first
        second = read(s, "AA01")
        assert processing.run_once(s) == 1
        assert [r["raw_read_id"] for r in pending(s)] == [first, second]
    finally:
        s.close()


def test_scanned_at_is_received_at(store):
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    read(store, "AA01", received_at="2026-10-16T09:30:00+00:00")
    processing.run_once(store)
    row = pending(store)[0]
    assert row["scanned_at"] == "2026-10-16T09:30:00+00:00"
    raw = store.one("SELECT read_at FROM raw_tag_reads")
    assert raw["read_at"] == "2026-10-16T14:03:22.512+0000"   # the reader's clock stays raw


def test_500_row_pass_limit(store):
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    rows, _ = parse_events([tag_event("AA01") for _ in range(501)])
    store_batch(store, reader_serial="R1", rows=rows, setup=SETUP, received_at=RECEIVED)
    assert processing.run_once(store) == 500
    assert cursor(store) == 500
    assert processing.run_once(store) == 1
    assert processing.run_once(store) == 0
    assert len(pending(store)) == 501


def test_rerun_never_duplicates(store):
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    read(store, "AA01")
    processing.run_once(store)
    store.run("UPDATE rfid_processing_meta SET last_raw_id = 0")
    assert processing.run_once(store) == 0
    assert len(pending(store)) == 1


def test_unmatched_read_rechecked_after_sync(store):
    seed(store)
    now = datetime(2026, 10, 16, 15, 0, tzinfo=UTC)
    rid = read(store, "AB12")
    processing.run_once(store)
    assert unmatched(store) == [rid]
    assert processing.recheck_unmatched(store, now=now) == 0     # still unknown: kept
    assert unmatched(store) == [rid]
    set_cache(store, "assets", {"assets": [{"id": "a-7", "rfid": "AB12"}]})
    assert processing.recheck_unmatched(store, now=now) == 1
    assert unmatched(store) == []
    row = pending(store)[0]
    assert (row["raw_read_id"], row["matched_kind"], row["matched_id"]) == (rid, "asset", "a-7")
    assert row["scanned_at"] == RECEIVED
    assert processing.recheck_unmatched(store, now=now) == 0


def test_unmatched_older_than_24h_dropped(store):
    seed(store)
    now = datetime(2026, 10, 17, 15, 0, tzinfo=UTC)
    old = read(store, "AB12", received_at=iso(now - timedelta(hours=24, seconds=1)))
    recent = read(store, "AB12", received_at=iso(now - timedelta(hours=23)))
    processing.run_once(store)
    assert unmatched(store) == [old, recent]
    set_cache(store, "assets", {"assets": [{"id": "a-7", "rfid": "AB12"}]})
    assert processing.recheck_unmatched(store, now=now) == 1
    assert unmatched(store) == []
    assert [r["raw_read_id"] for r in pending(store)] == [recent]
    assert store.one("SELECT COUNT(*) AS n FROM raw_tag_reads")["n"] == 2   # raw stays


def test_recheck_drops_reads_for_a_move_no_longer_set_up(store):
    seed(store)
    read(store, "AB12")
    processing.run_once(store)
    seed(store, assets=[{"id": "a-7", "rfid": "AB12"}], move="m-2")
    now = datetime(2026, 10, 16, 15, 0, tzinfo=UTC)
    assert processing.recheck_unmatched(store, now=now) == 0
    assert unmatched(store) == [] and pending(store) == []


async def test_sync_calls_recheck(app, cloud, monkeypatch):
    calls = []
    monkeypatch.setattr(processing, "recheck_unmatched",
                        lambda store, **kw: calls.append(store) or 0)
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target(MOVE, "p-1")
    for path in sync_paths(MOVE):
        cloud.get(path).respond(500, json={})
    cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(200, json={"moves": []})
    meta = await app.state.syncer.run()
    assert meta["last_error"] and calls == []                    # failed sync: no re-check
    for path in sync_paths(MOVE):
        cloud.get(path).respond(200, json={})
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None and calls == [app.state.store]


async def test_station_sync_calls_recheck(app, cloud, monkeypatch):
    from edge.rfid import station_key
    calls = []
    monkeypatch.setattr(processing, "recheck_unmatched",
                        lambda store, **kw: calls.append(store) or 0)
    station_key.store_key(app.state.store, app.state.keys, "the-station-key")
    app.state.syncer.set_target(MOVE, None)
    cloud.get(url__regex=r"/kiosk/station/sync/.*").respond(200, json={})
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None and calls == [app.state.store]


async def test_failing_recheck_never_fails_the_sync(app, cloud, monkeypatch):
    def boom(store, **kw):
        raise RuntimeError("bad")
    monkeypatch.setattr(processing, "recheck_unmatched", boom)
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target(MOVE, "p-1")
    for path in sync_paths(MOVE):
        cloud.get(path).respond(200, json={})
    cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(200, json={"moves": []})
    assert (await app.state.syncer.run())["last_error"] is None


async def test_wipe_resets_cursor_and_clears_pending(app, client):
    store = app.state.store
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    read(store, "AA01")
    read(store, "ZZ")  # not hex: never stored
    read(store, "BB99")
    processing.run_once(store)
    store.run("UPDATE pending_rfid_scans SET upload_state = 'accepted'")
    assert pending(store) and unmatched(store) and cursor(store) > 0
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.status_code == 200
    assert pending(store) == [] and unmatched(store) == []
    assert cursor(store) == 0
    # new reads after Wipe keep counting up and are still processed
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    rid = read(store, "AA01")
    assert rid > 2 and processing.run_once(store) == 1


async def test_wipe_guard_counts_pending_rfid_scans(app, client):
    store = app.state.store
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    read(store, "AA01")
    read(store, "AA01")
    processing.run_once(store)
    store.run("UPDATE pending_rfid_scans SET upload_state = 'accepted' WHERE raw_read_id = 1")
    outbox.enqueue_scans(store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    admin = make_session(app, max_rank=60)
    r = await client.post("/edge/wipe", json={}, headers=admin)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "outbox_not_empty", "pending": 2}
    r = await client.post("/edge/wipe", json={"confirm": "WIPE"},
                          headers=make_session(app, max_rank=60))
    assert r.status_code == 200 and pending(store) == []


async def test_wipe_guard_rfid_scans_alone(app, client):
    store = app.state.store
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    read(store, "AA01")
    processing.run_once(store)
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.status_code == 409 and r.json()["detail"]["pending"] == 1


async def test_ingest_wakes_the_processor(app):
    import httpx
    from edge.rfid import ingest
    from tests.test_rfid_ingest import pair_reader, path
    pair_reader(app)
    app.state.rfid_wake.clear()
    transport = httpx.ASGITransport(app=ingest.create_ingest_app(app.state))
    async with httpx.AsyncClient(transport=transport, base_url="http://edge.test") as c:
        r = await c.post(path(), json=[])
        assert r.status_code == 200 and not app.state.rfid_wake.is_set()   # nothing stored
        r = await c.post(path(), json=tag_event("AA01"))
        assert r.status_code == 200
    assert app.state.rfid_wake.is_set()


async def test_processor_loop_runs_on_wake(settings, cloud, monkeypatch):
    bg_app = create_app(dataclasses.replace(settings, background=False))
    calls = []
    monkeypatch.setattr(processing, "process",
                        lambda store: calls.append(1) or processing.PassResult(0, 0, False))
    bg = Background(bg_app.state)
    bg.tick = lambda now: asyncio.sleep(0)
    bg.start()
    try:
        for _ in range(50):
            if calls:
                break
            await asyncio.sleep(0.01)
        first = len(calls)
        bg_app.state.rfid_wake.set()
        for _ in range(50):
            if len(calls) > first:
                break
            await asyncio.sleep(0.01)
    finally:
        await bg.stop()
    assert first >= 1 and len(calls) > first        # woke at once, not after 2 s
    assert bg._process_task.cancelled()


async def test_processor_loop_survives_a_failing_pass(settings, cloud, monkeypatch):
    bg_app = create_app(dataclasses.replace(settings, background=False))
    calls = []

    def boom(store):
        calls.append(1)
        raise RuntimeError("bad")
    monkeypatch.setattr(processing, "process", boom)
    monkeypatch.setattr(processing, "INTERVAL_S", 0.01)
    bg = Background(bg_app.state)
    bg.tick = lambda now: asyncio.sleep(0)
    bg.start()
    try:
        for _ in range(100):
            if len(calls) >= 2:
                break
            await asyncio.sleep(0.01)
    finally:
        await bg.stop()
    assert len(calls) >= 2
