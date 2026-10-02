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
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(cli.sqlite3, "connect", boom)
    with pytest.raises(sqlite3.OperationalError):
        _run(monkeypatch, tmp_path)
    assert (tmp_path / KEY_FILE).exists()


def test_reset_key_takes_an_exclusive_lock_first(tmp_path, monkeypatch):
    _prepare(tmp_path)
    seen = []
    real_connect = sqlite3.connect

    class Spy:
        def __init__(self, conn):
            self._conn = conn

        def execute(self, sql, *a):
            seen.append(sql)
            return self._conn.execute(sql, *a)

        def __enter__(self):
            return self._conn.__enter__() and self

        def __exit__(self, *exc):
            return self._conn.__exit__(*exc)

        def close(self):
            self._conn.close()

    monkeypatch.setattr(cli.sqlite3, "connect", lambda *a, **kw: Spy(real_connect(*a, **kw)))
    _run(monkeypatch, tmp_path)
    assert seen[0] == "PRAGMA locking_mode=EXCLUSIVE"


def test_reset_key_while_the_kiosk_runs_says_stop_it_first(tmp_path, monkeypatch, capsys):
    _prepare(tmp_path)
    running = Store(tmp_path / "edge.db")      # the edge holds its exclusive lock
    running.run("INSERT INTO cache(key, status, body, stored_at) VALUES ('k', 200, 'b', 'now')")
    try:
        with pytest.raises(SystemExit) as exc:
            _run(monkeypatch, tmp_path)
        assert exc.value.code == 1
        out = capsys.readouterr()
        assert ("The kiosk is running — stop it first (see the README's Troubleshooting) "
                "and run reset-key again") in out.out + out.err
        assert "Traceback" not in out.out + out.err
        assert (tmp_path / KEY_FILE).exists()
    finally:
        running.close()
