"""report-worker: claim → build → upload → attach → notify, plus every
failure path, stale re-queue, pause, and the loop surviving DB blips.
The module's build is faked so no Node/WeasyPrint is needed here."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Attachment, Initiative, Notification, Person, ReportDefinition, ReportRun, SystemProcess,
)
from serversherpa.reports import worker
from serversherpa.reports.jobs import STALE_MINUTES, claim_next, requeue_stale
from serversherpa.reports.registry import ReportResult
from serversherpa.services.storage import get_object

ALL_ON = {"summary": True, "assets_by_source": True, "assets_by_destination": True,
          "size_weight": True, "rail_usage": True, "collisions": True,
          "source_racks": True, "destination_racks": True}


async def _run(db, *, notify=False, status="queued", started_at=None):
    # ReportDefinition.name has a live-unique index (report_definitions_name_live_idx)
    # — reuse the row across calls within a test instead of inserting a duplicate.
    person = Person(first_name="Rae", last_name="Requester")
    d = await db.scalar(select(ReportDefinition).where(ReportDefinition.name == "Move Report"))
    if d is None:
        d = ReportDefinition(name="Move Report", report_type="move_report", options=ALL_ON,
                             is_system=True)
        db.add(d)
    ini = Initiative(name="NAP11", initiative_type="move", status="planned")
    db.add_all([person, ini])
    await db.flush()
    run = ReportRun(definition_id=d.id, report_type="move_report", initiative_id=ini.id,
                    options=ALL_ON, requested_by=person.id, requested_rank=40, notify=notify,
                    status=status, started_at=started_at)
    db.add(run)
    await db.commit()
    return run.id, person.id, ini.id


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
        return ReportResult(pdf=b"%PDF-1.4 fake", filename="Move Report - NAP11 - 2026-09-09 1200.pdf")


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
