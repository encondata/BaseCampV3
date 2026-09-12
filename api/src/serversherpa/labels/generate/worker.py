"""The label-worker loop (`serversherpa label-worker`) — a separate
process from the API, mirroring reports/worker.py: claims queued
label_generation_runs, renders every requested label type through
`runner.process_run`, and survives DB blips the same way (a claim
failure or stale-sweep failure is logged once and retried, never kills
the loop; the heartbeat keeps beating regardless)."""

import asyncio
import logging
import time
from datetime import UTC, datetime

from serversherpa.db.models import LabelGenerationRun
from serversherpa.labels.generate.jobs import claim_next, requeue_stale
from serversherpa.labels.generate.runner import process_run

logger = logging.getLogger("serversherpa.labels.generate.worker")

STALE_SWEEP_SECONDS = 60
ERROR_MAX = 2000


async def run_once(sessionmaker) -> bool:
    """Claim and process at most one run. False when the queue is empty."""
    from serversherpa.system.db_logging import install
    install("label-worker")

    async with sessionmaker() as db:
        run = await claim_next(db)
        if run is None:
            return False
        run_id = run.id
        logger.info("claimed run %s (initiative %s)", run_id, run.initiative_id)
        try:
            status = await process_run(db, run, sessionmaker=sessionmaker)
        except Exception as exc:                # last resort: process_run owns its
            logger.exception("run %s crashed in worker: %s", run_id, exc)
            try:
                await db.rollback()
            except Exception:
                logger.warning("could not roll back the build session for run %s",
                               run_id, exc_info=True)
            async with sessionmaker() as fin:
                row = await fin.get(LabelGenerationRun, run_id)
                if row is not None:
                    row.status = "failed"
                    row.error = f"worker_error: {exc}"[:ERROR_MAX]
                    row.finished_at = datetime.now(UTC)
                    await fin.commit()
            status = "failed"
        logger.info("run %s finished status=%s", run_id, status)
        return True


async def _sweep_stale(maker, state: dict) -> None:
    """Re-queue runs a dead worker left 'running'. A DB blip must never
    kill the loop: log once per outage, same rule as the claim check."""
    try:
        async with maker() as db:
            requeued = await requeue_stale(db)
        if requeued:
            logger.info("re-queued %d stale run(s)", requeued)
        state["failed"] = False
    except Exception:
        if not state["failed"]:
            logger.warning("could not re-queue stale label runs — retrying", exc_info=True)
        state["failed"] = True


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("label-worker")
    pause_state = {"paused": False}
    check_state: dict = {}
    claim_state = {"failed": False}
    sweep_state = {"failed": False}
    heartbeat = start_heartbeat("label-worker", "worker", meta_fn=lambda: dict(pause_state))
    maker = get_sessionmaker()
    try:
        await _sweep_stale(maker, sweep_state)          # startup sweep
        swept_at = time.monotonic()
        logger.info("label worker online — watching the queue")
        while True:
            if await poll_workers_paused(maker, check_state):
                if not pause_state["paused"]:
                    logger.info("paused by read-only maintenance mode")
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            if pause_state["paused"]:
                logger.info("resumed")
            pause_state["paused"] = False
            if time.monotonic() - swept_at >= STALE_SWEEP_SECONDS:
                swept_at = time.monotonic()
                await _sweep_stale(maker, sweep_state)
            try:
                worked = await run_once(maker)
                claim_state["failed"] = False
            except Exception:
                if not claim_state["failed"]:
                    logger.warning("could not poll the label queue — retrying", exc_info=True)
                claim_state["failed"] = True
                worked = False
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
