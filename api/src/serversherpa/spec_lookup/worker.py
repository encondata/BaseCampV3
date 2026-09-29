"""The spec-lookup-worker loop (`serversherpa spec-lookup-worker`): claims
spec_lookup_jobs one at a time, asks the provider, verifies and records
suggestions; sweeps eligible models into the queue when Background search
is on. Survives DB blips like the label worker."""

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import AssetModel, AssetModelAlias, SpecLookupJob
from serversherpa.spec_lookup import service
from serversherpa.spec_lookup.fields import wanted_fields
from serversherpa.spec_lookup.jobs import MAX_ATTEMPTS, claim_next, requeue_stale
from serversherpa.spec_lookup.provider import (
    ProviderFailed, ProviderNotConfigured, ProviderRetryable, get_provider, is_configured,
)
from serversherpa.system.config_store import read_section

logger = logging.getLogger("serversherpa.spec_lookup.worker")

PROCESS_NAME = "spec-lookup-worker"
BACKOFF = (60, 300, 1800)
STALE_SWEEP_SECONDS = 60
SWEEP_SECONDS = 60
ERROR_MAX = 2000


def _finish(job: SpecLookupJob, status: str, error: str | None = None) -> str:
    job.status = status
    job.error = error[:ERROR_MAX] if error else None
    job.finished_at = datetime.now(UTC)
    return status


async def process_job(db, job: SpecLookupJob, provider) -> str:
    m = await db.get(AssetModel, job.model_id)
    if m is None:
        return _finish(job, "done", "model_gone")
    if m.private:                                   # re-checked right before any call
        return _finish(job, "done", "private")
    if m.spec_lookup_skip:
        return _finish(job, "done", "skipped")
    cfg = await read_section(db, service.AI_LOOKUP)
    fields = wanted_fields(m, cfg)
    if not fields:
        m.specs_looked_up_at = datetime.now(UTC)
        return _finish(job, "done", "nothing_to_look_up")
    if provider is None:
        return _finish(job, "failed", "not_configured")
    aliases = list(await db.scalars(
        select(AssetModelAlias.alias).where(AssetModelAlias.model_id == m.id)))
    job.attempts += 1
    await db.commit()          # a worker killed mid-call must not loop forever at attempts=0
    try:
        result = await provider.lookup(make=m.make, model=m.model, aliases=aliases,
                                       category=m.category, fields=fields,
                                       effort=cfg.get("effort", "medium"))
    except ProviderNotConfigured:
        return _finish(job, "failed", "not_configured")
    except ProviderRetryable as exc:
        if job.attempts >= MAX_ATTEMPTS:
            return _finish(job, "failed", f"retries_exhausted: {exc}")
        job.status = "queued"
        job.started_at = job.heartbeat_at = job.worker_id = None
        job.next_attempt_at = datetime.now(UTC) + timedelta(
            seconds=BACKOFF[min(job.attempts - 1, len(BACKOFF) - 1)])
        job.error = str(exc)[:ERROR_MAX]
        return "queued"
    except ProviderFailed as exc:
        # max_tokens is our budget, not the model's answer: leave the model
        # unstamped (FAILED_COOLDOWN still keeps the sweep off it for a day)
        if str(exc) != "max_tokens":
            m.specs_looked_up_at = datetime.now(UTC)
        return _finish(job, "failed", str(exc))
    # The call can take minutes; a user may have filled a field or made the
    # model private meanwhile. Re-read before deciding what is blank.
    m = await db.get(AssetModel, job.model_id, populate_existing=True)
    if m is None:
        return _finish(job, "done", "model_gone")
    if m.private or m.spec_lookup_skip:
        job.input_tokens += result.input_tokens
        job.output_tokens += result.output_tokens
        job.search_count += result.search_count
        return _finish(job, "done", "private" if m.private else "skipped")
    await service.record_result(db, job, m, result, cfg)
    return _finish(job, "done")


async def sweep(db, provider_configured: bool) -> int:
    cfg = await read_section(db, service.AI_LOOKUP)
    if not cfg.get("background_enabled") or not provider_configured:
        return 0
    if await service.key_rejected(db):
        # the API refused the key: stop spending sweeps until a manual lookup succeeds
        return 0
    ids = await service.eligible_model_ids(db, cfg)
    n = await service.enqueue(db, ids, service.PRIORITY_SWEEP, None)
    await db.commit()
    return n


async def run_once(sessionmaker, provider_factory=get_provider) -> bool:
    from serversherpa.system.db_logging import install
    install(PROCESS_NAME)

    async with sessionmaker() as db:
        job = await claim_next(db)
        if job is None:
            return False
        job_id = job.id
        provider = None
        try:
            provider = provider_factory()
            status = await process_job(db, job, provider)
            await db.commit()
        except Exception as exc:
            logger.exception("job %s crashed: %s", job_id, exc)
            try:
                await db.rollback()
            except Exception:
                logger.warning("could not roll back the spec lookup session for job %s",
                               job_id, exc_info=True)
            async with sessionmaker() as fin:
                row = await fin.get(SpecLookupJob, job_id)
                if row is not None:
                    _finish(row, "failed", f"worker_error: {exc}")
                    await fin.commit()
            status = "failed"
        finally:
            if provider is not None:
                await provider.aclose()
        logger.info("job %s finished status=%s", job_id, status)
        return True


async def _guarded(label: str, coro_fn, state: dict) -> None:
    try:
        await coro_fn()
        state[label] = False
    except Exception:
        if not state.get(label):
            logger.warning("%s failed — retrying", label, exc_info=True)
        state[label] = True


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install(PROCESS_NAME)
    pause_state = {"paused": False}
    check_state: dict = {}
    fail_state: dict = {}
    heartbeat = start_heartbeat(PROCESS_NAME, "worker", meta_fn=lambda: dict(pause_state))
    maker = get_sessionmaker()

    async def stale():
        async with maker() as db:
            if await requeue_stale(db):
                logger.info("re-queued stale spec lookups")

    async def do_sweep():
        async with maker() as db:
            n = await sweep(db, is_configured())
            if n:
                logger.info("sweep queued %d model(s)", n)

    try:
        await _guarded("stale sweep", stale, fail_state)
        stale_at = sweep_at = 0.0
        logger.info("spec lookup worker online — watching the queue")
        while True:
            if await poll_workers_paused(maker, check_state):
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            pause_state["paused"] = False
            now = time.monotonic()
            if now - stale_at >= STALE_SWEEP_SECONDS:
                stale_at = now
                await _guarded("stale sweep", stale, fail_state)
            if now - sweep_at >= SWEEP_SECONDS:
                sweep_at = now
                await _guarded("eligibility sweep", do_sweep, fail_state)
            worked = False
            try:
                worked = await run_once(maker)
                fail_state["claim"] = False
            except Exception:
                if not fail_state.get("claim"):
                    logger.warning("could not poll the spec lookup queue — retrying",
                                   exc_info=True)
                fail_state["claim"] = True
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
