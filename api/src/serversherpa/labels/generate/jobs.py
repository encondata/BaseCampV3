"""label_generation_runs queue helpers — same shape as reports/jobs.py:
the table is the queue, `label-worker` claims with FOR UPDATE SKIP
LOCKED.

Unlike report runs (which carry a hard RUN_TIMEOUT_SECONDS on the single
build() call), a label run has no timeout — a large roster times several
label types can legitimately run past a naive "started more than 15
minutes ago" cutoff. So staleness is judged on `heartbeat_at`, which the
runner bumps at every batch flush (jobs.claim_next also stamps it at
claim time, before the first batch), not on `started_at`: a run that is
still actively making progress is never mistaken for a dead worker's
abandoned row. This does assume a single label-worker process — with
two or more, a run whose worker really did die more than STALE_MINUTES
into a batch (rather than between batches) could be re-queued and
double-processed by another worker. That's still safe (generated_labels
upserts are idempotent, and both workers converge on the same content)
but wasteful and confusing for the counters, so keep to one label-worker
process until this queue gets real per-worker leasing."""

import os
import socket
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LabelGenerationRun

STALE_MINUTES = 15


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def claim_next(db: AsyncSession) -> LabelGenerationRun | None:
    run = await db.scalar(
        select(LabelGenerationRun).where(LabelGenerationRun.status == "queued")
        .order_by(LabelGenerationRun.created_at).limit(1).with_for_update(skip_locked=True))
    if run is None:
        return None
    now = datetime.now(UTC)
    run.status = "running"
    run.started_at = now
    run.heartbeat_at = now
    run.worker_id = _worker_id()
    await db.commit()
    return run


async def requeue_stale(db: AsyncSession) -> int:
    """A worker crashed mid-run: runs still 'running' whose heartbeat (or,
    absent one, started_at — a run claimed by an older worker build that
    never wrote a heartbeat) is older than STALE_MINUTES go back to the
    queue. Re-running is safe — regeneration upserts, and already-written
    `generated_labels` rows just get overwritten again."""
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    liveness = func.coalesce(LabelGenerationRun.heartbeat_at, LabelGenerationRun.started_at)
    runs = (await db.scalars(
        select(LabelGenerationRun).where(
            LabelGenerationRun.status == "running", liveness < cutoff)
        .with_for_update(skip_locked=True))).all()
    for run in runs:
        run.status = "queued"
        run.started_at = None
        run.heartbeat_at = None
        run.worker_id = None
    await db.commit()
    return len(runs)
