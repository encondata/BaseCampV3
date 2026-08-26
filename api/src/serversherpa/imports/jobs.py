"""Import job queue helpers. The queue is the import_jobs table itself:
the API inserts queued rows; worker processes claim them with
FOR UPDATE SKIP LOCKED so any number of workers can run without a broker."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ImportJob

STALE_MINUTES = 10


async def claim_next(db: AsyncSession) -> ImportJob | None:
    """Claim the oldest queued job (SKIP LOCKED) and mark it running.
    Commits the claim so the row is visible as running immediately."""
    job = await db.scalar(
        select(ImportJob)
        .where(ImportJob.status == "queued")
        .order_by(ImportJob.created_at)
        .limit(1)
        .with_for_update(skip_locked=True))
    if job is None:
        return None
    now = datetime.now(UTC)
    job.status = "running"
    job.started_at = now
    job.progress_at = now
    await db.commit()
    return job


async def requeue_stale(db: AsyncSession) -> int:
    """Re-queue running jobs whose progress_at is older than STALE_MINUTES
    (a worker crashed mid-job). Batched writes make re-running safe: work
    already committed stays, and the pipeline's update path is idempotent."""
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    jobs = (await db.scalars(
        select(ImportJob)
        .where(ImportJob.status == "running",
               ImportJob.progress_at < cutoff)
        .with_for_update(skip_locked=True))).all()
    for job in jobs:
        job.status = "queued"
        job.started_at = None
    await db.commit()
    return len(jobs)
