import dataclasses
import os
import random
import uuid

import pytest

from loadtest.ids import make_tags
from loadtest import journal as journal_mod
from loadtest.journal import JOURNAL_NAME, Journal, find_unfinished, load_state, start_entry
from loadtest.state import Container, RunState, Server, Truck


def make_state(url="http://localhost:8000") -> RunState:
    tags = make_tags(random.Random(1), 3)
    return RunState(
        run_id=uuid.UUID(int=7), server_url=url, move_id="m1", move_name="Move",
        profile_name="fast", profile_raw={"a": {"b": [1, 2.5]}},
        origin_site_id="s1", destination_site_id="s2",
        route=[(40.0, -75.0), (41.5, -74.25)], started_at=1000.0,
        # deliberately not alphabetical: order must survive the round trip
        servers={sid: Server(sid, f"SN-{sid}", t) for sid, t in zip(["z", "a", "m"], tags)},
        containers={"c1": Container("c1", "Crate 1")},
        trucks={"t1": Truck("t1", "Truck 1")},
    )


ENTRIES = [
    {"t": "stage_done", "at": 1001.0, "stage": "receive", "servers": ["z", "a", "m"], "ok": True},
    {"t": "packed", "at": 1002.0, "stage": "pack", "server": "z", "container": "c1", "ok": True},
    {"t": "packed", "at": 1003.0, "stage": "pack", "server": "a", "container": "c1", "ok": False},
    {"t": "container_closed", "at": 1004.0, "container": "c1"},
    {"t": "loaded", "at": 1005.0, "container": "c1", "truck": "t1", "ok": True},
    {"t": "departed", "at": 1006.0, "truck": "t1"},
    {"t": "location", "at": 1007.0, "truck": "t1", "index": 5, "ok": True},
    {"t": "interrupted", "at": 1008.0},
    {"t": "resumed", "at": 1009.0},
    {"t": "location_skipped", "at": 1009.5, "truck": "t1", "through": 8, "count": 3},
    {"t": "arrived", "at": 1010.0, "truck": "t1"},
    {"t": "unloaded", "at": 1011.0, "container": "c1", "ok": True},
    {"t": "unpacked", "at": 1012.0, "stage": "unpack", "server": "z", "container": "c1", "ok": True},
    {"t": "run_finished", "at": 1013.0, "reason": "completed"},
]


def write(path, state, entries):
    j = Journal(path)
    j.append(start_entry(state))
    for e in entries:
        j.append(e)
    j.close()


def test_round_trip(tmp_path):
    expected = make_state()
    for e in ENTRIES:
        expected.apply(e)
    path = tmp_path / JOURNAL_NAME
    write(path, make_state(), ENTRIES)
    got = load_state(path)
    assert got == expected
    assert list(got.servers) == ["z", "a", "m"]
    assert isinstance(got.route[0], tuple) and got.interruptions == [(1008.0, 1009.0)]
    assert got.containers["c1"].unpacked == {"z"}
    assert got.finished == "completed" and got.servers["a"].done["pack"] is False
    assert got.servers["a"].container_id == "c1"
    assert got.trucks["t1"].updates_sent == 5 and got.trucks["t1"].updates_skipped == 3
    assert got.trucks["t1"].skipped_through == 8


def test_torn_last_line_is_ignored(tmp_path):
    path = tmp_path / JOURNAL_NAME
    write(path, make_state(), ENTRIES[:3])
    before = load_state(path)
    with open(path, "ab") as fh:
        fh.write(b'{"t":"packed","at":10')
    assert load_state(path) == before
    # reopening repairs the tail so the next entry is not glued onto the torn one
    j = Journal(path)
    j.append(ENTRIES[3])
    j.close()
    assert load_state(path).containers["c1"].closed


def test_damaged_middle_line_raises(tmp_path):
    path = tmp_path / JOURNAL_NAME
    write(path, make_state(), ENTRIES[:2])
    lines = path.read_bytes().split(b"\n")
    lines.insert(1, b"garbage")
    path.write_bytes(b"\n".join(lines))
    with pytest.raises(ValueError):
        load_state(path)


def test_apply_is_idempotent():
    for e in ENTRIES:
        once, twice = make_state(), make_state()
        once.apply(e)
        twice.apply(e)
        twice.apply(e)
        assert dataclasses.asdict(once) == dataclasses.asdict(twice), e["t"]


FAILED_STEPS = [
    {"t": "loaded", "at": 1.0, "container": "c1", "truck": "t1", "ok": False},
    {"t": "departed", "at": 2.0, "truck": "t1", "ok": False},
    {"t": "location", "at": 3.0, "truck": "t1", "index": 1, "ok": False},
    {"t": "location", "at": 4.0, "truck": "t1", "index": 2, "ok": True},
    {"t": "location", "at": 5.0, "truck": "t1", "index": 3, "ok": False},
    {"t": "arrived", "at": 6.0, "truck": "t1", "ok": False},
    {"t": "unloaded", "at": 7.0, "container": "c1", "ok": False},
]


def test_failed_truck_and_trip_steps_are_remembered(tmp_path):
    path = tmp_path / JOURNAL_NAME
    write(path, make_state(), FAILED_STEPS)
    got = load_state(path)
    crate, truck = got.containers["c1"], got.trucks["t1"]
    assert crate.load_failed and crate.unload_failed and crate.truck_id == "t1"
    assert truck.depart_failed and truck.arrive_failed and truck.arrived
    assert truck.failed_locations == {1, 3} and truck.updates_sent == 3
    for e in FAILED_STEPS:          # applying an entry again changes nothing
        twice = make_state()
        twice.apply(e)
        once = dataclasses.asdict(twice)
        twice.apply(e)
        assert dataclasses.asdict(twice) == once, e["t"]


def test_truck_steps_without_ok_count_as_landed():
    """Journals written before `departed` and `arrived` carried `ok`."""
    state = make_state()
    for e in ENTRIES:
        state.apply(e)
    crate, truck = state.containers["c1"], state.trucks["t1"]
    assert not (crate.load_failed or crate.unload_failed)
    assert not (truck.depart_failed or truck.arrive_failed or truck.failed_locations)


def test_location_skipped_without_through_still_loads():
    state = make_state()
    state.apply({"t": "location_skipped", "at": 1.0, "truck": "t1", "count": 4})
    assert state.trucks["t1"].updates_skipped == 4 and state.trucks["t1"].skipped_through == 0
    state.apply({"t": "location_skipped", "at": 2.0, "truck": "t1", "through": 9, "count": 6})
    state.apply({"t": "location_skipped", "at": 1.5, "truck": "t1", "through": 7, "count": 6})
    assert state.trucks["t1"].skipped_through == 9  # never moves back


def test_unknown_entry_kind_raises():
    with pytest.raises(ValueError):
        make_state().apply({"t": "from_the_future", "at": 1.0})


def test_find_unfinished_picks_the_newest_open_run(tmp_path):
    def run(name, finished):
        d = tmp_path / name
        d.mkdir()
        write(d / JOURNAL_NAME, make_state(), [ENTRIES[-1]] if finished else [])
        return d / JOURNAL_NAME

    run("2026-01-01_000000", True)
    old = run("2026-01-02_000000", False)
    new = run("2026-01-03_000000", False)
    (tmp_path / "2026-01-04_000000").mkdir()  # no journal: not a run
    assert find_unfinished(tmp_path) == new
    assert old != new
    only_done = tmp_path / "done"
    only_done.mkdir()
    run("done/2026-02-01_000000", True)
    assert find_unfinished(only_done) is None
    assert find_unfinished(tmp_path / "missing") is None


def test_find_unfinished_skips_a_folder_without_run_started(tmp_path):
    d = tmp_path / "2026-01-01_000000"
    d.mkdir()
    (d / JOURNAL_NAME).write_bytes(b'{"t":"run_st')
    assert find_unfinished(tmp_path) is None


def test_journal_never_holds_secrets():
    with pytest.raises(ValueError):
        start_entry(make_state("https://user:pw@example.com"))
    with pytest.raises(ValueError):
        start_entry(make_state("https://user@example.com"))


def test_append_after_close_and_non_finite_floats(tmp_path):
    j = Journal(tmp_path / JOURNAL_NAME)
    with pytest.raises(ValueError):
        j.append({"t": "location", "at": float("nan")})
    j.close()
    with pytest.raises(ValueError):
        j.append({"t": "arrived", "at": 1.0})


def test_resumed_is_idempotent_and_closes_all_open_interruptions():
    st = make_state()
    st.apply({"t": "interrupted", "at": 1.0})
    st.apply({"t": "interrupted", "at": 2.0})
    st.apply({"t": "resumed", "at": 3.0})
    assert st.interruptions == [(1.0, 3.0), (2.0, 3.0)]
    st.apply({"t": "resumed", "at": 3.0})
    assert st.interruptions == [(1.0, 3.0), (2.0, 3.0)]
    st.apply({"t": "interrupted", "at": 4.0})
    st.apply({"t": "resumed", "at": 5.0})
    st.apply({"t": "resumed", "at": 5.0})
    assert st.interruptions == [(1.0, 3.0), (2.0, 3.0), (4.0, 5.0)]


def test_idempotent_with_an_open_interruption():
    for e in ENTRIES:
        once, twice = make_state(), make_state()
        for s in (once, twice):
            s.apply({"t": "interrupted", "at": 500.0})
        once.apply(e)
        twice.apply(e)
        twice.apply(e)
        assert dataclasses.asdict(once) == dataclasses.asdict(twice), e["t"]


def test_replaying_the_whole_sequence_again_changes_nothing():
    st = make_state()
    for e in ENTRIES:
        st.apply(e)
    snapshot = dataclasses.asdict(st)
    for e in ENTRIES:
        st.apply(e)
    assert dataclasses.asdict(st) == snapshot


def test_fsync_is_throttled_and_close_syncs(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(os, "fsync", lambda fd: calls.append(fd))
    j = Journal(tmp_path / JOURNAL_NAME)
    for i in range(50):
        j.append({"t": "arrived", "at": float(i), "truck": "t1"})
    assert len(calls) < 5
    before = len(calls)
    j.close()
    assert len(calls) == before + 1


def test_fsync_runs_again_after_the_interval(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(os, "fsync", lambda fd: calls.append(fd))
    clock = [100.0]
    monkeypatch.setattr(journal_mod.time, "monotonic", lambda: clock[0])
    j = Journal(tmp_path / JOURNAL_NAME)
    j.append({"t": "arrived", "at": 1.0, "truck": "t1"})
    assert calls == []
    clock[0] += 1.5
    j.append({"t": "arrived", "at": 2.0, "truck": "t1"})
    assert len(calls) == 1
    j.close()


def test_bad_last_line_with_newline_is_repaired(tmp_path):
    path = tmp_path / JOURNAL_NAME
    write(path, make_state(), ENTRIES[:2])
    before = load_state(path)
    with open(path, "ab") as fh:
        fh.write(b"garbage\n")
    assert load_state(path) == before
    j = Journal(path)
    j.append(ENTRIES[3])
    j.close()
    assert load_state(path).containers["c1"].closed


def test_server_url_with_query_or_fragment_is_refused():
    for url in ("https://example.com/?token=abc", "https://example.com/#frag"):
        with pytest.raises(ValueError):
            start_entry(make_state(url))
