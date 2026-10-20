import sqlite3

import pytest

from edge.db import SCHEMA_STEPS, Store, iso


def test_schema_created_and_versioned(tmp_path):
    store = Store(tmp_path / "edge.db")
    tables = {r["name"] for r in store.all("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"edge_sessions", "cloud_sessions", "offline_logins", "login_failures",
            "move_passwords", "cache", "sync_meta", "outbox", "schema_version",
            "station_status"} <= tables
    assert store.one("SELECT version FROM schema_version")["version"] == len(SCHEMA_STEPS)
    store.close()
    # reopening is a no-op upgrade
    again = Store(tmp_path / "edge.db")
    assert again.one("SELECT version FROM schema_version")["version"] == len(SCHEMA_STEPS)


def test_tx_rolls_back_on_error(tmp_path):
    store = Store(tmp_path / "edge.db")
    with pytest.raises(RuntimeError):
        with store.tx() as c:
            c.execute("INSERT INTO cache(key, status, body, stored_at) VALUES ('k', 200, 'b', 'now')")
            raise RuntimeError("boom")
    assert store.one("SELECT * FROM cache WHERE key='k'") is None


def test_iso_normalizes_to_utc_seconds():
    assert iso("2026-10-01T12:00:00.123456Z") == "2026-10-01T12:00:00+00:00"
    assert iso("2026-10-01T07:00:00-05:00") == "2026-10-01T12:00:00+00:00"


def test_a_version_one_database_upgrades_in_place(tmp_path, monkeypatch):
    from edge import db
    monkeypatch.setattr(db, "SCHEMA_STEPS", SCHEMA_STEPS[:1])
    old = Store(tmp_path / "edge.db")
    old.run("INSERT INTO move_passwords VALUES ('m-1', 'Move', 'v', '{}', 'now')")
    old.close()
    monkeypatch.setattr(db, "SCHEMA_STEPS", SCHEMA_STEPS)
    store = Store(tmp_path / "edge.db")
    row = store.one("SELECT initiative_id, version FROM move_passwords")
    assert (row["initiative_id"], row["version"]) == ("m-1", None)
    assert store.one("SELECT version FROM schema_version")["version"] == len(SCHEMA_STEPS)


def test_store_holds_an_exclusive_lock(tmp_path):
    store = Store(tmp_path / "edge.db")
    store.run("INSERT INTO cache(key, status, body, stored_at) VALUES ('k', 200, 'b', 'now')")
    other = sqlite3.connect(tmp_path / "edge.db", timeout=0.1)
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        other.execute("INSERT INTO cache(key, status, body, stored_at) VALUES ('j', 200, 'b', 'now')")
    other.close()
    assert not (tmp_path / "edge.db-shm").exists()   # WAL index kept in process memory
    store.close()


def test_an_older_image_never_lowers_the_schema_version(tmp_path, monkeypatch):
    # rollback: the newer image migrated to N+1; the older image (N steps)
    # must keep the record at N+1 so the newer image never re-runs a step
    from edge import db
    newer = Store(tmp_path / "edge.db")
    newer.close()
    monkeypatch.setattr(db, "SCHEMA_STEPS", SCHEMA_STEPS[:-1])
    older = Store(tmp_path / "edge.db")
    assert older.one("SELECT version FROM schema_version")["version"] == len(SCHEMA_STEPS)
    older.close()
    monkeypatch.setattr(db, "SCHEMA_STEPS", SCHEMA_STEPS)
    again = Store(tmp_path / "edge.db")   # would fail on a duplicate column if re-run
    assert again.one("SELECT version FROM schema_version")["version"] == len(SCHEMA_STEPS)
    again.close()


def test_schema_step_adds_station_status(tmp_path):
    store = Store(tmp_path / "edge.db")
    store.run("INSERT INTO station_status (id, paused) VALUES (1, 'kiosk_not_registered')")
    assert store.one("SELECT paused FROM station_status")["paused"] == "kiosk_not_registered"
    with pytest.raises(sqlite3.IntegrityError):         # one row only
        store.run("INSERT INTO station_status (id, paused) VALUES (2, NULL)")


def test_labeled_scan_step_keeps_queued_rfid_scans(tmp_path, monkeypatch):
    """The step that rebuilds pending_rfid_scans (nullable raw_read_id, new
    scan_type) carries every queued row over untouched."""
    from edge import db
    monkeypatch.setattr(db, "SCHEMA_STEPS", SCHEMA_STEPS[:-1])
    old = Store(tmp_path / "edge.db")
    old.run("INSERT INTO pending_rfid_scans (raw_read_id, client_scan_id, epc, matched_kind, "
            "matched_id, scanned_at, attempts, last_error, created_at) "
            "VALUES (7, 'c-1', 'E1', 'asset', 'a-1', 't', 3, 'http_500', 'now')")
    old.close()
    monkeypatch.setattr(db, "SCHEMA_STEPS", SCHEMA_STEPS)
    store = Store(tmp_path / "edge.db")
    row = store.one("SELECT * FROM pending_rfid_scans")
    assert (row["id"], row["raw_read_id"], row["client_scan_id"], row["attempts"],
            row["last_error"], row["scan_type"]) == (1, 7, "c-1", 3, "http_500", None)
    with pytest.raises(sqlite3.IntegrityError):           # raw_read_id still unique
        store.run("INSERT INTO pending_rfid_scans (raw_read_id, client_scan_id, epc, "
                  "matched_kind, matched_id, scanned_at, created_at) "
                  "VALUES (7, 'c-2', 'E1', 'asset', 'a-1', 't', 'now')")
    for sid in ("c-3", "c-4"):                            # but NULL never collides
        store.run("INSERT INTO pending_rfid_scans (client_scan_id, epc, matched_kind, "
                  "matched_id, scanned_at, created_at, scan_type) "
                  "VALUES (?, 'B1', 'asset', 'a-1', 't', 'now', 'barcode')", (sid,))
    assert store.one("SELECT MAX(id) AS m FROM pending_rfid_scans")["m"] == 3
    assert store.one("SELECT 1 FROM sqlite_master WHERE name = 'pending_rfid_scans_due'")
    store.close()
