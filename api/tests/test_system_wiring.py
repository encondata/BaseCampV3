"""API lifespan + import worker feed the registry and the log store."""

import uuid

from sqlalchemy import func, select
from starlette.testclient import TestClient

from serversherpa.api.app import create_app
from serversherpa.db.engine import dispose_engine, get_sessionmaker
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

    # the DB handler flushes on a 1 s cadence — poll for the job's OWN
    # lifecycle lines (in the shared test interpreter, handlers from other
    # tests can tag stray root-logger records as import-worker, so a bare
    # row-count check would pass early on noise)
    import asyncio

    async def _messages() -> str:
        return " ".join((await db.scalars(select(LogEntry.message).where(
            LogEntry.process == "import-worker"))).all())

    messages = await _messages()
    for _ in range(30):
        if str(job.id) in messages:
            break
        await asyncio.sleep(0.2)
        messages = await _messages()
    assert str(job.id) in messages               # lifecycle mentions the job


async def test_api_lifespan_marks_stop_despite_stale_prior_row():
    # a previous run's row must not satisfy the startup freshness check
    from datetime import UTC, datetime, timedelta
    import os

    await dispose_engine()
    async with get_sessionmaker()() as db:
        stale = datetime.now(UTC) - timedelta(minutes=10)
        db.add(SystemProcess(name="api", kind="service", pid=1,
                             hostname="oldbox", started_at=stale,
                             heartbeat_at=stale, stopped_at=None))
        await db.commit()
    await dispose_engine()

    with TestClient(create_app()) as tc:
        assert tc.get("/healthz").json() == {"status": "ok"}

    async with get_sessionmaker()() as db:
        row = await db.get(SystemProcess, "api")
        assert row.pid == os.getpid()             # updated to this run's pid
        assert row.hostname != "oldbox"            # this run overwrote it
        assert row.stopped_at is not None         # clean shutdown marked
