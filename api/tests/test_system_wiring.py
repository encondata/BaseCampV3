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
