"""report-worker: claim → build → upload → attach → notify, plus every
failure path, stale re-queue, pause, and the loop surviving DB blips.
The module's build is faked so no Node/WeasyPrint is needed here."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Attachment, AuditLog, Initiative, Notification, Person, ReportDefinition, ReportRun,
    SystemProcess,
)
from serversherpa.reports import worker
from serversherpa.reports.jobs import STALE_MINUTES, claim_next, requeue_stale
from serversherpa.reports.registry import ReportResult
from serversherpa.services.storage import get_object

ALL_ON = {"summary": True, "assets_by_source": True, "assets_by_destination": True,
          "size_weight": True, "rail_usage": True, "collisions": True,
          "source_racks": True, "destination_racks": True}


async def _run(db, *, notify=False, status="queued", started_at=None,
               report_type="move_report", definition_name="Move Report",
               options=None, with_initiative=True):
    # ReportDefinition.name has a live-unique index (report_definitions_name_live_idx)
    # — reuse the row across calls within a test instead of inserting a duplicate.
    options = ALL_ON if options is None else options
    person = Person(first_name="Rae", last_name="Requester")
    d = await db.scalar(select(ReportDefinition).where(ReportDefinition.name == definition_name))
    if d is None:
        d = ReportDefinition(name=definition_name, report_type=report_type, options=options,
                             is_system=True)
        db.add(d)
    ini = Initiative(name="NAP11", initiative_type="move", status="planned") if with_initiative else None
    db.add_all([person] + ([ini] if ini is not None else []))
    await db.flush()
    run = ReportRun(definition_id=d.id, report_type=report_type,
                    initiative_id=ini.id if ini is not None else None,
                    options=options, requested_by=person.id, requested_rank=40, notify=notify,
                    status=status, started_at=started_at)
    db.add(run)
    await db.commit()
    return run.id, person.id, (ini.id if ini is not None else None)


class FakeModule:
    report_type = "move_report"

    def __init__(self, *, fail: Exception | None = None, slow: float = 0):
        self.fail, self.slow = fail, slow

    def default_options(self):
        return ALL_ON

    def validate_options(self, o):
        return {**ALL_ON, **o}

    async def build(self, db, run, *, renderer=None):
        if self.slow:
            await asyncio.sleep(self.slow)
        if self.fail:
            raise self.fail
        return ReportResult(content=b"%PDF-1.4 fake",
                            filename="Move Report - NAP11 - 2026-09-09 1200.pdf")


class DbErrorModule(FakeModule):
    """Builds by poisoning the build session's transaction — the shape of a
    real bad query inside a report module."""

    async def build(self, db, run, *, renderer=None):
        await db.execute(text("SELECT * FROM table_that_does_not_exist"))
        raise AssertionError("unreachable")             # pragma: no cover


async def test_claim_next_oldest_first_and_requeue_stale(db):
    r1, *_ = await _run(db)
    r2, *_ = await _run(db)
    claimed = await claim_next(db)
    assert claimed.id == r1 and claimed.status == "running" and claimed.started_at is not None
    assert (await claim_next(db)).id == r2
    assert await claim_next(db) is None
    stale = await db.get(ReportRun, r1)
    stale.started_at = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES + 1)
    await db.commit()
    assert await requeue_stale(db) == 1
    await db.refresh(stale)
    assert stale.status == "queued" and stale.started_at is None
    fresh = await db.get(ReportRun, r2)
    assert fresh.status == "running"                    # not stale — untouched


async def test_run_once_completes_uploads_attaches_and_notifies(db, monkeypatch):
    monkeypatch.setattr(worker, "get_module", lambda t: FakeModule())
    run_id, person_id, ini_id = await _run(db, notify=True)
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    assert run.status == "completed" and run.finished_at is not None
    assert run.storage_key == f"reports/{ini_id}/{run_id}.pdf"
    assert run.filename.startswith("Move Report - NAP11") and run.size_bytes == len(b"%PDF-1.4 fake")
    assert await get_object(run.storage_key) == b"%PDF-1.4 fake"
    att = await db.get(Attachment, run.attachment_id)
    assert (att.entity_type, str(att.entity_id), att.kind, att.content_type,
            att.uploaded_by, att.filename) == (
        "initiative", str(ini_id), "document", "application/pdf", person_id, run.filename)
    log = await db.scalar(select(AuditLog).where(AuditLog.entity_type == "initiative",
                                                 AuditLog.action == "attachment.add"))
    assert log is not None, "the worker's attachment is audited like a manual upload"
    assert (log.actor_person_id, log.entity_id) == (person_id, str(ini_id))
    assert log.changes == {"filename": {"from": None, "to": run.filename}}
    n = await db.scalar(select(Notification).where(Notification.person_id == person_id))
    assert n.kind == "report_ready" and n.title == "Move Report is ready" and n.body == "NAP11"
    assert n.link == f"/reports?tab=history&run={run_id}" and n.payload == {"run_id": str(run_id)}


async def test_run_once_without_notify_writes_no_inbox_row(db, monkeypatch):
    monkeypatch.setattr(worker, "get_module", lambda t: FakeModule())
    await _run(db, notify=False)
    await worker.run_once(get_sessionmaker())
    assert await db.scalar(select(Notification)) is None


async def test_build_failure_marks_failed_and_notifies(db, monkeypatch):
    from serversherpa.reports.rack_renderer import RackRendererUnavailable
    monkeypatch.setattr(worker, "get_module",
                        lambda t: FakeModule(fail=RackRendererUnavailable("renderer script not found: x")))
    run_id, person_id, _ = await _run(db, notify=True)
    await worker.run_once(get_sessionmaker())
    run = await db.get(ReportRun, run_id)
    assert run.status == "failed" and run.attachment_id is None
    assert run.error.startswith("rack renderer unavailable: renderer script not found")
    n = await db.scalar(select(Notification).where(Notification.person_id == person_id))
    assert n.kind == "report_failed" and n.body == run.error


async def test_initiative_unavailable_and_timeout(db, monkeypatch):
    from serversherpa.reports.move_report.gather import InitiativeUnavailable
    monkeypatch.setattr(worker, "get_module", lambda t: FakeModule(fail=InitiativeUnavailable("x")))
    run_id, *_ = await _run(db)
    await worker.run_once(get_sessionmaker())
    assert (await db.get(ReportRun, run_id)).error == "initiative_unavailable"
    monkeypatch.setattr(worker, "get_module", lambda t: FakeModule(slow=1.0))
    monkeypatch.setattr(worker, "RUN_TIMEOUT_SECONDS", 0.1)
    run_id, *_ = await _run(db)
    await worker.run_once(get_sessionmaker())
    run = await db.get(ReportRun, run_id)
    assert run.status == "failed" and "timed out" in run.error
    # the cancelled build must not leave the run half-finished or still claimed
    assert run.finished_at is not None
    assert await worker.run_once(get_sessionmaker()) is False    # queue empty


async def test_notify_failure_does_not_flip_a_completed_run(db, monkeypatch, caplog):
    """An inbox write is best-effort: it happens in its own session after the
    terminal state is committed, so it can never undo a finished report."""
    monkeypatch.setattr(worker, "get_module", lambda t: FakeModule())

    async def boom(*args, **kwargs):
        raise RuntimeError("inbox down")

    monkeypatch.setattr(worker, "notify", boom)
    run_id, person_id, ini_id = await _run(db, notify=True)
    with caplog.at_level(logging.WARNING, logger="serversherpa.reports.worker"):
        assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    assert run.status == "completed" and run.error is None
    assert run.storage_key == f"reports/{ini_id}/{run_id}.pdf"
    assert run.attachment_id is not None
    assert await db.get(Attachment, run.attachment_id) is not None
    assert await db.scalar(select(Notification)) is None
    warnings = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert any(str(run_id) in m for m in warnings), warnings


async def test_db_error_during_build_reports_the_real_error(db, monkeypatch):
    """A build that poisons its own transaction must still report ITS error —
    not the PendingRollbackError of a session reused after the fact."""
    monkeypatch.setattr(worker, "get_module", lambda t: DbErrorModule())
    run_id, person_id, _ = await _run(db, notify=True)
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    assert run.status == "failed" and run.attachment_id is None
    assert run.error.startswith("ProgrammingError:"), run.error
    assert "rolled back" not in run.error
    n = await db.scalar(select(Notification).where(Notification.person_id == person_id))
    assert n is not None and n.kind == "report_failed" and n.body == run.error


XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class StubXlsxModule:
    """A minimal non-PDF report module — stands in for
    reports/site_move_survey (built in a later task) so the worker's
    non-PDF path can be exercised without it."""
    report_type = "stub_site_move_survey"

    def default_options(self):
        return {}

    def validate_options(self, o):
        return o

    async def build(self, db, run, *, renderer=None):
        return ReportResult(content=b"PK\x03\x04 fake xlsx bytes",
                            filename="Site & Move Survey - Acme - 2026-09-11 1200.xlsx",
                            content_type=XLSX_CONTENT_TYPE)


async def test_worker_stores_a_non_pdf_result_with_its_content_type(db, monkeypatch):
    """The registry, not the worker, decides content type and extension —
    monkeypatching registry() (rather than worker.get_module directly)
    proves the worker really goes through the module lookup the report
    framework exposes, the same path a real site_move_survey module
    would register through."""
    from serversherpa.reports import registry as registry_module

    stub = StubXlsxModule()
    monkeypatch.setattr(registry_module, "registry", lambda: {stub.report_type: stub})

    run_id, person_id, ini_id = await _run(
        db, notify=False, report_type=stub.report_type, definition_name="Stub Survey",
        options={})
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    assert run.status == "completed" and run.finished_at is not None
    assert run.storage_key == f"reports/{ini_id}/{run_id}.xlsx"
    assert run.filename == "Site & Move Survey - Acme - 2026-09-11 1200.xlsx"
    assert run.size_bytes == len(b"PK\x03\x04 fake xlsx bytes")
    assert await get_object(run.storage_key) == b"PK\x03\x04 fake xlsx bytes"
    att = await db.get(Attachment, run.attachment_id)
    assert att.content_type == XLSX_CONTENT_TYPE
    assert att.filename == run.filename


async def test_worker_run_with_no_initiative_stores_but_attaches_nothing(db, monkeypatch):
    """A Site & Move Survey run for a partner + manually chosen sites has no
    initiative to attach to — the worker must still store the file and
    complete the run, just skip the Attachment/audit row."""
    from serversherpa.reports import registry as registry_module

    stub = StubXlsxModule()
    monkeypatch.setattr(registry_module, "registry", lambda: {stub.report_type: stub})

    run_id, person_id, ini_id = await _run(
        db, notify=True, report_type=stub.report_type, definition_name="Stub Survey",
        options={}, with_initiative=False)
    assert ini_id is None
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    assert run.status == "completed" and run.attachment_id is None
    assert run.storage_key == f"reports/standalone/{run_id}.xlsx"
    assert await get_object(run.storage_key) == b"PK\x03\x04 fake xlsx bytes"
    assert await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "initiative", AuditLog.action == "attachment.add")) is None
    # the requester still gets their inbox notification even with no initiative
    n = await db.scalar(select(Notification).where(Notification.person_id == person_id))
    assert n is not None and n.kind == "report_ready" and n.body == "—"


async def test_run_forever_sweeps_stale_runs_periodically(db, monkeypatch):
    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    monkeypatch.setattr(worker, "STALE_SWEEP_SECONDS", 0.05)

    async def no_claim(session):
        return None

    monkeypatch.setattr(worker, "claim_next", no_claim)
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.1)
        # queued AFTER the startup sweep — only a periodic sweep can catch it
        run_id, *_ = await _run(db, status="running",
                                started_at=datetime.now(UTC)
                                - timedelta(minutes=STALE_MINUTES + 1))
        for _ in range(60):
            await asyncio.sleep(0.05)
            row = await db.scalar(
                select(ReportRun).where(ReportRun.id == run_id)
                .execution_options(populate_existing=True))
            if row.status == "queued":
                break
        assert row.status == "queued" and row.started_at is None
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_run_forever_idles_while_paused_then_resumes(db, monkeypatch):
    from serversherpa.system import registry

    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    monkeypatch.setattr(registry, "start_heartbeat",                 # 5 s is too slow here
                        lambda name, kind, meta_fn=None: asyncio.create_task(
                            registry.heartbeat_loop(name, kind, interval=0.05,
                                                    meta_fn=meta_fn)))
    paused = {"on": True}

    async def fake_paused(sessionmaker):
        return paused["on"]

    monkeypatch.setattr("serversherpa.system.admin_config.workers_paused", fake_paused)
    calls = {"n": 0}

    async def counting_claim(session):
        calls["n"] += 1
        return None

    monkeypatch.setattr(worker, "claim_next", counting_claim)
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05))
    try:
        row = None
        for _ in range(60):
            await asyncio.sleep(0.05)
            row = await db.scalar(
                select(SystemProcess).where(SystemProcess.name == "report-worker")
                .execution_options(populate_existing=True))
            if row is not None and row.meta == {"paused": True}:
                break
        assert row is not None and row.meta == {"paused": True}
        assert calls["n"] == 0                          # nothing claimed while paused
        paused["on"] = False
        for _ in range(60):
            await asyncio.sleep(0.05)
            if calls["n"]:
                break
        assert calls["n"] > 0                           # claims resume
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_run_forever_heartbeats_idles_when_paused_and_survives_claim_blip(db, monkeypatch, caplog):
    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    calls = {"n": 0}

    async def flaky_claim(session):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("db blip")
        return None

    monkeypatch.setattr(worker, "claim_next", flaky_claim)
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05))
    try:
        for _ in range(80):
            await asyncio.sleep(0.05)
            row = await db.scalar(select(SystemProcess).where(SystemProcess.name == "report-worker"))
            if row is not None and calls["n"] >= 3:
                break
        assert row is not None and row.kind == "worker"
        assert not task.done()                          # the blip did not kill the loop
        assert calls["n"] >= 3
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
