"""The Dock Station's laptop store (dock station spec §3): its settings (dry run
on and a 5 s quiet gap by default), dry run stamped on each raw read when it is
read, dry-run reads' scans never uploaded (not even after dry run is turned
off), the uploader held while dry run is on, and pass data cleared with the
alarm tables on a move change, Clear Setup and Wipe."""

import uuid

import pytest

from edge import laptop_setup
from edge.db import Store
from edge.dock import state
from edge.rfid import processing
from edge.rfid.tagreads import parse_events, store_batch
from edge.rfid.uploader import Uploader
from tests.conftest import make_session
from tests.fake_reader import tag_event
from tests.test_rfid_alarm import FRESH, NOW, as_station, client_asset, open_rows
from tests.test_rfid_processing import MOVE, SETUP, pending, read, seed, unmatched
from tests.test_rfid_uploader import PATH, accept_all, add_scans, rows, uploader, with_key

DOCK = {**SETUP, "station_type": "dock"}
PASS_TABLES = ("dock_passes", "dock_pass_tags", "dock_pass_reads")


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "edge.db")
    yield s
    s.close()


def dry_runs(store):
    return [r["dry_run"] for r in store.all("SELECT dry_run FROM raw_tag_reads ORDER BY id")]


def dock_cursor(store):
    return store.one("SELECT last_raw_id FROM dock_meta WHERE id = 1")["last_raw_id"]


def add_pass(store, *, send_state="none", raw_id=1):
    """One pass with one tag and one read behind it."""
    with store.tx() as c:
        pid = c.execute(
            "INSERT INTO dock_passes (pass_id, initiative_id, opened_at, last_new_at, "
            "last_new_received_at, last_received_at, send_state, created_at) "
            "VALUES (?, ?, 't', 't', 't', 't', ?, 't')",
            (str(uuid.uuid4()), MOVE, send_state)).lastrowid
        c.execute("INSERT INTO dock_pass_tags (pass_id, epc, kind, first_read_at) "
                  "VALUES (?, 'AA01', 'asset', 't')", (pid,))
        c.execute("INSERT INTO dock_pass_reads (pass_id, raw_read_id) VALUES (?, ?)",
                  (pid, raw_id))
    return pid


def pass_counts(store):
    return [store.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in PASS_TABLES]


def test_settings_defaults_and_save(store):
    assert state.settings(store) == {"dry_run": True, "quiet_gap_s": 5} == state.DEFAULTS
    assert state.dry_run_on(store)
    assert state.save_settings(store, quiet_gap_s=12) == {"dry_run": True, "quiet_gap_s": 12}
    assert state.save_settings(store, dry_run=False) == {"dry_run": False, "quiet_gap_s": 12}
    assert state.settings(store) == {"dry_run": False, "quiet_gap_s": 12}
    assert not state.dry_run_on(store)
    with store.tx() as c:
        assert state.settings_in(c) == {"dry_run": False, "quiet_gap_s": 12}
    for bad in (0, 61, True, "5", 5.0):
        with pytest.raises(ValueError, match="quiet_gap_s"):
            state.save_settings(store, quiet_gap_s=bad)
    for bad in (1, "true"):
        with pytest.raises(ValueError, match="dry_run"):
            state.save_settings(store, dry_run=bad)
    with pytest.raises(ValueError, match="dry_run"):    # nothing saved when either is bad
        state.save_settings(store, dry_run=1, quiet_gap_s=30)
    assert state.settings(store) == {"dry_run": False, "quiet_gap_s": 12}
    assert state.save_settings(store, quiet_gap_s=1)["quiet_gap_s"] == 1      # both ends allowed
    assert state.save_settings(store, quiet_gap_s=60)["quiet_gap_s"] == 60


def test_reads_stamped_dry_run_only_on_dock(store):
    rows_, _ = parse_events([tag_event("AA01"), tag_event("BB02")])
    store_batch(store, reader_serial="R1", rows=rows_, setup=DOCK)   # dry run on by default
    state.save_settings(store, dry_run=False)
    read(store, "AA01", setup=DOCK)
    state.save_settings(store, dry_run=True)
    read(store, "AA01", setup={**SETUP, "station_type": "rfid"})
    read(store, "AA01", setup=None)
    assert dry_runs(store) == [1, 1, None, None, None]


def test_dry_run_reads_never_queue_scans(store):
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}], client=[client_asset(1)])
    as_station(store, "dock")
    matched = read(store, "AA01", setup=DOCK, received_at=FRESH)
    off = read(store, "EE01", setup=DOCK, received_at=FRESH)
    read(store, "FF06", setup=DOCK, received_at=FRESH)               # matches nothing
    assert processing.process(store, now=NOW).inserted == 2
    assert {r["raw_read_id"]: r["upload_state"] for r in pending(store)} \
        == {matched: "dry_run", off: "dry_run"}
    assert [r["asset_id"] for r in open_rows(store)] == ["x-1"]      # the alarm is local
    assert unmatched(store) == []                                    # never re-checked later
    state.save_settings(store, dry_run=False)
    up = Uploader(store, None)
    assert {r["raw_read_id"]: r["upload_state"] for r in pending(store)} \
        == {matched: "dry_run", off: "dry_run"}
    assert up.due_rows() == []
    live = read(store, "AA01", setup=DOCK, received_at=FRESH)        # taken after dry run
    assert processing.process(store, now=NOW).inserted == 1
    assert [r["raw_read_id"] for r in up.due_rows()] == [live]


async def test_uploader_holds_while_dry_run_on(app, cloud):
    store = app.state.store
    laptop_setup.save(store, {"initiative_id": MOVE}, "dock")
    with_key(app)
    [sid] = add_scans(store, 1)                                      # a live scan, due now
    route = cloud.post(PATH).mock(side_effect=accept_all)
    up = uploader(app)
    assert state.dry_run_on(store)
    assert await up.drain_once() == 0
    assert route.call_count == 0
    row = rows(store)[sid]
    assert (row["upload_state"], row["attempts"], row["last_error"]) == ("pending", 0, None)
    state.save_settings(store, dry_run=False)
    assert await up.drain_once() == 1
    assert route.call_count == 1 and rows(store)[sid]["upload_state"] == "accepted"
    state.save_settings(store, dry_run=True)                        # only a Dock is held
    laptop_setup.save(store, {"initiative_id": MOVE}, "rfid")
    [other] = add_scans(store, 1)
    assert await up.drain_once() == 1
    assert rows(store)[other]["upload_state"] == "accepted"


async def test_pass_data_cleared_on_setup_changes(app, client):
    store = app.state.store
    laptop_setup.save(store, {"initiative_id": MOVE}, "dock")
    state.save_settings(store, dry_run=False, quiet_gap_s=9)
    raw = [read(store, "AA01", setup=DOCK) for _ in range(2)]
    add_pass(store, raw_id=raw[0])
    assert dock_cursor(store) == 0
    laptop_setup.save(store, {"initiative_id": MOVE}, "dock")       # set up again, same move
    assert pass_counts(store) == [1, 1, 1] and dock_cursor(store) == 0
    laptop_setup.save(store, {"initiative_id": "m-2"}, "dock")      # a new move
    assert pass_counts(store) == [0, 0, 0] and dock_cursor(store) == raw[-1]
    add_pass(store)
    laptop_setup.save(store, {"initiative_id": "m-2"}, "rfid")      # same move, not a Dock
    assert pass_counts(store) == [0, 0, 0]
    assert state.settings(store) == {"dry_run": False, "quiet_gap_s": 9}
    add_pass(store)
    laptop_setup.clear(store)                                       # Clear Setup
    assert pass_counts(store) == [0, 0, 0]
    assert state.settings(store) == state.DEFAULTS

    laptop_setup.save(store, {"initiative_id": MOVE}, "dock")
    state.save_settings(store, quiet_gap_s=9)
    add_pass(store, send_state="pending")
    add_pass(store, send_state="sent")
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "outbox_not_empty", "pending": 1}
    assert pass_counts(store) == [2, 2, 2]
    r = await client.post("/edge/wipe", json={"confirm": "WIPE"},
                          headers=make_session(app, max_rank=60))
    assert r.json() == {"cleared_move_data": True}
    for table in ("dock_settings", *PASS_TABLES):
        assert store.one(f"SELECT COUNT(*) AS n FROM {table}")["n"] == 0, table
    assert dock_cursor(store) == 0                                  # after the raw reads (none)


def test_upgrade_keeps_reads_and_starts_the_dock_cursor_after_them(tmp_path, monkeypatch):
    from edge import db
    steps = db.SCHEMA_STEPS
    monkeypatch.setattr(db, "SCHEMA_STEPS", steps[:-1])
    old = Store(tmp_path / "edge.db")
    for _ in range(2):
        old.run("INSERT INTO raw_tag_reads (received_at, reader_serial, epc, raw_json) "
                "VALUES ('now', 'R1', 'AA01', '{}')")
    old.close()
    monkeypatch.setattr(db, "SCHEMA_STEPS", steps)
    store = Store(tmp_path / "edge.db")
    assert dry_runs(store) == [None, None]
    assert dock_cursor(store) == 2
    assert state.settings(store) == state.DEFAULTS
    store.close()
