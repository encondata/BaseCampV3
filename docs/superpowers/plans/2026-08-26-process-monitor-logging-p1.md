# Process Monitor & Logging — Plan 1 (Monitor + Pipeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Process registry with heartbeats and derived status, a Postgres-backed logging pipeline used by every ServerSherpa process, the new log-service worker (retention + web probe; no SIEM forwarding yet), the System→Processes page, and the developer-only live log viewer.

**Architecture:** Each process upserts a heartbeat row every 5 s; status (running/stopped/failed) is derived at read time. A stdlib logging handler batches records to `log_entries` from a dedicated thread with its own small sync engine. The log-service worker enforces retention from the seeded config and probes the portal origin for a synthetic `web` row. FastAPI serves the registry (rank ≥ 80), paged log queries, a 1 s-tailing WebSocket stream, and audited clear (devtools gate). Plan 2 adds the config UI + syslog forwarding.

**Tech Stack:** Alembic/SQLAlchemy/FastAPI (WebSocket)/typer/httpx (api/), React+TypeScript+vitest (portal/).

**Spec:** `docs/superpowers/specs/2026-08-26-process-monitor-logging-design.md` (approved). This plan is the spec's "Plan 1"; config endpoints, System Config page, and syslog forwarding are Plan 2 — do NOT build them here.

## Global Constraints

- Work on branch `feature/initiatives` in `/Users/jrh1812/Developer/BaseCampV3`. Migration numbering: **0024 revises 0023**.
- API tests: `cd api && .venv/bin/pytest tests/<file> -q` (docker stack up: `docker compose -f docker-compose.dev.yml up -d`). Portal: `cd portal && npx vitest run <file>`; `npx tsc --noEmit`.
- Numbers pinned by the spec: heartbeat interval **5 s**; stale threshold **15 s**; handler queue bound **10k** records (drop-oldest); flush batch **200 rows or 1 s**; config re-read **30 s**; log-service tick **10 s**, web probe every 3rd tick; WS tail poll **1 s**, cap 500 rows/message, ping every 30 s idle; logs GET default limit 200, max 1000; seeded logging defaults `{"mode": "local", "local_max_rows_per_process": 20000, "local_max_age_days": 14, "remote_buffer_rows": 10000, "min_level": "INFO", "syslog": {"host": "", "port": 514, "protocol": "udp"}}`.
- Gates: processes list = global actor with `max_rank >= 80`; logs read/stream/clear = `require_permission("devtools", "change")`. Probe processes (kind `probe`) have no logs: 404 `process_has_no_logs`.
- App logs only: handler attaches to the root logger and `uvicorn.error`; NEVER `uvicorn.access`.
- Status is derived, never stored: running = heartbeat < 15 s old and no newer clean stop; stopped = `stopped_at >= heartbeat_at`; failed = stale heartbeat without clean stop.
- Errors use the `_err` code pattern; audit clear as `entity_type="system"`, `action="logs_clear"`.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration 0024 + models + conftest

**Files:**
- Create: `api/migrations/versions/0024_process_monitor_logging.py`
- Modify: `api/src/serversherpa/db/models.py` (append after `ImportJob`)
- Modify: `api/tests/conftest.py` (TRUNCATE list ~line 55; system_config reseed block)
- Test: `api/tests/test_system_models.py`

**Interfaces:**
- Produces ORM classes consumed by every later task:
  - `SystemProcess`: `name` (str PK), `kind` (str), `pid` (int|None), `hostname` (str, default ""), `started_at` (datetime|None), `heartbeat_at` (datetime|None), `stopped_at` (datetime|None), `meta` (dict, JSONB default {}).
  - `LogEntry`: `id` (int PK bigserial), `process` (str), `level` (str), `levelno` (int), `logger` (str, default ""), `message` (str), `extra` (dict JSONB default {}), `at` (datetime default now()).
  - `SystemConfig`: `section` (str PK), `data` (dict JSONB), `updated_at` (datetime default now()), `updated_by` (UUID|None FK people).

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_system_models.py`:

```python
"""0024: processes / log_entries / system_config tables + seeded config."""

from sqlalchemy import select

from serversherpa.db.models import LogEntry, SystemConfig, SystemProcess


async def test_system_process_defaults(db):
    p = SystemProcess(name="api", kind="service")
    db.add(p)
    await db.commit()
    await db.refresh(p)
    assert p.pid is None
    assert p.hostname == ""
    assert p.started_at is None and p.heartbeat_at is None
    assert p.stopped_at is None
    assert p.meta == {}


async def test_log_entry_defaults_and_ordering(db):
    db.add_all([
        LogEntry(process="api", level="INFO", levelno=20, message="one"),
        LogEntry(process="api", level="ERROR", levelno=40, message="two"),
    ])
    await db.commit()
    rows = (await db.scalars(
        select(LogEntry).order_by(LogEntry.id))).all()
    assert [r.message for r in rows] == ["one", "two"]
    assert rows[0].id < rows[1].id            # bigserial cursor
    assert rows[0].logger == ""
    assert rows[0].extra == {}
    assert rows[0].at is not None


async def test_logging_config_seeded(db):
    cfg = await db.get(SystemConfig, "logging")
    assert cfg is not None
    assert cfg.data["mode"] == "local"
    assert cfg.data["local_max_rows_per_process"] == 20000
    assert cfg.data["local_max_age_days"] == 14
    assert cfg.data["remote_buffer_rows"] == 10000
    assert cfg.data["min_level"] == "INFO"
    assert cfg.data["syslog"] == {"host": "", "port": 514, "protocol": "udp"}
    cursor = await db.get(SystemConfig, "logging_cursor")
    assert cursor.data == {"last_forwarded_id": 0}
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_system_models.py -q`
Expected: FAIL with `ImportError: cannot import name 'SystemProcess'`.

- [ ] **Step 3: Write migration 0024**

Create `api/migrations/versions/0024_process_monitor_logging.py`:

```python
"""Process monitor + logging pipeline: the heartbeat registry
(processes), the log store (log_entries), and system_config with the
seeded logging section + forwarding cursor. Status is derived at read
time from heartbeat_at/stopped_at — never stored.

Revision ID: 0024
Revises: 0023
Create Date: 2026-08-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOGGING_DEFAULTS = (
    '{"mode": "local", "local_max_rows_per_process": 20000, '
    '"local_max_age_days": 14, "remote_buffer_rows": 10000, '
    '"min_level": "INFO", '
    '"syslog": {"host": "", "port": 514, "protocol": "udp"}}'
)


def upgrade() -> None:
    op.create_table(
        "processes",
        sa.Column("name", sa.Text, primary_key=True),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("pid", sa.Integer),
        sa.Column("hostname", sa.Text, nullable=False, server_default=""),
        sa.Column("started_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("heartbeat_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("stopped_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("meta", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
    )

    op.create_table(
        "log_entries",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("process", sa.Text, nullable=False),
        sa.Column("level", sa.Text, nullable=False),
        sa.Column("levelno", sa.Integer, nullable=False),
        sa.Column("logger", sa.Text, nullable=False, server_default=""),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("extra", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("log_entries_process_id_idx", "log_entries",
                    ["process", "id"])
    op.create_index("log_entries_process_level_idx", "log_entries",
                    ["process", "levelno", "id"])

    op.create_table(
        "system_config",
        sa.Column("section", sa.Text, primary_key=True),
        sa.Column("data", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id")),
    )
    op.execute(
        "INSERT INTO system_config (section, data) VALUES "
        f"('logging', '{LOGGING_DEFAULTS}'::jsonb), "
        "('logging_cursor', '{\"last_forwarded_id\": 0}'::jsonb)"
    )


def downgrade() -> None:
    op.drop_table("system_config")
    op.drop_table("log_entries")
    op.drop_table("processes")
```

- [ ] **Step 4: Add the ORM classes**

In `api/src/serversherpa/db/models.py`, append after the `ImportJob` class:

```python
class SystemProcess(Base):
    """Heartbeat registry — one row per process name, upserted at
    startup (a restart overwrites; no run history). Status is derived
    at read time in system/registry.py, never stored here."""

    __tablename__ = "processes"

    name: Mapped[str] = mapped_column(primary_key=True)
    kind: Mapped[str]                    # 'service' | 'worker' | 'probe'
    pid: Mapped[int | None] = mapped_column(Integer)
    hostname: Mapped[str] = mapped_column(server_default="")
    started_at: Mapped[datetime | None]
    heartbeat_at: Mapped[datetime | None]
    stopped_at: Mapped[datetime | None]
    meta: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))


class LogEntry(Base):
    """One log record from any process; id is the ordering + streaming
    cursor. Size is bounded by the log-service's retention pass."""

    __tablename__ = "log_entries"

    id: Mapped[int] = mapped_column(BigInteger, Identity(),
                                    primary_key=True)
    process: Mapped[str]
    level: Mapped[str]
    levelno: Mapped[int] = mapped_column(Integer)
    logger: Mapped[str] = mapped_column(server_default="")
    message: Mapped[str]
    extra: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class SystemConfig(Base):
    """Section-keyed JSONB config. 'logging' is seeded by 0024;
    'logging_cursor' is written only by the log-service."""

    __tablename__ = "system_config"

    section: Mapped[str] = mapped_column(primary_key=True)
    data: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    updated_at: Mapped[datetime] = mapped_column(
        server_default=text("now()"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id"))
```

`Identity` needs importing: extend the existing `from sqlalchemy import (...)` block in models.py with `Identity` (it already imports `BigInteger`, `Integer`, `ForeignKey`, `text`; check and add only what is missing).

- [ ] **Step 5: conftest — truncate + reseed**

In `api/tests/conftest.py`:
1. Add `log_entries, processes, ` to the TRUNCATE statement (insert before `"initiative_links, ...`).
2. After the asset_categories reseed block (end of the seed section, before `await session.commit()`), add:

```python
        # system_config is editable seed data — restore 0024 defaults
        await session.execute(text("DELETE FROM system_config"))
        await session.execute(text("""
            INSERT INTO system_config (section, data) VALUES
              ('logging', '{"mode": "local",
                "local_max_rows_per_process": 20000,
                "local_max_age_days": 14, "remote_buffer_rows": 10000,
                "min_level": "INFO",
                "syslog": {"host": "", "port": 514, "protocol": "udp"}}'::jsonb),
              ('logging_cursor', '{"last_forwarded_id": 0}'::jsonb)
        """))
```

- [ ] **Step 6: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_system_models.py -q`
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0024_process_monitor_logging.py api/src/serversherpa/db/models.py api/tests/conftest.py api/tests/test_system_models.py
git commit -m "feat(api): processes/log_entries/system_config tables + seeded logging config (0024)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: system package — config store + heartbeat registry

**Files:**
- Create: `api/src/serversherpa/system/__init__.py`
- Create: `api/src/serversherpa/system/config_store.py`
- Create: `api/src/serversherpa/system/registry.py`
- Test: `api/tests/test_system_registry.py`

**Interfaces:**
- Produces:
  - `config_store.DEFAULTS: dict[str, dict]` — `{"logging": {...seeded defaults...}}`.
  - `async config_store.read_section(db: AsyncSession, section: str) -> dict` — DB row merged over defaults (row wins; missing row → defaults copy).
  - `config_store.read_section_sync(engine, section: str) -> dict` — same merge using a sync SQLAlchemy engine (for the handler thread).
  - `registry.HEARTBEAT_SECONDS = 5`, `registry.STALE_AFTER_SECONDS = 15`.
  - `registry.derive_status(heartbeat_at, stopped_at, now) -> str` — pure: `"running" | "stopped" | "failed"`.
  - `async registry.heartbeat_loop(name: str, kind: str, *, interval: float = HEARTBEAT_SECONDS) -> None` — upserts forever; on `asyncio.CancelledError` marks `stopped_at` and returns.
  - `registry.start_heartbeat(name, kind) -> asyncio.Task` — `asyncio.create_task(heartbeat_loop(...))`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_system_registry.py`:

```python
"""Heartbeat registry: upserts, clean-stop marking, derived status."""

import asyncio
from datetime import UTC, datetime, timedelta

from serversherpa.db.models import SystemProcess
from serversherpa.system import config_store
from serversherpa.system.registry import derive_status, heartbeat_loop

NOW = datetime(2026, 8, 26, 12, 0, 0, tzinfo=UTC)


def test_derive_status():
    fresh = NOW - timedelta(seconds=3)
    stale = NOW - timedelta(seconds=60)
    assert derive_status(fresh, None, NOW) == "running"
    assert derive_status(stale, None, NOW) == "failed"
    assert derive_status(None, None, NOW) == "failed"        # never beat
    # clean stop after the last beat
    assert derive_status(stale, stale + timedelta(seconds=1), NOW) == "stopped"
    # restart after an old clean stop: fresh beat wins
    assert derive_status(fresh, stale, NOW) == "running"
    # stopped marker also beats a still-fresh heartbeat when newer
    assert derive_status(fresh, NOW, NOW) == "stopped"


async def test_heartbeat_loop_upserts_and_marks_stop(db):
    task = asyncio.create_task(
        heartbeat_loop("testproc", "worker", interval=0.05))
    await asyncio.sleep(0.2)
    row = await db.get(SystemProcess, "testproc")
    assert row is not None
    assert row.kind == "worker"
    assert row.pid is not None
    assert row.hostname != ""
    assert row.started_at is not None
    first_beat = row.heartbeat_at
    assert first_beat is not None

    await asyncio.sleep(0.15)
    await db.refresh(row)
    assert row.heartbeat_at > first_beat                     # keeps beating

    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    await db.refresh(row)
    assert row.stopped_at is not None                        # clean stop


async def test_restart_overwrites_previous_run(db):
    task = asyncio.create_task(
        heartbeat_loop("testproc", "worker", interval=0.05))
    await asyncio.sleep(0.15)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    task = asyncio.create_task(
        heartbeat_loop("testproc", "worker", interval=0.05))
    await asyncio.sleep(0.15)
    row = await db.get(SystemProcess, "testproc")
    await db.refresh(row)
    assert row.stopped_at is None                            # cleared on start
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_config_store_defaults_and_merge(db):
    data = await config_store.read_section(db, "logging")
    assert data["mode"] == "local"                           # seeded row
    missing = await config_store.read_section(db, "nonexistent")
    assert missing == {}
    # row values win over defaults
    from serversherpa.db.models import SystemConfig
    cfg = await db.get(SystemConfig, "logging")
    cfg.data = {**cfg.data, "min_level": "DEBUG"}
    await db.commit()
    data = await config_store.read_section(db, "logging")
    assert data["min_level"] == "DEBUG"
    assert data["local_max_age_days"] == 14                  # default kept
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_system_registry.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'serversherpa.system'`.

- [ ] **Step 3: Implement**

Create empty `api/src/serversherpa/system/__init__.py` with docstring:

```python
"""Process-runtime services shared by every ServerSherpa process:
heartbeat registry, Postgres logging pipeline, and system config."""
```

Create `api/src/serversherpa/system/config_store.py`:

```python
"""system_config readers. Defaults mirror migration 0024's seeds so a
missing row never breaks a caller; the DB row's keys win on conflict."""

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULTS: dict[str, dict] = {
    "logging": {
        "mode": "local",
        "local_max_rows_per_process": 20000,
        "local_max_age_days": 14,
        "remote_buffer_rows": 10000,
        "min_level": "INFO",
        "syslog": {"host": "", "port": 514, "protocol": "udp"},
    },
}


def _merged(section: str, row_data: dict | None) -> dict:
    base = dict(DEFAULTS.get(section, {}))
    if row_data:
        base.update(row_data)
    return base


async def read_section(db: AsyncSession, section: str) -> dict:
    from serversherpa.db.models import SystemConfig

    row = await db.get(SystemConfig, section)
    return _merged(section, row.data if row is not None else None)


def read_section_sync(engine, section: str) -> dict:
    """Same merge over a sync engine — for the log handler's flusher
    thread, which must never touch the async event loop."""
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT data FROM system_config WHERE section = :s"),
            {"s": section}).fetchone()
    return _merged(section, row[0] if row is not None else None)
```

Create `api/src/serversherpa/system/registry.py`:

```python
"""Heartbeat registry. Every process upserts its row every 5 s; status
is DERIVED from the timestamps at read time (spec: running/stopped/
failed), never stored — so a kill -9 needs no cleanup to show as
failed once the heartbeat goes stale."""

import asyncio
import os
import socket
from datetime import UTC, datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert

from serversherpa.db.models import SystemProcess

HEARTBEAT_SECONDS = 5
STALE_AFTER_SECONDS = 15          # 3 × the heartbeat interval


def derive_status(heartbeat_at: datetime | None,
                  stopped_at: datetime | None,
                  now: datetime) -> str:
    if stopped_at is not None and (
            heartbeat_at is None or stopped_at >= heartbeat_at):
        return "stopped"
    if heartbeat_at is None:
        return "failed"
    age = (now - heartbeat_at).total_seconds()
    return "running" if age < STALE_AFTER_SECONDS else "failed"


async def _beat(name: str, kind: str, *, first: bool) -> None:
    from serversherpa.db.engine import get_sessionmaker

    now = datetime.now(UTC)
    values = {"kind": kind, "pid": os.getpid(),
              "hostname": socket.gethostname(), "heartbeat_at": now}
    if first:
        values["started_at"] = now
        values["stopped_at"] = None
    stmt = pg_insert(SystemProcess).values(name=name, **values)
    stmt = stmt.on_conflict_do_update(index_elements=["name"], set_=values)
    async with get_sessionmaker()() as db:
        await db.execute(stmt)
        await db.commit()


async def _mark_stopped(name: str) -> None:
    from serversherpa.db.engine import get_sessionmaker

    async with get_sessionmaker()() as db:
        row = await db.get(SystemProcess, name)
        if row is not None:
            row.stopped_at = datetime.now(UTC)
            await db.commit()


async def heartbeat_loop(name: str, kind: str, *,
                         interval: float = HEARTBEAT_SECONDS) -> None:
    first = True
    try:
        while True:
            try:
                await _beat(name, kind, first=first)
                first = False
            except asyncio.CancelledError:
                raise
            except Exception:
                pass          # a DB blip must never kill the host process
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        try:
            await _mark_stopped(name)
        except Exception:
            pass


def start_heartbeat(name: str, kind: str) -> asyncio.Task:
    return asyncio.create_task(heartbeat_loop(name, kind))
```

- [ ] **Step 4: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_system_registry.py -q`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/system/ api/tests/test_system_registry.py
git commit -m "feat(api): system package — heartbeat registry + config store

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: DB log handler

**Files:**
- Create: `api/src/serversherpa/system/db_logging.py`
- Test: `api/tests/test_db_logging.py`

**Interfaces:**
- Consumes: `config_store.read_section_sync`, `LogEntry`, `Settings.sync_database_url` (existing property used by Alembic).
- Produces:
  - `DbLogHandler(process: str, *, queue_size: int = 10000, batch_size: int = 200, flush_seconds: float = 1.0, config_refresh_seconds: float = 30.0)` — stdlib `logging.Handler`; `close()` drains and stops the thread.
  - `install(process: str) -> DbLogHandler` — idempotent per-process module singleton: sets root logger level to DEBUG (the handler filters by configured min level), attaches the handler to the root logger, ensures `logging.getLogger("uvicorn.error").propagate = True`, never touches `uvicorn.access`, and adds a stderr `StreamHandler` (INFO) only when the root logger had no handlers (so worker terminals keep human-readable output).

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_db_logging.py`:

```python
"""DB log handler: batching, level threshold, recursion guard, bounds."""

import logging
import time

from sqlalchemy import create_engine, select, text

from serversherpa.config import get_settings
from serversherpa.db.models import LogEntry
from serversherpa.system.db_logging import DbLogHandler


def _wait_for(check, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    return check()


def _count(process):
    engine = create_engine(get_settings().sync_database_url)
    with engine.connect() as conn:
        n = conn.execute(
            text("SELECT count(*) FROM log_entries WHERE process = :p"),
            {"p": process}).scalar()
    engine.dispose()
    return n


async def test_records_land_in_batches(db):
    handler = DbLogHandler("t-batch", flush_seconds=0.1)
    logger = logging.getLogger("serversherpa.test.batch")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        logger.info("hello %s", "world")
        try:
            raise ValueError("boom")
        except ValueError:
            logger.exception("it broke")
        assert _wait_for(lambda: _count("t-batch") == 2)
    finally:
        logger.removeHandler(handler)
        handler.close()
    rows = (await db.scalars(select(LogEntry).where(
        LogEntry.process == "t-batch").order_by(LogEntry.id))).all()
    assert rows[0].message == "hello world"
    assert rows[0].level == "INFO" and rows[0].levelno == 20
    assert rows[0].logger == "serversherpa.test.batch"
    assert "ValueError: boom" in rows[1].message      # traceback included
    assert rows[1].level == "ERROR"


async def test_min_level_filters(db):
    # config seeds min_level INFO — DEBUG records must not land
    handler = DbLogHandler("t-level", flush_seconds=0.1)
    logger = logging.getLogger("serversherpa.test.level")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        logger.debug("too quiet")
        logger.warning("loud enough")
        assert _wait_for(lambda: _count("t-level") == 1)
        time.sleep(0.3)
        assert _count("t-level") == 1
    finally:
        logger.removeHandler(handler)
        handler.close()


async def test_flush_errors_never_recurse(db, monkeypatch):
    handler = DbLogHandler("t-recurse", flush_seconds=0.1)
    monkeypatch.setattr(handler, "_write_batch",
                        lambda rows: (_ for _ in ()).throw(RuntimeError("db down")))
    logger = logging.getLogger("serversherpa.test.recurse")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        logger.error("during outage")
        time.sleep(0.4)                     # give the flusher time to fail
        assert _count("t-recurse") == 0     # nothing landed, nothing crashed
    finally:
        logger.removeHandler(handler)
        handler.close()


async def test_bounded_queue_drops_oldest(db):
    handler = DbLogHandler("t-bound", queue_size=5, flush_seconds=60.0)
    logger = logging.getLogger("serversherpa.test.bound")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        for i in range(20):
            logger.info("msg %d", i)
        # force one flush now by closing (close drains the queue)
    finally:
        logger.removeHandler(handler)
        handler.close()
    rows = _wait_for(lambda: _count("t-bound") == 5) and None
    engine = create_engine(get_settings().sync_database_url)
    with engine.connect() as conn:
        msgs = [r[0] for r in conn.execute(text(
            "SELECT message FROM log_entries WHERE process = 't-bound' "
            "ORDER BY id"))]
    engine.dispose()
    assert len(msgs) == 5
    assert msgs[-1] == "msg 19"             # newest kept, oldest dropped
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_db_logging.py -q`
Expected: FAIL with `ModuleNotFoundError` on `db_logging`.

- [ ] **Step 3: Implement**

Create `api/src/serversherpa/system/db_logging.py`:

```python
"""Postgres logging pipeline: a stdlib handler that batches records to
log_entries from a dedicated thread with its own small SYNC engine, so
logging never blocks the event loop and behaves identically in every
process. Log writes do NOT route through the log-service — logs still
land when it is down (spec architecture decision A)."""

import logging
import queue
import sys
import threading
import time
from datetime import UTC, datetime

_LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40,
           "CRITICAL": 50}


class DbLogHandler(logging.Handler):
    def __init__(self, process: str, *, queue_size: int = 10000,
                 batch_size: int = 200, flush_seconds: float = 1.0,
                 config_refresh_seconds: float = 30.0) -> None:
        super().__init__(level=logging.DEBUG)
        self.process_name = process
        self._batch_size = batch_size
        self._flush_seconds = flush_seconds
        self._config_refresh = config_refresh_seconds
        self._queue: queue.Queue = queue.Queue(maxsize=queue_size)
        self._stop = threading.Event()
        self._engine = None
        self._min_levelno = _LEVELS["INFO"]
        self._config_read_at = 0.0
        self._last_error_at = 0.0
        self._thread = threading.Thread(
            target=self._run, name=f"db-log-{process}", daemon=True)
        self._thread.start()

    # ── producer side (any thread) ─────────────────────────────
    def emit(self, record: logging.LogRecord) -> None:
        if record.name.startswith("serversherpa.system.db_logging"):
            return                          # recursion guard
        try:
            row = {
                "process": self.process_name,
                "level": record.levelname,
                "levelno": record.levelno,
                "logger": record.name,
                "message": self.format(record),
                "extra": {},
                "at": datetime.now(UTC),
            }
        except Exception:
            return
        while True:
            try:
                self._queue.put_nowait(row)
                return
            except queue.Full:              # drop-oldest under pressure
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    return

    def format(self, record: logging.LogRecord) -> str:
        base = record.getMessage()
        if record.exc_info:
            formatter = logging.Formatter()
            base = f"{base}\n{formatter.formatException(record.exc_info)}"
        return base

    # ── flusher thread ─────────────────────────────────────────
    def _get_engine(self):
        if self._engine is None:
            from sqlalchemy import create_engine

            from serversherpa.config import get_settings
            self._engine = create_engine(
                get_settings().sync_database_url, pool_size=1,
                max_overflow=0, pool_pre_ping=True)
        return self._engine

    def _refresh_config(self) -> None:
        now = time.monotonic()
        if now - self._config_read_at < self._config_refresh:
            return
        self._config_read_at = now
        try:
            from serversherpa.system.config_store import read_section_sync
            data = read_section_sync(self._get_engine(), "logging")
            self._min_levelno = _LEVELS.get(
                str(data.get("min_level", "INFO")).upper(), 20)
        except Exception:
            pass                            # keep the previous threshold

    def _write_batch(self, rows: list[dict]) -> None:
        from serversherpa.db.models import LogEntry
        with self._get_engine().begin() as conn:
            conn.execute(LogEntry.__table__.insert(), rows)

    def _drain(self, max_rows: int) -> list[dict]:
        rows: list[dict] = []
        while len(rows) < max_rows:
            try:
                rows.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return rows

    def _run(self) -> None:
        while not self._stop.is_set():
            self._stop.wait(self._flush_seconds)
            self._flush_once()
        self._flush_once()                  # final drain on close

    def _flush_once(self) -> None:
        self._refresh_config()
        rows = [r for r in self._drain(self._batch_size)
                if r["levelno"] >= self._min_levelno]
        if not rows:
            return
        try:
            self._write_batch(rows)
        except Exception as exc:            # stderr, once a minute, never logs
            now = time.monotonic()
            if now - self._last_error_at > 60:
                self._last_error_at = now
                print(f"[db_logging] flush failed: {exc}", file=sys.stderr)

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
        if self._engine is not None:
            self._engine.dispose()
        super().close()


_installed: dict[str, DbLogHandler] = {}


def install(process: str) -> DbLogHandler:
    """Attach the pipeline for this process. Idempotent. Root goes to
    DEBUG (the handler applies the configured min level itself);
    uvicorn.error propagates in; uvicorn.access is never touched."""
    if process in _installed:
        return _installed[process]
    root = logging.getLogger()
    if not root.handlers:                   # keep terminals readable
        stderr = logging.StreamHandler()
        stderr.setLevel(logging.INFO)
        stderr.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(stderr)
    root.setLevel(logging.DEBUG)
    handler = DbLogHandler(process)
    root.addHandler(handler)
    logging.getLogger("uvicorn.error").propagate = True
    _installed[process] = handler
    return handler
```

NOTE on the bounded-queue test: `close()` drains up to `batch_size` rows per `_flush_once`; with `queue_size=5` only 5 rows exist. The `_wait_for(...) and None` line just waits — the real assertions follow it.

- [ ] **Step 4: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_db_logging.py -q`
Expected: 4 passed, no stray output except the deliberate stderr line from the recursion test.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/system/db_logging.py api/tests/test_db_logging.py
git commit -m "feat(api): batching Postgres log handler with recursion guard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: log-service worker (retention + web probe) + CLI + Procfile

**Files:**
- Create: `api/src/serversherpa/system/log_service.py`
- Modify: `api/src/serversherpa/cli.py` (new command after `import_worker`)
- Modify: `api/src/serversherpa/config.py` (add `portal_origin`)
- Modify: `.env.example` (document `SS_PORTAL_ORIGIN`)
- Modify: `Procfile.dev` (add `logsvc` line)
- Modify: `api/pyproject.toml` (move `httpx>=0.27` from `[dev]` into runtime `dependencies` — the probe needs it at runtime; keep the dev list otherwise)
- Test: `api/tests/test_log_service.py`, extend `api/tests/test_cli_import_worker.py` naming conventions with a new `api/tests/test_cli_log_service.py`

**Interfaces:**
- Consumes: `config_store.read_section`, `registry.start_heartbeat`, `db_logging.install`, `SystemProcess`, `LogEntry`.
- Produces:
  - `async log_service.enforce_retention(db) -> dict` — per-process deletes per the logging config; returns `{"deleted": n}`. Row cap = `local_max_rows_per_process` (or `remote_buffer_rows` when `mode == "remote"`); age cap = `local_max_age_days`.
  - `async log_service.probe_web(db, url: str) -> None` — GET url (3 s timeout); success → upsert `web` row (kind `probe`, fresh `heartbeat_at`, `meta={"url": url, "status_code": n}`); failure → upsert meta `{"url": url, "error": str}` WITHOUT touching `heartbeat_at` (stale → derives failed).
  - `async log_service.run_forever(poll_seconds: float = 10.0) -> None` — heartbeat + logging attach, then loop: retention every tick, probe every 3rd tick.
  - `async log_service.run_once() -> None` — one retention pass + one probe (for tests/CLI).
  - CLI: `serversherpa log-service [--poll-seconds 10.0] [--once] [--reload]` mirroring `import-worker` exactly (same conflict rule: `--once` + `--reload` → exit 1).

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_log_service.py`:

```python
"""log-service: retention per config mode + the web probe."""

from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import func, select

from serversherpa.db.models import LogEntry, SystemConfig, SystemProcess
from serversherpa.system import log_service


async def _fill(db, process, n, *, age_days=0):
    at = datetime.now(UTC) - timedelta(days=age_days)
    db.add_all([LogEntry(process=process, level="INFO", levelno=20,
                         message=f"m{i}", at=at) for i in range(n)])
    await db.commit()


async def _set_logging(db, **over):
    cfg = await db.get(SystemConfig, "logging")
    cfg.data = {**cfg.data, **over}
    await db.commit()


async def _count(db, process):
    return await db.scalar(select(func.count()).select_from(LogEntry)
                           .where(LogEntry.process == process))


async def test_retention_row_cap(db):
    await _set_logging(db, local_max_rows_per_process=10)
    await _fill(db, "api", 25)
    await _fill(db, "import-worker", 5)
    result = await log_service.enforce_retention(db)
    assert result["deleted"] == 15
    assert await _count(db, "api") == 10
    assert await _count(db, "import-worker") == 5     # under cap: untouched
    # newest survive
    newest = (await db.scalars(select(LogEntry.message).where(
        LogEntry.process == "api").order_by(LogEntry.id.desc()))).first()
    assert newest == "m24"


async def test_retention_age_cap(db):
    await _set_logging(db, local_max_age_days=7)
    await _fill(db, "api", 3, age_days=10)
    await _fill(db, "api", 2, age_days=0)
    await log_service.enforce_retention(db)
    assert await _count(db, "api") == 2


async def test_remote_mode_uses_buffer_cap(db):
    await _set_logging(db, mode="remote", remote_buffer_rows=4,
                       local_max_rows_per_process=10000)
    await _fill(db, "api", 10)
    await log_service.enforce_retention(db)
    assert await _count(db, "api") == 4


async def test_probe_web_up_and_down(db, monkeypatch):
    class FakeResponse:
        status_code = 200

    async def fake_get(self, url, **kw):
        if "down" in url:
            raise httpx.ConnectError("refused")
        return FakeResponse()

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    await log_service.probe_web(db, "http://portal-up.local")
    row = await db.get(SystemProcess, "web")
    assert row.kind == "probe"
    assert row.heartbeat_at is not None
    assert row.meta["status_code"] == 200
    beat = row.heartbeat_at

    await log_service.probe_web(db, "http://portal-down.local")
    await db.refresh(row)
    assert row.heartbeat_at == beat            # not advanced on failure
    assert "refused" in row.meta["error"]
```

Create `api/tests/test_cli_log_service.py`:

```python
"""log-service CLI mirrors import-worker's flags."""

from typer.testing import CliRunner

from serversherpa.cli import app

runner = CliRunner()


def test_help_shows_flags():
    result = runner.invoke(app, ["log-service", "--help"])
    assert result.exit_code == 0
    assert "--reload" in result.output
    assert "--once" in result.output


def test_reload_and_once_conflict():
    result = runner.invoke(app, ["log-service", "--reload", "--once"])
    assert result.exit_code == 1
    assert "cannot be combined" in result.output
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_log_service.py tests/test_cli_log_service.py -q`
Expected: FAIL (`log_service` module missing; CLI command unknown → exit code 2 on --help).

- [ ] **Step 3: Implement log_service.py**

Create `api/src/serversherpa/system/log_service.py`:

```python
"""The log-service worker: retention enforcement + the web-server
probe. Plan 2 adds syslog forwarding here. Runs as its own process
(`serversherpa log-service`) and is listed in the registry like any
other worker. Retention failure modes never crash the loop."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import SystemProcess
from serversherpa.system.config_store import read_section

logger = logging.getLogger("serversherpa.system.log_service")

PROBE_EVERY_TICKS = 3


async def enforce_retention(db: AsyncSession) -> dict:
    cfg = await read_section(db, "logging")
    row_cap = int(cfg["remote_buffer_rows"] if cfg["mode"] == "remote"
                  else cfg["local_max_rows_per_process"])
    max_age_days = int(cfg["local_max_age_days"])
    deleted = 0

    processes = [r[0] for r in await db.execute(
        text("SELECT DISTINCT process FROM log_entries"))]
    for process in processes:
        result = await db.execute(text("""
            DELETE FROM log_entries WHERE process = :p AND id <= (
                SELECT id FROM log_entries WHERE process = :p
                ORDER BY id DESC OFFSET :cap LIMIT 1)
        """), {"p": process, "cap": row_cap})
        deleted += result.rowcount or 0

    cutoff = datetime.now(UTC) - timedelta(days=max_age_days)
    result = await db.execute(
        text("DELETE FROM log_entries WHERE at < :cutoff"),
        {"cutoff": cutoff})
    deleted += result.rowcount or 0
    await db.commit()
    if deleted:
        logger.info("retention deleted %d log rows", deleted)
    return {"deleted": deleted}


async def probe_web(db: AsyncSession, url: str) -> None:
    values: dict = {"kind": "probe"}
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url)
        values["heartbeat_at"] = datetime.now(UTC)
        values["meta"] = {"url": url, "status_code": resp.status_code}
    except Exception as exc:
        values["meta"] = {"url": url, "error": str(exc)}
    stmt = pg_insert(SystemProcess).values(name="web", **values)
    stmt = stmt.on_conflict_do_update(index_elements=["name"], set_=values)
    await db.execute(stmt)
    await db.commit()


async def run_once() -> None:
    from serversherpa.config import get_settings
    from serversherpa.db.engine import get_sessionmaker

    async with get_sessionmaker()() as db:
        await enforce_retention(db)
        await probe_web(db, get_settings().portal_origin)


async def run_forever(poll_seconds: float = 10.0) -> None:
    from serversherpa.config import get_settings
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("log-service")
    heartbeat = start_heartbeat("log-service", "worker")
    logger.info("log-service watching retention + web probe")
    tick = 0
    try:
        while True:
            try:
                async with get_sessionmaker()() as db:
                    await enforce_retention(db)
                    if tick % PROBE_EVERY_TICKS == 0:
                        await probe_web(db, get_settings().portal_origin)
            except Exception:
                logger.exception("log-service tick failed")
            tick += 1
            await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
```

- [ ] **Step 4: Settings + CLI + Procfile + deps**

In `api/src/serversherpa/config.py`, in the Runtime section after `api_base_url: str`, add:

```python
    # portal origin probed by the log-service for the 'web' registry row
    portal_origin: str = "http://localhost:5173"
```

In `.env.example`, next to the CORS/portal-related settings, add:

```
# Portal origin the log-service health-probes for the Processes page
SS_PORTAL_ORIGIN=http://localhost:5173
```

In `api/src/serversherpa/cli.py`, after the `import_worker` command add (mirroring its structure exactly, including the reload child entry point):

```python
def _run_log_service_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (picklable, like the import
    worker's)."""

    async def _run() -> None:
        from serversherpa.system import log_service

        await log_service.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass    # watchfiles stops the old process with SIGINT on reload


@app.command()
def log_service(
    poll_seconds: float = typer.Option(
        10.0, help="Seconds between retention/probe ticks"),
    once: bool = typer.Option(
        False, help="One retention pass + one probe, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart when api/src changes "
                    "(uvicorn-style)"),
) -> None:
    """Run the log-service worker — retention enforcement and the web
    probe (SIEM forwarding arrives with the config slice)."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[log-service] dev reload — watching {src_dir}",
                    fg="cyan")
        watchfiles.run_process(src_dir, target=_run_log_service_process,
                               args=(poll_seconds,))
        return

    async def _run() -> None:
        from serversherpa.system import log_service as svc

        if once:
            await svc.run_once()
            typer.secho("retention + probe pass complete", fg="green")
        else:
            await svc.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())
```

In `Procfile.dev`, after the `worker:` line add:

```
logsvc: api/.venv/bin/serversherpa log-service --reload
```

In `api/pyproject.toml`, move `"httpx>=0.27",` from the `dev` extra into the runtime `dependencies` list (after `"openpyxl>=3.1",`); remove it from `dev` (it is now inherited).

- [ ] **Step 5: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_log_service.py tests/test_cli_log_service.py tests/test_cli_import_worker.py -q`
Expected: all passed. Also: `cd api && .venv/bin/serversherpa log-service --help` shows the three flags.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/system/log_service.py api/src/serversherpa/cli.py api/src/serversherpa/config.py .env.example Procfile.dev api/pyproject.toml api/tests/test_log_service.py api/tests/test_cli_log_service.py
git commit -m "feat(api): log-service worker — retention + web probe + CLI/Procfile

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: system routes — registry, logs, WS stream, clear

**Files:**
- Modify: `api/src/serversherpa/api/deps.py` (extract `authenticate_token`)
- Create: `api/src/serversherpa/api/routes/system.py`
- Modify: `api/src/serversherpa/api/schemas.py` (append)
- Modify: `api/src/serversherpa/api/app.py` (import + include router)
- Test: `api/tests/test_system_api.py`

**Interfaces:**
- Consumes: `derive_status`, `SystemProcess`, `LogEntry`, `audit`.
- Produces:
  - `deps.authenticate_token(db, token: str) -> AuthContext` (async; raises the same 401 HTTPExceptions `get_current_user` raises today; `get_current_user` now delegates to it).
  - Endpoints: `GET /system/processes` (rank ≥ 80), `GET /system/processes/{name}/logs`, `WS /system/processes/{name}/logs/stream`, `DELETE /system/processes/{name}/logs` (all three devtools-gated).
  - Schemas: `SystemProcessOut` (name, kind, status, pid, hostname, started_at, heartbeat_at, stopped_at, uptime_seconds, meta), `LogEntryOut` (id, level, levelno, logger, message, at), `LogPageOut` (entries: list, has_more: bool).

- [ ] **Step 1: Refactor deps (no behavior change)**

In `api/src/serversherpa/api/deps.py`, split `get_current_user` so the token+session+account+access logic is reusable by the WebSocket route:

```python
async def authenticate_token(db: AsyncSession, token: str) -> AuthContext:
    """Validate an access token end-to-end (JWT, live session, active
    account) and build the AuthContext. Raises the same 401s as
    get_current_user — the WS route maps them to close codes."""
    settings = get_settings()
    try:
        claims = decode_access_token(
            token, secret=settings.jwt_secret.get_secret_value())
    except TokenError:
        raise _unauthorized("invalid_token") from None

    session = await db.get(AuthSession, uuid.UUID(claims["sid"]))
    if (
        session is None
        or session.revoked_at is not None
        or session.expires_at <= datetime.now(UTC)
    ):
        raise _unauthorized("session_ended")

    account = await db.scalar(
        select(UserAccount)
        .options(joinedload(UserAccount.person))
        .where(UserAccount.person_id == uuid.UUID(claims["sub"]))
    )
    if (
        account is None
        or account.disabled_at is not None
        or account.person.archived_at is not None
    ):
        raise _unauthorized("account_disabled")

    access = await resolve_access(db, account.person_id)
    return AuthContext(
        person=account.person, account=account, roles=access.role_names,
        session=session, access=access,
    )


async def get_current_user(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthContext:
    if credentials is None:
        raise _unauthorized("missing_token")
    return await authenticate_token(db, credentials.credentials)
```

(The bodies are the existing lines moved verbatim; nothing else in deps.py changes.)

Run the auth suite to prove no drift: `cd api && .venv/bin/pytest tests/test_auth_flow.py -q` → all passed.

- [ ] **Step 2: Write the failing route tests**

Create `api/tests/test_system_api.py`:

```python
"""System routes: registry gating, logs paging/filter/search, WS
stream, audited clear."""

import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from starlette.testclient import TestClient

from serversherpa.api.app import create_app
from serversherpa.db.models import (
    AuditLog, LogEntry, Person, PersonRole, SystemProcess,
)

from .test_assets_api import login, make_login


async def _super_admin_headers(db, client):
    person = Person(first_name="Sue", last_name="Prime")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="super_admin"))
    await db.commit()
    return await make_login(db, client, person, "sue@test.example.com")


async def _developer_headers(db, client):
    person = Person(first_name="Dev", last_name="Eloper")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="developer"))
    await db.commit()
    return await make_login(db, client, person, "dev@test.example.com")


def _proc(name="api", kind="service", beat_age=2, stopped=False):
    now = datetime.now(UTC)
    return SystemProcess(
        name=name, kind=kind, pid=123, hostname="devbox",
        started_at=now - timedelta(minutes=5),
        heartbeat_at=now - timedelta(seconds=beat_age),
        stopped_at=now if stopped else None)


async def test_processes_requires_rank_80(client, db, seeded_user):
    staff = await login(client)          # staff: rank < 80
    resp = await client.get("/system/processes", headers=staff)
    assert resp.status_code == 403

    sa = await _super_admin_headers(db, client)
    db.add_all([_proc(), _proc(name="import-worker", kind="worker",
                              beat_age=60)])
    await db.commit()
    resp = await client.get("/system/processes", headers=sa)
    assert resp.status_code == 200
    rows = {r["name"]: r for r in resp.json()}
    assert rows["api"]["status"] == "running"
    assert rows["api"]["uptime_seconds"] > 0
    assert rows["import-worker"]["status"] == "failed"


async def test_logs_require_devtools(client, db, seeded_user):
    sa = await _super_admin_headers(db, client)     # rank 80, no devtools
    resp = await client.get("/system/processes/api/logs", headers=sa)
    assert resp.status_code == 403


async def test_logs_page_filter_search(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    db.add_all([
        LogEntry(process="api", level="DEBUG", levelno=10, message="noise"),
        LogEntry(process="api", level="INFO", levelno=20,
                 message="import started"),
        LogEntry(process="api", level="ERROR", levelno=40,
                 message="import failed hard"),
        LogEntry(process="other", level="ERROR", levelno=40, message="x"),
    ])
    await db.commit()

    resp = await client.get("/system/processes/api/logs", headers=dev)
    assert resp.status_code == 200
    body = resp.json()
    assert [e["message"] for e in body["entries"]] == [
        "import failed hard", "import started", "noise"]   # newest first
    assert body["has_more"] is False

    resp = await client.get(
        "/system/processes/api/logs?min_level=ERROR", headers=dev)
    assert [e["message"] for e in resp.json()["entries"]] == [
        "import failed hard"]

    resp = await client.get(
        "/system/processes/api/logs?q=import", headers=dev)
    assert len(resp.json()["entries"]) == 2

    first_page = await client.get(
        "/system/processes/api/logs?limit=2", headers=dev)
    assert first_page.json()["has_more"] is True
    before = first_page.json()["entries"][-1]["id"]
    second = await client.get(
        f"/system/processes/api/logs?limit=2&before_id={before}",
        headers=dev)
    assert [e["message"] for e in second.json()["entries"]] == ["noise"]


async def test_probe_process_has_no_logs(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    db.add(_proc(name="web", kind="probe"))
    await db.commit()
    resp = await client.get("/system/processes/web/logs", headers=dev)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "process_has_no_logs"


async def test_clear_logs_audited(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    db.add_all([LogEntry(process="api", level="INFO", levelno=20,
                         message=f"m{i}") for i in range(3)])
    await db.commit()
    resp = await client.delete("/system/processes/api/logs", headers=dev)
    assert resp.status_code == 200
    assert resp.json() == {"deleted": 3}
    assert await db.scalar(select(func.count()).select_from(LogEntry)
                           .where(LogEntry.process == "api")) == 0
    entry = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "system",
        AuditLog.action == "logs_clear"))
    assert entry is not None
    assert entry.changes["process"] == "api"
    assert entry.changes["deleted"] == 3


async def test_ws_stream_and_auth(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    token = dev["Authorization"].removeprefix("Bearer ")

    # TestClient runs the app in its own thread + event loop. asyncpg
    # connections are loop-bound, so the async engine pooled in pytest's
    # loop must be dropped first — the app's loop then builds its own
    # fresh pool, and pytest's side lazily recreates one afterwards.
    from serversherpa.db.engine import dispose_engine
    await db.close()
    await dispose_engine()

    from sqlalchemy import create_engine, text as sql_text

    from serversherpa.config import get_settings
    sync = create_engine(get_settings().sync_database_url)

    def insert_row(message):
        with sync.begin() as conn:
            conn.execute(sql_text(
                "INSERT INTO log_entries (process, level, levelno, "
                "logger, message) VALUES ('api', 'INFO', 20, 't', :m)"),
                {"m": message})

    with TestClient(create_app()) as tc:
        with tc.websocket_connect(
                f"/system/processes/api/logs/stream?token={token}") as ws:
            insert_row("streamed hello")
            msg = ws.receive_json()          # tail poll is 1 s
            assert msg["entries"][0]["message"] == "streamed hello"

        # bad token → closed with 4401 before any data
        import pytest
        from starlette.websockets import WebSocketDisconnect
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect(
                    "/system/processes/api/logs/stream?token=junk") as ws:
                ws.receive_json()
        assert exc.value.code == 4401
    sync.dispose()
```

- [ ] **Step 3: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_system_api.py -q`
Expected: FAIL (404s — routes missing). NOTE: `_developer_headers` relies on a system role named `developer` holding `devtools` — verify with `grep -n "developer" api/src/serversherpa/access/defaults.py`; if the role has a different name, use that name in both helpers (the devtools-holding role is whatever `defaults.py` grants `devtools` to).

- [ ] **Step 4: Add schemas**

Append to `api/src/serversherpa/api/schemas.py`:

```python
class SystemProcessOut(BaseModel):
    name: str
    kind: str
    status: str                      # derived: running | stopped | failed
    pid: int | None = None
    hostname: str
    started_at: datetime | None = None
    heartbeat_at: datetime | None = None
    stopped_at: datetime | None = None
    uptime_seconds: int | None = None
    meta: dict


class LogEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    level: str
    levelno: int
    logger: str
    message: str
    at: datetime


class LogPageOut(BaseModel):
    entries: list[LogEntryOut]
    has_more: bool
```

- [ ] **Step 5: Implement routes/system.py**

Create `api/src/serversherpa/api/routes/system.py`:

```python
"""System surface: process registry (super_admin+) and per-process logs
(developer-only): paged reads, a 1 s-tailing WebSocket stream, and an
audited clear. Config endpoints arrive with Plan 2."""

import asyncio
import contextlib
import uuid as _uuid
from datetime import UTC, datetime

from fastapi import (
    APIRouter, HTTPException, WebSocket, WebSocketDisconnect,
)
from sqlalchemy import delete, func, select

from serversherpa.api.deps import (
    AuthContext, DbSession, authenticate_token, require_permission,
)
from serversherpa.api.schemas import (
    LogEntryOut, LogPageOut, SystemProcessOut,
)
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import LogEntry, SystemProcess
from serversherpa.services.audit import audit
from serversherpa.system.registry import derive_status

router = APIRouter(prefix="/system", tags=["system"])

SUPER_ADMIN_RANK = 80
_LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40,
           "CRITICAL": 50}
_KIND_ORDER = {"service": 0, "worker": 1, "probe": 2}
STREAM_POLL_SECONDS = 1.0
STREAM_BATCH_CAP = 500
STREAM_PING_SECONDS = 30.0


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _require_super_admin(actor: AuthContext) -> None:
    if not actor.access.is_global or actor.access.max_rank < SUPER_ADMIN_RANK:
        raise _err(403, "forbidden")


@router.get("/processes", response_model=list[SystemProcessOut])
async def list_processes(
    db: DbSession,
    actor: AuthContext = require_permission("dashboard", "view"),
) -> list[SystemProcessOut]:
    _require_super_admin(actor)
    now = datetime.now(UTC)
    rows = (await db.scalars(select(SystemProcess))).all()
    out = []
    for p in rows:
        status = derive_status(p.heartbeat_at, p.stopped_at, now)
        uptime = None
        if status == "running" and p.started_at is not None:
            uptime = int((now - p.started_at).total_seconds())
        out.append(SystemProcessOut(
            name=p.name, kind=p.kind, status=status, pid=p.pid,
            hostname=p.hostname, started_at=p.started_at,
            heartbeat_at=p.heartbeat_at, stopped_at=p.stopped_at,
            uptime_seconds=uptime, meta=p.meta))
    out.sort(key=lambda p: (_KIND_ORDER.get(p.kind, 9), p.name))
    return out


async def _no_probe(db: DbSession, name: str) -> None:
    row = await db.get(SystemProcess, name)
    if row is not None and row.kind == "probe":
        raise _err(404, "process_has_no_logs")


def _logs_query(name: str, min_level: str | None, q: str | None):
    stmt = select(LogEntry).where(LogEntry.process == name)
    if min_level:
        levelno = _LEVELS.get(min_level.upper())
        if levelno is None:
            raise _err(422, "unknown_level")
        stmt = stmt.where(LogEntry.levelno >= levelno)
    if q:
        stmt = stmt.where(LogEntry.message.ilike(f"%{q}%"))
    return stmt


@router.get("/processes/{name}/logs", response_model=LogPageOut)
async def get_process_logs(
    name: str,
    db: DbSession,
    min_level: str | None = None,
    q: str | None = None,
    before_id: int | None = None,
    limit: int = 200,
    actor: AuthContext = require_permission("devtools", "change"),
) -> LogPageOut:
    await _no_probe(db, name)
    limit = max(1, min(limit, 1000))
    stmt = _logs_query(name, min_level, q)
    if before_id is not None:
        stmt = stmt.where(LogEntry.id < before_id)
    rows = (await db.scalars(
        stmt.order_by(LogEntry.id.desc()).limit(limit + 1))).all()
    has_more = len(rows) > limit
    return LogPageOut(
        entries=[LogEntryOut.model_validate(r) for r in rows[:limit]],
        has_more=has_more)


@router.delete("/processes/{name}/logs")
async def clear_process_logs(
    name: str,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    await _no_probe(db, name)
    result = await db.execute(
        delete(LogEntry).where(LogEntry.process == name))
    deleted = result.rowcount or 0
    audit(db, actor_id=actor.person.id, entity_type="system",
          entity_id=name, action="logs_clear",
          changes={"process": name, "deleted": deleted})
    await db.commit()
    return {"deleted": deleted}


@router.websocket("/processes/{name}/logs/stream")
async def stream_process_logs(ws: WebSocket, name: str) -> None:
    """Live tail. Browsers cannot set Authorization on WebSockets, so
    the access token rides the `token` query param; it is validated
    with the same machinery as HTTP before accept."""
    token = ws.query_params.get("token", "")
    min_level = ws.query_params.get("min_level")
    q = ws.query_params.get("q")

    maker = get_sessionmaker()
    async with maker() as db:
        try:
            actor = await authenticate_token(db, token)
        except HTTPException:
            await ws.close(code=4401)
            return
        if not actor.access.can("devtools", "change"):
            await ws.close(code=4403)
            return
        row = await db.get(SystemProcess, name)
        if row is not None and row.kind == "probe":
            await ws.close(code=4404)
            return
        cursor = await db.scalar(
            select(func.max(LogEntry.id)).where(
                LogEntry.process == name)) or 0

    await ws.accept()
    idle = 0.0
    try:
        while True:
            async with maker() as db:
                stmt = _logs_query(name, min_level, q).where(
                    LogEntry.id > cursor
                ).order_by(LogEntry.id).limit(STREAM_BATCH_CAP)
                rows = (await db.scalars(stmt)).all()
                # cursor advances past filtered-out rows too
                latest = await db.scalar(
                    select(func.max(LogEntry.id)).where(
                        LogEntry.process == name,
                        LogEntry.id > cursor))
            if rows:
                # advance past filtered-out rows too (latest >= rows[-1].id)
                cursor = max(cursor, rows[-1].id, latest or 0)
                await ws.send_json({"entries": [
                    LogEntryOut.model_validate(r).model_dump(mode="json")
                    for r in rows]})
                idle = 0.0
            elif latest is not None:
                cursor = latest
            else:
                idle += STREAM_POLL_SECONDS
                if idle >= STREAM_PING_SECONDS:
                    await ws.send_json({"ping": True})
                    idle = 0.0
            await asyncio.sleep(STREAM_POLL_SECONDS)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        with contextlib.suppress(Exception):
            await ws.close()
```

NOTE on the registry gate: `require_permission("dashboard", "view")` only forces authentication (every global role can view dashboard); the real gate is `_require_super_admin`. If the test's staff user unexpectedly lacks `dashboard: view`, swap the dependency for `CurrentUser` (plain auth) — check `defaults.py` and keep the 403 coming from `_require_super_admin`.

- [ ] **Step 6: Wire the router**

In `api/src/serversherpa/api/app.py`: add `system` to the routes import tuple and `app.include_router(system.router)` after `audit.router`.

- [ ] **Step 7: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_system_api.py tests/test_auth_flow.py -q`
Expected: all passed (auth suite proves the deps refactor is behavior-neutral).

- [ ] **Step 8: Commit**

```bash
git add api/src/serversherpa/api/deps.py api/src/serversherpa/api/routes/system.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/app.py api/tests/test_system_api.py
git commit -m "feat(api): system routes — process registry, log pages, WS tail, audited clear

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the API + import-worker into the pipeline

**Files:**
- Modify: `api/src/serversherpa/api/app.py` (lifespan)
- Modify: `api/src/serversherpa/imports/worker.py` (logging + heartbeat)
- Test: `api/tests/test_system_wiring.py`

**Interfaces:**
- Consumes: `db_logging.install`, `registry.start_heartbeat` / `heartbeat_loop`.
- Produces: process rows `api` and `import-worker` appear + real log rows from the import worker's activity.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_system_wiring.py`:

```python
"""API lifespan + import worker feed the registry and the log store."""

import uuid

from sqlalchemy import func, select
from starlette.testclient import TestClient

from serversherpa.api.app import create_app
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    ImportJob, Initiative, LogEntry, SystemProcess,
)
from serversherpa.imports.worker import run_once
from serversherpa.services.storage import put_object


async def test_api_lifespan_registers_and_logs():
    # No `db` fixture here on purpose: TestClient runs the app in its own
    # thread + loop, and asyncpg pools are loop-bound. Drop any engine the
    # autouse fixture pooled in pytest's loop first; assert afterwards on
    # a freshly created one.
    from serversherpa.db.engine import dispose_engine
    await dispose_engine()
    with TestClient(create_app()) as tc:
        assert tc.get("/healthz").json() == {"status": "ok"}
    async with get_sessionmaker()() as db:
        row = await db.get(SystemProcess, "api")
        assert row is not None
        assert row.kind == "service"
        assert row.heartbeat_at is not None
        assert row.stopped_at is not None        # clean shutdown marked


async def test_import_worker_logs_job_lifecycle(db):
    ini = Initiative(name="Move L", initiative_type="move",
                     status="planned")
    db.add(ini)
    await db.flush()
    job = ImportJob(kind="move_assets", initiative_id=ini.id,
                    filename="ft.csv")
    db.add(job)
    await db.flush()
    key = f"import-jobs/{ini.id}/{job.id}/ft.csv"
    await put_object(key, b"Serial Number\nSN-LOG-1\n", "text/csv")
    job.file_key = key
    await db.commit()

    assert await run_once(get_sessionmaker()) is True

    count = await db.scalar(
        select(func.count()).select_from(LogEntry)
        .where(LogEntry.process == "import-worker"))
    # the DB handler flushes on a 1 s cadence — wait for it
    import asyncio
    for _ in range(30):
        if count:
            break
        await asyncio.sleep(0.2)
        count = await db.scalar(
            select(func.count()).select_from(LogEntry)
            .where(LogEntry.process == "import-worker"))
    assert count >= 1
    messages = " ".join((await db.scalars(select(LogEntry.message).where(
        LogEntry.process == "import-worker"))).all())
    assert str(job.id) in messages               # lifecycle mentions the job
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_system_wiring.py -q`
Expected: FAIL (`api` row missing; no import-worker log rows).

- [ ] **Step 3: Wire the API lifespan**

In `api/src/serversherpa/api/app.py`, replace `_lifespan`:

```python
@asynccontextmanager
async def _lifespan(app: FastAPI):
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    handler = install("api")
    heartbeat = start_heartbeat("api", "service")
    try:
        yield
    finally:
        heartbeat.cancel()
        import asyncio
        await asyncio.gather(heartbeat, return_exceptions=True)
        handler.close()
        await dispose_engine()
```

- [ ] **Step 4: Wire the import worker**

In `api/src/serversherpa/imports/worker.py`:

1. Add near the top: `import logging` and `logger = logging.getLogger("serversherpa.imports.worker")`.
2. `run_once`: after a successful claim add `logger.info("claimed job %s (%s phase=%s)", job.id, job.filename, job.phase)`; in the exception path replace nothing but add `logger.exception("job %s failed in worker: %s", job.id, exc)` before the commit; after `process_job` completes add `logger.info("job %s finished status=%s rows=%s", job.id, job.status, job.processed_rows)`.
3. `run_forever`: replace both `print(...)` calls with `logger.info(...)` equivalents (`"re-queued %d stale job(s)", requeued` and `"watching the queue"`), and at the top (before the requeue block) add:

```python
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("import-worker")
    heartbeat = start_heartbeat("import-worker", "worker")
```

wrap the existing `while True:` loop in `try:` with:

```python
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
```

4. `run_once` must ALSO log through the pipeline when called outside `run_forever` (the wiring test calls it directly): at the top of `run_once` add `from serversherpa.system.db_logging import install` + `install("import-worker")` — `install` is idempotent, so the forever-loop path pays nothing extra.

- [ ] **Step 5: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_system_wiring.py tests/test_import_worker.py -q`
Expected: all passed (the worker suite proves job behavior unchanged).

- [ ] **Step 6: Full API suite + commit**

Run: `cd api && .venv/bin/pytest -q` → all passed.

```bash
git add api/src/serversherpa/api/app.py api/src/serversherpa/imports/worker.py api/tests/test_system_wiring.py
git commit -m "feat(api): api + import-worker join the registry and log pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Portal — client, helpers, minRank gating, Processes page

**Files:**
- Modify: `portal/src/lib/api.ts` (append system client)
- Create: `portal/src/lib/system.ts`
- Test: `portal/src/lib/system.test.ts`
- Modify: `portal/src/lib/godmode.ts` (+ its test `portal/src/lib/godmode.test.ts`)
- Modify: `portal/src/layout/navSections.tsx` (NavItem type + Processes item)
- Modify: `portal/src/components/ProtectedRoute.tsx` (minRank prop)
- Create: `portal/src/pages/SystemProcesses.tsx`
- Modify: `portal/src/App.tsx` (route)

**Interfaces:**
- Consumes: Task 5's endpoints; `useAuth` exposing `maxRank`, `can`, `godMode` (already exists).
- Produces (for Task 8): in `api.ts` — `SystemProcessOut`, `listSystemProcesses(): Promise<SystemProcessOut[]>`, `LogEntryOut`, `LogPageOut`, `getProcessLogs(name, opts: {minLevel?, q?, beforeId?, limit?})`, `clearProcessLogs(name): Promise<{deleted: number}>`, `logStreamUrl(name, token, opts: {minLevel?, q?}): string` (http→ws scheme swap on `apiUrl()`), `getAccessTokenForStream(): string | null` (exports the module's current access token). In `system.ts` — `statusMeta(status)`, `formatAge(iso, nowMs)`, `formatUptime(seconds)`.

- [ ] **Step 1: Write the failing helper tests**

Create `portal/src/lib/system.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { formatAge, formatUptime, statusMeta } from './system';

describe('statusMeta', () => {
  it('maps the three statuses', () => {
    expect(statusMeta('running')).toEqual(
      { label: 'Running', className: 'sys-dot-running' });
    expect(statusMeta('stopped')).toEqual(
      { label: 'Stopped', className: 'sys-dot-stopped' });
    expect(statusMeta('failed')).toEqual(
      { label: 'Failed', className: 'sys-dot-failed' });
    expect(statusMeta('weird')).toEqual(
      { label: 'weird', className: 'sys-dot-stopped' });
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-08-26T12:00:00Z');
  it('renders humane ages', () => {
    expect(formatAge('2026-08-26T11:59:57Z', now)).toBe('3 s ago');
    expect(formatAge('2026-08-26T11:58:00Z', now)).toBe('2 min ago');
    expect(formatAge('2026-08-26T09:00:00Z', now)).toBe('3 h ago');
    expect(formatAge(null, now)).toBe('—');
  });
});

describe('formatUptime', () => {
  it('renders compact uptime', () => {
    expect(formatUptime(42)).toBe('42s');
    expect(formatUptime(3900)).toBe('1h 5m');
    expect(formatUptime(90 * 3600)).toBe('3d 18h');
    expect(formatUptime(null)).toBe('—');
  });
});
```

Add to `portal/src/lib/godmode.test.ts` (keep existing tests intact):

```typescript
describe('minRank gating', () => {
  const yes = () => true;
  it('hides items below the rank floor', () => {
    const item = { resource: 'dashboard', minRank: 80 };
    expect(isNavItemVisible(item, yes, false, 60)).toBe(false);
    expect(isNavItemVisible(item, yes, false, 80)).toBe(true);
  });
  it('items without minRank ignore rank', () => {
    expect(isNavItemVisible({ resource: 'dashboard' }, yes, false, 0))
      .toBe(true);
  });
});
```

(Adjust the import/describe wrapper to the file's existing style; `isNavItemVisible` gains a 4th parameter — update the existing call sites in the tests to pass a rank, e.g. `0`.)

- [ ] **Step 2: Run — must fail**

Run: `cd portal && npx vitest run src/lib/system.test.ts src/lib/godmode.test.ts`
Expected: FAIL (module missing / wrong arity).

- [ ] **Step 3: Implement helpers + gating**

Create `portal/src/lib/system.ts`:

```typescript
/** Pure helpers for the System pages (processes list + log viewer). */

export function statusMeta(status: string): { label: string; className: string } {
  switch (status) {
    case 'running': return { label: 'Running', className: 'sys-dot-running' };
    case 'failed': return { label: 'Failed', className: 'sys-dot-failed' };
    case 'stopped': return { label: 'Stopped', className: 'sys-dot-stopped' };
    default: return { label: status, className: 'sys-dot-stopped' };
  }
}

export function formatAge(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
```

In `portal/src/lib/godmode.ts`: add `minRank?: number` to `GodGatedItem` and extend the function:

```typescript
export function isNavItemVisible(
  item: GodGatedItem,
  can: (resource: string, action: 'view') => boolean,
  godMode: boolean,
  maxRank: number,
): boolean {
  if (item.minRank !== undefined && maxRank < item.minRank) return false;
  if (!can(item.resource, 'view')) return false;
  return !item.godOnly || godMode;
}
```

Update the `AppShell.tsx` call site to pass `maxRank` (it comes from `useAuth()` — add it to the destructure there), and fix any other `isNavItemVisible` callers/tests to the new arity.

In `portal/src/layout/navSections.tsx`: extend the item type — `export interface NavItem { to: string; label: string; resource: string; icon: ReactNode; godOnly?: boolean; minRank?: number }` — and add the Processes item to the **System** section between Access control and Settings:

```tsx
      {
        to: '/system/processes',
        label: 'Processes',
        resource: 'dashboard',
        minRank: 80,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 9h6v6H9z" />
            <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
          </svg>
        ),
      },
```

In `portal/src/components/ProtectedRoute.tsx`: add a `minRank` prop —

```tsx
export default function ProtectedRoute({
  children, resource, minRank,
}: { children: ReactNode; resource?: string; minRank?: number }) {
  const { status, mustChangePassword, can, maxRank } = useAuth();
```

and after the resource check add:

```tsx
  if (minRank !== undefined && maxRank < minRank) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Access control</div>
        <h1 className="page-title">No access</h1>
        <p className="page-hint">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }
```

- [ ] **Step 4: api.ts client additions**

Append to `portal/src/lib/api.ts`:

```typescript
// ── system: process registry + logs ─────────────────────────────────

export interface SystemProcessOut {
  name: string;
  kind: 'service' | 'worker' | 'probe';
  status: 'running' | 'stopped' | 'failed';
  pid: number | null;
  hostname: string;
  started_at: string | null;
  heartbeat_at: string | null;
  stopped_at: string | null;
  uptime_seconds: number | null;
  meta: Record<string, unknown>;
}

export async function listSystemProcesses(): Promise<SystemProcessOut[]> {
  const resp = await apiFetch('/system/processes');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export interface SystemLogEntry {
  id: number;
  level: string;
  levelno: number;
  logger: string;
  message: string;
  at: string;
}

export interface SystemLogPage {
  entries: SystemLogEntry[];
  has_more: boolean;
}

export async function getProcessLogs(
  name: string,
  opts: { minLevel?: string; q?: string; beforeId?: number; limit?: number } = {},
): Promise<SystemLogPage> {
  const params = new URLSearchParams();
  if (opts.minLevel) params.set('min_level', opts.minLevel);
  if (opts.q) params.set('q', opts.q);
  if (opts.beforeId !== undefined) params.set('before_id', String(opts.beforeId));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const suffix = params.size ? `?${params}` : '';
  const resp = await apiFetch(`/system/processes/${name}/logs${suffix}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function clearProcessLogs(
  name: string,
): Promise<{ deleted: number }> {
  const resp = await apiFetch(`/system/processes/${name}/logs`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** The live-tail WebSocket URL. Browsers cannot set Authorization on
 *  WebSockets, so the current access token rides a query param. */
export function logStreamUrl(
  name: string, token: string,
  opts: { minLevel?: string; q?: string } = {},
): string {
  const params = new URLSearchParams({ token });
  if (opts.minLevel) params.set('min_level', opts.minLevel);
  if (opts.q) params.set('q', opts.q);
  return `${apiUrl().replace(/^http/, 'ws')}/system/processes/${name}/logs/stream?${params}`;
}

export function getAccessTokenForStream(): string | null {
  return accessToken;
}
```

(`accessToken` is the module-level variable `apiFetch` already uses — export it via this accessor, do not restructure the module.)

- [ ] **Step 5: Processes page + route**

Create `portal/src/pages/SystemProcesses.tsx`:

```tsx
/** System → Processes: the heartbeat registry with derived status.
 *  Rows link to the log viewer only for god-mode developers. */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { listSystemProcesses, type SystemProcessOut } from '../lib/api';
import { formatAge, formatUptime, statusMeta } from '../lib/system';

const POLL_MS = 10_000;

export default function SystemProcesses() {
  const { can, godMode } = useAuth();
  const canViewLogs = can('devtools', 'view') && godMode;
  const [rows, setRows] = useState<SystemProcessOut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () =>
      listSystemProcesses()
        .then((r) => { if (alive) { setRows(r); setError(null); } })
        .catch(() => { if (alive) setError('Cannot load processes.'); });
    void load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(poll); clearInterval(tick); };
  }, []);

  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <h1 className="page-title">Processes</h1>
      <p className="page-hint">
        Every ServerSherpa process, its heartbeat, and its status.
      </p>

      {error && <div className="dir-empty"><b>{error}</b></div>}

      <div className="dir-list sys-proc-list">
        <div className="list-head sys-proc-grid">
          <span className="col-head">Status</span>
          <span className="col-head">Process</span>
          <span className="col-head">Kind</span>
          <span className="col-head">Host</span>
          <span className="col-head">PID</span>
          <span className="col-head">Uptime</span>
          <span className="col-head">Last heartbeat</span>
        </div>
        {rows.map((p) => {
          const meta = statusMeta(p.status);
          const degraded = p.meta.forwarding_degraded === true;
          const body = (
            <>
              <span className="sys-status">
                <span className={`sys-dot ${meta.className}`} />
                {meta.label}
                {degraded && (
                  <span className="chip c-amber">forwarding degraded</span>
                )}
              </span>
              <span className="sys-name">{p.name}</span>
              <span><span className="chip c-slate">{p.kind}</span></span>
              <span>{p.hostname || '—'}</span>
              <span>{p.pid ?? '—'}</span>
              <span>{formatUptime(p.uptime_seconds)}</span>
              <span>{formatAge(p.heartbeat_at, now)}</span>
            </>
          );
          return canViewLogs && p.kind !== 'probe' ? (
            <Link key={p.name} className="list-row sys-proc-grid"
                  to={`/system/processes/${p.name}/logs`}>
              {body}
            </Link>
          ) : (
            <div key={p.name} className="list-row sys-proc-grid">{body}</div>
          );
        })}
        {rows.length === 0 && !error && (
          <p className="page-hint" style={{ padding: 16 }}>
            No processes have registered yet.
          </p>
        )}
      </div>
    </div>
  );
}
```

Add scoped styles (grid columns, the pulsing status dots) to a new `portal/src/styles/system.css` (imported from the page: `import '../styles/system.css';` — mirror how existing pages import their stylesheets; check `Sites.tsx` or `InitiativeDetail.tsx` for the exact idiom and match it):

```css
/* System pages: processes list + log viewer */
.sys-proc-grid { grid-template-columns: 170px 1.2fr 110px 1fr 80px 110px 140px; }
.sys-status { display: flex; align-items: center; gap: 8px; }
.sys-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
.sys-dot-running { background: var(--c-green, #178a4c); animation: sys-pulse 2s infinite; }
.sys-dot-stopped { background: var(--c-slate, #51606f); }
.sys-dot-failed { background: var(--c-red, #c03540); }
@keyframes sys-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(23, 138, 76, 0.4); }
  50% { box-shadow: 0 0 0 5px rgba(23, 138, 76, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .sys-dot-running { animation: none; }
}
```

(If existing pages centralize CSS in `portal/src/styles/*.css` imported once globally, follow THAT convention instead — put the block wherever `initiatives.css` is loaded from and skip the per-page import.)

In `portal/src/App.tsx`: import the page and add after the `/settings` route:

```tsx
            <Route path="/system/processes" element={
              <ProtectedRoute minRank={80}><SystemProcesses /></ProtectedRoute>
            } />
```

- [ ] **Step 6: Verify**

Run: `cd portal && npx tsc --noEmit && npx vitest run`
Expected: clean types; all tests green (including the updated godmode suite).

- [ ] **Step 7: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/system.ts portal/src/lib/system.test.ts portal/src/lib/godmode.ts portal/src/lib/godmode.test.ts portal/src/layout/navSections.tsx portal/src/layout/AppShell.tsx portal/src/components/ProtectedRoute.tsx portal/src/pages/SystemProcesses.tsx portal/src/styles/system.css portal/src/App.tsx
git commit -m "feat(portal): System processes page + minRank gating + system API client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Portal — log viewer page

**Files:**
- Create: `portal/src/lib/logViewer.ts`
- Test: `portal/src/lib/logViewer.test.ts`
- Create: `portal/src/pages/ProcessLogs.tsx`
- Modify: `portal/src/App.tsx` (route)
- Modify: `portal/src/styles/system.css` (viewer styles — same file/convention as Task 7)

**Interfaces:**
- Consumes: `getProcessLogs`, `clearProcessLogs`, `logStreamUrl`, `getAccessTokenForStream`, `statusMeta` (Task 7).
- Produces (in `logViewer.ts`):
  - `nextBackoff(prevMs: number): number` — 1000 → doubling → cap 30000; `nextBackoff(0)` = 1000.
  - `splitMessage(message: string): { head: string; rest: string | null }` — first line vs the remainder (tracebacks), `rest` null for single-line messages.
  - `levelClass(level: string): string` — `log-DEBUG|INFO|WARNING|ERROR|CRITICAL`, unknown → `log-INFO`.
  - `mergeEntries(existing, incoming)` — id-deduped, ascending-id merge (WS reconnect resync can overlap the GET refill).

- [ ] **Step 1: Write the failing helper tests**

Create `portal/src/lib/logViewer.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  levelClass, mergeEntries, nextBackoff, splitMessage,
} from './logViewer';

const entry = (id: number): { id: number } & Record<string, unknown> => ({
  id, level: 'INFO', levelno: 20, logger: 't', message: `m${id}`,
  at: '2026-08-26T12:00:00Z',
});

describe('nextBackoff', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(nextBackoff(0)).toBe(1000);
    expect(nextBackoff(1000)).toBe(2000);
    expect(nextBackoff(16000)).toBe(30000);
    expect(nextBackoff(30000)).toBe(30000);
  });
});

describe('splitMessage', () => {
  it('splits multi-line, passes single-line through', () => {
    expect(splitMessage('one line')).toEqual({ head: 'one line', rest: null });
    expect(splitMessage('err\nTraceback\n  boom')).toEqual(
      { head: 'err', rest: 'Traceback\n  boom' });
  });
});

describe('levelClass', () => {
  it('maps known and unknown levels', () => {
    expect(levelClass('ERROR')).toBe('log-ERROR');
    expect(levelClass('whatever')).toBe('log-INFO');
  });
});

describe('mergeEntries', () => {
  it('dedupes by id and keeps ascending order', () => {
    const merged = mergeEntries(
      [entry(1), entry(2)] as never,
      [entry(2), entry(3)] as never);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `cd portal && npx vitest run src/lib/logViewer.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement logViewer.ts**

```typescript
/** Pure helpers for the process log viewer. */

import type { SystemLogEntry } from './api';

export function nextBackoff(prevMs: number): number {
  if (prevMs <= 0) return 1000;
  return Math.min(prevMs * 2, 30_000);
}

export function splitMessage(
  message: string,
): { head: string; rest: string | null } {
  const idx = message.indexOf('\n');
  if (idx === -1) return { head: message, rest: null };
  return { head: message.slice(0, idx), rest: message.slice(idx + 1) };
}

const KNOWN = new Set(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);

export function levelClass(level: string): string {
  return `log-${KNOWN.has(level) ? level : 'INFO'}`;
}

export function mergeEntries(
  existing: SystemLogEntry[], incoming: SystemLogEntry[],
): SystemLogEntry[] {
  const seen = new Set(existing.map((e) => e.id));
  const merged = [...existing];
  for (const e of incoming) {
    if (!seen.has(e.id)) { merged.push(e); seen.add(e.id); }
  }
  return merged.sort((a, b) => a.id - b.id);
}
```

- [ ] **Step 4: Build the page**

Create `portal/src/pages/ProcessLogs.tsx`. Structure (all of it real JSX — reuse `portal-page`, `eyebrow`, `mini-btn`, `dir-empty`, chips; add `.log-*` styles to system.css):

```tsx
/** Developer log viewer: live WS tail + paged history for one process.
 *  All state renders from server data; reconnects resync via GET. */

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  clearProcessLogs, getAccessTokenForStream, getProcessLogs,
  logStreamUrl, type SystemLogEntry,
} from '../lib/api';
import {
  levelClass, mergeEntries, nextBackoff, splitMessage,
} from '../lib/logViewer';
import '../styles/system.css';

const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'] as const;
const PAGE_LIMIT = 200;

export default function ProcessLogs() {
  const { name = '' } = useParams<{ name: string }>();
  const [entries, setEntries] = useState<SystemLogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [minLevel, setMinLevel] = useState<string>('DEBUG');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [wsState, setWsState] = useState<'live' | 'connecting'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  /* debounce search input (300 ms) → debouncedQuery */
  /* initial + filter-change load: GET latest page (reversed into
     ascending order), setEntries/setHasMore */
  /* WS effect keyed on [name, minLevel, debouncedQuery]:
       - close any previous socket
       - connect logStreamUrl(name, token, {minLevel, q}); token from
         getAccessTokenForStream(); missing token → error state
       - onmessage: parse; ignore {ping}; merge entries via mergeEntries
       - onclose/onerror: schedule reconnect via nextBackoff(backoffRef),
         re-running the GET on success to fill any gap; wsState tracks it
       - cleanup closes the socket */
  /* follow effect: when follow && new entries, scroll bodyRef to bottom;
     an onScroll handler that detects a user scroll away from the bottom
     (scrollHeight - scrollTop - clientHeight > 40) turns follow off */
  /* loadOlder(): GET with before_id = entries[0]?.id, prepend via
     mergeEntries, keep scroll position stable */
  /* clear(): confirm dialog → clearProcessLogs(name) → empty entries */

  return (
    <div className="portal-page sys-logs-page">
      {/* header: back Link to /system/processes, eyebrow "Process logs",
          title {name}, right side: connection chip
          (wsState === 'live' ? 'Live' : 'Reconnecting…'), Clear logs
          button (mini-btn danger) */}
      {/* toolbar: segmented level buttons (LEVELS, active = minLevel),
          search input, Follow toggle button (active state visible) */}
      {/* body: div ref=bodyRef className="sys-log-body" — for each entry:
          <div className={`sys-log-line ${levelClass(entry.level)}`}>
            gutter: level tag + time (HH:MM:SS), logger, head of
            splitMessage; when rest !== null a "+N lines" expander toggling
            entry.id in `expanded`, showing <pre> with the rest.
          "Load older" button at top when hasMore.
          Empty state: "No log entries yet — they appear live." */}
      {/* error banner (dir-empty) when error */}
    </div>
  );
}
```

The comment blocks above are the section spec — every one must be real code in the implementation (the effects, the debounce, the reconnect loop, the follow logic, the render). No `console.log` noise; the reconnect timer must be cleaned up on unmount.

Viewer styles to append to `portal/src/styles/system.css`:

```css
.sys-log-body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px; line-height: 1.5; overflow-y: auto;
  max-height: calc(100vh - 260px); border: 1px solid var(--line, #e2e2e2);
  border-radius: 12px; padding: 8px 0; background: var(--surface, #fff); }
.sys-log-line { display: grid;
  grid-template-columns: 70px 64px minmax(120px, 220px) 1fr;
  gap: 10px; padding: 1px 14px; }
.sys-log-line pre { grid-column: 4; white-space: pre-wrap; margin: 2px 0 6px; }
.log-DEBUG { color: var(--c-slate, #51606f); }
.log-WARNING { color: var(--c-amber, #a36207); }
.log-ERROR, .log-CRITICAL { color: var(--c-red, #c03540); }
```

In `portal/src/App.tsx`, after the processes route:

```tsx
            <Route path="/system/processes/:name/logs" element={
              <ProtectedRoute resource="devtools"><ProcessLogs /></ProtectedRoute>
            } />
```

(`resource="devtools"` means view permission; the API enforces `devtools: change` on every call regardless — nav hides the entry point behind godMode already.)

- [ ] **Step 5: Verify**

Run: `cd portal && npx tsc --noEmit && npx vitest run`
Expected: clean + all green.

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/logViewer.ts portal/src/lib/logViewer.test.ts portal/src/pages/ProcessLogs.tsx portal/src/styles/system.css portal/src/App.tsx
git commit -m "feat(portal): developer log viewer — live WS tail, filters, clear

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Live end-to-end verification (controller)

**Files:** none (verification; fix-forward + re-run suites if anything surfaces).

- [ ] **Step 1: Migrate + start the stack**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/api && .venv/bin/alembic upgrade head
```

Expected: `Running upgrade 0023 -> 0024`. Restart the dev API (it must pick up the new lifespan), start `serversherpa import-worker --reload` and `serversherpa log-service --reload` (background), portal dev server up.

- [ ] **Step 2: Browser verification**

1. Log in as the dev admin; god-unlock. System → Processes shows `api`, `import-worker`, `log-service` running (pulsing green) and `web` running via the probe.
2. Kill the import worker → within ~15 s its row shows **failed**; restart → running; Ctrl+C (clean) → **stopped**.
3. Open the api process logs: entries stream live (trigger some API activity); level filter to ERROR; search a substring; Load older works; Clear logs empties and audits.
4. Run a small move-assets import; open import-worker logs: claimed/finished lifecycle lines with the job id appear live over the WebSocket.
5. As a plain admin (rank 60): Processes nav item hidden; direct URL shows "No access". As super_admin without god mode: list visible, rows not clickable.
6. Screenshot the Processes page and a live log view.

- [ ] **Step 3: Full suites**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/api && .venv/bin/pytest -q
```

```bash
cd /Users/jrh1812/Developer/BaseCampV3/portal && npx tsc --noEmit && npx vitest run
```

Expected: everything green.
