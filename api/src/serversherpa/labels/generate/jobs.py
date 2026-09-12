"""label_generation_runs queue helpers — same shape as reports/jobs.py:
the table is the queue, `label-worker` claims with FOR UPDATE SKIP
LOCKED."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LabelGenerationRun

STALE_MINUTES = 15


async def claim_next(db: AsyncSession) -> LabelGenerationRun | None:
    run = await db.scalar(
        select(LabelGenerationRun).where(LabelGenerationRun.status == "queued")
        .order_by(LabelGenerationRun.created_at).limit(1).with_for_update(skip_locked=True))
    if run is None:
        return None
    run.status = "running"
    run.started_at = datetime.now(UTC)
    await db.commit()
    return run


async def requeue_stale(db: AsyncSession) -> int:
    """A worker crashed mid-run: runs still 'running' past STALE_MINUTES
    go back to the queue. Re-running is safe — regeneration upserts, and
    already-written `generated_labels` rows just get overwritten again."""
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    runs = (await db.scalars(
        select(LabelGenerationRun).where(
            LabelGenerationRun.status == "running", LabelGenerationRun.started_at < cutoff)
        .with_for_update(skip_locked=True))).all()
    for run in runs:
        run.status = "queued"
        run.started_at = None
    await db.commit()
    return len(runs)
