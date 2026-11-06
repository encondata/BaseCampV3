"""The Dock overview's open burst as the Dock screen shows it (dock station
spec, "The crate window"): the crates read so far by first read, whether two
will be flagged together, how many assets the newest crate holds, and for
each asset its serial (from the move's cached data) and whether it is inside
a crate's window. It is worked out with the grouper's own window test, so the
screen agrees with what deciding the burst packs. W = 5 s throughout."""

from itertools import cycle

import pytest

from edge.db import Store
from edge.dock import views
from tests.test_dock_grouper import ASSETS, at, batch, dock, group, passes, read, tags
from tests.test_rfid_alarm import client_asset
from tests.test_rfid_processing import MOVE, set_cache

JANE = {"id": "p-1", "display_name": "Jane Doe", "rfid_tag": "BB01"}


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "edge.db")
    yield s
    s.close()


def stamp(seconds: float) -> str:
    """A read time as the overview gives it: UTC ISO with milliseconds."""
    return at(seconds).isoformat(timespec="milliseconds")


def open_pass(store, seconds: float) -> dict:
    return views.overview(store, at(seconds))["open"]


def shown(store, seconds: float, *fields) -> dict:
    """epc -> the given fields of each tag in the open burst."""
    return {t["epc"]: tuple(t[f] for f in fields) for t in open_pass(store, seconds)["tags"]}


def test_open_pass_shows_the_spec_example(store):
    dock(store)
    for epc, s in (("AA01", 0), ("CC01", 2), ("AA02", 6), ("AA03", 8)):
        read(store, epc, s)
    group(store, 8)
    body = open_pass(store, 9)
    assert body["window_s"] == 5
    assert body["crates"] == [{"epc": "CC01", "label": "Crate 1", "first_read_at": stamp(2)}]
    assert body["conflict"] is False and body["added_count"] == 2
    assert (body["crate_count"], body["asset_count"]) == (1, 3)
    assert body["tags"] == [
        {"epc": "AA01", "kind": "asset", "label": "Server 1", "first_read_at": stamp(0),
         "serial": "SN1", "in_window": True, "crate_label": "Crate 1"},
        {"epc": "CC01", "kind": "container", "label": "Crate 1", "first_read_at": stamp(2),
         "serial": None, "in_window": None, "crate_label": None},
        {"epc": "AA02", "kind": "asset", "label": "SN2", "first_read_at": stamp(6),
         "serial": "SN2", "in_window": True, "crate_label": "Crate 1"},
        {"epc": "AA03", "kind": "asset", "label": "A-3", "first_read_at": stamp(8),
         "serial": None, "in_window": False, "crate_label": None}]


def test_open_pass_before_a_crate_is_read(store):
    dock(store, people=[JANE])
    batch(store, [("AA01", 0), ("BB01", 0.5), ("AA02", 1)])
    group(store, 1)
    body = open_pass(store, 2)
    assert body["crates"] == [] and body["conflict"] is False and body["added_count"] == 0
    fields = ("kind", "serial", "in_window", "crate_label")
    assert shown(store, 2, *fields) == {"AA01": ("asset", "SN1", None, None),
                                        "BB01": ("person", None, None, None),
                                        "AA02": ("asset", "SN2", None, None)}
    read(store, "CC01", 4)                        # the crate: each asset is in its window or not
    group(store, 4)
    assert shown(store, 5, *fields) == {"AA01": ("asset", "SN1", True, "Crate 1"),
                                        "BB01": ("person", None, None, None),
                                        "AA02": ("asset", "SN2", True, "Crate 1"),
                                        "CC01": ("container", None, None, None)}
    assert open_pass(store, 5)["added_count"] == 2


def test_open_pass_serials_come_from_the_move_cache(store):
    dock(store, client=[client_asset(1)])
    batch(store, [("AA01", 0), ("AA02", 0.5), ("AA03", 0.7), ("EE01", 1)])
    group(store, 1)
    # off-move (EE01) is not one of the move's assets: no serial, like a person
    assert shown(store, 2, "serial") == {"AA01": ("SN1",), "AA02": ("SN2",), "AA03": (None,),
                                         "EE01": (None,)}
    set_cache(store, "assets", {"initiative_id": MOVE, "assets": [
        {**ASSETS[0], "serial_number": "SN1-B"},             # re-synced with a new serial
        {**ASSETS[1], "rfid": "AA09"},                       # its tag moved to another asset
        {"id": "a-9", "asset_id": "A-9", "serial_number": "SN9", "rfid": "AA02"},
        {**ASSETS[2], "serial_number": "SN3"}]})
    assert shown(store, 2, "serial") == {"AA01": ("SN1-B",), "AA02": (None,), "AA03": ("SN3",),
                                         "EE01": (None,)}
    store.run("DELETE FROM cache")                # the move's data gone: still answers
    assert shown(store, 2, "serial") == {"AA01": (None,), "AA02": (None,), "AA03": (None,),
                                         "EE01": (None,)}


@pytest.mark.parametrize("reads", [
    [("AA01", 0), ("CC01", 2), ("AA02", 6), ("AA03", 8)],                    # the spec's example
    [("AA01", 0), ("CC01", 5), ("AA02", 10), ("AA03", 10.2)],                # W either side
    [("AA01", 0), ("CC01", 2), ("AA02", 8), ("CC02", 15), ("AA03", 16)],     # two crates apart
    [("CC01", 0), ("AA01", 1), ("CC02", 7), ("AA02", 8), ("AA03", 13.5)],    # two within 2W
    [("CC01", 0), ("AA01", 1), ("AA02", 6), ("AA01", 10), ("CC02", 11),      # an asset in both
     ("AA03", 12)],                                                          # windows
], ids=["spec", "edges", "apart", "within_2w", "shared_asset"])
def test_open_pass_window_status_matches_the_decision(store, reads):
    dock(store)
    for epc, s in reads:
        read(store, epc, s)
    last = reads[-1][1]
    group(store, last)
    body = open_pass(store, last)
    assert group(store, last + 11).closed          # decided: 2W + 1 s after the last read
    landed = {t[0]: (p["outcome"], p["container_name"])
              for p in passes(store) for t in tags(store, p) if t[1] == "asset"}
    assets = {t["epc"]: t for t in body["tags"] if t["kind"] == "asset"}
    assert set(assets) == set(landed)
    for epc, t in assets.items():
        outcome, crate = landed[epc]
        if t["in_window"]:   # packed into the crate shown, or flagged with it
            assert (outcome, crate) in (("pack", t["crate_label"]), ("many_crates", None)), epc
        else:                # outside every window: "No crate read"
            assert t["in_window"] is False and outcome == "no_crate", epc
    assert body["conflict"] == any(o == "many_crates" for o, _ in landed.values())


def test_open_pass_reports_crates_and_conflict(store):
    dock(store)

    def crates(seconds):
        return [(c["epc"], c["label"], c["first_read_at"])
                for c in open_pass(store, seconds)["crates"]]

    # 7 s apart, posted newest first: listed by first read, flagged together
    batch(store, [("CC02", 7), ("CC01", 0), ("AA01", 1), ("AA02", 8)])
    group(store, 8)
    assert crates(9) == [("CC01", "Crate 1", stamp(0)), ("CC02", "Crate 2", stamp(7))]
    body = open_pass(store, 9)
    assert body["conflict"] is True and body["added_count"] == 1     # AA02, in Crate 2's window
    assert shown(store, 9, "in_window", "crate_label")["AA01"] == (True, "Crate 1")
    assert shown(store, 9, "in_window", "crate_label")["AA02"] == (True, "Crate 2")

    # 13 s apart: decided separately
    batch(store, [("CC01", 100), ("AA02", 108), ("CC02", 113)])
    group(store, 113)
    assert crates(114) == [("CC01", "Crate 1", stamp(100)), ("CC02", "Crate 2", stamp(113))]
    body = open_pass(store, 114)
    assert body["conflict"] is False and body["added_count"] == 1    # W after Crate 2, inclusive
    assert shown(store, 114, "crate_label")["AA02"] == ("Crate 2",)

    # exactly 2W apart: flagged
    batch(store, [("CC01", 200), ("CC02", 210)])
    group(store, 210)
    assert open_pass(store, 211)["conflict"] is True

    # 11 s apart, but an asset read in both windows flags them, as the decision does
    batch(store, [("CC01", 300), ("AA01", 301), ("AA01", 310), ("CC02", 311)])
    group(store, 311)
    body = open_pass(store, 312)
    assert body["conflict"] is True and body["added_count"] == 1
    assert shown(store, 312, "crate_label")["AA01"] == ("Crate 2",)   # the newest holding it


def test_open_pass_with_many_reads(store, tmp_path):
    reads = [("AA01", 0), ("CC01", 2), ("AA03", 8)]
    again = [(epc, s + 0.001 * (n // 3 + 1)) for n, (epc, s) in zip(range(200), cycle(reads))]

    def counted(s):
        """The open pass and how many statements the overview ran (its move
        indexes already warm)."""
        views.overview(s, at(9))
        seen = []
        s.conn.set_trace_callback(seen.append)
        try:
            return open_pass(s, 9), len(seen)
        finally:
            s.conn.set_trace_callback(None)

    few = Store(tmp_path / "few.db")
    try:
        for s, extra in ((few, []), (store, again)):
            dock(s)
            batch(s, reads, received=8)
            if extra:
                batch(s, extra, received=8)
            group(s, 8)
        assert store.one("SELECT COUNT(*) AS n FROM dock_pass_reads")["n"] == 203
        (many_body, many_n), (few_body, few_n) = counted(store), counted(few)
        assert many_body == few_body and many_n == few_n
        assert many_body["added_count"] == 1
        assert shown(store, 9, "in_window")["AA03"] == (False,)
    finally:
        few.close()
