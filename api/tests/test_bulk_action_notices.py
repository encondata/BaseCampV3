"""Bulk action notices: when the import worker finishes or fails a job that wrote data, the
person who committed it and its uploader (when that's someone else) each get an inbox row
(imports/notices.py). It is written after the job's own final state is committed, in a session
of its own, so no failure there can undo the work. Validation passes, canceled jobs and jobs
nobody started or committed say nothing.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 5), and answer 7
in docs/superpowers/specs/2026-11-02-notifications-phase2-as-built.md"""

import logging
import uuid

import pytest
from sqlalchemy import delete, func, select, update

from serversherpa.assets.bulk_update import KIND as BULK_UPDATE
from serversherpa.config import get_settings
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset,
    EmailOutbox,
    ImportJob,
    Initiative,
    Notification,
    NotificationLog,
    Person,
    SystemConfig,
    Truck,
    UserAccount,
)
from serversherpa.imports import move_setup, notices, worker
from serversherpa.imports.notices import (
    ACTIONS,
    FAILED_LINKS,
    FINISHED_LINKS,
    JobDone,
    count_left_out,
    writes_data,
)
from serversherpa.imports.worker import run_once
from serversherpa.notifications.inbox import notify
from serversherpa.status_rules.engine import invalidate_cache
from tests.test_asset_bulk_update_apply import fresh_job, mk_asset, mk_job, mk_person
from tests.test_import_worker import _job as mk_from_to_job
from tests.test_move_setup_api import BASE, TRUCKS, admin_login, make_sites, new_draft, reload
from tests.test_move_setup_worker import full_draft, queue
from tests.test_status_rules_engine import _rule

WORKER_LOG = "serversherpa.imports.worker"


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_cache()
    yield
    invalidate_cache()


@pytest.fixture
async def admin_hdrs(db, client):
    return await admin_login(db, client, "ada@test.example.com")


# ── helpers ─────────────────────────────────────────────────────────

async def _admin(db) -> Person:
    """The person the move setup wizard's admin login belongs to."""
    return await db.scalar(select(Person).where(Person.email == "ada@test.example.com"))


async def _second_person(db) -> Person:
    """Someone besides `mk_person`'s Ada: the other hand in a job two people had a part in."""
    person = Person(first_name="Bea", last_name="Builder")
    db.add(person)
    await db.commit()
    return person


def _done(**fields) -> JobDone:
    """A finished From-To import that names nobody, with whatever a test sets."""
    return JobDone(**{"job_id": uuid.uuid4(), "kind": "move_assets", "phase": "commit",
                      "status": "completed", "created_by": None, "initiative_id": None,
                      **fields})


async def _notices(db) -> list[Notification]:
    """Every inbox row written so far, oldest first."""
    return list(await db.scalars(
        select(Notification).order_by(Notification.created_at, Notification.id)))


async def _log(db) -> list[NotificationLog]:
    return list(await db.scalars(select(NotificationLog).order_by(NotificationLog.id)))


async def _set(db, job_id, **values) -> None:
    """Change a job row the way the app would have left it (committed)."""
    await db.execute(update(ImportJob).where(ImportJob.id == job_id).values(**values))
    await db.commit()


def _warning_records(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == WORKER_LOG and r.levelno >= logging.WARNING]


def _warnings(caplog) -> list[str]:
    return [r.getMessage() for r in _warning_records(caplog)]


async def _run() -> None:
    assert await run_once(get_sessionmaker()) is True


# ── what counts ─────────────────────────────────────────────────────

def test_the_actions_are_named_for_the_three_job_kinds():
    assert ACTIONS == {"asset_bulk_update": "Bulk update assets",
                       "move_assets": "From-To import", "move_setup": "Move setup"}
    # the kinds the import worker really claims
    assert set(ACTIONS) == {BULK_UPDATE, move_setup.KIND, move_setup.CHECK_KIND}
    # every action has a link for both endings
    assert set(FINISHED_LINKS) == set(FAILED_LINKS) == set(ACTIONS)


@pytest.mark.parametrize(("kind", "phase", "expected"), [
    # every job that writes data is claimed in phase "commit" (the routes that queue them set it)
    ("asset_bulk_update", "commit", True),
    ("move_setup", "commit", True),
    ("move_assets", "commit", True),
    ("move_assets", "validate", False),     # the person is reviewing it on screen
    ("move_assets", "preview", False),
    ("nope", "commit", False),
])
def test_writes_data(kind, phase, expected):
    assert writes_data(kind, phase) is expected


@pytest.mark.parametrize("status", ["queued", "running", "preview", "cancelled"])
async def test_only_a_completed_or_failed_job_is_notified(db, status):
    me = await mk_person(db)
    for kind in ACTIONS:
        await notices.notify_job_done(db, JobDone(
            job_id=uuid.uuid4(), kind=kind, phase="commit", status=status,
            created_by=me.id, initiative_id=None))
    await db.commit()
    assert await _notices(db) == []
    assert await _log(db) == []


@pytest.mark.parametrize("status", ["completed", "failed"])
async def test_a_job_nobody_started_is_not_notified(db, status):
    """No owner, no notice: skipped up front, not tried and failed (a notification needs a
    person)."""
    for kind in ACTIONS:
        await notices.notify_job_done(db, JobDone(
            job_id=uuid.uuid4(), kind=kind, phase="commit", status=status,
            created_by=None, initiative_id=None))
    await db.commit()
    assert await _notices(db) == []
    assert await _log(db) == []


async def test_a_notice_without_a_move_has_no_link_to_one(db):
    """The finished notice of a job tied to a move names it and links to it; with no move on
    the row (it cannot happen today) the notice still goes, without a body or a link."""
    me = await mk_person(db)
    for status in ("completed", "failed"):
        await notices.notify_job_done(db, JobDone(
            job_id=uuid.uuid4(), kind="move_assets", phase="commit", status=status,
            created_by=me.id, initiative_id=None))
    await db.commit()
    finished, failed = await _notices(db)
    assert (finished.title, finished.body, finished.link) == ("From-To import finished", "", None)
    assert (failed.title, failed.body, failed.link) == ("From-To import failed", "", None)


def test_the_rows_left_out_are_the_ones_with_an_error_and_the_ones_needing_review():
    assert count_left_out({"errors": 2, "review": 1, "created": 5, "updated": 1}) == 3
    assert count_left_out({"errors": 1}) == 1
    assert count_left_out({"review": 4}) == 4
    # the other jobs' summaries (and a job with none) leave nothing out
    assert count_left_out({"updated": 1, "skipped": 1, "unchanged": 1}) == 0
    assert count_left_out({}) == 0
    assert count_left_out(None) == 0


async def test_only_a_from_to_import_says_how_many_rows_it_left_out(db):
    """The count rides on the From-To import's finished line alone: the other jobs ignore it,
    a failed import has no line, and a count with no move to name still reads as one."""
    me = await mk_person(db)
    move = Initiative(name="Move Q", initiative_type="move", status="planned")
    db.add(move)
    await db.commit()
    await notices.notify_job_done(db, JobDone(
        job_id=uuid.uuid4(), kind="asset_bulk_update", phase="commit", status="completed",
        created_by=me.id, initiative_id=None, rows_left_out=5))
    await notices.notify_job_done(db, JobDone(
        job_id=uuid.uuid4(), kind="move_setup", phase="commit", status="completed",
        created_by=me.id, initiative_id=move.id, rows_left_out=5))
    await notices.notify_job_done(db, JobDone(
        job_id=uuid.uuid4(), kind="move_assets", phase="commit", status="completed",
        created_by=me.id, initiative_id=None, rows_left_out=2))
    await notices.notify_job_done(db, JobDone(
        job_id=uuid.uuid4(), kind="move_assets", phase="commit", status="failed",
        created_by=me.id, initiative_id=move.id, rows_left_out=2))
    await db.commit()
    bulk_update, setup, nameless, failed = await _notices(db)
    assert (bulk_update.body, setup.body) == ("", "Move Q")
    assert nameless.body == "2 rows not imported"
    assert failed.body == ""


# ── who is told ─────────────────────────────────────────────────────

def test_recipients_committer_first_then_uploader():
    uploader, committer = uuid.uuid4(), uuid.uuid4()
    done = _done(created_by=uploader, committed_by=committer)
    assert notices.recipients(done) == [committer, uploader]


async def test_same_person_gets_one_notice(db):
    """A uploads the file and commits it too: A is one person, so A hears once, not once for
    each part."""
    me = await mk_person(db)
    done = _done(created_by=me.id, committed_by=me.id)

    assert notices.recipients(done) == [me.id]
    await notices.notify_job_done(db, done)
    await db.commit()

    [only] = await _notices(db)
    assert (only.person_id, only.kind) == (me.id, "bulk_action_finished")


async def test_recipients_before_0119_is_the_uploader(db):
    """A job queued before migration 0119 has no committer (nor has a move setup, which its
    creator queues): its uploader is told, as it always was."""
    me = await mk_person(db)
    done = _done(created_by=me.id, committed_by=None)

    assert notices.recipients(done) == [me.id]
    await notices.notify_job_done(db, done)
    await db.commit()

    [only] = await _notices(db)
    assert (only.person_id, only.kind) == (me.id, "bulk_action_finished")


def test_a_committer_is_told_when_the_row_has_no_uploader():
    """A job with no uploader on its row (nobody started it) still tells whoever committed it."""
    committer = uuid.uuid4()
    assert notices.recipients(_done(created_by=None, committed_by=committer)) == [committer]


async def test_recipients_none_is_silent(db):
    done = _done(created_by=None, committed_by=None)

    assert notices.recipients(done) == []
    await notices.notify_job_done(db, done)
    await db.commit()

    assert await _notices(db) == []
    assert await _log(db) == []


async def test_from_to_finished_tells_committer_and_uploader(db):
    uploader, committer = await mk_person(db), await _second_person(db)
    move = Initiative(name="Move Q", initiative_type="move", status="planned")
    db.add(move)
    await db.commit()
    done = _done(created_by=uploader.id, committed_by=committer.id, initiative_id=move.id,
                 rows_left_out=2)

    await notices.notify_job_done(db, done)
    await db.commit()

    told = await _notices(db)
    assert sorted(n.person_id for n in told) == sorted([uploader.id, committer.id])
    # one notice each, and the same notice: title, body, link and payload
    for notice in told:
        assert (notice.kind, notice.title, notice.body, notice.link, notice.payload) == (
            "bulk_action_finished", "From-To import finished", "Move Q · 2 rows not imported",
            f"/initiatives/{move.id}?tab=assets",
            {"job_id": str(done.job_id), "job_kind": "move_assets"})
        assert notice.read_at is None and notice.dismissed_at is None


async def test_failed_job_tells_committer_and_uploader(db):
    uploader, committer = await mk_person(db), await _second_person(db)
    move = Initiative(name="Move Q", initiative_type="move", status="planned")
    db.add(move)
    await db.commit()
    done = _done(created_by=uploader.id, committed_by=committer.id, initiative_id=move.id,
                 status="failed")

    await notices.notify_job_done(db, done)
    await db.commit()

    told = await _notices(db)
    assert sorted(n.person_id for n in told) == sorted([uploader.id, committer.id])
    # a failed notice is title and link only
    for notice in told:
        assert (notice.kind, notice.title, notice.body, notice.link, notice.payload) == (
            "bulk_action_failed", "From-To import failed", "",
            f"/initiatives/{move.id}/import-assets",
            {"job_id": str(done.job_id), "job_kind": "move_assets"})


async def test_each_person_follows_their_own_switches(db):
    """Both are told through `notify()`, so each one's Bulk actions switches apply to their own
    copy: the uploader has Inbox off and hears nothing, the committer still hears."""
    uploader, committer = await mk_person(db), await _second_person(db)
    db.add(UserAccount(person_id=uploader.id, email="ada@test.example.com",
                       ui_prefs={"notif": {"switches": {"bulk_actions": {"inbox": False}}}}))
    await db.commit()

    await notices.notify_job_done(
        db, _done(created_by=uploader.id, committed_by=committer.id))
    await db.commit()

    [heard] = await _notices(db)
    assert heard.person_id == committer.id
    suppressed = [row for row in await _log(db) if row.event == "inbox_suppressed"]
    assert [(row.person_id, row.reason) for row in suppressed] == [
        (uploader.id, "category_off")]


# ── Bulk update assets ──────────────────────────────────────────────

async def test_bulk_update_finished_and_failed(db):
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")
    done_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", options={"approve_all": True})

    await _run()

    assert (await fresh_job(done_id)).status == "completed"
    [finished] = await _notices(db)
    assert (finished.person_id, finished.kind, finished.title, finished.body,
            finished.link) == (me.id, "bulk_action_finished", "Bulk update assets finished",
                               "", "/assets")
    assert finished.payload == {"job_id": str(done_id), "job_kind": "asset_bulk_update"}
    assert finished.read_at is None and finished.dismissed_at is None

    # a status rule that fails rolls the whole file back, and the job fails
    await mk_asset(db, 101, "SN-B", status="active")
    db.add(_rule("Broken", status="racked",
                 actions=(("set_asset_status", {"status": "no-such-status"}),)))
    await db.commit()
    failed_id = await mk_job(db, me, "asset_id,status\n101,racked\n",
                             options={"approve_all": True})

    await _run()

    job = await fresh_job(failed_id)
    assert (job.status, job.error) == ("failed", "rule_failed")
    failed = (await _notices(db))[-1]
    assert (failed.person_id, failed.kind, failed.title, failed.body, failed.link) == (
        me.id, "bulk_action_failed", "Bulk update assets failed", "", "/bulk/assets")
    assert failed.payload == {"job_id": str(failed_id), "job_kind": "asset_bulk_update"}
    assert len(await _notices(db)) == 2


# ── From-To import ──────────────────────────────────────────────────

async def test_from_to_import_finished_and_failed(db):
    me = await mk_person(db)
    job_id, ini_id = await mk_from_to_job(db, phase="commit")
    await _set(db, job_id, created_by=me.id)

    await _run()

    assert (await fresh_job(job_id)).status == "completed"
    move = await db.get(Initiative, ini_id)
    [finished] = await _notices(db)
    assert (finished.person_id, finished.kind, finished.title, finished.body,
            finished.link) == (me.id, "bulk_action_finished", "From-To import finished",
                               move.name, f"/initiatives/{ini_id}?tab=assets")
    assert finished.payload == {"job_id": str(job_id), "job_kind": "move_assets"}

    # a file with a bad row still finishes, and the notice says one row was not imported (the
    # initiative's assets do not list it)
    rows_id, rows_ini = await mk_from_to_job(
        db, phase="commit", content=b"Serial Number,Asset Name\n,no-serial\nSN-OK,web-01\n")
    await _set(db, rows_id, created_by=me.id)

    await _run()

    job = await fresh_job(rows_id)
    assert (job.status, job.error_count) == ("completed", 1)
    with_errors = (await _notices(db))[-1]
    assert (with_errors.kind, with_errors.title, with_errors.link) == (
        "bulk_action_finished", "From-To import finished", f"/initiatives/{rows_ini}?tab=assets")
    assert with_errors.body == f"{(await db.get(Initiative, rows_ini)).name} · 1 row not imported"

    # a stored file that cannot be read fails the commit
    lost_id, lost_ini = await mk_from_to_job(db, phase="commit")
    await _set(db, lost_id, created_by=me.id, file_key="import-jobs/gone/missing.csv")

    await _run()

    job = await fresh_job(lost_id)
    assert (job.status, job.error) == ("failed", "file_unreadable")
    failed = (await _notices(db))[-1]
    assert (failed.person_id, failed.kind, failed.title, failed.body, failed.link) == (
        me.id, "bulk_action_failed", "From-To import failed", "",
        f"/initiatives/{lost_ini}/import-assets")
    assert failed.payload == {"job_id": str(lost_id), "job_kind": "move_assets"}
    assert len(await _notices(db)) == 3


async def test_worker_tells_the_committer(db):
    """B committed the file A uploaded. The worker reads who committed it back with the job's
    final state, so both hear how it ended, finished or failed."""
    uploader, committer = await mk_person(db), await _second_person(db)
    job_id, ini_id = await mk_from_to_job(db, phase="commit")
    await _set(db, job_id, created_by=uploader.id, committed_by=committer.id)

    await _run()

    assert (await fresh_job(job_id)).status == "completed"
    move = await db.get(Initiative, ini_id)
    finished = await _notices(db)
    assert sorted(n.person_id for n in finished) == sorted([uploader.id, committer.id])
    for notice in finished:
        assert (notice.kind, notice.title, notice.body, notice.link) == (
            "bulk_action_finished", "From-To import finished", move.name,
            f"/initiatives/{ini_id}?tab=assets")
        assert notice.payload == {"job_id": str(job_id), "job_kind": "move_assets"}

    # a stored file that cannot be read fails the commit, and both hear that too
    lost_id, lost_ini = await mk_from_to_job(db, phase="commit")
    await _set(db, lost_id, created_by=uploader.id, committed_by=committer.id,
               file_key="import-jobs/gone/missing.csv")

    await _run()

    job = await fresh_job(lost_id)
    assert (job.status, job.error) == ("failed", "file_unreadable")
    failed = (await _notices(db))[len(finished):]
    assert sorted(n.person_id for n in failed) == sorted([uploader.id, committer.id])
    for notice in failed:
        assert (notice.kind, notice.title, notice.body, notice.link) == (
            "bulk_action_failed", "From-To import failed", "",
            f"/initiatives/{lost_ini}/import-assets")
        assert notice.payload == {"job_id": str(lost_id), "job_kind": "move_assets"}
    assert len(await _notices(db)) == 4


async def test_worker_tells_the_committer_when_the_row_has_no_uploader(db):
    """A job with an empty `created_by` is no longer skipped on that alone: who committed it is
    read back with its final state, and they are told."""
    committer = await mk_person(db)
    job_id, _ = await mk_from_to_job(db, phase="commit")              # no created_by
    await _set(db, job_id, committed_by=committer.id)

    await _run()

    assert (await fresh_job(job_id)).status == "completed"
    [finished] = await _notices(db)
    assert (finished.person_id, finished.kind) == (committer.id, "bulk_action_finished")


FROM_TO_HEADER = b"Serial Number,Asset Name,Asset Make,Asset Model\n"


@pytest.mark.parametrize(("rows", "errors", "review", "line"), [
    pytest.param(b"SN-1,web-01,,\nSN-2,web-02,,\n", 0, 0, "", id="none-left-out"),
    pytest.param(b",no-serial,,\nSN-1,web-01,,\n", 1, 0, " · 1 row not imported",
                 id="one-row-with-an-error"),
    # two rows without a serial, and one whose make and model is not in the catalog
    pytest.param(b",no-serial-1,,\n,no-serial-2,,\nSN-1,web-01,,\nSN-2,web-02,NoMake,NoModel\n",
                 2, 1, " · 3 rows not imported", id="errors-and-a-row-needing-review"),
])
async def test_a_finished_import_says_how_many_rows_were_not_imported(
        db, rows, errors, review, line):
    me = await mk_person(db)
    job_id, ini_id = await mk_from_to_job(db, phase="commit", content=FROM_TO_HEADER + rows)
    await _set(db, job_id, created_by=me.id)

    await _run()

    job = await fresh_job(job_id)
    assert job.status == "completed"
    # error_count holds the rows with an error only; the ones needing review are in the summary
    assert (job.error_count, job.results["summary"]["review"]) == (errors, review)
    move = await db.get(Initiative, ini_id)
    [finished] = await _notices(db)
    assert (finished.kind, finished.title, finished.link) == (
        "bulk_action_finished", "From-To import finished", f"/initiatives/{ini_id}?tab=assets")
    assert finished.body == move.name + line


# ── Move setup ──────────────────────────────────────────────────────

async def test_move_setup_finished_and_failed(client, db, admin_hdrs):
    ada = await _admin(db)
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    assert await _notices(db) == []              # the wizard's file check said nothing
    await queue(client, admin_hdrs, draft["id"])
    db.add(Truck(name="TRK-SJC-DAL-002"))        # lands after the check, before the worker
    await db.commit()

    await _run()

    failed_job = await reload(draft["id"])
    assert (failed_job.status, failed_job.error) == ("failed", "name_taken")
    [failed] = await _notices(db)
    assert (failed.person_id, failed.kind, failed.title, failed.body, failed.link) == (
        ada.id, "bulk_action_failed", "Move setup failed", "", "/bulk/new-move")
    assert failed.payload == {"job_id": draft["id"], "job_kind": "move_setup"}

    # fixed and created again: the move did not exist the first time, so the id is read
    # from the job once it has finished
    fixed = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                               json={"trucks": {**TRUCKS, "start": 10}})
    assert fixed.json()["status"] == "preview"
    await queue(client, admin_hdrs, draft["id"])

    await _run()

    done = await reload(draft["id"])
    assert done.status == "completed" and done.initiative_id is not None
    finished = (await _notices(db))[-1]
    assert (finished.person_id, finished.kind, finished.title, finished.body,
            finished.link) == (ada.id, "bulk_action_finished", "Move setup finished",
                               "SJC to DAL", f"/initiatives/{done.initiative_id}")
    assert finished.payload == {"job_id": draft["id"], "job_kind": "move_setup"}
    assert len(await _notices(db)) == 2


# ── a crash in the worker ───────────────────────────────────────────

async def test_a_worker_crash_still_tells_the_owner(db, monkeypatch):
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")
    job_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", options={"approve_all": True})

    async def boom(session, job, *, progress=None):
        await session.execute(select(1))       # a transaction is open when it fails
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(worker, "apply_job", boom)

    await _run()

    job = await fresh_job(job_id)
    assert (job.status, job.error) == ("failed", "worker_error: disk on fire")
    [failed] = await _notices(db)
    assert (failed.person_id, failed.kind, failed.title, failed.body, failed.link) == (
        me.id, "bulk_action_failed", "Bulk update assets failed", "", "/bulk/assets")
    # the error text is internal: it is on the job, never in the notice
    assert "disk on fire" not in repr((failed.title, failed.body, failed.link, failed.payload))


async def test_a_move_setup_crash_still_tells_the_owner(client, db, admin_hdrs, monkeypatch):
    ada = await _admin(db)
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                       json={"skip": ["assets", "crates", "trucks"]})
    await queue(client, admin_hdrs, draft["id"])

    async def boom(db, job):
        await db.execute(select(1))            # a transaction is open when it fails
        raise RuntimeError("storage down")

    monkeypatch.setattr(move_setup, "prepare", boom)

    await _run()

    job = await reload(draft["id"])
    assert (job.status, job.error) == ("failed", "worker_error")
    [failed] = await _notices(db)
    assert (failed.person_id, failed.kind, failed.title, failed.body, failed.link) == (
        ada.id, "bulk_action_failed", "Move setup failed", "", "/bulk/new-move")


@pytest.mark.parametrize(("crash", "ends"), [(False, "completed"), (True, "failed")])
async def test_the_notice_follows_the_committed_state_in_a_session_of_its_own(
        db, monkeypatch, crash, ends):
    """Call 5 of the plan: the job's final state (done, or failed by a crash) is committed
    first, and the notice is written in a new session, so nothing it does can touch the job."""
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")
    job_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", options={"approve_all": True})
    if crash:
        async def boom(session, job, *, progress=None):
            await session.execute(select(1))   # a transaction is open when it fails
            raise RuntimeError("disk on fire")

        monkeypatch.setattr(worker, "apply_job", boom)
    real_process, real_notify = worker.process_job, worker.notify_job_done
    seen: dict = {}

    async def spy_process(session, job):
        seen["job_session"] = session
        await real_process(session, job)

    async def spy_notify(session, done):
        seen["notice_session"] = session
        seen["done"] = done
        # what any other reader of the row sees at the moment the notice is written
        seen["committed"] = (await fresh_job(done.job_id)).status
        await real_notify(session, done)

    monkeypatch.setattr(worker, "process_job", spy_process)
    monkeypatch.setattr(worker, "notify_job_done", spy_notify)

    await _run()

    assert seen["notice_session"] is not seen["job_session"]
    assert seen["committed"] == ends
    assert seen["done"] == JobDone(
        job_id=job_id, kind="asset_bulk_update", phase="commit", status=ends,
        created_by=me.id, initiative_id=None)
    assert len(await _notices(db)) == 1


# ── what stays silent ───────────────────────────────────────────────

async def test_validation_passes_are_silent(client, db, admin_hdrs):
    """A validate pass writes nothing and the person is looking at it on screen: no notice,
    whether it completes or fails, and none for the wizard's file check."""
    ada = await _admin(db)
    ok_id, ok_ini = await mk_from_to_job(db)                       # phase "validate"
    bad_id, _ = await mk_from_to_job(db, content=b"Asset Name\nx\n")   # no serial column
    await _set(db, ok_id, created_by=ada.id)
    await _set(db, bad_id, created_by=ada.id)

    await _run()
    await _run()

    ok, bad = await fresh_job(ok_id), await fresh_job(bad_id)
    assert (ok.status, ok.phase) == ("completed", "validate")
    assert (bad.status, bad.error) == ("failed", "missing_serial_column")

    # the wizard's file check is a validate pass of its own, with no move yet
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    check = await reload((await reload(draft["id"])).payload["assets"]["check_job_id"])
    assert (check.kind, check.phase, check.status, check.initiative_id) == (
        "move_assets", "validate", "completed", None)
    assert check.created_by == ada.id
    assert await _notices(db) == []
    assert await _log(db) == []                 # not even a suppressed one

    # committing the validated pass is what makes it a bulk action: the same row now says so
    await _set(db, ok_id, phase="commit", status="queued")
    await _run()
    [finished] = await _notices(db)
    assert (finished.kind, finished.title, finished.link) == (
        "bulk_action_finished", "From-To import finished", f"/initiatives/{ok_ini}?tab=assets")


async def test_a_validate_pass_opens_no_notice_session(db):
    """A validate pass is skipped before a session is opened for the notice: it pays no read,
    and a database blip there cannot warn about it. Every commit opens one, even a job nobody
    started: who committed it is read back with its final state, and `recipients` is what finds
    there is nobody to tell. So the count tells the validate pass apart."""
    me = await mk_person(db)
    validate_id, _ = await mk_from_to_job(db)                          # phase "validate"
    await _set(db, validate_id, created_by=me.id)
    ownerless_id, _ = await mk_from_to_job(db, phase="commit")        # no created_by
    owned_id, _ = await mk_from_to_job(db, phase="commit")
    await _set(db, owned_id, created_by=me.id)

    real = get_sessionmaker()
    opened: list[object] = []

    def counting():
        opened.append(object())
        return real()

    sessions = []
    for _ in range(3):                                  # the jobs run oldest first
        before = len(opened)
        assert await run_once(counting) is True
        sessions.append(len(opened) - before)

    assert [(await fresh_job(j)).status for j in (validate_id, ownerless_id, owned_id)] == [
        "completed", "completed", "completed"]
    # the job's own session, plus the notice's (none for the validate pass)
    assert sessions == [1, 2, 2]
    [finished] = await _notices(db)             # the job nobody started said nothing
    assert finished.person_id == me.id


async def test_cancelled_and_ownerless_jobs_are_silent(db, monkeypatch, caplog):
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")

    # nobody started these, so there is nobody to tell
    orphan_update = await mk_job(db, me, "asset_id,name\n100,new-a\n",
                                 options={"approve_all": True})
    await _set(db, orphan_update, created_by=None)
    orphan_import, _ = await mk_from_to_job(db, phase="commit")       # no created_by
    orphan_failure, _ = await mk_from_to_job(db, phase="commit")
    await _set(db, orphan_failure, file_key="import-jobs/gone/missing.csv")
    with caplog.at_level(logging.WARNING, logger=WORKER_LOG):
        for _ in range(3):
            await _run()
    assert (await fresh_job(orphan_update)).status == "completed"
    assert (await fresh_job(orphan_import)).status == "completed"
    failed = await fresh_job(orphan_failure)
    assert (failed.status, failed.error) == ("failed", "file_unreadable")

    # canceled before the worker got to it: the person did that themselves
    early = await mk_job(db, me, "asset_id,name\n100,newer-a\n", options={"approve_all": True})
    await _set(db, early, cancel_requested=True)
    await _run()
    assert (await fresh_job(early)).status == "cancelled"

    # and canceled part-way through a From-To commit
    mid_id, _ = await mk_from_to_job(db, phase="commit")
    await _set(db, mid_id, created_by=me.id)

    async def cancelled_import(*args, **kwargs):
        return {"summary": {"processed_rows": 1, "created": 1, "updated": 0, "errors": 0},
                "details": [], "cancelled": True}

    monkeypatch.setattr(worker, "run_import", cancelled_import)
    await _run()
    assert (await fresh_job(mid_id)).status == "cancelled"

    assert await _notices(db) == []
    assert await _log(db) == []
    # skipped, not tried and failed: a failed try would only be a warning in the worker's log
    assert _warnings(caplog) == []


# ── a notice that cannot be written ─────────────────────────────────

async def test_a_notify_failure_leaves_the_job_alone(db, monkeypatch, caplog):
    """The notice is written after the job's own state is committed, in a session of its own:
    when it cannot be, the work stands, the worker carries on, and one warning names the
    class of the error and where it went wrong (the traceback), never its text (a database
    error can carry values)."""
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")
    job_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", options={"approve_all": True})
    # in the error's text, joined in at run time: a traceback prints source lines, not values
    value = "ada@test.example.com"

    async def boom(*args, **kwargs):
        raise RuntimeError(f"inbox down for {value}")

    monkeypatch.setattr(notices, "notify", boom)
    with caplog.at_level(logging.WARNING, logger=WORKER_LOG):
        assert await run_once(get_sessionmaker()) is True

    job = await fresh_job(job_id)
    assert (job.status, job.error) == ("completed", None)
    assert await db.scalar(select(Asset.name).where(Asset.legacy_id == 100)) == "new-a"
    assert await _notices(db) == []
    [line] = _warnings(caplog)
    assert str(job_id) in line and "RuntimeError" in line        # the class is logged
    assert value not in line
    [record] = _warning_records(caplog)
    shown = logging.Formatter().format(record)           # the line and its traceback, as logged
    assert "Traceback (most recent call last)" in shown and "in boom" in shown
    assert "RuntimeError" in shown
    assert value not in shown                            # the error's text never is
    assert record.exc_info[0] is RuntimeError and record.exc_info[1] is None
    assert await run_once(get_sessionmaker()) is False        # the queue is clear


async def test_a_job_gone_by_the_time_of_the_notice_is_skipped(db, monkeypatch, caplog):
    """A move's jobs go with the move. If the row is not there to be read back, there is
    nothing to say and nothing to warn about."""
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")
    job_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", options={"approve_all": True})
    real = worker.process_job

    async def then_delete_the_row(session, job):
        await real(session, job)
        async with get_sessionmaker()() as other:
            await other.execute(delete(ImportJob).where(ImportJob.id == job_id))
            await other.commit()

    monkeypatch.setattr(worker, "process_job", then_delete_the_row)
    with caplog.at_level(logging.WARNING, logger=WORKER_LOG):
        assert await run_once(get_sessionmaker()) is True

    assert await db.scalar(select(func.count()).select_from(ImportJob)) == 0
    assert await _notices(db) == []
    assert _warnings(caplog) == []


# ── email and the Bulk actions switches ─────────────────────────────

async def test_the_owner_is_emailed_like_for_any_other_category(db, email_on):
    """Email is on until someone turns it off, as for every Phase 1 category: the finished
    notice carries the initiative's name and a link to the result, the failed one only its
    title and its link."""
    me = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(me)
    await db.commit()
    job_id, ini_id = await mk_from_to_job(db, phase="commit")
    await _set(db, job_id, created_by=me.id)
    lost_id, lost_ini = await mk_from_to_job(db, phase="commit")
    await _set(db, lost_id, created_by=me.id, file_key="import-jobs/gone/missing.csv")

    await _run()
    await _run()

    move = await db.get(Initiative, ini_id)
    finished, failed = list(await db.scalars(
        select(EmailOutbox).order_by(EmailOutbox.created_at, EmailOutbox.id)))
    origin = get_settings().portal_origin.rstrip("/")
    assert (finished.kind, finished.template, finished.to_address, finished.subject) == (
        "bulk_action_finished", "notification", "ada@test.example.com",
        "From-To import finished")
    assert move.name in finished.text_body
    assert f"{origin}/initiatives/{ini_id}?tab=assets" in finished.text_body
    assert (failed.kind, failed.subject) == ("bulk_action_failed", "From-To import failed")
    assert f"{origin}/initiatives/{lost_ini}/import-assets" in failed.text_body
    assert "file_unreadable" not in failed.text_body and "file_unreadable" not in failed.html_body


async def test_a_failed_notice_is_emailed_with_a_title_and_a_link_only(db, email_on):
    """bulk_action_failed is a brief kind like report_failed: the registry keeps the body out
    of its email, so error text a caller might pass can never leave. The finished notice's
    body (the move's name) goes."""
    me = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(me)
    await db.commit()
    await notify(db, me.id, "bulk_action_failed", "Bulk update assets failed",
                 body="rule_failed secret-detail-xyz", link="/bulk/assets")
    await notify(db, me.id, "bulk_action_finished", "From-To import finished",
                 body="Move North", link="/assets")
    await db.commit()

    mails = {m.kind: m for m in await db.scalars(select(EmailOutbox))}
    failed, finished = mails["bulk_action_failed"], mails["bulk_action_finished"]
    for body in (failed.text_body, failed.html_body):
        assert "secret-detail-xyz" not in body
    assert "/bulk/assets" in failed.text_body
    assert "Move North" in finished.text_body and "Move North" in finished.html_body


async def test_the_category_switch_applies(db):
    """The notice goes through the person's Bulk actions switches like any other: with
    Inbox off nothing is written, and the delivery log says so. The company default decides
    for a person who never chose."""
    me = await mk_person(db)
    db.add(UserAccount(person_id=me.id, email="ada@test.example.com",
                       ui_prefs={"notif": {"switches": {"bulk_actions": {"inbox": False}}}}))
    other = Person(first_name="Bea", last_name="Builder")
    db.add(other)
    db.add(SystemConfig(section="notifications", data={
        "defaults": {"bulk_actions": {"inbox": False, "email": False}}}))
    await db.commit()
    await mk_asset(db, 100, "SN-A", name="old-a")
    await mk_asset(db, 101, "SN-B", status="active")
    db.add(_rule("Broken", status="racked",
                 actions=(("set_asset_status", {"status": "no-such-status"}),)))
    await db.commit()
    own_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", options={"approve_all": True})
    default_id = await mk_job(db, other, "asset_id,status\n101,racked\n",
                              options={"approve_all": True})

    await _run()
    await _run()

    assert (await fresh_job(own_id)).status == "completed"
    assert (await fresh_job(default_id)).error == "rule_failed"
    assert await _notices(db) == []
    own, by_default = await _log(db)
    assert (own.event, own.person_id, own.kind, own.category, own.reason) == (
        "inbox_suppressed", me.id, "bulk_action_finished", "bulk_actions", "category_off")
    assert own.detail == {"source": "own"}
    assert (by_default.event, by_default.person_id, by_default.kind, by_default.category,
            by_default.reason) == ("inbox_suppressed", other.id, "bulk_action_failed",
                                   "bulk_actions", "category_off")
    assert by_default.detail == {"source": "default"}
