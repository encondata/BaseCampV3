"""The Dock Station's laptop store (dock station spec §3): a fixed 5 s window and
no settings, reads never stamped dry run (a stamp from an older build is kept,
and its scan never uploaded), the uploader never held on a Dock, and pass data
cleared with the alarm tables on a move change, Clear Setup and Wipe."""

import json
import uuid

import pytest

from edge import laptop_setup
from edge.db import Store
from edge.dock import state
from edge.rfid import processing
from tests.conftest import make_session
from tests.test_dock_grouper import legacy_settings, stamp_dry_run
from tests.test_rfid_alarm import FRESH, NOW, as_station, client_asset, open_rows
from tests.test_rfid_processing import MOVE, SETUP, pending, read, seed, unmatched
from tests.test_rfid_uploader import PATH, accept_all, uploader, with_key

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


def settings_rows(store):
    return store.one("SELECT COUNT(*) AS n FROM dock_settings")["n"]


def test_window_is_fixed_at_five():
    assert state.WINDOW_S == 5
    for gone in ("save_settings", "settings", "settings_in", "dry_run_on", "DEFAULTS",
                 "GAP_RANGE"):
        assert not hasattr(state, gone), gone


def test_reads_are_never_stamped_dry_run(store):
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}])
    as_station(store, "dock")
    legacy_settings(store, quiet_gap_s=9)                  # a laptop upgraded with dry run on
    first = read(store, "AA01", setup=DOCK, received_at=FRESH)
    second = read(store, "AA01", setup=DOCK, received_at=FRESH)
    assert dry_runs(store) == [None, None]
    assert processing.process(store, now=NOW).inserted == 2
    assert {r["raw_read_id"]: r["upload_state"] for r in pending(store)} \
        == {first: "pending", second: "pending"}


async def test_legacy_dry_run_reads_never_upload(app, cloud):
    store = app.state.store
    seed(store, assets=[{"id": "a-1", "rfid": "AA01"}], client=[client_asset(1)])
    as_station(store, "dock")
    legacy_settings(store, quiet_gap_s=9)
    with_key(app)
    old = [read(store, "AA01", setup=DOCK, received_at=FRESH),
           read(store, "EE01", setup=DOCK, received_at=FRESH)]
    read(store, "FF06", setup=DOCK, received_at=FRESH)               # matches nothing
    stamp_dry_run(store, *old, old[-1] + 1)                          # taken before the change
    assert processing.process(store, now=NOW).inserted == 2
    assert {r["raw_read_id"]: r["upload_state"] for r in pending(store)} \
        == {old[0]: "dry_run", old[1]: "dry_run"}
    assert [r["asset_id"] for r in open_rows(store)] == ["x-1"]      # the alarm is local
    assert unmatched(store) == []                                    # never re-checked later
    route = cloud.post(PATH).mock(side_effect=accept_all)
    up = uploader(app)
    assert up.due_rows() == []
    assert await up.drain_once() == 0 and route.call_count == 0
    live = read(store, "AA01", setup=DOCK, received_at=FRESH)        # read after the change
    assert processing.process(store, now=NOW).inserted == 1
    assert [r["raw_read_id"] for r in up.due_rows()] == [live]
    assert await up.drain_once() == 1
    sent = json.loads(route.calls[0].request.content)["scans"]
    assert [s["scanned_value"] for s in sent] == ["AA01"]
    assert {r["raw_read_id"]: r["upload_state"] for r in pending(store)} \
        == {old[0]: "dry_run", old[1]: "dry_run", live: "accepted"}


async def test_pass_data_cleared_on_setup_changes(app, client):
    store = app.state.store
    laptop_setup.save(store, {"initiative_id": MOVE}, "dock")
    legacy_settings(store, quiet_gap_s=9)
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
    assert settings_rows(store) == 1                                # kept: not Clear Setup
    rfid_read = read(store, "AA01", setup={"initiative_id": "m-2", "station_type": "rfid"})
    add_pass(store, raw_id=rfid_read)
    laptop_setup.save(store, {"initiative_id": "m-2"}, "dock")      # same move, now a Dock
    assert pass_counts(store) == [0, 0, 0] and dock_cursor(store) == rfid_read
    add_pass(store)
    laptop_setup.clear(store)                                       # Clear Setup
    assert pass_counts(store) == [0, 0, 0]
    assert settings_rows(store) == 0                                # a legacy row goes too

    laptop_setup.save(store, {"initiative_id": MOVE}, "dock")
    legacy_settings(store, quiet_gap_s=9)
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
    step = next(i for i, sql in enumerate(steps) if "dock_meta" in sql)
    monkeypatch.setattr(db, "SCHEMA_STEPS", steps[:step])    # the image before this step
    old = Store(tmp_path / "edge.db")
    for _ in range(2):
        old.run("INSERT INTO raw_tag_reads (received_at, reader_serial, epc, raw_json) "
                "VALUES ('now', 'R1', 'AA01', '{}')")
    old.close()
    monkeypatch.setattr(db, "SCHEMA_STEPS", steps)
    store = Store(tmp_path / "edge.db")
    assert dry_runs(store) == [None, None]
    assert dock_cursor(store) == 2
    assert settings_rows(store) == 0
    store.close()


def test_upgrade_gives_decided_passes_their_anchor(tmp_path, monkeypatch):
    from edge import db
    steps = db.SCHEMA_STEPS
    step = next(i for i, sql in enumerate(steps) if "anchor_at" in sql)
    monkeypatch.setattr(db, "SCHEMA_STEPS", steps[:step])    # the image before this step
    old = Store(tmp_path / "edge.db")
    for pass_id, closed_at in (("p-closed", "2026-10-16T14:00:06.900+00:00"), ("p-open", None)):
        old.run("INSERT INTO dock_passes (pass_id, initiative_id, opened_at, last_new_at, "
                "last_new_received_at, last_received_at, closed_at, created_at) "
                "VALUES (?, ?, '2026-10-16T14:00:00.000+00:00', "
                "'2026-10-16T14:00:01.900+00:00', '2026-10-16T14:00:01+00:00', "
                "'2026-10-16T14:00:03+00:00', ?, 'now')", (pass_id, MOVE, closed_at))
    old.close()
    monkeypatch.setattr(db, "SCHEMA_STEPS", steps)
    store = Store(tmp_path / "edge.db")
    closed, open_ = (store.one("SELECT * FROM dock_passes WHERE pass_id = ?", (p,))
                     for p in ("p-closed", "p-open"))
    assert (closed["anchor_at"], closed["anchor_received_at"]) \
        == (closed["last_new_at"], closed["last_new_received_at"]) \
        == ("2026-10-16T14:00:01.900+00:00", "2026-10-16T14:00:01+00:00")
    assert (open_["anchor_at"], open_["anchor_received_at"]) == (None, None)
    store.close()
