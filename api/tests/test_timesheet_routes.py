"""Timesheet report routes and worker wiring: runs without a job, the
time:view gate, the preview endpoint, history hiding, worker error code and
inbox body."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Attachment, Initiative, Notification, PermissionOverride, Person, ReportDefinition,
    ReportRun, TimeEntry,
)
from serversherpa.reports import worker
from serversherpa.reports.timesheet import gather as ts_gather

from tests.test_sites_api import login

RANGE = {"from": "2026-10-01", "to": "2026-10-31"}
BASE = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)


async def _definition(db):
    d = ReportDefinition(
        name="Timesheet", description="d", report_type="timesheet", is_system=True,
        options={"default_format": "xlsx", "default_views": ["day", "punch"],
                 "default_statuses": ["approved", "pending"]})
    db.add(d)
    await db.commit()
    return d


async def _person(db, first="Pat", last="Punch"):
    p = Person(first_name=first, last_name=last)
    db.add(p)
    await db.flush()
    return p


async def _initiative(db, name="Job A"):
    ini = Initiative(name=name, initiative_type="project", status="planned")
    db.add(ini)
    await db.flush()
    return ini


def _entry(person, start, hours=8, **kw):
    kw.setdefault("status", "approved")
    return TimeEntry(person_id=person.id, clock_in_at=start,
                     clock_out_at=start + timedelta(hours=hours), **kw)


async def _deny_time_view(db, person_id):
    db.add(PermissionOverride(person_id=person_id, resource="time", action="view",
                              allow=False))
    await db.commit()


def _body(d, *, initiative_id=None, options=None):
    return {"definition_id": str(d.id), "initiative_id": initiative_id,
            "options": options if options is not None else RANGE, "notify": False}


# ── create_run ─────────────────────────────────────────────────────

async def test_timesheet_run_is_accepted_without_an_initiative(client, db, seeded_user):
    d = await _definition(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs, json=_body(d))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["report_type"] == "timesheet" and body["status"] == "queued"
    assert body["initiative_id"] is None and body["initiative_name"] == "—"
    assert body["options"] == RANGE


async def test_timesheet_run_with_a_job_uses_the_initiative_scope_check(
        client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    ini.archived_at = datetime.now(UTC)
    await db.commit()
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=_body(d, initiative_id=str(ini.id)))
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "initiative_not_found"
    live = await _initiative(db, "Live job")
    await db.commit()
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=_body(d, initiative_id=str(live.id)))
    assert resp.status_code == 201 and resp.json()["initiative_name"] == "Live job"


async def test_timesheet_run_rejects_bad_options(client, db, seeded_user):
    d = await _definition(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=_body(d, options={"from": "2026-10-05", "to": "2026-10-01"}))
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_options"


async def test_other_report_types_still_need_an_initiative(client, db, seeded_user):
    d = ReportDefinition(name="Move Report", description="d", report_type="move_report",
                         options={}, is_system=True)
    db.add(d)
    await db.commit()
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs, json=_body(d, options={}))
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "initiative_required"


async def test_timesheet_run_needs_time_view(client, db, seeded_user):
    d = await _definition(db)
    await _deny_time_view(db, seeded_user.id)
    hdrs = await login(client)
    # 403 comes before option validation
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=_body(d, options={"bogus": 1}))
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "time_view_required"
    assert (await db.scalar(select(ReportRun.id))) is None


# ── preview ────────────────────────────────────────────────────────

async def test_preview_numbers_on_seeded_data(client, db, seeded_user):
    p1 = await _person(db, "Ann", "Alpha")
    p2 = await _person(db, "Bob", "Beta")
    ini = await _initiative(db)
    db.add_all([
        _entry(p1, BASE, hours=4, initiative_id=ini.id),                       # 240 approved
        _entry(p1, BASE + timedelta(days=1), hours=11, status="pending"),     # 660 pending, Over 10 h
        _entry(p2, BASE, hours=2, status="approved"),                          # 120 approved
        _entry(p2, BASE + timedelta(days=2), hours=3, status="rejected"),      # excluded by status
    ])
    await db.commit()
    hdrs = await login(client)
    resp = await client.get("/reports/timesheet/preview",
                            params={"from": "2026-10-01", "to": "2026-10-31"}, headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"entries": 3, "people": 2, "days": 2, "approved_minutes": 360,
                           "pending_minutes": 660, "flagged_entries": 1, "too_many": False}
    # filters + explicit statuses
    resp = await client.get("/reports/timesheet/preview", headers=hdrs, params={
        "from": "2026-10-01", "to": "2026-10-31", "person_id": str(p2.id),
        "statuses": "approved,rejected"})
    assert resp.json()["entries"] == 2 and resp.json()["approved_minutes"] == 120
    resp = await client.get("/reports/timesheet/preview", headers=hdrs, params={
        "from": "2026-10-01", "to": "2026-10-31", "initiative_id": str(ini.id)})
    assert resp.json()["entries"] == 1 and resp.json()["approved_minutes"] == 240


async def test_preview_too_many_is_a_flag_not_an_error(client, db, seeded_user, monkeypatch):
    p = await _person(db)
    db.add_all([_entry(p, BASE + timedelta(days=i), hours=1) for i in range(3)])
    await db.commit()
    monkeypatch.setattr(ts_gather, "MAX_ENTRIES", 2)
    hdrs = await login(client)
    resp = await client.get("/reports/timesheet/preview", headers=hdrs, params=RANGE)
    assert resp.status_code == 200, resp.text
    assert resp.json()["too_many"] is True
    assert resp.json()["entries"] == 0


async def test_preview_validates_like_the_run(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/reports/timesheet/preview", headers=hdrs,
                            params={"from": "2026-10-05", "to": "2026-10-01"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_options"
    assert resp.json()["detail"]["problems"]
    resp = await client.get("/reports/timesheet/preview", headers=hdrs, params={
        "from": "2026-10-01", "to": "2026-10-31", "statuses": "approved,bogus",
        "person_id": "nope"})
    assert resp.status_code == 422 and len(resp.json()["detail"]["problems"]) == 2


async def test_preview_scope_checks_the_initiative(client, db, seeded_user):
    ini = await _initiative(db)
    ini.archived_at = datetime.now(UTC)
    await db.commit()
    hdrs = await login(client)
    resp = await client.get("/reports/timesheet/preview", headers=hdrs,
                            params={**RANGE, "initiative_id": str(ini.id)})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "initiative_not_found"


async def test_preview_needs_time_view_and_reports_view(client, db, seeded_user):
    await _deny_time_view(db, seeded_user.id)
    hdrs = await login(client)
    resp = await client.get("/reports/timesheet/preview", headers=hdrs, params=RANGE)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "time_view_required"
    from tests.test_status_values_write import _make
    worker_hdrs = await _make(db, client, "worker", "w@test.example.com")
    resp = await client.get("/reports/timesheet/preview", headers=worker_hdrs, params=RANGE)
    assert resp.status_code == 403


# ── history hiding ─────────────────────────────────────────────────

async def test_history_hides_timesheet_runs_without_time_view(client, db, seeded_user):
    d = await _definition(db)
    hdrs = await login(client)
    run = (await client.post("/reports/runs", headers=hdrs, json=_body(d))).json()
    row = await db.get(ReportRun, run["id"])
    row.status = "completed"
    row.storage_key = f"reports/standalone/{row.id}.xlsx"
    row.filename = "Timesheet - 2026-10-01 to 2026-10-31 - 2026-10-06 1200.xlsx"
    await db.commit()

    assert [r["id"] for r in (await client.get("/reports/runs", headers=hdrs)).json()] == [run["id"]]
    assert (await client.get(f"/reports/runs/{run['id']}", headers=hdrs)).status_code == 200
    assert (await client.get(f"/reports/runs/{run['id']}/download", headers=hdrs)).status_code == 200

    await _deny_time_view(db, seeded_user.id)
    hdrs = await login(client)                      # a reports-only user now
    assert (await client.get("/reports/runs", headers=hdrs)).json() == []
    resp = await client.get(f"/reports/runs/{run['id']}", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "run_not_found"
    resp = await client.get(f"/reports/runs/{run['id']}/download", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "run_not_found"


# ── worker ─────────────────────────────────────────────────────────

async def _queued_run(db, d, requester, *, initiative_id=None, options=None, notify=True):
    run = ReportRun(definition_id=d.id, report_type="timesheet", initiative_id=initiative_id,
                    options=options if options is not None else RANGE,
                    requested_by=requester.id, requested_rank=40, notify=notify,
                    status="queued")
    db.add(run)
    await db.commit()
    return run.id


async def test_worker_builds_a_job_timesheet_and_attaches_it_to_the_job(db):
    d = await _definition(db)
    person = await _person(db, "Rae", "Requester")
    ini = await _initiative(db)
    db.add(_entry(person, BASE, hours=4, initiative_id=ini.id))
    await db.commit()
    run_id = await _queued_run(db, d, person, initiative_id=ini.id,
                               options={**RANGE, "format": "xlsx"})
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    await db.refresh(run)
    assert run.status == "completed", run.error
    assert run.attachment_id is not None
    att = await db.get(Attachment, run.attachment_id)
    assert att.entity_type == "initiative" and att.entity_id == ini.id
    assert att.filename.startswith("Timesheet - 2026-10-01 to 2026-10-31 - Job A")


async def test_worker_runs_a_timesheet_with_no_job_and_attaches_nothing(db):
    d = await _definition(db)
    person = await _person(db, "Rae", "Requester")
    db.add(_entry(person, BASE, hours=4))
    await db.commit()
    run_id = await _queued_run(db, d, person)
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    await db.refresh(run)
    assert run.status == "completed", run.error
    assert run.attachment_id is None
    assert run.storage_key == f"reports/standalone/{run_id}.xlsx"


async def test_worker_maps_too_many_entries_to_its_error_code(db, monkeypatch):
    d = await _definition(db)
    person = await _person(db, "Rae", "Requester")
    db.add_all([_entry(person, BASE + timedelta(days=i), hours=1) for i in range(3)])
    await db.commit()
    monkeypatch.setattr(ts_gather, "MAX_ENTRIES", 2)
    run_id = await _queued_run(db, d, person)
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    await db.refresh(run)
    assert run.status == "failed" and run.error == "too_many_entries"
    n = await db.scalar(select(Notification).where(Notification.person_id == person.id))
    assert n.kind == "report_failed" and n.body == "too_many_entries"


async def test_worker_inbox_body_is_the_range_plus_person_and_job(db):
    d = await _definition(db)
    rae = await _person(db, "Rae", "Requester")
    pat = await _person(db, "Pat", "Punch")
    ini = await _initiative(db, "Alpha job")
    db.add(_entry(pat, BASE, hours=4, initiative_id=ini.id))
    await db.commit()

    async def body_for(**kw):
        run_id = await _queued_run(db, d, rae, **kw)
        assert await worker.run_once(get_sessionmaker()) is True
        rows = (await db.scalars(select(Notification).where(
            Notification.person_id == rae.id, Notification.payload["run_id"].astext == str(run_id)
        ))).all()
        assert len(rows) == 1 and rows[0].title == "Timesheet is ready"
        return rows[0].body

    assert await body_for() == "2026-10-01 to 2026-10-31"
    assert await body_for(options={**RANGE, "person_id": str(pat.id)}) == \
        f"2026-10-01 to 2026-10-31 · {pat.display_name}"
    assert await body_for(initiative_id=ini.id) == "2026-10-01 to 2026-10-31 · Alpha job"
    assert await body_for(initiative_id=ini.id, options={**RANGE, "person_id": str(pat.id)}) == \
        f"2026-10-01 to 2026-10-31 · {pat.display_name} · Alpha job"
