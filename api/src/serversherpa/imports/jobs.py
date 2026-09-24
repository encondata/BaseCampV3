"""Import job queue helpers. The queue is the import_jobs table itself:
the API inserts queued rows; worker processes claim them with
FOR UPDATE SKIP LOCKED so any number of workers can run without a broker."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import String, cast, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from serversherpa.db.models import ImportJob

STALE_MINUTES = 10
STALE_DRAFT_HOURS = 24


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


async def sweep_stale(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """Housekeeping for rows nobody will come back to:
    - Create-a-move-in-steps drafts still in preview/failed and untouched
      (progress_at, else created_at) for 24 hours — deleted;
    - move-setup file checks no live draft points at any more (replaced,
      skipped, or their draft is gone), unless the worker is still on one —
      deleted;
    - bulk asset update previews abandoned for 24 hours — cancelled, their
      parsed file dropped (error "expired")."""
    cutoff = (now or datetime.now(UTC)) - timedelta(hours=STALE_DRAFT_HOURS)
    touched = func.coalesce(ImportJob.progress_at, ImportJob.created_at)
    drafts = (await db.execute(
        delete(ImportJob).where(ImportJob.kind == "move_setup",
                                ImportJob.status.in_(("preview", "failed")),
                                touched < cutoff)
        .returning(ImportJob.id))).scalars().all()
    live = aliased(ImportJob)
    referenced = select(live.id).where(
        live.kind == "move_setup",
        live.payload["assets"]["check_job_id"].astext == cast(ImportJob.id, String))
    checks = (await db.execute(
        delete(ImportJob).where(ImportJob.kind == "move_assets",
                                ImportJob.initiative_id.is_(None),
                                ImportJob.options["move_setup_id"].astext.is_not(None),
                                ImportJob.status != "running",
                                ~referenced.exists())
        .returning(ImportJob.id))).scalars().all()
    previews = (await db.execute(
        update(ImportJob).where(ImportJob.kind == "asset_bulk_update",
                                ImportJob.status == "preview", touched < cutoff)
        .values(status="cancelled", error="expired", payload=None, finished_at=func.now())
        .returning(ImportJob.id))).scalars().all()
    await db.commit()
    return {"drafts": len(drafts), "checks": len(checks), "previews": len(previews)}
