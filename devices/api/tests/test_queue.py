"""The worker's job queue: claiming (SKIP LOCKED, backoff), retries, the
rate-limit re-queue, the stale sweep, coalesced profile rebuilds and the
`devices worker` command."""

import asyncio
import datetime as dt

import pytest
from sqlalchemy import select, update
from typer.testing import CliRunner

from serversherpa_devices import catalog
from serversherpa_devices.db.engine import get_sessionmaker
from serversherpa_devices.db.models import IosDevice, Job
from serversherpa_devices.worker import queue
from serversherpa_devices.worker.run import run_once

from .worker_support import UDID_A, install_fake, jobs_of, seed_apple, seed_device


@pytest.fixture
def fake(monkeypatch):
    return install_fake(monkeypatch)


async def _set(job_id, **values) -> None:
    async with get_sessionmaker()() as session:
        await session.execute(update(Job).where(Job.id == job_id).values(**values))
        await session.commit()


def _ago(seconds: int) -> dt.datetime:
    return dt.datetime.now(dt.UTC) - dt.timedelta(seconds=seconds)


async def test_claim_skips_locked_and_backs_off(db):
    first = await queue.enqueue(db, "sync_devices", {})
    second = await queue.enqueue(db, "ensure_bundle", {"app_id": "x"})
    await db.commit()
    assert first.created_at < second.created_at   # one transaction, still in order

    maker = get_sessionmaker()
    async with maker() as holder, maker() as claimer:
        # Another worker holds the oldest row: the claim skips it, never waits.
        await holder.scalar(select(Job).where(Job.id == first.id).with_for_update())
        claimed = await asyncio.wait_for(queue.claim_next(claimer), timeout=5)
        assert claimed.id == second.id
        assert (claimed.status, claimed.attempts) == ("running", 1)
        assert claimed.started_at is not None and claimed.progress_at is not None
        await holder.rollback()

    # A job tried once waits 30 s from its last try; twice, 60 s.
    await _set(first.id, attempts=1, progress_at=_ago(20))
    async with maker() as session:
        assert await queue.claim_next(session) is None
    await _set(first.id, attempts=2, progress_at=_ago(45))
    async with maker() as session:
        assert await queue.claim_next(session) is None
    await _set(first.id, progress_at=_ago(61))
    async with maker() as session:
        claimed = await queue.claim_next(session)
        assert claimed.id == first.id
        assert claimed.attempts == 3


async def test_failed_job_retries_then_fails_for_good(db, monkeypatch):
    from serversherpa_devices.worker import jobs

    async def broken(session, job):
        raise RuntimeError("storage is down")

    monkeypatch.setitem(jobs.HANDLERS, "sync_devices", broken)
    job = await queue.enqueue(db, "sync_devices", {})
    await db.commit()

    for attempt in range(1, queue.MAX_ATTEMPTS + 1):
        assert await run_once(get_sessionmaker())
        (row,) = await jobs_of()
        assert row.attempts == attempt
        assert row.error == "RuntimeError: storage is down"
        if attempt < queue.MAX_ATTEMPTS:
            assert (row.status, row.started_at, row.finished_at) == ("queued", None, None)
            await _set(job.id, progress_at=_ago(3600))   # skip the backoff
    assert row.status == "failed"
    assert row.finished_at is not None
    assert not await run_once(get_sessionmaker())


async def test_rate_limited_requeues_without_attempt(db, fake):
    await seed_apple(db, cert_id=fake.cert_id)
    device = await seed_device(db, UDID_A)
    await queue.enqueue(db, "register_device", {"device_id": str(device.id)})
    await db.commit()
    fake.rate_limit(1)

    assert await run_once(get_sessionmaker())
    (job,) = await jobs_of()
    assert (job.status, job.attempts) == ("queued", 0)
    assert job.started_at is None
    assert job.error is not None and "rate limit" in job.error
    async with get_sessionmaker()() as session:
        assert (await session.get(IosDevice, device.id)).status == "pending"
        # It still waits before Apple is asked again.
        assert await queue.claim_next(session) is None

    await _set(job.id, progress_at=_ago(31))
    assert await run_once(get_sessionmaker())
    (job, rebuild) = await jobs_of()
    assert (job.status, job.attempts, job.error) == ("done", 1, None)
    assert rebuild.kind == "rebuild_profiles"
    async with get_sessionmaker()() as session:
        assert (await session.get(IosDevice, device.id)).status == "registered"


async def test_stale_running_job_is_requeued(db):
    job = await queue.enqueue(db, "sync_devices", {})
    await db.commit()
    async with get_sessionmaker()() as session:
        await queue.claim_next(session)
    await _set(job.id, progress_at=_ago(queue.STALE_MINUTES * 60 - 30))
    async with get_sessionmaker()() as session:
        assert await queue.requeue_stale(session) == 0
    await _set(job.id, progress_at=_ago(queue.STALE_MINUTES * 60 + 30))
    async with get_sessionmaker()() as session:
        assert await queue.requeue_stale(session) == 1
    (row,) = await jobs_of()
    assert (row.status, row.attempts) == ("queued", 1)
    assert row.error.startswith("worker_stopped")


async def test_rebuild_is_coalesced(db):
    first = await queue.enqueue(db, "rebuild_profiles", {})
    again = await queue.enqueue(db, "rebuild_profiles", {})
    await db.commit()
    assert again.id == first.id
    assert len(await jobs_of("rebuild_profiles")) == 1

    # Two callers at once: the second waits for the first to commit, then
    # finds its row.
    maker = get_sessionmaker()
    async with maker() as a, maker() as b:
        await a.execute(update(Job).values(status="done"))
        mine = await queue.enqueue(a, "rebuild_profiles", {})
        theirs = asyncio.create_task(queue.enqueue(b, "rebuild_profiles", {}))
        await asyncio.sleep(0.3)
        assert not theirs.done()
        await a.commit()
        assert (await asyncio.wait_for(theirs, timeout=5)).id == mine.id
        await b.commit()
    assert [j.status for j in await jobs_of("rebuild_profiles")] == ["done", "queued"]

    # A running rebuild may already have read the devices: a new one queues.
    async with maker() as session:
        claimed = await queue.claim_next(session)
        assert claimed.id == mine.id
    newer = await queue.enqueue(db, "rebuild_profiles", {})
    await db.commit()
    assert newer.id != mine.id
    assert [j.status for j in await jobs_of("rebuild_profiles")] == ["done", "running", "queued"]

    # Other kinds never coalesce.
    await queue.enqueue(db, "sync_devices", {})
    await queue.enqueue(db, "sync_devices", {})
    await db.commit()
    assert len(await jobs_of("sync_devices")) == 2


async def test_catalog_queue_job_uses_the_queue(db):
    await catalog.queue_job(db, "ensure_bundle", {"app_id": "abc"})
    await db.commit()
    (job,) = await jobs_of()
    assert (job.kind, job.payload, job.status, job.attempts) == (
        "ensure_bundle", {"app_id": "abc"}, "queued", 0)


async def test_enqueue_rejects_unknown_kind(db):
    with pytest.raises(ValueError):
        await queue.enqueue(db, "make_coffee", {})


def test_worker_cli_once():
    from serversherpa_devices.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["worker", "--once"])
    assert result.exit_code == 0, result.output
    assert "queue empty" in result.output

    result = runner.invoke(app, ["worker", "--once", "--reload"])
    assert result.exit_code == 1
    assert "--once can't be combined with --reload" in result.output
