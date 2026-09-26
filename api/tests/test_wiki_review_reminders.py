"""The wiki worker's `reminders` job (Phase 2 Task 5): scheduling at most
one run a day (persisted as a `reminders` wiki_jobs row), and the
handler — `wiki_review_due` to the page owner (or, without one, the last
publisher) for each page whose review is due, once per due date."""
import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Notification,
    WikiJob,
    WikiNode,
    WikiPage,
    WikiPageVersion,
    WikiSpace,
)
from serversherpa.wiki import worker
from tests.wiki_helpers import _setup, login_as


async def _reminder_jobs(db):
    return (await db.scalars(select(WikiJob).where(WikiJob.kind == "reminders")
                             .execution_options(populate_existing=True))).all()


async def _due_page(db, space_id, *, owner_id=None, publisher_id=None, due_in_days=-1,
                    title="Due page"):
    """A published page whose review falls `due_in_days` from now."""
    node = WikiNode(space_id=space_id, path=[], kind="page", title=title,
                    owner_id=owner_id, review_interval_months=6,
                    next_review_at=datetime.now(UTC) + timedelta(days=due_in_days))
    db.add(node)
    await db.flush()
    page = WikiPage(node_id=node.id)
    db.add(page)
    await db.flush()
    version = WikiPageVersion(node_id=node.id, version_no=1, title=title,
                              content_json={"type": "doc", "content": []},
                              kind="published", created_by=publisher_id)
    db.add(version)
    await db.flush()
    page.published_version_id = version.id
    await db.commit()
    return node


async def _run(db):
    job = WikiJob(kind="reminders", status="running")
    db.add(job)
    await db.commit()
    await worker.process_job(db, job)
    return job


async def _due_notes(db, person_id):
    return (await db.scalars(select(Notification).where(
        Notification.person_id == person_id, Notification.kind == "wiki_review_due"))).all()


# ── scheduling ───────────────────────────────────────────────────────


async def test_ensure_reminders_job_queues_one_a_day(db):
    async with get_sessionmaker()() as session:
        first = await worker.ensure_reminders_job(session)
    assert first is not None
    async with get_sessionmaker()() as session:
        assert await worker.ensure_reminders_job(session) is None
    assert len(await _reminder_jobs(db)) == 1

    # a day later there's room for the next one
    await db.execute(update(WikiJob).where(WikiJob.kind == "reminders")
                     .values(created_at=datetime.now(UTC) - timedelta(hours=25),
                             status="done"))
    await db.commit()
    async with get_sessionmaker()() as session:
        assert await worker.ensure_reminders_job(session) is not None
    jobs = await _reminder_jobs(db)
    assert sorted(j.status for j in jobs) == ["done", "queued"]


async def test_the_worker_loop_queues_reminders_at_startup(db, monkeypatch):
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
            if await _reminder_jobs(db):
                break
        assert len(await _reminder_jobs(db)) == 1
        await asyncio.sleep(0.2)                 # later ticks don't queue more
        assert len(await _reminder_jobs(db)) == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


# ── the handler ──────────────────────────────────────────────────────


async def test_reminders_notify_the_owner_once_per_due_date(client, db):
    s = await _setup(client, db)
    space_id = uuid.UUID(s["space"]["id"])
    node = await _due_page(db, space_id, owner_id=s["editor_id"])
    await _due_page(db, space_id, owner_id=s["editor_id"], due_in_days=5, title="Not yet")

    job = await _run(db)
    assert job.status == "done" and job.result == {"notified": 1, "pages": 1}
    notes = await _due_notes(db, s["editor_id"])
    assert len(notes) == 1 and notes[0].title == "Due page is due for review"

    await _run(db)
    assert len(await _due_notes(db, s["editor_id"])) == 1

    # a new due date (e.g. marked reviewed, then due again) notifies again
    fresh = await db.get(WikiNode, node.id, populate_existing=True)
    fresh.next_review_at = datetime.now(UTC) - timedelta(hours=1)
    await db.commit()
    await _run(db)
    assert len(await _due_notes(db, s["editor_id"])) == 2


async def test_reminders_fall_back_to_the_last_publisher(client, db):
    s = await _setup(client, db)
    await _due_page(db, uuid.UUID(s["space"]["id"]), publisher_id=s["owner_id"])
    await _run(db)
    assert len(await _due_notes(db, s["owner_id"])) == 1


async def test_reminders_skip_deleted_pages_archived_spaces_and_cleared_intervals(client, db):
    s = await _setup(client, db)
    space_id = uuid.UUID(s["space"]["id"])
    deleted = await _due_page(db, space_id, owner_id=s["editor_id"], title="Deleted")
    cleared = await _due_page(db, space_id, owner_id=s["editor_id"], title="Cleared")
    (await db.get(WikiNode, deleted.id)).deleted_at = datetime.now(UTC)
    (await db.get(WikiNode, cleared.id)).review_interval_months = None
    await db.commit()

    other = await _setup(client, db)
    await _due_page(db, uuid.UUID(other["space"]["id"]), owner_id=other["editor_id"])
    (await db.get(WikiSpace, uuid.UUID(other["space"]["id"]))).archived_at = datetime.now(UTC)
    await db.commit()

    await _run(db)
    assert await _due_notes(db, s["editor_id"]) == []
    assert await _due_notes(db, other["editor_id"]) == []


async def test_reminders_use_the_space_interval_when_the_page_has_none(client, db):
    s = await _setup(client, db)
    resp = await client.patch(f"/wiki/spaces/{s['space']['key']}", headers=s["owner"],
                              json={"settings": {"review_interval_months": 3}})
    assert resp.status_code == 200, resp.text
    node = await _due_page(db, uuid.UUID(s["space"]["id"]), owner_id=s["editor_id"])
    (await db.get(WikiNode, node.id)).review_interval_months = None
    await db.commit()
    await _run(db)
    assert len(await _due_notes(db, s["editor_id"])) == 1


async def test_an_owner_who_cannot_view_is_not_notified_but_the_date_is_spent(client, db):
    s = await _setup(client, db)
    _, stranger = await login_as(client, db, roles=("external",))
    node = await _due_page(db, uuid.UUID(s["space"]["id"]), owner_id=stranger)
    await _run(db)
    assert await _due_notes(db, stranger) == []
    fresh = await db.get(WikiNode, node.id, populate_existing=True)
    assert fresh.review_notified_for == fresh.next_review_at
    assert await db.scalar(select(func.count()).select_from(Notification).where(
        Notification.kind == "wiki_review_due")) == 0
