"""The jobs table as a queue, after the main API's wiki worker: any number
of workers claim rows with FOR UPDATE SKIP LOCKED, no broker.

- `attempts` counts claims. A failed try goes back to the queue and waits
  RETRY_BASE_SECONDS * 2^(attempts-1) from its last try (`progress_at`),
  until MAX_ATTEMPTS, then it is `failed`.
- Apple's rate limit (AscRateLimited) re-queues a job without counting the
  try; it still waits RETRY_BASE_SECONDS before Apple is asked again.
- JobFailed fails a job at once: trying again can't help.
- A job a dead worker left `running` for STALE_MINUTES counts as a failed
  try (`requeue_stale`).
- `rebuild_profiles` is coalesced: queuing one while another is still
  queued (not yet running) returns that one, since it will see every
  device registered by then."""

import datetime as dt
import uuid

from sqlalchemy import func, insert, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices.db.models import JOB_KINDS, Job

MAX_ATTEMPTS = 3
RETRY_BASE_SECONDS = 30
STALE_MINUTES = 30
ERROR_MAX = 2000
RATE_LIMITED = "Apple's rate limit was reached; trying again shortly."
STALE = "worker_stopped: the job was abandoned mid-run"
COALESCED_KINDS = ("rebuild_profiles",)
# Transaction-scoped advisory lock: two callers never both queue a rebuild.
_COALESCE_LOCK_KEY = 0x5D_E71C_0001


class JobFailed(Exception):
    """Fail the job now, without another try. The message is its error."""


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


async def enqueue(db: AsyncSession, kind: str, payload: dict | None) -> Job:
    """Queue a job in the caller's transaction (the caller commits).
    `created_at` is the clock time, so jobs queued in one transaction still
    run in the order they were queued."""
    if kind not in JOB_KINDS:
        raise ValueError(f"unknown job kind {kind!r}")
    if kind in COALESCED_KINDS:
        await db.execute(select(func.pg_advisory_xact_lock(_COALESCE_LOCK_KEY)))
        # FOR UPDATE: a worker claiming this row right now makes us wait, and
        # once it is `running` it no longer matches, so a fresh one is queued.
        waiting = await db.scalar(
            select(Job).where(Job.kind == kind, Job.status == "queued")
            .order_by(Job.created_at).limit(1).with_for_update())
        if waiting is not None:
            return waiting
    return await db.scalar(
        insert(Job).values(kind=kind, payload=payload or {}, created_at=func.clock_timestamp())
        .returning(Job))


def _backoff_elapsed():
    """WHERE clause: a job tried (or rate limited) before has waited out its
    backoff since then. A fresh job has no progress_at."""
    tries = func.greatest(Job.attempts, 1)
    wait = func.make_interval(0, 0, 0, 0, 0, 0, RETRY_BASE_SECONDS * func.power(2, tries - 1))
    return or_(Job.progress_at.is_(None), Job.progress_at + wait <= func.now())


async def claim_next(db: AsyncSession) -> Job | None:
    """Claim the oldest due queued job (SKIP LOCKED), mark it running and
    count the attempt. Commits the claim."""
    job = await db.scalar(
        select(Job).where(Job.status == "queued", _backoff_elapsed())
        .order_by(Job.created_at, Job.id).limit(1).with_for_update(skip_locked=True))
    if job is None:
        return None
    now = _now()
    job.status = "running"
    job.attempts += 1
    job.started_at = now
    job.progress_at = now
    await db.commit()
    return job


async def own_attempt(db: AsyncSession, job_id: uuid.UUID,
                      attempt: int) -> tuple[Job | None, bool]:
    """(the job row locked FOR UPDATE, whether this attempt still owns it).
    Once the stale sweep re-queued it, or another worker claimed it again,
    this attempt records nothing on the row."""
    row = await db.scalar(select(Job).where(Job.id == job_id).with_for_update()
                          .execution_options(populate_existing=True))
    return row, row is not None and row.status == "running" and row.attempts == attempt


def done(job: Job, result: dict | None = None) -> None:
    job.status = "done"
    job.error = None
    job.result = result
    job.finished_at = _now()


def fail(job: Job, error: str) -> None:
    job.status = "failed"
    job.error = error[:ERROR_MAX]
    job.progress_at = job.finished_at = _now()


def requeue_without_attempt(job: Job, error: str) -> None:
    job.status = "queued"
    job.attempts = max(job.attempts - 1, 0)
    job.error = error[:ERROR_MAX]
    job.started_at = None
    job.progress_at = _now()


async def retry_or_fail(db: AsyncSession, job: Job, error: str) -> None:
    """A try failed: back to the queue (its backoff runs from now), or, out
    of attempts, failed for good (and the job's subject told, see
    jobs.gave_up)."""
    if job.attempts >= MAX_ATTEMPTS:
        fail(job, error)
        # Imported here: jobs queues through this module.
        from serversherpa_devices.worker import jobs

        await jobs.gave_up(db, job)
    else:
        job.status = "queued"
        job.error = error[:ERROR_MAX]
        job.started_at = None
        job.progress_at = _now()


async def requeue_stale(db: AsyncSession) -> int:
    """Jobs a crashed worker left `running` for STALE_MINUTES count as a
    failed try. Commits; returns how many it touched."""
    cutoff = _now() - dt.timedelta(minutes=STALE_MINUTES)
    stale = (await db.scalars(
        select(Job).where(Job.status == "running", Job.progress_at < cutoff)
        .with_for_update(skip_locked=True))).all()
    for job in stale:
        await retry_or_fail(db, job, STALE)
    await db.commit()
    return len(stale)
