"""The Dock Station's pass grouper (dock station spec, pass rules): any tag
opens a pass; a pass closes once no NEW tag has been read for the quiet gap,
timed by the reader's own read_at (re-reads never keep it open); a closed
pass packs only with exactly one crate of the move and at least one asset.
Ambiguity is flagged, never guessed."""

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from edge import laptop_setup
from edge.db import Store, iso
from edge.dock import grouper, state
from edge.rfid.tagreads import parse_events, store_batch
from tests.fake_reader import tag_event
from tests.test_rfid_alarm import as_station, client_asset
from tests.test_rfid_processing import MOVE, SETUP, seed, set_cache, set_setup

DOCK = {**SETUP, "station_type": "dock"}
T0 = datetime(2026, 10, 16, 14, 0, 0, tzinfo=UTC)
GAP = timedelta(seconds=5)

# labels: the name, else the serial number, else the asset id
ASSETS = [{"id": "a-1", "asset_id": "A-1", "name": "Server 1", "serial_number": "SN1",
           "rfid": "AA01"},
          {"id": "a-2", "asset_id": "A-2", "name": None, "serial_number": "SN2", "rfid": "AA02"},
          {"id": "a-3", "asset_id": "A-3", "rfid": "AA03"}]
CRATES = [{"id": f"c-{n}", "name": f"Crate {n}", "rfid_tag": f"CC0{n}"} for n in (1, 2, 3)]


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "edge.db")
    yield s
    s.close()


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


def reader_time(seconds: float) -> str:
    """The reader's own form: milliseconds and a +0000 offset."""
    return at(seconds).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "+0000"


def dock(store, *, dry_run=False, **sources):
    """A Dock setup on MOVE with its sync data cached; dry run off unless asked."""
    seed(store, **{"assets": ASSETS, "containers": CRATES, **sources})
    as_station(store, "dock")
    state.save_settings(store, dry_run=dry_run)


def post(store, events, received: float, setup=DOCK) -> int:
    """One reader post received at T0 + `received` (whole seconds, as stored)."""
    rows, _ = parse_events(events)
    store_batch(store, reader_serial="R1", rows=rows, setup=setup, received_at=iso(at(received)))
    return store.one("SELECT MAX(id) AS id FROM raw_tag_reads")["id"]


def batch(store, reads, *, received: float | None = None, setup=DOCK) -> int:
    """(epc, seconds after T0) reads in one post, received with the last one."""
    events = [tag_event(epc, timestamp=reader_time(s)) for epc, s in reads]
    return post(store, events, max(s for _, s in reads) if received is None else received,
                setup)


def read(store, epc, seconds, **kw) -> int:
    return batch(store, [(epc, seconds)], **kw)


def group(store, seconds):
    return grouper.group(store, now=at(seconds))


def passes(store):
    return [dict(r) for r in store.all("SELECT * FROM dock_passes ORDER BY id")]


def tags(store, pass_row):
    return [tuple(r) for r in store.all(
        "SELECT epc, kind, matched_id, label FROM dock_pass_tags WHERE pass_id = ? "
        "ORDER BY rowid", (pass_row["id"],))]


def read_ids(store, pass_row):
    return [r["raw_read_id"] for r in store.all(
        "SELECT raw_read_id FROM dock_pass_reads WHERE pass_id = ? ORDER BY raw_read_id",
        (pass_row["id"],))]


def cursor(store):
    return store.one("SELECT last_raw_id FROM dock_meta WHERE id = 1")["last_raw_id"]


def when(text) -> datetime:
    return datetime.fromisoformat(text)


def outcomes(store):
    return [(p["outcome"], p["container_id"], p["asset_count"], p["send_state"])
            for p in passes(store)]


def test_one_crate_pass_packs(store):
    dock(store)
    ids = [read(store, epc, s) for epc, s in
           (("AA01", 0), ("AA02", 0.5), ("AA03", 1.2), ("CC01", 1.9))]
    assert group(store, 2) == grouper.GroupResult(scanned=4, closed=0, to_send=0, waiting=False)
    [p] = passes(store)
    assert p["closed_at"] is None and p["outcome"] is None and p["send_state"] == "none"
    assert group(store, 10) == grouper.GroupResult(scanned=0, closed=1, to_send=1, waiting=False)
    [p] = passes(store)
    assert p["outcome"] == "pack" and p["container_id"] == "c-1"
    assert p["container_name"] == "Crate 1" and p["asset_count"] == 3
    assert p["send_state"] == "pending" and p["dry_run"] == 0
    assert when(p["closed_at"]) == when(p["last_new_at"]) + GAP == at(1.9) + GAP
    assert when(p["opened_at"]) == at(0) and p["quiet_gap_s"] == 5
    assert p["last_received_at"] == iso(at(1)) == p["last_new_received_at"]
    assert p["initiative_id"] == MOVE and uuid.UUID(p["pass_id"]).version == 4
    assert tags(store, p) == [("AA01", "asset", "a-1", "Server 1"),
                              ("AA02", "asset", "a-2", "SN2"),
                              ("AA03", "asset", "a-3", "A-3"),
                              ("CC01", "container", "c-1", "Crate 1")]
    assert read_ids(store, p) == ids and cursor(store) == ids[-1]


def test_read_order_does_not_matter(store):
    dock(store)
    read(store, "CC01", 0)                       # the crate tag first
    read(store, "AA01", 0.4)
    batch(store, [("AA02", 1), ("AA03", 1.6)])
    group(store, 1)
    assert group(store, 10).to_send == 1
    assert outcomes(store) == [("pack", "c-1", 3, "pending")]
    assert passes(store)[0]["container_name"] == "Crate 1"


def test_quiet_gap_closes_and_new_tag_opens_next_pass(store):
    dock(store)
    read(store, "AA01", 0)
    read(store, "AA02", 3)
    read(store, "AA03", 9)                       # 6 s after the last new tag
    assert group(store, 9).closed == 1
    first, second = passes(store)
    assert [t[0] for t in tags(store, first)] == ["AA01", "AA02"]
    assert when(first["closed_at"]) == at(8) and first["outcome"] == "no_crate"
    assert [t[0] for t in tags(store, second)] == ["AA03"]
    assert second["closed_at"] is None and when(second["opened_at"]) == at(9)


def test_rereads_do_not_extend_pass(store):
    dock(store)
    ids = [read(store, epc, s) for epc, s in
           (("AA01", 0), ("AA02", 1), ("AA01", 4), ("AA01", 5.5), ("AA01", 6.2))]
    assert group(store, 6.2).closed == 1
    first, second = passes(store)
    assert when(first["last_new_at"]) == at(1)
    assert when(first["closed_at"]) == at(1) + GAP == at(6)
    assert read_ids(store, first) == ids[:4]
    assert first["last_received_at"] == iso(at(5))         # re-reads still raise it
    assert first["last_new_received_at"] == iso(at(1))
    assert [t[0] for t in tags(store, second)] == ["AA01"] and read_ids(store, second) == ids[4:]
    assert when(second["opened_at"]) == when(second["last_new_at"]) == at(6.2)


def test_no_crate_is_flagged(store):
    dock(store)
    batch(store, [("AA01", 0), ("AA02", 1)])
    assert group(store, 10).to_send == 0
    assert outcomes(store) == [("no_crate", None, 2, "none")]


def test_two_crates_are_flagged(store):
    dock(store)
    batch(store, [("CC01", 0), ("AA01", 0.5), ("CC02", 1)])
    result = group(store, 10)
    assert result.closed == 1 and result.to_send == 0
    [p] = passes(store)
    assert p["outcome"] == "many_crates" and p["send_state"] == "none"
    assert p["container_id"] is None and p["container_name"] is None


def test_other_move_crate_reads_as_unknown(store):
    dock(store)
    set_cache(store, "containers",                 # another move's crate, cached too
              {"containers": [{"id": "c-9", "name": "Other crate", "rfid_tag": "CC09"}]},
              move="m-2")
    batch(store, [("AA01", 0), ("CC09", 1)])
    group(store, 10)
    [p] = passes(store)
    assert tags(store, p) == [("AA01", "asset", "a-1", "Server 1"), ("CC09", "unknown", None, None)]
    assert outcomes(store) == [("no_crate", None, 1, "none")]


def test_people_off_move_and_unknown_are_ignored_for_packing(store):
    dock(store, people=[{"id": "p-1", "display_name": "Jane Doe", "rfid_tag": "BB01"}],
         client=[client_asset(1, name="Stray server")])
    batch(store, [("CC01", 0), ("AA01", 0.2), ("BB01", 0.4), ("EE01", 0.6), ("FF06", 1)])
    batch(store, [("BB01", 10), ("EE01", 10.5), ("FF06", 11)])     # none of them packs
    read(store, "CC01", 20)                                         # a crate on its own
    assert group(store, 30).closed == 3
    assert tags(store, passes(store)[0]) == [("CC01", "container", "c-1", "Crate 1"),
                                             ("AA01", "asset", "a-1", "Server 1"),
                                             ("BB01", "person", "p-1", "Jane Doe"),
                                             ("EE01", "off_move", "x-1", "Stray server"),
                                             ("FF06", "unknown", None, None)]
    assert outcomes(store) == [("pack", "c-1", 1, "pending"), ("nothing", None, 0, "none"),
                               ("nothing", None, 0, "none")]


def test_dry_run_pass_is_never_pending(store):
    dock(store, dry_run=True)
    batch(store, [("AA01", 0), ("CC01", 1)])
    assert group(store, 10).to_send == 0
    [p] = passes(store)
    assert p["outcome"] == "pack" and p["container_id"] == "c-1"
    assert p["dry_run"] == 1 and p["send_state"] == "none"


def test_switch_during_open_pass_keeps_dry_run(store):
    dock(store, dry_run=True)
    read(store, "AA01", 0)                        # taken in dry run
    group(store, 1)
    state.save_settings(store, dry_run=False)
    read(store, "CC01", 1)                        # live
    assert group(store, 10).to_send == 0
    batch(store, [("AA02", 20), ("CC01", 21)])
    assert group(store, 30).to_send == 1
    first, second = passes(store)
    assert (first["outcome"], first["dry_run"], first["send_state"]) == ("pack", 1, "none")
    assert (second["outcome"], second["dry_run"], second["send_state"]) == ("pack", 0, "pending")


def test_closed_while_dry_run_on_is_dry(store):
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 1)])      # live reads
    group(store, 2)
    assert passes(store)[0]["dry_run"] == 0
    state.save_settings(store, dry_run=True)
    assert group(store, 10).to_send == 0
    [p] = passes(store)
    assert (p["outcome"], p["dry_run"], p["send_state"]) == ("pack", 1, "none")


def test_backlog_batch_splits_by_read_time(store):
    dock(store)
    batch(store, [("CC01", 0), ("AA01", 0.5), ("CC02", 8), ("AA02", 8.5),
                  ("CC03", 16), ("AA03", 16.5)], received=30)       # one post, one received_at
    assert group(store, 30) == grouper.GroupResult(scanned=6, closed=2, to_send=2,
                                                   waiting=False)
    first, second, third = passes(store)
    assert [when(p["closed_at"]) for p in (first, second)] == [at(5.5), at(13.5)]
    assert third["closed_at"] is None
    assert {p["last_received_at"] for p in (first, second, third)} == {iso(at(30))}
    assert group(store, 35).closed == 0           # the idle rule: received_at + gap + 1 s
    assert group(store, 36).closed == 1
    assert when(passes(store)[2]["closed_at"]) == at(21.5)
    assert outcomes(store) == [("pack", "c-1", 1, "pending"), ("pack", "c-2", 1, "pending"),
                               ("pack", "c-3", 1, "pending")]


def test_read_time_parsing_and_fallback(store):
    received = "2026-10-16T14:03:30+00:00"
    parsed = grouper.read_time({"read_at": "2026-10-16T14:03:22.512+0000",
                                "received_at": received})
    assert parsed == datetime(2026, 10, 16, 14, 3, 22, 512000, tzinfo=UTC)
    assert parsed.utcoffset() == timedelta(0)
    assert grouper.read_time({"read_at": "2026-10-16T09:03:22.512-0500",
                              "received_at": received}) \
        == datetime(2026, 10, 16, 14, 3, 22, 512000, tzinfo=UTC)
    assert grouper.read_time({"read_at": "2026-10-16T14:03:22", "received_at": received}) \
        == datetime(2026, 10, 16, 14, 3, 22, tzinfo=UTC)          # no offset reads as UTC
    for bad in (None, "garbage", ""):
        assert grouper.read_time({"read_at": bad, "received_at": received}) \
            == datetime(2026, 10, 16, 14, 3, 30, tzinfo=UTC)

    dock(store)
    missing = tag_event("AA01")
    del missing["timestamp"]
    post(store, [missing], 0)
    last = post(store, [tag_event("CC01", timestamp="garbage")], 2)
    assert group(store, 3).scanned == 2 and cursor(store) == last
    [p] = passes(store)
    assert when(p["opened_at"]) == at(0) and when(p["last_new_at"]) == at(2)
    group(store, 10)
    [p] = passes(store)
    assert p["outcome"] == "pack" and when(p["closed_at"]) == at(7)


def test_idle_close_waits_gap_plus_one_second(store):
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 1.5)])    # received at 14:00:01
    assert passes(store) == []
    group(store, 6)                               # last_received_at + 5 s
    [p] = passes(store)
    assert p["last_received_at"] == iso(at(1)) and p["closed_at"] is None
    assert group(store, 7).closed == 1            # + 6 s
    [p] = passes(store)
    assert p["outcome"] == "pack" and when(p["closed_at"]) == at(6.5)


def test_idle_close_waits_for_the_backlog(store, monkeypatch):
    monkeypatch.setattr(grouper, "BATCH", 2)
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 1), ("AA02", 2)])          # one pass, long ago
    assert group(store, 60) == grouper.GroupResult(scanned=2, closed=0, to_send=0,
                                                   waiting=False)  # more may be waiting
    assert group(store, 60) == grouper.GroupResult(scanned=1, closed=1, to_send=1,
                                                   waiting=False)
    assert outcomes(store) == [("pack", "c-1", 2, "pending")]


def test_waits_for_move_cache(store):
    set_setup(store)
    as_station(store, "dock")
    state.save_settings(store, dry_run=False)
    start = cursor(store)
    first = read(store, "AA01", 0)
    assert group(store, 1) == grouper.GroupResult(scanned=0, closed=0, to_send=0, waiting=True)
    assert group(store, 2).waiting
    assert cursor(store) == start and passes(store) == []
    dock(store)
    other = read(store, "AA02", 1, setup={**DOCK, "initiative_id": "m-old"})  # skipped
    assert group(store, 2) == grouper.GroupResult(scanned=2, closed=0, to_send=0, waiting=False)
    assert cursor(store) == other
    [p] = passes(store)
    assert read_ids(store, p) == [first] and tags(store, p) == [("AA01", "asset", "a-1",
                                                                 "Server 1")]


def test_not_dock_setup_skips_reads(store):
    seed(store, assets=ASSETS, containers=CRATES)
    rfid = {**SETUP, "station_type": "rfid"}
    state.save_settings(store, dry_run=False)
    laptop_setup.save(store, SETUP, "rfid")
    batch(store, [("AA01", 0), ("CC01", 1)], setup=rfid)
    last = read(store, "AA02", 2, setup=rfid)
    assert group(store, 3) == grouper.GroupResult(scanned=0, closed=0, to_send=0, waiting=False)
    assert cursor(store) == last and passes(store) == []
    laptop_setup.save(store, SETUP, "dock")       # same move: no pass data to clear
    group(store, 20)
    assert cursor(store) == last and passes(store) == []
    batch(store, [("AA03", 30), ("CC02", 30.5)])  # read on the Dock
    group(store, 40)
    [p] = passes(store)
    assert [t[0] for t in tags(store, p)] == ["AA03", "CC02"]
    assert outcomes(store) == [("pack", "c-2", 1, "pending")]
    store.run("UPDATE laptop_setup SET setup_json = ? WHERE id = 1",
              (json.dumps({**DOCK, "initiative_id": None}),))     # a Dock with no move
    last = read(store, "AA01", 50, setup=None)
    group(store, 60)
    assert cursor(store) == last and len(passes(store)) == 1
