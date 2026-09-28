"""spec_lookup_jobs queue helpers — the label queue's shape (see
labels/generate/jobs.py) plus priority and a retry clock. One worker process."""

import os
import socket
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import SpecLookupJob

STALE_MINUTES = 15


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def claim_next(db: AsyncSession) -> SpecLookupJob | None:
    now = datetime.now(UTC)
    job = await db.scalar(
        select(SpecLookupJob)
        .where(SpecLookupJob.status == "queued",
               or_(SpecLookupJob.next_attempt_at.is_(None),
                   SpecLookupJob.next_attempt_at <= now))
        .order_by(SpecLookupJob.priority.desc(), SpecLookupJob.created_at)
        .limit(1).with_for_update(skip_locked=True))
    if job is None:
        return None
    job.status = "running"
    job.started_at = now
    job.heartbeat_at = now
    job.worker_id = _worker_id()
    await db.commit()
    return job


async def requeue_stale(db: AsyncSession) -> int:
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    liveness = func.coalesce(SpecLookupJob.heartbeat_at, SpecLookupJob.started_at)
    rows = (await db.scalars(
        select(SpecLookupJob).where(SpecLookupJob.status == "running", liveness < cutoff)
        .with_for_update(skip_locked=True))).all()
    for job in rows:
        job.status = "queued"
        job.started_at = None
        job.heartbeat_at = None
        job.worker_id = None
    await db.commit()
    return len(rows)
