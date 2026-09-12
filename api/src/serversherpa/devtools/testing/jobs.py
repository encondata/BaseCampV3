"""db_testing_sessions queue helpers — same shape as labels/generate/jobs.py:
the table is the queue, `db-testing-worker` claims a session that needs
processing (status 'snapshotting' or 'reverting') with FOR UPDATE SKIP
LOCKED and stamps worker_id/heartbeat_at. Staleness is judged on
heartbeat_at, not started_at — a snapshot or restore can legitimately run
for a while — so claim_next also skips a row whose heartbeat is still
fresh (another live worker already owns it) and only takes one that is
either unclaimed or stale."""

import os
import socket
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import DbTestingSession

STALE_MINUTES = 15

# The only statuses a worker ever has anything to do for — 'active' just
# sits there until the API flips it to 'reverting' or ends it, and
# 'ended'/'failed' are terminal.
WORKING_STATUSES = ("snapshotting", "reverting")


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def claim_next(db: AsyncSession) -> DbTestingSession | None:
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    session = await db.scalar(
        select(DbTestingSession)
        .where(DbTestingSession.status.in_(WORKING_STATUSES),
               or_(DbTestingSession.worker_id.is_(None),
                   DbTestingSession.heartbeat_at < cutoff))
        .order_by(DbTestingSession.started_at)
        .limit(1)
        .with_for_update(skip_locked=True))
    if session is None:
        return None
    session.heartbeat_at = datetime.now(UTC)
    session.worker_id = _worker_id()
    await db.commit()
    return session


async def requeue_stale(db: AsyncSession) -> int:
    """A worker crashed mid-snapshot/revert: clear worker_id/heartbeat_at
    so another live worker can pick the session back up. Status stays
    'snapshotting'/'reverting' — there is no 'queued' state to return a
    testing session to."""
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    sessions = (await db.scalars(
        select(DbTestingSession).where(
            DbTestingSession.status.in_(WORKING_STATUSES),
            DbTestingSession.worker_id.is_not(None),
            DbTestingSession.heartbeat_at < cutoff)
        .with_for_update(skip_locked=True))).all()
    for session in sessions:
        session.worker_id = None
        session.heartbeat_at = None
    await db.commit()
    return len(sessions)
