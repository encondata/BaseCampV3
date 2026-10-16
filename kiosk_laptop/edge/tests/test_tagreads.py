import json

import pytest

from edge.db import Store
from edge.rfid import tagreads
from edge.rfid.tagreads import normalize_epc, parse_events, store_batch
from fake_reader import tag_event


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "edge.db")
    yield s
    s.close()


def test_normalize_epc():
    assert normalize_epc(" e2 80 11 ") == "E28011"
    assert normalize_epc("") is None
    assert normalize_epc("xyz") is None
    assert normalize_epc("A" * 129) is None
    assert normalize_epc("A" * 128) == "A" * 128
    assert normalize_epc(123) is None
    assert normalize_epc(None) is None


def test_single_object_is_one_row():
    rows, skipped = parse_events(tag_event("e2801160"))
    assert skipped == 0 and len(rows) == 1
    assert rows[0]["epc"] == "E2801160"
    assert rows[0]["antenna"] == 1
    assert rows[0]["peak_rssi"] == -52.0
    assert rows[0]["event_type"] == "SIMPLE"
    assert rows[0]["read_at"] == "2026-10-16T14:03:22.512+0000"


def test_mixed_batch_stores_good_events():
    body = [tag_event("AA01"), {"type": "HEARTBEAT", "data": {}}, tag_event("not-hex"), "junk"]
    rows, skipped = parse_events(body)
    assert len(rows) == 1 and skipped == 3


def test_non_numeric_fields_become_null():
    event = tag_event("AA01", antenna="x", peakRssi=None, timestamp="t" * 65)
    event["data"]["peakRssi"] = None
    event["data"].pop("peak_rssi", None)
    rows, _ = parse_events(event)
    assert rows[0]["antenna"] is None and rows[0]["peak_rssi"] is None
    assert rows[0]["read_at"] is None


def test_parse_events_rejects_scalars():
    with pytest.raises(ValueError):
        parse_events(5)


def test_store_batch_writes_rows_and_summary(store):
    rows, _ = parse_events([tag_event("AA01", reads=3), tag_event("aa01", reads=0),
                            tag_event("BB02")])
    assert store_batch(store, reader_serial="R1", rows=rows, setup=None,
                       received_at="2026-10-16T14:00:00+00:00") == 3
    assert store.one("SELECT COUNT(*) AS n FROM raw_tag_reads")["n"] == 3
    assert store.one("SELECT COUNT(*) AS n FROM rfid_tags_seen")["n"] == 2
    seen = store.one("SELECT * FROM rfid_tags_seen WHERE epc = 'AA01'")
    assert seen["total_reads"] == 4 and seen["first_seen"] <= seen["last_seen"]
    assert seen["reader_serial"] == "R1" and seen["last_antenna"] == 1


def test_summary_keeps_first_seen_across_batches(store):
    rows, _ = parse_events(tag_event("AA01"))
    store_batch(store, reader_serial="R1", rows=rows, setup=None, received_at="2026-10-16T14:00:00+00:00")
    store_batch(store, reader_serial="R1", rows=rows, setup=None, received_at="2026-10-16T15:00:00+00:00")
    seen = store.one("SELECT * FROM rfid_tags_seen")
    assert seen["first_seen"] == "2026-10-16T14:00:00+00:00"
    assert seen["last_seen"] == "2026-10-16T15:00:00+00:00"
    assert seen["total_reads"] == 2


def test_rows_carry_setup_snapshot(store):
    rows, _ = parse_events([tag_event("AA01"), tag_event("BB02")])
    setup = {"initiative_id": "m-1", "site_id": "s-1", "scan_status": "rfid_in"}
    store_batch(store, reader_serial="R1", rows=rows, setup=setup)
    for r in store.all("SELECT * FROM raw_tag_reads"):
        assert (r["initiative_id"], r["site_id"], r["scan_status"]) == ("m-1", "s-1", "rfid_in")


def test_rows_without_setup_have_null_context(store):
    rows, _ = parse_events(tag_event("AA01"))
    store_batch(store, reader_serial="R1", rows=rows, setup=None)
    r = store.one("SELECT * FROM raw_tag_reads")
    assert r["initiative_id"] is None and r["site_id"] is None and r["scan_status"] is None
    assert r["received_at"]


def test_raw_json_round_trips(store):
    event = tag_event("AA01", channel=915.25, vendorThing="kept")
    rows, _ = parse_events(event)
    assert json.loads(rows[0]["raw_json"]) == event
    store_batch(store, reader_serial="R1", rows=rows, setup=None)
    assert json.loads(store.one("SELECT raw_json FROM raw_tag_reads")["raw_json"]) == event


def test_failed_batch_rolls_back(store, monkeypatch):
    rows, _ = parse_events([tag_event("AA01"), tag_event("BB02")])
    rows[1]["epc"] = None  # NOT NULL violation on the second insert
    with pytest.raises(Exception):
        store_batch(store, reader_serial="R1", rows=rows, setup=None)
    assert store.one("SELECT COUNT(*) AS n FROM raw_tag_reads")["n"] == 0
    assert store.one("SELECT COUNT(*) AS n FROM rfid_tags_seen")["n"] == 0
