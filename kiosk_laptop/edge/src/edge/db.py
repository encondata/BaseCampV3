"""The edge's SQLite store. One connection shared across the app behind a
lock (sqlite is fast enough locally that handlers call it inline). Schema
is a list of SQL steps; `schema_version` records how many have run, so an
upgraded image only applies the new ones."""

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

# Steps must be additive (new tables, new nullable columns). After a
# rollback an older image keeps running on a database a newer image already
# migrated, so nothing an older image reads or writes may be renamed,
# dropped or tightened, and `schema_version` never goes down.
SCHEMA_STEPS: list[str] = [
    """
    CREATE TABLE edge_sessions (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL, refresh_hash TEXT NOT NULL UNIQUE,
        offline INTEGER NOT NULL, session_json TEXT NOT NULL, expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE cloud_sessions (
        person_id TEXT PRIMARY KEY, refresh_enc TEXT NOT NULL, access_enc TEXT,
        access_expires_at TEXT, ending INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE offline_logins (
        email TEXT PRIMARY KEY, person_id TEXT NOT NULL, verifier TEXT NOT NULL,
        session_json TEXT NOT NULL, cached_at TEXT NOT NULL);
    CREATE TABLE login_failures (key TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE move_passwords (
        initiative_id TEXT PRIMARY KEY, name TEXT NOT NULL, verifier TEXT NOT NULL,
        session_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE cache (
        key TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, stored_at TEXT NOT NULL);
    CREATE TABLE sync_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1), initiative_id TEXT, actor_person_id TEXT,
        synced_at TEXT, last_error TEXT);
    CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, person_id TEXT NOT NULL,
        person_name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT,
        created_at TEXT NOT NULL, dedupe_key TEXT UNIQUE);
    CREATE INDEX outbox_due ON outbox (status, next_attempt_at);
    """,
    # the cloud's move-password version, sent back as `have=` (unchanged → no rehash)
    "ALTER TABLE move_passwords ADD COLUMN version TEXT",
    # RFID station: readers this laptop has signed in to (only the winning
    # password's index, never a password) and the one it is paired with
    """
    CREATE TABLE rfid_readers (
        serial TEXT PRIMARY KEY, ip TEXT NOT NULL, model TEXT, versions TEXT,
        password_index INTEGER, token TEXT, laptop_ip TEXT, paired_at TEXT);
    CREATE TABLE rfid_pairing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        serial TEXT NOT NULL REFERENCES rfid_readers (serial));
    """,
    # where each reader answers: https 443 or http 80 (reused by connect and pair)
    """
    ALTER TABLE rfid_readers ADD COLUMN scheme TEXT;
    ALTER TABLE rfid_readers ADD COLUMN port INTEGER
    """,
    # the laptop's finished Kiosk Setup, shared with every browser (JSON)
    """
    CREATE TABLE laptop_setup (
        id INTEGER PRIMARY KEY CHECK (id = 1), setup_json TEXT NOT NULL,
        updated_at TEXT NOT NULL)
    """,
]


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def iso(value: datetime | str) -> str:
    """Normalize to UTC with seconds precision, so stored times compare as strings."""
    dt = datetime.fromisoformat(value) if isinstance(value, str) else value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).replace(microsecond=0).isoformat()


class Store:
    def __init__(self, path: Path) -> None:
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False,
                                    isolation_level=None, timeout=5.0)
        self.conn.row_factory = sqlite3.Row
        # Only the edge process opens edge.db. Exclusive locking makes WAL
        # keep its index in process memory instead of the -shm file, which
        # is what breaks on Docker Desktop's shared folders (Windows WSL
        # file sharing, macOS VirtioFS). Nothing else may open the file
        # while the edge runs — backups stop the kiosk first.
        self.conn.execute("PRAGMA locking_mode=EXCLUSIVE")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self._migrate()

    def _migrate(self) -> None:
        with self.tx() as c:
            c.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
            row = c.execute("SELECT version FROM schema_version").fetchone()
            current = row[0] if row else 0
            for step in SCHEMA_STEPS[current:]:
                # executescript() would COMMIT the open transaction; run statements singly
                for stmt in step.split(";"):
                    if stmt.strip():
                        c.execute(stmt)
            if row is None:
                c.execute("INSERT INTO schema_version (version) VALUES (?)", (len(SCHEMA_STEPS),))
            elif current < len(SCHEMA_STEPS):
                # an older image (fewer steps) leaves a newer record alone
                c.execute("UPDATE schema_version SET version = ?", (len(SCHEMA_STEPS),))

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            self.conn.execute("COMMIT")

    def one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        with self._lock:
            return self.conn.execute(sql, params).fetchone()

    def all(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.conn.execute(sql, params).fetchall()

    def run(self, sql: str, params: tuple = ()) -> int:
        with self._lock:
            return self.conn.execute(sql, params).rowcount

    def close(self) -> None:
        with self._lock:
            self.conn.close()
