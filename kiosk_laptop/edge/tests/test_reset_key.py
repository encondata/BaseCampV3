"""`python -m edge reset-key`: the DB cleanup runs first and edge.key is
unlinked last, so a failed cleanup never leaves a new key beside tokens
encrypted under the old one."""

import sqlite3
import sys

import pytest

from edge import __main__ as cli
from edge.crypto import KEY_FILE, load_or_create_keys
from edge.db import Store


def _run(monkeypatch, data_dir):
    monkeypatch.setattr(sys, "argv", ["edge", "reset-key", "--data-dir", str(data_dir)])
    cli.main()


def _prepare(tmp_path):
    load_or_create_keys(tmp_path)
    store = Store(tmp_path / "edge.db")
    store.run("INSERT INTO cloud_sessions (person_id, refresh_enc, ending, updated_at) "
              "VALUES ('p-1', 'x', 0, 'now')")
    store.run("INSERT INTO outbox (kind, person_id, person_name, payload, next_attempt_at, "
              "created_at) VALUES ('scan', 'p-1', 'Jane', '{}', 'now', 'now')")
    store.close()


def test_reset_key_clears_tokens_then_removes_key(tmp_path, monkeypatch):
    _prepare(tmp_path)
    _run(monkeypatch, tmp_path)
    assert not (tmp_path / KEY_FILE).exists()
    conn = sqlite3.connect(tmp_path / "edge.db")
    assert conn.execute("SELECT COUNT(*) FROM cloud_sessions").fetchone()[0] == 0
    assert conn.execute("SELECT status FROM outbox").fetchone()[0] == "needs_sign_in"
    conn.close()


def test_failed_cleanup_keeps_the_key(tmp_path, monkeypatch):
    _prepare(tmp_path)

    def boom(*a, **kw):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(cli.sqlite3, "connect", boom)
    with pytest.raises(sqlite3.OperationalError):
        _run(monkeypatch, tmp_path)
    assert (tmp_path / KEY_FILE).exists()
