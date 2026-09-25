"""Worker loop: claim -> process -> terminal status, against real MinIO."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset,
    ImportJob,
    Initiative,
    InitiativeAsset,
)
from serversherpa.imports.jobs import claim_next, requeue_stale
from serversherpa.imports.worker import run_once
from serversherpa.services.storage import get_object, put_object

CSV = b"Serial Number,Asset Name\nSN-W1,web-01\nSN-W2,web-02\n"


async def _job(db, *, phase="validate", content=CSV, filename="ft.csv",
               status="queued", options=None):
    ini = Initiative(name=f"Move {uuid.uuid4().hex[:6]}",
                     initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    job = ImportJob(kind="move_assets", initiative_id=ini.id,
                    filename=filename, phase=phase, status=status,
                    options=options or {})
    db.add(job)
    await db.flush()
    key = f"import-jobs/{ini.id}/{job.id}/{filename}"
    await put_object(key, content, "text/csv")
    job.file_key = key
    await db.commit()
    return job.id, ini.id


async def test_storage_get_object_roundtrip(db):
    await put_object("import-jobs/test/roundtrip.bin", b"hello", "text/plain")
    assert await get_object("import-jobs/test/roundtrip.bin") == b"hello"


async def test_claim_next_marks_running_oldest_first(db):
    job1, _ = await _job(db)
    job2, _ = await _job(db)
    claimed = await claim_next(db)
    assert claimed.id == job1
    assert claimed.status == "running"
    assert claimed.started_at is not None and claimed.progress_at is not None
    claimed2 = await claim_next(db)
    assert claimed2.id == job2
    assert await claim_next(db) is None


async def test_run_once_validate_job(db):
    job_id, _ = await _job(db)
    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, job_id)
    assert job.status == "completed"
    assert job.phase == "validate"
    assert job.total_rows == 2
    assert job.results["summary"]["created"] == 2
    assert len(job.results["details"]) == 2
    # validate never writes
    assert await db.scalar(select(func.count()).select_from(Asset)) == 0


async def test_run_once_commit_job_writes(db):
    job_id, ini_id = await _job(db, phase="commit")
    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, job_id)
    assert job.status == "completed"
    assert (job.created_count, job.updated_count) == (2, 0)
    assert await db.scalar(select(func.count()).select_from(Asset)) == 2
    assert await db.scalar(select(func.count()).where(
        InitiativeAsset.initiative_id == ini_id)
        .select_from(InitiativeAsset)) == 2


async def test_run_once_bad_file_fails_job(db):
    job_id, _ = await _job(db, content=b"Asset Name\nx\n")  # no serial column
    await run_once(get_sessionmaker())
    job = await db.get(ImportJob, job_id)
    assert job.status == "failed"
    assert job.error == "missing_serial_column"
    assert job.finished_at is not None


async def test_run_once_respects_pre_cancel(db):
    job_id, _ = await _job(db)
    job = await db.get(ImportJob, job_id)
    job.cancel_requested = True
    await db.commit()
    await run_once(get_sessionmaker())
    await db.refresh(job)
    assert job.status == "cancelled"


async def test_run_once_empty_queue(db):
    assert await run_once(get_sessionmaker()) is False


async def test_requeue_stale(db):
    job_id, _ = await _job(db, status="running")
    job = await db.get(ImportJob, job_id)
    job.progress_at = datetime.now(UTC) - timedelta(minutes=11)
    await db.commit()
    assert await requeue_stale(db) == 1
    await db.refresh(job)
    assert job.status == "queued"
    # fresh running jobs are left alone
    job.status = "running"
    job.progress_at = datetime.now(UTC)
    await db.commit()
    assert await requeue_stale(db) == 0


async def test_run_forever_survives_a_failing_sweep(db, monkeypatch):
    """A sweep that raises (a DB blip) is logged and skipped until the next
    hour: the loop keeps claiming jobs and never retries the sweep at once."""
    from serversherpa.imports import worker

    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    calls = {"n": 0}

    async def broken_sweep(session, **kw):
        calls["n"] += 1
        raise RuntimeError("db blip")

    monkeypatch.setattr(worker, "sweep_stale", broken_sweep)
    job_id, _ = await _job(db)
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05))
    try:
        job = None
        for _ in range(100):
            await asyncio.sleep(0.05)
            job = await db.scalar(select(ImportJob).where(ImportJob.id == job_id)
                                  .execution_options(populate_existing=True))
            if job.status == "completed":
                break
        assert job.status == "completed"               # the queued job still ran
        await asyncio.sleep(0.2)                       # several more idle loops
        assert not task.done()                         # the failing sweep did not kill it
        assert calls["n"] == 1                         # and is not retried every loop
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
