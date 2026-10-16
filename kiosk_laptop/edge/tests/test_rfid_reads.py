import json
from datetime import UTC, datetime

import pytest

from conftest import make_session
from edge import laptop_setup
from edge.db import Store, now_iso
from edge.rfid import tagreads
from edge.rfid.tagreads import reads_summary

CACHE_KEY = "/kiosk/sync/assets?initiative_id=m-1"
NOW = datetime(2026, 10, 16, 15, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def clear_memo():
    tagreads._asset_index.clear()
    yield
    tagreads._asset_index.clear()


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "edge.db")
    yield s
    s.close()


def seed_setup(store, move="m-1"):
    laptop_setup.save(store, {"initiative_id": move, "initiative_name": "Move",
                              "site_id": "s-1", "site_name": "Site", "site_role": "origin",
                              "scan_status": "scanned", "scan_status_label": "Scanned"}, "rfid")


def seed_cache(store, assets, key=CACHE_KEY, stored_at="2026-10-16T10:00:00+00:00"):
    body = json.dumps({"initiative_id": "m-1", "assets": assets})
    store.run("INSERT OR REPLACE INTO cache (key, status, body, stored_at) VALUES (?, 200, ?, ?)",
              (key, body, stored_at))


def asset(rfid, serial="SN", name="Name", make_model="Make Model"):
    return {"id": "a", "rfid": rfid, "serial_number": serial, "name": name,
            "make_model": make_model}


def read(store, epc, received_at=None):
    tagreads.store_batch(store, reader_serial="r1", received_at=received_at,
                         setup=None, rows=[{
                             "read_at": None, "epc": epc, "antenna": 1, "peak_rssi": -52.0,
                             "reads": 1, "channel": None, "phase": None, "event_num": None,
                             "event_type": None, "raw_json": "{}"}])


def seen_at(store, epc, last_seen):
    store.run("INSERT INTO rfid_tags_seen (epc, first_seen, last_seen, total_reads, "
              "reader_serial) VALUES (?, ?, ?, 1, 'r1')", (epc, last_seen, last_seen))


async def test_reads_needs_a_session(client):
    assert (await client.get("/edge/rfid/reads")).status_code == 401


async def test_reads_route_returns_summary(app, client):
    r = await client.get("/edge/rfid/reads?tz=America/Chicago", headers=make_session(app))
    assert r.status_code == 200
    assert r.json()["tags_today"] == 0


def test_reads_without_setup_or_cache(store):
    out = reads_summary(store, now=NOW)
    assert out == {"tags_today": 0, "move_total": None, "move_seen": None, "recent": [],
                   "last_received_at": None}
    read(store, "AA01")
    out = reads_summary(store, now=NOW)
    assert out["move_total"] is None and out["move_seen"] is None
    assert len(out["recent"]) == 1 and out["recent"][0]["asset"] is None
    assert out["last_received_at"] is not None


def test_setup_without_cache_has_null_counts(store):
    seed_setup(store)
    out = reads_summary(store, now=NOW)
    assert out["move_total"] is None and out["move_seen"] is None


def test_tags_today_uses_local_midnight(store):
    seen_at(store, "AA01", "2026-10-16T04:30:00+00:00")  # 23:30 on 10-15 in Chicago
    seen_at(store, "AA02", "2026-10-16T05:30:00+00:00")
    assert reads_summary(store, tz="America/Chicago", now=NOW)["tags_today"] == 1
    assert reads_summary(store, tz="UTC", now=NOW)["tags_today"] == 2


def test_midnight_string_matches_stored_format(store):
    # a tag stored by now_iso() at exactly the boundary must count: the cutoff
    # string has to be formatted like now_iso() ("+00:00", seconds precision)
    seen_at(store, "AA01", "2026-10-16T00:00:00+00:00")
    assert reads_summary(store, tz="UTC", now=NOW)["tags_today"] == 1
    assert now_iso().endswith("+00:00")
    assert tagreads.local_midnight_iso("UTC", NOW) == "2026-10-16T00:00:00+00:00"


def test_move_progress_from_cache(store):
    seed_setup(store)
    seed_cache(store, [asset("AA01"), asset("bb 02"), asset("CC03"), asset(None)])
    seen_at(store, "AA01", now_iso())
    seen_at(store, "BB02", now_iso())
    seen_at(store, "ZZ99", now_iso())
    out = reads_summary(store, now=NOW)
    assert out["move_total"] == 4 and out["move_seen"] == 2


def test_asset_match_ignores_case_and_spaces(store):
    seed_setup(store)
    seed_cache(store, [asset("e2 80 11 aa", serial="S1", name="N1", make_model="HPE")])
    read(store, "E28011AA")
    out = reads_summary(store, now=NOW)
    assert out["recent"][0]["asset"] == {"serial_number": "S1", "name": "N1",
                                         "make_model": "HPE"}
    assert set(out["recent"][0]) == {"epc", "received_at", "antenna", "peak_rssi", "asset"}


def test_unknown_tag_has_null_asset(store):
    seed_setup(store)
    seed_cache(store, [asset("AA01")])
    read(store, "BB02")
    assert reads_summary(store, now=NOW)["recent"][0]["asset"] is None


def test_recent_is_newest_50(store):
    for i in range(60):
        read(store, f"AA{i:02X}")
    recent = reads_summary(store, now=NOW)["recent"]
    assert len(recent) == 50
    assert recent[0]["epc"] == "AA3B"


@pytest.mark.parametrize("tz", ["Not/AZone", "", None, 5])
def test_bad_tz_falls_back_to_utc(store, tz):
    seen_at(store, "AA01", "2026-10-16T00:30:00+00:00")
    assert reads_summary(store, tz=tz, now=NOW)["tags_today"] == 1


def test_index_refreshes_when_cache_changes(store):
    seed_setup(store)
    seed_cache(store, [asset("AA01", name="Old")])
    read(store, "AA01")
    assert reads_summary(store, now=NOW)["recent"][0]["asset"]["name"] == "Old"
    seed_cache(store, [asset("AA01", name="New")], stored_at="2026-10-16T11:00:00+00:00")
    assert reads_summary(store, now=NOW)["recent"][0]["asset"]["name"] == "New"


def test_move_seen_with_many_unrelated_tags(store):
    seed_setup(store)
    seed_cache(store, [asset("AA01"), asset("BB02"), asset("CC03")])
    for i in range(1200):
        seen_at(store, f"F{i:05X}", now_iso())
    seen_at(store, "AA01", now_iso())
    seen_at(store, "CC03", now_iso())
    out = reads_summary(store, now=NOW)
    assert out["move_total"] == 3 and out["move_seen"] == 2


def test_move_seen_over_chunk_boundary(store):
    seed_setup(store)
    seed_cache(store, [asset(f"A{i:04X}") for i in range(1100)])
    for i in range(0, 1100, 2):
        seen_at(store, f"A{i:04X}", now_iso())
    assert reads_summary(store, now=NOW)["move_seen"] == 550


def test_malformed_cache_is_memoized_as_null(store):
    seed_setup(store)
    store.run("INSERT INTO cache (key, status, body, stored_at) VALUES (?, 200, ?, ?)",
              (CACHE_KEY, '{"assets": "nope"}', "2026-10-16T10:00:00+00:00"))
    assert reads_summary(store, now=NOW)["move_total"] is None
    assert len(tagreads._asset_index) == 1
    assert reads_summary(store, now=NOW)["move_total"] is None
