"""The worker loop (`devices worker`): claim a job, run its handler, record
how it went; sweep up jobs a dead worker left running once a minute."""

import asyncio
import logging
import time

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from serversherpa_devices.apple.asc import AscError, AscRateLimited
from serversherpa_devices.db.engine import get_sessionmaker
from serversherpa_devices.db.models import Job
from serversherpa_devices.worker import jobs
from serversherpa_devices.worker.queue import (
    RATE_LIMITED,
    JobFailed,
    claim_next,
    done,
    fail,
    own_attempt,
    requeue_stale,
    requeue_without_attempt,
    retry_or_fail,
)

log = logging.getLogger("serversherpa_devices.worker")

STALE_SWEEP_SECONDS = 60


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")


async def process_job(db: AsyncSession, job: Job) -> dict | None:
    """Run one claimed job's handler; its result (raises on failure)."""
    handler = jobs.HANDLERS.get(job.kind)
    if handler is None:
        raise JobFailed(f"unknown job kind {job.kind!r}")
    return await handler(db, job)


def _log_failure(job_id, kind: str, exc: Exception) -> None:
    # Class and Apple's status only: messages can hold a UDID.
    if isinstance(exc, AscRateLimited):
        log.info("job %s (%s): Apple's rate limit, re-queued", job_id, kind)
    elif isinstance(exc, JobFailed):
        log.warning("job %s (%s) failed for good", job_id, kind)
    elif isinstance(exc, AscError):
        log.warning("job %s (%s): App Store Connect answered %s %s",
                    job_id, kind, exc.status, exc.code)
    else:
        log.warning("job %s (%s) failed: %s", job_id, kind, type(exc).__name__, exc_info=exc)


async def _record_failure(maker: async_sessionmaker, job_id, attempt: int,
                          exc: Exception) -> str:
    async with maker() as fin:
        row, owned = await own_attempt(fin, job_id, attempt)
        if row is None:
            status = "gone"
        elif not owned:                    # the stale sweep (or another worker) has it now
            status = "superseded"
        elif isinstance(exc, JobFailed):
            fail(row, str(exc))
            status = "failed"
        elif isinstance(exc, AscRateLimited):
            requeue_without_attempt(row, RATE_LIMITED)
            status = "rate_limited"
        else:
            await retry_or_fail(fin, row, f"{type(exc).__name__}: {exc}")
            status = row.status
        await fin.commit()
    return status


async def run_once(sessionmaker: async_sessionmaker | None = None) -> bool:
    """Claim and run at most one job. False when nothing is due."""
    maker = sessionmaker or get_sessionmaker()
    async with maker() as db:
        job = await claim_next(db)
        if job is None:
            return False
        job_id, kind, attempt = job.id, job.kind, job.attempts
        log.info("claimed job %s (%s, attempt %s)", job_id, kind, attempt)
        try:
            result = await process_job(db, job)
        except Exception as exc:  # noqa: BLE001 (every failure is recorded on the job)
            _log_failure(job_id, kind, exc)
            try:
                await db.rollback()
            except Exception:
                log.warning("could not roll back job %s's session", job_id, exc_info=True)
            status = await _record_failure(maker, job_id, attempt, exc)
        else:
            # The handler's last writes and `done` commit together.
            row, owned = await own_attempt(db, job_id, attempt)
            if owned:
                done(row, result)
                status = "done"
            else:
                status = "gone" if row is None else "superseded"
            await db.commit()
        log.info("job %s finished status=%s", job_id, status)
        return True


async def _requeue_stale(maker: async_sessionmaker, state: dict) -> None:
    """Never stops the loop: a failure is logged once per outage."""
    try:
        async with maker() as db:
            requeued = await requeue_stale(db)
        if requeued:
            log.info("re-queued %d stale job(s)", requeued)
        state["failed"] = False
    except Exception:
        if not state["failed"]:
            log.warning("could not re-queue stale jobs; retrying", exc_info=True)
        state["failed"] = True


async def run_forever(poll_seconds: float = 2.0) -> None:
    maker = get_sessionmaker()
    stale_state = {"failed": False}
    claim_failed = False
    await _requeue_stale(maker, stale_state)          # start-up sweep
    stale_at = time.monotonic()
    log.info("devices worker online, polling every %ss", poll_seconds)
    while True:
        if time.monotonic() - stale_at >= STALE_SWEEP_SECONDS:
            stale_at = time.monotonic()
            await _requeue_stale(maker, stale_state)
        try:
            worked = await run_once(maker)
            claim_failed = False
        except Exception:
            if not claim_failed:
                log.warning("could not poll the job queue; retrying", exc_info=True)
            claim_failed = True
            worked = False
        if not worked:
            await asyncio.sleep(poll_seconds)


def reload_child(poll_seconds: float) -> None:
    """`devices worker --reload`'s child process (watchfiles restarts it
    after every code change, stopping the old one with SIGINT)."""
    configure_logging()
    try:
        asyncio.run(run_forever(poll_seconds))
    except KeyboardInterrupt:
        pass
