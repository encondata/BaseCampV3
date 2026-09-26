"""The wiki worker's daily `retention` job (Phase 3 Task 4): page views
older than 365 days, search log rows older than 90 days, and finished
(`done`/`failed`) wiki_jobs older than 30 days are deleted — except the
newest `reminders`/`retention` rows, which are what the loop reads to
decide whether the day's run is due. Scheduled like `reminders`: at most
one a day, recorded as a wiki_jobs row."""
import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import WikiJob, WikiNode, WikiPageView, WikiSearchLog, WikiSpace
from serversherpa.wiki import worker
from tests.wiki_helpers import login_as


async def _jobs(db, kind=None):
    q = select(WikiJob).execution_options(populate_existing=True)
    if kind:
        q = q.where(WikiJob.kind == kind)
    return (await db.scalars(q)).all()


async def _run(db):
    job = WikiJob(kind="retention", status="running")
    db.add(job)
    await db.commit()
    await worker.process_job(db, job)
    return job


async def _node(db):
    space = WikiSpace(key=f"r-{uuid.uuid4().hex[:8]}", name="Retention")
    db.add(space)
    await db.flush()
    node = WikiNode(space_id=space.id, path=[], kind="page", title="Viewed")
    db.add(node)
    await db.commit()
    return node


async def test_retention_deletes_old_views_and_search_log(client, db):
    _, person_id = await login_as(client, db)
    node = await _node(db)
    today = datetime.now(UTC).date()
    now = datetime.now(UTC)
    db.add_all([
        WikiPageView(node_id=node.id, person_id=person_id,
                     viewed_on=today - timedelta(days=366), count=4),
        WikiPageView(node_id=node.id, person_id=person_id,
                     viewed_on=today - timedelta(days=364), count=2),
        WikiPageView(node_id=node.id, person_id=person_id, viewed_on=today, count=1),
        WikiSearchLog(person_id=person_id, query="old", result_count=0,
                      at=now - timedelta(days=91)),
        WikiSearchLog(person_id=person_id, query="recent", result_count=0,
                      at=now - timedelta(days=89)),
    ])
    await db.commit()

    job = await _run(db)
    assert job.status == "done"
    assert job.result["views"] == 1 and job.result["searches"] == 1
    assert job.result["exports"] == 0

    views = (await db.scalars(select(WikiPageView.count).execution_options(
        populate_existing=True))).all()
    assert sorted(views) == [1, 2]
    assert (await db.scalars(select(WikiSearchLog.query))).all() == ["recent"]


async def test_retention_deletes_finished_jobs_but_keeps_the_schedule_markers(db):
    old = datetime.now(UTC) - timedelta(days=40)
    recent = datetime.now(UTC) - timedelta(days=5)
    rows = {
        "old_done": WikiJob(kind="purge", status="done", created_at=old, finished_at=old),
        "old_failed": WikiJob(kind="file_extract", status="failed", created_at=old,
                              finished_at=old),
        "old_queued": WikiJob(kind="purge", status="queued", created_at=old),
        "recent_done": WikiJob(kind="purge", status="done", created_at=recent,
                               finished_at=recent),
        "older_reminders": WikiJob(kind="reminders", status="done",
                                   created_at=old - timedelta(days=1), finished_at=old),
        "newest_reminders": WikiJob(kind="reminders", status="done", created_at=old,
                                    finished_at=old),
        "old_retention": WikiJob(kind="retention", status="done", created_at=old,
                                 finished_at=old),
    }
    db.add_all(rows.values())
    await db.commit()
    ids = {name: job.id for name, job in rows.items()}

    # the running retention job is its kind's newest row now, so the old
    # one is no longer a marker and goes like any other finished job
    job = await _run(db)
    assert job.result["jobs"] == 4
    left = {j.id for j in await _jobs(db)}
    assert left == {ids["old_queued"], ids["recent_done"], ids["newest_reminders"], job.id}


async def test_purge_old_exports_is_a_no_op_until_exports_exist(db):
    assert await worker.purge_old_exports(db, datetime.now(UTC)) == 0


async def test_ensure_retention_job_queues_one_a_day(db):
    async with get_sessionmaker()() as session:
        assert await worker.ensure_retention_job(session) is not None
    async with get_sessionmaker()() as session:
        assert await worker.ensure_retention_job(session) is None
    # a reminders run doesn't count as the day's retention run, nor the reverse
    async with get_sessionmaker()() as session:
        assert await worker.ensure_reminders_job(session) is not None
    assert len(await _jobs(db, "retention")) == 1

    await db.execute(update(WikiJob).where(WikiJob.kind == "retention").values(
        created_at=datetime.now(UTC) - timedelta(hours=25), status="done"))
    await db.commit()
    async with get_sessionmaker()() as session:
        assert await worker.ensure_retention_job(session) is not None
    assert sorted(j.status for j in await _jobs(db, "retention")) == ["done", "queued"]


async def test_the_worker_loop_queues_retention_at_startup(db, monkeypatch):
    from serversherpa.system import registry

    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    monkeypatch.setattr(registry, "start_heartbeat",
                        lambda name, kind, meta_fn=None: asyncio.create_task(asyncio.sleep(0)))

    async def not_paused(maker, state):
        return False

    monkeypatch.setattr("serversherpa.system.admin_config.poll_workers_paused", not_paused)

    async def no_claim(session):
        return None

    monkeypatch.setattr(worker, "claim_next", no_claim)
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05))
    try:
        for _ in range(60):
            await asyncio.sleep(0.05)
            if await _jobs(db, "retention"):
                break
        assert len(await _jobs(db, "retention")) == 1
        await asyncio.sleep(0.2)
        assert len(await _jobs(db, "retention")) == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
