"""The db-testing-worker loop (`serversherpa db-testing-worker`) — a
separate process from the API. Claims db_testing_sessions that need
snapshotting or reverting and runs them to a terminal status via
devtools.testing.runner. Mirrors reports/worker.py's claim/heartbeat/
stale-sweep shape, with one deliberate difference: this worker does NOT
honor the read-only maintenance mode's worker-pause sub-toggle — it is
the process that turns that toggle on during a revert, so pausing itself
on it would deadlock the very revert it just started."""

import asyncio
import logging
import time

from serversherpa.db.models import DbTestingSession
from serversherpa.devtools.testing.jobs import claim_next, requeue_stale
from serversherpa.devtools.testing.runner import process_session

logger = logging.getLogger("serversherpa.devtools.testing.worker")

STALE_SWEEP_SECONDS = 60


async def run_once(sessionmaker) -> bool:
    """Claim and process at most one session. False when there is nothing
    to do (no session in 'snapshotting' or 'reverting')."""
    from serversherpa.system.db_logging import install
    install("db-testing-worker")

    async with sessionmaker() as db:
        session = await claim_next(db)
        if session is None:
            return False
        session_id = session.id
        logger.info("claimed db-testing session %s (%s)", session_id, session.status)
        try:
            status = await process_session(db, session, sessionmaker=sessionmaker)
        except Exception as exc:            # last resort: process_session owns its
            logger.exception("db-testing session %s crashed in worker: %s",
                             session_id, exc)
            try:
                await db.rollback()
            except Exception:
                logger.warning("could not roll back the db-testing session %s",
                               session_id, exc_info=True)
            async with sessionmaker() as fin:
                row = await fin.get(DbTestingSession, session_id)
                if row is not None:
                    row.status = "failed"
                    row.error = f"worker_error: {exc}"[:2000]
                    await fin.commit()
            status = "failed"
        logger.info("db-testing session %s finished status=%s", session_id, status)
        return True


async def _sweep_stale(maker, state: dict) -> None:
    """Re-claim sessions a dead worker left mid-snapshot/revert. A DB blip
    must never kill the loop: log once per outage, same rule as the claim
    and pause checks elsewhere."""
    try:
        async with maker() as db:
            requeued = await requeue_stale(db)
        if requeued:
            logger.info("re-claimed %d stale db-testing session(s)", requeued)
        state["failed"] = False
    except Exception:
        if not state["failed"]:
            logger.warning("could not sweep stale db-testing sessions — retrying",
                           exc_info=True)
        state["failed"] = True


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("db-testing-worker")
    claim_state = {"failed": False}
    sweep_state = {"failed": False}
    # No pause meta — this worker never idles for read-only mode (see the
    # module docstring), so unlike report-worker/label-worker it carries
    # no `meta_fn`.
    heartbeat = start_heartbeat("db-testing-worker", "worker")
    maker = get_sessionmaker()
    try:
        await _sweep_stale(maker, sweep_state)          # startup sweep
        swept_at = time.monotonic()
        logger.info("db-testing worker online — watching for sessions")
        while True:
            if time.monotonic() - swept_at >= STALE_SWEEP_SECONDS:
                swept_at = time.monotonic()
                await _sweep_stale(maker, sweep_state)
            try:
                worked = await run_once(maker)
                claim_state["failed"] = False
            except Exception:
                if not claim_state["failed"]:
                    logger.warning("could not poll db-testing sessions — retrying",
                                   exc_info=True)
                claim_state["failed"] = True
                worked = False
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
