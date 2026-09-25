"""The import worker loop — a separate process from the API
(`serversherpa import-worker`). Claims queued import_jobs rows and runs
the pipeline; the API process never parses files or writes import rows.
Three kinds share the queue: `move_assets` (a roster file, below),
`asset_bulk_update` (parsed rows in `payload`, applied by
assets/bulk_update.apply_job in one transaction) and `move_setup` (a
Create-a-move-in-steps draft in `payload`, created by
imports/move_setup.apply_job in one transaction). Every hour the loop also
sweeps stale drafts, their orphaned file checks, and abandoned bulk asset
update previews (jobs.sweep_stale).

Shutdown story: no signal handling on purpose. Commit-phase work is
committed every BATCH_SIZE rows and the update path is idempotent, so
killing the worker mid-job loses at most one uncommitted batch; the job
sits 'running' until the next worker start re-queues it via
requeue_stale, and the re-run converges on the same result."""

import asyncio
import logging
import time
from datetime import UTC, datetime

from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.assets.bulk_update import KIND as ASSET_BULK_UPDATE
from serversherpa.assets.bulk_update import apply_job
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import ImportJob
from serversherpa.imports import move_setup
from serversherpa.imports.jobs import claim_next, requeue_stale, sweep_stale
from serversherpa.imports.move_assets import parse_row, run_import
from serversherpa.imports.parsing import ImportFileError, parse_upload
from serversherpa.services.storage import get_object

logger = logging.getLogger("serversherpa.imports.worker")

SWEEP_SECONDS = 3600


def _finish(job: ImportJob, status: str, error: str | None = None) -> None:
    job.status = status
    job.error = error
    job.finished_at = datetime.now(UTC)


async def _process_asset_bulk_update(db: AsyncSession, job: ImportJob) -> None:
    """Apply a bulk asset update. Its transaction stays open for the whole
    file, so progress goes through a second, short-lived session that
    commits at once — the page polling the job sees it immediately."""
    job_id = job.id
    job.total_rows = len(job.payload or [])
    job.processed_rows = 0
    job.progress_at = datetime.now(UTC)
    await db.commit()

    async def _progress(processed: int) -> None:
        async with get_sessionmaker()() as side:
            await side.execute(
                update(ImportJob).where(ImportJob.id == job_id)
                .values(processed_rows=processed, progress_at=func.now()))
            await side.commit()

    await apply_job(db, job, progress=_progress)
    await db.commit()


async def _process_move_setup(db: AsyncSession, job: ImportJob) -> None:
    """Create a move from a queued Create-a-move-in-steps draft. The create
    runs in one transaction (move_setup.apply_job); progress goes through a
    second, short-lived session, exactly like the bulk asset update."""
    job_id = job.id
    try:
        plan = await move_setup.prepare(db, job)
    except move_setup.SetupFailed as exc:
        move_setup.mark_failed(job, exc.code, exc.reasons)
        await db.commit()
        return
    job.total_rows = plan.total
    job.processed_rows = 0
    job.progress_at = datetime.now(UTC)
    await db.commit()

    async def _progress(processed: int) -> None:
        async with get_sessionmaker()() as side:
            await side.execute(
                update(ImportJob).where(ImportJob.id == job_id)
                .values(processed_rows=processed, progress_at=func.now()))
            await side.commit()

    await move_setup.apply_job(db, job, plan, progress=_progress)
    await db.commit()


async def process_job(db: AsyncSession, job: ImportJob) -> None:
    """Run one claimed (status='running') job to a terminal status."""
    if job.cancel_requested:
        _finish(job, "cancelled")
        if job.kind == ASSET_BULK_UPDATE:
            job.payload = None
        await db.commit()
        return
    if job.kind == ASSET_BULK_UPDATE:
        await _process_asset_bulk_update(db, job)
        return
    if job.kind == move_setup.KIND:
        await _process_move_setup(db, job)
        return
    try:
        content = await get_object(job.file_key)
    except Exception:
        _finish(job, "failed", "file_unreadable")
        await db.commit()
        return
    try:
        numbered = parse_upload(job.filename, content)
    except ImportFileError as exc:
        _finish(job, "failed", exc.code)
        await db.commit()
        return

    opts = job.options or {}
    parsed = [parse_row(n, canonical, raw,
                        generate_serials=bool(opts.get("generate_serials")))
              for n, canonical, raw in numbered]

    only_rows = set(opts.get("only_rows") or [])
    if only_rows:
        parsed = [r for r in parsed if r["row"] in only_rows]
    job.total_rows = len(parsed)

    async def _progress(processed: int, created: int, updated: int,
                        errors: int) -> None:
        job.processed_rows = processed
        job.created_count = created
        job.updated_count = updated
        job.error_count = errors
        job.progress_at = datetime.now(UTC)
        # the pipeline commits right after each progress call

    async def _cancelled() -> bool:
        await db.refresh(job, ["cancel_requested"])
        return job.cancel_requested

    write = job.phase == "commit"
    result = await run_import(
        db, initiative_id=job.initiative_id, added_by=job.created_by,
        rows=parsed,
        make_model_mode=str(opts.get("make_model_mode") or "fuzzy"),
        write=write,
        source_label=f"import-job {job.id} ({job.filename})",
        progress=_progress if write else None,
        is_cancelled=_cancelled if write else None)

    summary = result["summary"]
    job.processed_rows = summary["processed_rows"]
    job.created_count = summary["created"]
    job.updated_count = summary["updated"]
    job.error_count = summary["errors"]
    job.results = {"summary": summary, "details": result["details"]}
    job.progress_at = datetime.now(UTC)
    _finish(job, "cancelled" if result["cancelled"] else "completed")
    await db.commit()


async def run_once(sessionmaker) -> bool:
    """Claim and process at most one job. False when the queue is empty."""
    from serversherpa.system.db_logging import install
    install("import-worker")

    async with sessionmaker() as db:
        job = await claim_next(db)
        if job is None:
            return False
        kind = job.kind                  # read now: a rollback below expires the row
        logger.info("claimed job %s (%s phase=%s)",
                    job.id, job.filename, job.phase)
        try:
            await process_job(db, job)
        except Exception as exc:                       # job must terminate
            logger.exception("job %s failed in worker: %s", job.id, exc)
            await db.rollback()
            if kind == move_setup.KIND:
                # the draft stays editable: payload kept, a sentence code
                move_setup.mark_failed(job, "worker_error", [move_setup.WORKER_ERROR_MESSAGE])
            else:
                _finish(job, "failed", f"worker_error: {exc}")
            if kind == ASSET_BULK_UPDATE:
                job.payload = None       # the parsed file is never read again
            await db.commit()
        logger.info("job %s finished status=%s rows=%s",
                    job.id, job.status, job.processed_rows)
        return True


async def _sweep(maker) -> None:
    """One sweep_stale pass that can never stop the loop: a failure (a DB
    blip) is logged and rolled back, and the next hour's pass tries again."""
    try:
        async with maker() as db:
            try:
                swept = await sweep_stale(db)
            except Exception:
                await db.rollback()
                raise
    except Exception:
        logger.exception("sweep of stale drafts and previews failed; retrying in an hour")
        return
    if any(swept.values()):
        logger.info("swept %d draft(s), %d check(s), %d preview(s)",
                    swept["drafts"], swept["checks"], swept["previews"])


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("import-worker")
    pause_state = {"paused": False}
    check_state = {}
    heartbeat = start_heartbeat("import-worker", "worker",
                                meta_fn=lambda: dict(pause_state))

    maker = get_sessionmaker()
    try:
        async with maker() as db:
            requeued = await requeue_stale(db)
            if requeued:
                logger.info("re-queued %d stale job(s)", requeued)
        logger.info("watching the queue")
        last_sweep = -SWEEP_SECONDS
        while True:
            # read-only mode's "also pause background services": idle (still
            # heart-beating as paused) until the flag clears — no work lost
            if await poll_workers_paused(maker, check_state):
                if not pause_state["paused"]:
                    logger.info("paused by read-only maintenance mode")
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            if pause_state["paused"]:
                logger.info("resumed")
            pause_state["paused"] = False
            if time.monotonic() - last_sweep >= SWEEP_SECONDS:   # the first pass = start-up
                await _sweep(maker)
                last_sweep = time.monotonic()      # even after a failure: retry next hour
            worked = await run_once(maker)
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
