import sqlite3

import pytest

from edge.db import SCHEMA_STEPS, Store, iso


def test_schema_created_and_versioned(tmp_path):
    store = Store(tmp_path / "edge.db")
    tables = {r["name"] for r in store.all("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"edge_sessions", "cloud_sessions", "offline_logins", "login_failures",
            "move_passwords", "cache", "sync_meta", "outbox", "schema_version"} <= tables
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
