"""The Dock Station's pass grouper (dock station spec, "The crate window"):
reads gather into a burst that ends 2W after its last NEW tag, timed by the
reader's own read_at (re-reads never keep it open). Deciding a burst anchors
each crate at its first read: an asset read within W of it packs into it,
crates within 2W of each other are flagged together, and an asset in no
crate's window is flagged "No crate read". Ambiguity is flagged, never
guessed. W = 5 s throughout."""

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


def decided(store) -> list[tuple[str, str | None, list[str]]]:
    """(outcome, crate id, sorted asset ids) of each decided pass, in id order."""
    return [(p["outcome"], p["container_id"],
             sorted({t[2] for t in tags(store, p) if t[1] == "asset"}))
            for p in passes(store) if p["closed_at"] is not None]


def test_spec_example_packs_the_crate_window(store):
    dock(store)
    ids = [read(store, epc, s) for epc, s in (("AA01", 0), ("CC01", 2), ("AA02", 6), ("AA03", 8))]
    group(store, 8)
    [burst] = passes(store)
    assert group(store, 18).closed == 0                      # 8 + 2W + 1 s not yet
    assert group(store, 19) == grouper.GroupResult(scanned=0, closed=2, to_send=1, waiting=False)
    pack, left = passes(store)
    assert decided(store) == [("pack", "c-1", ["a-1", "a-2"]), ("no_crate", None, ["a-3"])]
    assert pack["id"] == burst["id"] and pack["pass_id"] == burst["pass_id"] != left["pass_id"]
    assert when(pack["anchor_at"]) == at(2) and pack["anchor_received_at"] == iso(at(2))
    assert when(pack["closed_at"]) == at(7) and when(pack["opened_at"]) == at(0)
    assert (pack["container_name"], pack["asset_count"], pack["send_state"], pack["quiet_gap_s"]) \
        == ("Crate 1", 2, "pending", 5)
    assert tags(store, pack) == [("AA01", "asset", "a-1", "Server 1"),
                                 ("CC01", "container", "c-1", "Crate 1"),
                                 ("AA02", "asset", "a-2", "SN2")]
    assert tags(store, left) == [("AA03", "asset", "a-3", "A-3")]
    assert read_ids(store, pack) == ids[:3] and read_ids(store, left) == ids[3:]
    assert left["anchor_at"] is None and when(left["closed_at"]) == at(18)
    assert (left["send_state"], when(left["opened_at"])) == ("none", at(8))


def test_one_burst_packs_each_crate_on_its_own(store):
    dock(store)
    ids = [read(store, epc, s) for epc, s in
           (("AA01", 0), ("CC01", 2), ("AA02", 8), ("CC02", 15), ("AA03", 16))]
    assert group(store, 26).closed == 0
    assert group(store, 27) == grouper.GroupResult(scanned=0, closed=3, to_send=2, waiting=False)
    assert decided(store) == [("pack", "c-1", ["a-1"]), ("no_crate", None, ["a-2"]),
                              ("pack", "c-2", ["a-3"])]
    first, left, second = passes(store)
    assert [when(p["closed_at"]) for p in (first, left, second)] == [at(7), at(26), at(20)]
    assert first["id"] < left["id"] < second["id"]
    assert [when(p["opened_at"]) for p in (first, left, second)] == [at(0), at(8), at(15)]
    assert [p["send_state"] for p in (first, left, second)] == ["pending", "none", "pending"]
    assert [read_ids(store, p) for p in (first, left, second)] \
        == [ids[:2], [ids[2]], ids[3:]] and cursor(store) == ids[-1]
    assert len({p["pass_id"] for p in (first, left, second)}) == 3
    for p in (first, left, second):                # the burst's own columns on every pass
        assert uuid.UUID(p["pass_id"]).version == 4 and p["initiative_id"] == MOVE
        assert when(p["last_new_at"]) == at(16) and p["quiet_gap_s"] == 5
        assert p["last_new_received_at"] == p["last_received_at"] == iso(at(16))
    assert [p["anchor_received_at"] for p in (first, left, second)] \
        == [iso(at(2)), None, iso(at(15))]


def test_window_reaches_w_before_and_after_the_crate(store):
    dock(store)
    for epc, s in (("AA01", 0), ("CC01", 5), ("AA02", 10), ("AA03", 10.2)):
        read(store, epc, s)
    group(store, 21)
    assert decided(store) == [("pack", "c-1", ["a-1", "a-2"]), ("no_crate", None, ["a-3"])]


def test_crate_rereads_do_not_move_its_window(store):
    dock(store)
    ids = [read(store, epc, s) for epc, s in
           (("CC01", 0), ("CC01", 4), ("CC01", 8), ("AA01", 9))]
    group(store, 20)
    assert decided(store) == [("nothing", "c-1", []), ("no_crate", None, ["a-1"])]
    nothing, left = passes(store)
    assert nothing["container_name"] == "Crate 1" and when(nothing["anchor_at"]) == at(0)
    assert when(nothing["closed_at"]) == at(5) and nothing["send_state"] == "none"
    assert read_ids(store, nothing) == ids[:3] and read_ids(store, left) == ids[3:]


def test_crates_within_two_windows_are_flagged_together(store):
    dock(store)
    for epc, s in (("CC01", 0), ("AA01", 1), ("CC02", 7), ("AA02", 8), ("AA03", 13.5)):
        read(store, epc, s)
    result = group(store, 24)
    assert result.closed == 2 and result.to_send == 0
    assert decided(store) == [("many_crates", None, ["a-1", "a-2"]), ("no_crate", None, ["a-3"])]
    flagged = passes(store)[0]
    assert {"CC01", "CC02"} <= {t[0] for t in tags(store, flagged)}
    assert flagged["container_id"] is None and flagged["container_name"] is None
    assert when(flagged["anchor_at"]) == at(0) and flagged["send_state"] == "none"


def test_crates_exactly_two_windows_apart_are_flagged(store):
    dock(store)
    for epc, s in (("CC01", 0), ("AA01", 5), ("CC02", 10)):
        read(store, epc, s)
    group(store, 21)
    assert decided(store) == [("many_crates", None, ["a-1"])]


def test_crates_exactly_two_windows_apart_chain_without_a_shared_asset(store):
    dock(store)
    for epc, s in (("CC01", 0), ("AA01", 1), ("AA02", 9), ("CC02", 10)):
        read(store, epc, s)                       # each asset is in one window only
    group(store, 21)
    assert decided(store) == [("many_crates", None, ["a-1", "a-2"])]


def test_an_asset_read_in_two_crate_windows_flags_both(store):
    dock(store)
    for epc, s in (("CC01", 0), ("AA01", 1), ("AA02", 6), ("AA01", 10), ("CC02", 11),
                   ("AA03", 12)):
        read(store, epc, s)
    assert group(store, 23).to_send == 0
    assert decided(store) == [("many_crates", None, ["a-1", "a-2", "a-3"])]
    assert [p["send_state"] for p in passes(store)] == ["none"]


def test_burst_ends_two_windows_after_its_last_new_tag(store):
    dock(store)
    ids = [read(store, epc, s) for epc, s in
           (("AA01", 0), ("AA02", 10), ("AA01", 15), ("AA01", 19), ("AA03", 20.5))]
    assert group(store, 20.5).closed == 1
    first, second = passes(store)
    assert decided(store) == [("no_crate", None, ["a-1", "a-2"])]
    assert read_ids(store, first) == ids[:4]
    assert when(first["last_new_at"]) == at(10) and when(first["closed_at"]) == at(20)
    assert first["last_new_received_at"] == iso(at(10))
    assert first["last_received_at"] == iso(at(19))           # re-reads still raise it
    assert second["closed_at"] is None and when(second["opened_at"]) == at(20.5)
    assert tags(store, second) == [("AA03", "asset", "a-3", "A-3")]
    assert read_ids(store, second) == ids[4:]


def test_people_off_move_and_unknown_never_pack_or_merge(store):
    dock(store, people=[{"id": "p-1", "display_name": "Jane Doe", "rfid_tag": "BB01"}],
         client=[client_asset(1, name="Stray server")])
    ids = {}
    for epc, s in (("CC01", 0), ("AA01", 0.2), ("BB01", 0.4), ("EE01", 0.6), ("FF06", 1),
                   ("CC02", 100), ("BB01", 101), ("AA02", 106), ("BB01", 111), ("CC03", 111),
                   ("AA03", 112),
                   ("BB01", 200), ("EE01", 200.5), ("FF06", 201)):
        ids[(epc, s)] = read(store, epc, s)
    assert group(store, 212).closed == 4
    assert decided(store) == [("pack", "c-1", ["a-1"]), ("nothing", "c-2", []),
                              ("pack", "c-3", ["a-2", "a-3"]), ("nothing", None, [])]
    first, crate_2, crate_3, last = passes(store)
    assert tags(store, first) == [("CC01", "container", "c-1", "Crate 1"),
                                  ("AA01", "asset", "a-1", "Server 1"),
                                  ("BB01", "person", "p-1", "Jane Doe"),
                                  ("EE01", "off_move", "x-1", "Stray server"),
                                  ("FF06", "unknown", None, None)]
    # BB01 is read in both crates' windows: it joins the earlier and merges nothing
    assert [t[0] for t in tags(store, crate_2)] == ["CC02", "BB01"]
    assert read_ids(store, crate_2) == [ids[("CC02", 100)], ids[("BB01", 101)],
                                        ids[("BB01", 111)]]
    assert [t[0] for t in tags(store, crate_3)] == ["AA02", "CC03", "AA03"]
    assert [t[0] for t in tags(store, last)] == ["BB01", "EE01", "FF06"]
    assert [p["send_state"] for p in passes(store)] == ["pending", "none", "pending", "none"]


def test_other_move_crate_reads_as_unknown(store):
    dock(store)
    set_cache(store, "containers",                 # another move's crate, cached too
              {"containers": [{"id": "c-9", "name": "Other crate", "rfid_tag": "CC09"}]},
              move="m-2")
    batch(store, [("AA01", 0), ("CC09", 1)])
    group(store, 12)
    [p] = passes(store)
    assert tags(store, p) == [("AA01", "asset", "a-1", "Server 1"), ("CC09", "unknown", None, None)]
    assert decided(store) == [("no_crate", None, ["a-1"])]
    assert outcomes(store) == [("no_crate", None, 1, "none")]


def test_dry_run_pass_is_never_pending(store):
    dock(store, dry_run=True)
    batch(store, [("AA01", 0), ("CC01", 1)])
    assert group(store, 12).to_send == 0
    [p] = passes(store)
    assert p["outcome"] == "pack" and p["container_id"] == "c-1"
    assert p["dry_run"] == 1 and p["send_state"] == "none"


def test_switch_during_open_burst_keeps_its_reads_dry(store):
    dock(store, dry_run=True)
    read(store, "AA01", 0)                        # taken in dry run
    group(store, 1)
    state.save_settings(store, dry_run=False)
    read(store, "CC01", 1)                        # live
    assert group(store, 12).to_send == 0
    batch(store, [("AA02", 20), ("CC01", 21)])
    assert group(store, 32).to_send == 1
    first, second = passes(store)
    assert (first["outcome"], first["dry_run"], first["send_state"]) == ("pack", 1, "none")
    assert (second["outcome"], second["dry_run"], second["send_state"]) == ("pack", 0, "pending")


def test_closed_while_dry_run_on_is_dry(store):
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 1)])      # live reads
    group(store, 2)
    assert passes(store)[0]["closed_at"] is None
    assert [r["dry_run"] for r in store.all("SELECT dry_run FROM raw_tag_reads")] == [None, None]
    state.save_settings(store, dry_run=True)
    assert group(store, 12).to_send == 0
    [p] = passes(store)
    assert (p["outcome"], p["dry_run"], p["send_state"]) == ("pack", 1, "none")


def test_dry_run_is_decided_per_pass(store):
    dock(store, dry_run=True)
    read(store, "CC01", 0)                        # taken in dry run
    read(store, "AA01", 1)
    group(store, 1)
    state.save_settings(store, dry_run=False)
    read(store, "AA02", 8)                        # live, same burst
    read(store, "CC02", 12)
    result = group(store, 23)
    assert (result.closed, result.to_send) == (2, 1)
    assert decided(store) == [("pack", "c-1", ["a-1"]), ("pack", "c-2", ["a-2"])]
    first, second = passes(store)
    assert (first["dry_run"], first["send_state"]) == (1, "none")
    assert (second["dry_run"], second["send_state"]) == (0, "pending")


def test_backlog_batch_splits_like_live(store, tmp_path):
    reads = [("CC01", 0), ("AA01", 1), ("AA02", 8), ("CC02", 30), ("AA03", 31), ("CC03", 60)]
    expected = [("pack", "c-1", ["a-1"]), ("no_crate", None, ["a-2"]), ("pack", "c-2", ["a-3"]),
                ("nothing", "c-3", [])]

    def times(s):
        return [(p["opened_at"], p["closed_at"], p["anchor_at"]) for p in passes(s)]

    dock(store)                                   # live: grouped as each read comes in
    for epc, s in reads:
        read(store, epc, s)
        group(store, s)
    group(store, 71)
    assert decided(store) == expected

    backlog = Store(tmp_path / "backlog.db")
    try:
        dock(backlog)
        batch(backlog, reads, received=70)        # one post, one received_at
        assert group(backlog, 70) == grouper.GroupResult(scanned=6, closed=3, to_send=2,
                                                         waiting=False)
        assert group(backlog, 80).closed == 0     # the idle rule: received_at + 2W + 1 s
        assert group(backlog, 81).closed == 1
        assert decided(backlog) == expected
        assert times(backlog) == times(store)
    finally:
        backlog.close()


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
    group(store, 13)
    [p] = passes(store)
    assert p["outcome"] == "pack" and when(p["closed_at"]) == at(7)
    assert when(p["anchor_at"]) == at(2)


def test_read_time_too_late_to_close_falls_back(store):
    received = "2026-10-16T14:03:30+00:00"
    fallback = datetime(2026, 10, 16, 14, 3, 30, tzinfo=UTC)
    for late in ("9999-12-31T23:58:00+0000", "9999-12-31T23:59:59.999+0000",
                 "0001-01-01T00:00:00+0100", "0001-01-01T00:00:00+0000",
                 "0001-01-01T00:00:02.000+0000", "0001-01-01T00:02:00.999+0000"):
        assert grouper.read_time({"read_at": late, "received_at": received}) == fallback
    # room for 2 x the widest window + 1 s at either end of time
    assert grouper.read_time({"read_at": "9999-12-31T23:57:58+0000", "received_at": received}) \
        == datetime(9999, 12, 31, 23, 57, 58, tzinfo=UTC)
    assert grouper.read_time({"read_at": "0001-01-01T00:02:01+0000", "received_at": received}) \
        == datetime(1, 1, 1, 0, 2, 1, tzinfo=UTC)

    dock(store)
    post(store, [tag_event("AA01", timestamp="9999-12-31T23:59:59.999+0000")], 0)
    last = read(store, "CC01", 1)
    assert group(store, 3).scanned == 2 and cursor(store) == last
    [p] = passes(store)
    assert when(p["opened_at"]) == at(0) and when(p["last_new_at"]) == at(1)
    assert group(store, 12).closed == 1
    [p] = passes(store)
    assert p["outcome"] == "pack" and when(p["closed_at"]) == at(6)

    post(store, [tag_event("CC02", timestamp="0001-01-01T00:00:00+0000")], 30)  # a crate, and
    last = post(store, [tag_event("AA02", timestamp="0001-01-01T00:00:02.000+0000")], 31)  # W on
    assert group(store, 31).scanned == 2 and cursor(store) == last
    assert group(store, 42).closed == 1           # grouped by received_at: no stall
    first, second = passes(store)
    assert (second["outcome"], second["container_id"]) == ("pack", "c-2")
    assert when(second["anchor_at"]) == at(30) and when(second["closed_at"]) == at(35)
    assert when(second["opened_at"]) == at(30)


def test_idle_decision_waits_two_windows_plus_one_second(store):
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 1.5)])    # received at 14:00:01
    assert passes(store) == []
    group(store, 11)                              # last_received_at + 2W
    [p] = passes(store)
    assert p["last_received_at"] == iso(at(1)) and p["closed_at"] is None
    assert group(store, 12).closed == 1           # + 2W + 1 s
    [p] = passes(store)
    assert p["outcome"] == "pack" and when(p["closed_at"]) == at(6.5)


def test_idle_close_waits_for_the_backlog(store, monkeypatch):
    monkeypatch.setattr(grouper, "BATCH", 2)
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 1), ("AA02", 2)])          # one burst, long ago
    assert group(store, 60) == grouper.GroupResult(scanned=2, closed=0, to_send=0,
                                                   waiting=False)  # more may be waiting
    assert group(store, 60) == grouper.GroupResult(scanned=1, closed=1, to_send=1,
                                                   waiting=False)
    assert outcomes(store) == [("pack", "c-1", 2, "pending")]


def test_decide_now_groups_the_backlog_first(store, tmp_path, monkeypatch):
    monkeypatch.setattr(grouper, "BATCH", 2)
    dock(store)
    batch(store, [("CC01", 0), ("AA01", 0.5), ("AA02", 1), ("AA03", 1.5), ("AA01", 2)])
    # three ticks (2 + 2 + 1 reads), long before the idle decision at 2 + 2W + 1 s
    assert grouper.decide_now(store, now=at(2)) == grouper.GroupResult(
        scanned=5, closed=1, to_send=1, waiting=False)
    assert decided(store) == [("pack", "c-1", ["a-1", "a-2", "a-3"])]

    cold = Store(tmp_path / "cold.db")
    try:
        set_setup(cold)                           # a Dock whose move data isn't cached yet
        as_station(cold, "dock")
        state.save_settings(cold, dry_run=False)
        read(cold, "AA01", 0)
        assert grouper.decide_now(cold, now=at(1)) == grouper.GroupResult(
            scanned=0, closed=0, to_send=0, waiting=True)
        assert passes(cold) == []
    finally:
        cold.close()


def test_late_reads_after_stop_open_a_new_burst(store):
    dock(store)
    batch(store, [("AA01", 0), ("CC01", 1)])
    group(store, 1)
    assert grouper.decide_now(store, now=at(2)).closed == 1
    [stopped] = passes(store)
    stopped_tags, stopped_reads = tags(store, stopped), read_ids(store, stopped)
    late = read(store, "AA02", 1.5, received=3)  # read before Stop, posted after it
    group(store, 3)
    again, late_burst = passes(store)
    assert again == stopped
    assert tags(store, again) == stopped_tags and read_ids(store, again) == stopped_reads
    assert late_burst["closed_at"] is None and when(late_burst["opened_at"]) == at(1.5)
    assert tags(store, late_burst) == [("AA02", "asset", "a-2", "SN2")]
    assert read_ids(store, late_burst) == [late]
    group(store, 14)                              # its own rule: no crate in it
    assert decided(store) == [("pack", "c-1", ["a-1"]), ("no_crate", None, ["a-2"])]


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
    laptop_setup.save(store, SETUP, "dock")       # same move, straight from RFID: no tick
    assert group(store, 20) == grouper.GroupResult(scanned=0, closed=0, to_send=0,
                                                   waiting=False)
    assert cursor(store) == last and passes(store) == []
    batch(store, [("AA03", 30), ("CC02", 30.5)])  # read on the Dock
    group(store, 41)
    [p] = passes(store)
    assert [t[0] for t in tags(store, p)] == ["AA03", "CC02"]
    assert outcomes(store) == [("pack", "c-2", 1, "pending")]
    as_station(store, "rfid")                     # off a Dock the grouper skips by itself
    last = read(store, "AA01", 50, setup=rfid)
    assert group(store, 60) == grouper.GroupResult(scanned=0, closed=0, to_send=0,
                                                   waiting=False)
    assert cursor(store) == last and len(passes(store)) == 1
    store.run("UPDATE laptop_setup SET setup_json = ? WHERE id = 1",
              (json.dumps({**DOCK, "initiative_id": None}),))     # a Dock with no move
    last = read(store, "AA01", 70, setup=None)
    group(store, 80)
    assert cursor(store) == last and len(passes(store)) == 1
