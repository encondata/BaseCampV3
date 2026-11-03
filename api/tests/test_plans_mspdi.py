"""MS Project XML (MSPDI): GET /plans/{id}/export.xml, and the imports
POST /plans/{id}/import and POST /initiatives/{id}/plan/import
(plans/mspdi.py, plans/importer.py). Every import is a dry run, a per-row
summary, then an apply; a dry run writes nothing.

The sample file (fixtures/plans/sample_mspdi.xml) is hand-written to the
schema: two summaries over six tasks on the Standard calendar from Mon
2026-11-02 08:00, its Start / Finish what the engine computes. Its "Label
racks" is As Late As Possible and assigned a resource the plan doesn't
have; "Site survey" is assigned Pat Lee, who is on the team."""

import re
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from defusedxml import ElementTree as ET
from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, InitiativePerson, Person
from serversherpa.plans import importer, mspdi
from serversherpa.plans.models import PlanTask, ProjectPlan
from tests.test_plans_api import _admin, _create, _initiative
from tests.test_plans_links import _assign, _resources
from tests.test_plans_ops import _add, _get, _ok, _update
from tests.test_sites_api import login

SAMPLE = Path(__file__).parent / "fixtures" / "plans" / "sample_mspdi.xml"
NS = "{http://schemas.microsoft.com/project}"
SAMPLE_NAMES = ["Phase 1 - Prep", "Site survey", "Pack equipment", "Label racks",
                "Phase 2 - Move", "Truck loading", "Rack install", "Go live"]

# ── helpers ──────────────────────────────────────────────────────────


def _sample() -> bytes:
    return SAMPLE.read_bytes()


def _edit(content: bytes, old: str, new: str) -> bytes:
    text = content.decode()
    assert old in text, old
    return text.replace(old, new, 1).encode()


async def _pat(db, move) -> Person:
    """Pat Lee, on the initiative's team."""
    pat = Person(first_name="Pat", last_name="Lee")
    db.add(pat)
    await db.flush()
    db.add(InitiativePerson(initiative_id=move.id, person_id=pat.id))
    await db.commit()
    return pat


async def _setup(client, db):
    """An empty plan on an initiative whose team has Pat Lee."""
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    pat = await _pat(db, move)
    plan = await _create(client, hdrs, move)
    return hdrs, move, plan, pat


async def _post(client, hdrs, url, content, *, filename="plan.xml", **params):
    params = {k: ("1" if v is True else "0" if v is False else v) for k, v in params.items()}
    return await client.post(url, headers=hdrs, params=params,
                             files={"file": (filename, content, "application/xml")})


async def _import(client, hdrs, plan, content, **params):
    return await _post(client, hdrs, f"/plans/{plan['id']}/import", content, **params)


async def _ok_import(client, hdrs, plan, content, **params) -> dict:
    resp = await _import(client, hdrs, plan, content, **params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _rows(body) -> dict[str, dict]:
    return {row["name"]: row for row in body["rows"]}


def _tasks(body) -> dict[str, dict]:
    return {t["name"]: t for t in body["tasks"]}


async def _task_count(db, plan_id) -> int:
    return await db.scalar(select(func.count()).select_from(PlanTask)
                           .where(PlanTask.plan_id == plan_id))


async def _imports_audited(db) -> list[AuditLog]:
    return (await db.scalars(select(AuditLog).where(AuditLog.action == "plan_import"))).all()


def _bad_file(resp, status=422, code="bad_file") -> dict:
    assert resp.status_code == status, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == code, detail
    return detail


# ── preview, then apply ──────────────────────────────────────────────


async def test_preview_lists_rows_and_problems_and_writes_nothing(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    body = await _ok_import(client, hdrs, plan, _sample(), dry_run=True, mode="fill")

    assert [row["name"] for row in body["rows"]] == SAMPLE_NAMES
    assert [row["index"] for row in body["rows"]] == list(range(1, 9))
    assert {row["action"] for row in body["rows"]} == {"create"}
    rows = _rows(body)
    label = rows["Label racks"]["problems"]
    assert len(label) == 2, label
    assert any("As Late As Possible" in p for p in label), label
    assert any("Dana Unknown" in p for p in label), label
    for name in SAMPLE_NAMES:
        if name != "Label racks":
            assert rows[name]["problems"] == [], (name, rows[name])
        assert rows[name]["moved_days"] is None, (name, rows[name])
    assert body["problems"] == []
    assert body["summary"] == {"created": 8, "problems": 2}

    # nothing written: no tasks, the version and the calendar as they were
    after = await _get(client, hdrs, plan)
    assert after["tasks"] == [] and after["links"] == []
    assert after["version"] == plan["version"]
    assert after["calendar"] == plan["calendar"]
    assert await _task_count(db, plan["id"]) == 0
    assert await _imports_audited(db) == []


async def test_apply_builds_the_outline_links_and_lags(client, db):
    hdrs, _move, plan, pat = await _setup(client, db)
    body = await _ok_import(client, hdrs, plan, _sample(), dry_run=False, mode="fill")
    assert body["summary"] == {"created": 8, "problems": 2}

    got = await _get(client, hdrs, plan)
    assert [t["name"] for t in got["tasks"]] == SAMPLE_NAMES
    assert [t["wbs"] for t in got["tasks"]] == ["1", "1.1", "1.2", "1.3", "2", "2.1", "2.2",
                                                "2.3"]
    tasks = _tasks(got)
    assert tasks["Phase 1 - Prep"]["is_summary"] and tasks["Phase 2 - Move"]["is_summary"]
    assert tasks["Site survey"]["parent_id"] == tasks["Phase 1 - Prep"]["id"]
    assert tasks["Go live"]["parent_id"] == tasks["Phase 2 - Move"]["id"]

    # links: SS +2 days, FF, then FS
    assert tasks["Pack equipment"]["predecessors"] == "2SS+2 days"
    assert tasks["Label racks"]["predecessors"] == "3FF"
    assert tasks["Truck loading"]["predecessors"] == "4"
    assert tasks["Go live"]["predecessors"] == "7"
    by_pair = {(lk["predecessor_id"], lk["successor_id"]): lk for lk in got["links"]}
    survey_pack = by_pair[(tasks["Site survey"]["id"], tasks["Pack equipment"]["id"])]
    assert (survey_pack["link_type"], survey_pack["lag_minutes"], survey_pack["lag_unit"],
            survey_pack["lag_elapsed"]) == ("SS", 960, "d", False)
    assert len(got["links"]) == 5

    # durations, constraints, the deadline, the milestone, notes
    assert tasks["Site survey"]["duration_text"] == "2 days"
    assert tasks["Pack equipment"]["duration_text"] == "3 days"
    assert tasks["Pack equipment"]["deadline"] == "2026-11-06T17:00"
    assert tasks["Label racks"]["constraint_type"] == "asap"         # ALAP made ASAP
    assert tasks["Truck loading"]["constraint_type"] == "snet"
    assert tasks["Truck loading"]["constraint_date"] == "2026-11-10T08:00"
    assert tasks["Go live"]["is_milestone"] is True
    assert tasks["Go live"]["duration_minutes"] == 0
    assert tasks["Go live"]["show_on_timeline"] is True
    assert tasks["Site survey"]["notes"] == "Walk both halls & count racks."

    # scheduled as the file has it
    assert (tasks["Site survey"]["start"], tasks["Site survey"]["finish"]) == (
        "2026-11-02T08:00", "2026-11-03T17:00")
    assert (tasks["Label racks"]["start"], tasks["Label racks"]["finish"]) == (
        "2026-11-06T08:00", "2026-11-06T17:00")
    assert tasks["Truck loading"]["start"] == "2026-11-10T08:00"
    assert tasks["Go live"]["finish"] == "2026-11-12T17:00"

    # Pat Lee matched by name; the unknown resource never created
    assert tasks["Site survey"]["assignees"] == [
        {"kind": "person", "id": str(pat.id), "name": "Pat Lee"}]
    assert tasks["Label racks"]["assignees"] == []
    assert await db.scalar(select(func.count()).select_from(Person)
                           .where(Person.last_name == "Unknown")) == 0

    # fill: the file's calendar (its holiday) and start
    assert got["project_start"] == "2026-11-02T08:00"
    assert got["calendar"]["exceptions"] == [
        {"date": "2026-11-26", "name": "Thanksgiving", "hours": []}]

    # one write: the version bumped once, audited with counts
    assert got["version"] == plan["version"] + 1
    (row,) = await _imports_audited(db)
    assert row.entity_id == plan["id"]
    assert row.changes["mode"] == "fill"
    assert (row.changes["tasks"], row.changes["links"], row.changes["assignments"],
            row.changes["problems"]) == (8, 5, 1, 2)


async def test_moved_days(client, db):
    """A task the links move more than a working day from the file's start
    says by how much (working days, the plan's calendar)."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _edit(_sample(), "<Start>2026-11-11T08:00:00</Start>",
                    "<Start>2026-11-02T08:00:00</Start>")
    body = await _ok_import(client, hdrs, plan, content, dry_run=True, mode="fill")
    rows = _rows(body)
    assert rows["Rack install"]["moved_days"] == 7.0
    assert rows["Go live"]["moved_days"] is None


# ── round trip (Review Focus 4) ─────────────────────────────────────

ROUND_TRIP_TASK_FIELDS = (
    "display_id", "wbs", "outline_level", "position", "is_summary", "name", "is_milestone",
    "mode", "duration_minutes", "duration_unit", "elapsed", "duration_text", "start",
    "finish", "constraint_type", "constraint_date", "deadline", "percent_complete",
    "actual_start", "actual_finish", "notes", "show_on_timeline", "color",
    "total_slack_minutes", "is_critical", "conflict", "predecessors", "successors",
    "status", "missed_deadline", "completed_by_name")


async def _rich_plan(client, db):
    """A plan built through ops with every input field an MS Project file
    carries: summaries (one with an SNET), working and elapsed durations in
    hours, days and weeks, a manual task, a milestone and a flagged
    milestone with a duration, FS/SS/FF/SF links with a lag, a lead and an
    elapsed lag, SNET/FNLT/MSO/FNET constraints, a deadline, notes with
    markup characters, progress, a person and a partner, and a calendar
    with a holiday and a short working Saturday."""
    hdrs = await _admin(db, client)
    move = await _initiative(db, name="Source move")
    worker, shipper = await _resources(db, move)
    plan = await _create(client, hdrs, move)
    calendar = {**plan["calendar"], "exceptions": [
        {"date": "2026-11-14", "name": "Saturday move", "hours": [["09:00", "13:00"]]},
        {"date": "2026-11-26", "name": "Thanksgiving", "hours": []}]}
    resp = await client.patch(f"/plans/{plan['id']}", headers=hdrs,
                              json={"base_version": plan["version"], "calendar": calendar,
                                    "status_date": "2026-11-11T17:00"})
    assert resp.status_code == 200, resp.text

    ids = await _add(client, hdrs, plan, "Phase 1")
    ids.update(await _add(client, hdrs, plan, "Survey", duration="2d"))
    ids.update(await _add(client, hdrs, plan, "Pack <crates> & tape", duration="3d"))
    ids.update(await _add(client, hdrs, plan, "Freight", duration="3ed"))
    ids.update(await _add(client, hdrs, plan, "Walkthrough", mode="manual",
                          start="2026-11-04T10:00", finish="2026-11-04T15:00"))
    ids.update(await _add(client, hdrs, plan, "Phase 2"))
    ids.update(await _add(client, hdrs, plan, "Call", duration="4h"))
    ids.update(await _add(client, hdrs, plan, "Build", duration="1w"))
    ids.update(await _add(client, hdrs, plan, "Go live", duration="0"))
    ids.update(await _add(client, hdrs, plan, "Signoff", duration="1d", is_milestone=True))
    ids.update(await _add(client, hdrs, plan, "Wrap up", duration="2d"))
    pack = ids["Pack <crates> & tape"]
    await _ok(client, hdrs, plan, [
        {"op": "indent", "ids": [ids["Survey"], pack, ids["Freight"], ids["Walkthrough"]]},
        {"op": "indent", "ids": [ids["Call"], ids["Build"], ids["Go live"], ids["Signoff"]]},
    ])
    await _ok(client, hdrs, plan, [
        _update(ids["Phase 1"], constraint_type="snet", constraint_date="2026-11-03T08:00"),
        _update(pack, predecessors="2SS-4h", deadline="2026-11-06T17:00",
                notes='Bring <carts> & "tape"\nSecond line ✓'),
        _update(ids["Freight"], predecessors="3FS+2d"),
        _update(ids["Call"], predecessors="4FF+1ed", constraint_type="fnlt",
                constraint_date="2026-11-20T17:00"),
        _update(ids["Build"], predecessors="7SF", constraint_type="mso",
                constraint_date="2026-11-16T08:00"),
        _update(ids["Go live"], predecessors="8"),
        _update(ids["Wrap up"], constraint_type="fnet", constraint_date="2026-12-04T17:00"),
        _assign(ids["Survey"], ("person", worker.id), ("partner", shipper.id)),
        _assign(ids["Phase 2"], ("person", worker.id)),
        {"op": "set_percent", "ids": [ids["Survey"]], "percent": 50},
        {"op": "set_percent", "ids": [ids["Signoff"]], "percent": 100},
    ])
    return hdrs, move, plan, worker, shipper


def _comparable_tasks(body) -> list[dict]:
    rows = []
    position = {t["id"]: t["display_id"] for t in body["tasks"]}
    for task in body["tasks"]:
        row = {key: task[key] for key in ROUND_TRIP_TASK_FIELDS}
        row["parent"] = position.get(task["parent_id"])
        row["assignees"] = [(a["kind"], a["name"]) for a in task["assignees"]]
        row["completed"] = task["completed_at"] is not None
        rows.append(row)
    return rows


def _comparable_links(body) -> list[tuple]:
    display = {t["id"]: t["display_id"] for t in body["tasks"]}
    return sorted((display[lk["predecessor_id"]], display[lk["successor_id"]], lk["link_type"],
                   lk["lag_minutes"], lk["lag_unit"], lk["lag_elapsed"], lk["lag_text"])
                  for lk in body["links"])


async def test_round_trip(client, db):
    """Export a plan built through ops, import the file into a new
    initiative (with the same people and partner), and every input field,
    link and assignee comes back as it was."""
    hdrs, _move, plan, worker, shipper = await _rich_plan(client, db)
    source = await _get(client, hdrs, plan)
    resp = await client.get(f"/plans/{plan['id']}/export.xml", headers=hdrs)
    assert resp.status_code == 200, resp.text
    content = resp.content

    other = await _initiative(db, name="Next move")
    db.add(InitiativePerson(initiative_id=other.id, person_id=worker.id))
    other.shipping_partner_id = shipper.id
    await db.commit()
    resp = await _post(client, hdrs, f"/initiatives/{other.id}/plan/import", content,
                       dry_run=False)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["problems"] == [] and body["summary"]["problems"] == 0, body
    assert all(row["moved_days"] is None for row in body["rows"]), body["rows"]

    got = (await client.get(f"/initiatives/{other.id}/plan", headers=hdrs)).json()
    assert got["project_start"] == source["project_start"]
    assert got["status_date"] == source["status_date"] == "2026-11-11T17:00"
    assert got["calendar"] == source["calendar"]
    assert _comparable_tasks(got) == _comparable_tasks(source)
    assert _comparable_links(got) == _comparable_links(source)
    assert len(got["links"]) == len(source["links"]) == 5


# ── export ──────────────────────────────────────────────────────────


async def test_export_xml(client, db):
    hdrs, move, plan, _pat_row = await _setup(client, db)
    await _ok_import(client, hdrs, plan, _sample(), dry_run=False, mode="fill")
    move.code = "NAP11"
    await db.commit()

    resp = await client.get(f"/plans/{plan['id']}/export.xml", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/xml")
    disposition = resp.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="NAP11 - Project plan.xml"'), disposition

    root = ET.fromstring(resp.content)
    assert root.tag == f"{NS}Project"
    assert root.findtext(f"{NS}Name") == "Move"
    assert root.findtext(f"{NS}StartDate") == "2026-11-02T08:00:00"
    assert root.findtext(f"{NS}MinutesPerDay") == "480"
    assert root.findtext(f"{NS}MinutesPerWeek") == "2400"
    assert root.findtext(f"{NS}DaysPerMonth") == "20"
    assert root.findtext(f"{NS}CalendarUID") == "1"

    (calendar,) = root.iterfind(f"{NS}Calendars/{NS}Calendar")
    assert calendar.findtext(f"{NS}UID") == "1"
    days = {d.findtext(f"{NS}DayType"): d for d in calendar.iterfind(f"{NS}WeekDays/{NS}WeekDay")}
    assert sorted(days) == ["1", "2", "3", "4", "5", "6", "7"]
    assert days["1"].findtext(f"{NS}DayWorking") == "0"
    assert [(t.findtext(f"{NS}FromTime"), t.findtext(f"{NS}ToTime"))
            for t in days["2"].iterfind(f"{NS}WorkingTimes/{NS}WorkingTime")] == [
        ("08:00:00", "12:00:00"), ("13:00:00", "17:00:00")]
    (holiday,) = calendar.iterfind(f"{NS}Exceptions/{NS}Exception")
    assert holiday.findtext(f"{NS}Name") == "Thanksgiving"
    assert holiday.findtext(f"{NS}TimePeriod/{NS}FromDate") == "2026-11-26T00:00:00"
    assert holiday.findtext(f"{NS}DayWorking") == "0"

    tasks = {t.findtext(f"{NS}Name"): t for t in root.iterfind(f"{NS}Tasks/{NS}Task")}
    survey = tasks["Site survey"]
    assert survey.findtext(f"{NS}UID") == "2" and survey.findtext(f"{NS}ID") == "2"
    assert survey.findtext(f"{NS}OutlineLevel") == "2"
    assert survey.findtext(f"{NS}Duration") == "PT16H0M0S"
    assert survey.findtext(f"{NS}DurationFormat") == "7"
    assert survey.findtext(f"{NS}Start") == "2026-11-02T08:00:00"
    assert survey.findtext(f"{NS}Manual") == "0"
    assert tasks["Phase 1 - Prep"].findtext(f"{NS}Summary") == "1"
    assert tasks["Go live"].findtext(f"{NS}Milestone") == "1"
    assert tasks["Truck loading"].findtext(f"{NS}ConstraintType") == "4"
    assert tasks["Truck loading"].findtext(f"{NS}ConstraintDate") == "2026-11-10T08:00:00"
    assert tasks["Pack equipment"].findtext(f"{NS}Deadline") == "2026-11-06T17:00:00"
    (link,) = tasks["Pack equipment"].iterfind(f"{NS}PredecessorLink")
    assert (link.findtext(f"{NS}PredecessorUID"), link.findtext(f"{NS}Type"),
            link.findtext(f"{NS}LinkLag"), link.findtext(f"{NS}LagFormat")) == (
        "2", "3", "9600", "7")
    (link,) = tasks["Label racks"].iterfind(f"{NS}PredecessorLink")
    assert link.findtext(f"{NS}Type") == "0"
    # task color is not exported (MS Project keeps bar styles in the view)
    assert "Color" not in resp.text

    resources = {r.findtext(f"{NS}Name"): r for r in root.iterfind(f"{NS}Resources/{NS}Resource")}
    assert list(resources) == ["Pat Lee"]
    pat_uid = resources["Pat Lee"].findtext(f"{NS}UID")
    (assignment,) = root.iterfind(f"{NS}Assignments/{NS}Assignment")
    assert assignment.findtext(f"{NS}TaskUID") == "2"
    assert assignment.findtext(f"{NS}ResourceUID") == pat_uid


async def test_export_element_order_follows_the_schema(client, db):
    """MS Project reads MSPDI against its schema, whose elements are a
    sequence: the ones written must keep the schema's order."""
    hdrs, _move, plan, _worker, _shipper = await _rich_plan(client, db)
    resp = await client.get(f"/plans/{plan['id']}/export.xml", headers=hdrs)
    root = ET.fromstring(resp.content)

    def order_ok(element, schema: list[str]):
        tags = [child.tag.removeprefix(NS) for child in element]
        assert all(tag in schema for tag in tags), [t for t in tags if t not in schema]
        ranks = [schema.index(tag) for tag in tags]
        assert ranks == sorted(ranks), tags

    order_ok(root, mspdi.PROJECT_ORDER)
    for task in root.iterfind(f"{NS}Tasks/{NS}Task"):
        order_ok(task, mspdi.TASK_ORDER)
        for link in task.iterfind(f"{NS}PredecessorLink"):
            order_ok(link, mspdi.LINK_ORDER)
    for calendar in root.iterfind(f"{NS}Calendars/{NS}Calendar"):
        order_ok(calendar, mspdi.CALENDAR_ORDER)
        for exception in calendar.iterfind(f"{NS}Exceptions/{NS}Exception"):
            order_ok(exception, mspdi.EXCEPTION_ORDER)
    for resource in root.iterfind(f"{NS}Resources/{NS}Resource"):
        order_ok(resource, mspdi.RESOURCE_ORDER)
    for assignment in root.iterfind(f"{NS}Assignments/{NS}Assignment"):
        order_ok(assignment, mspdi.ASSIGNMENT_ORDER)


async def test_export_drops_characters_xml_cannot_hold(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "Bell\x07 task")
    await _ok(client, hdrs, plan, [_update(ids["Bell\x07 task"], notes="a\x01b\x1fc\td")])
    resp = await client.get(f"/plans/{plan['id']}/export.xml", headers=hdrs)
    root = ET.fromstring(resp.content)             # parses: the file is well formed
    summary, task = root.iterfind(f"{NS}Tasks/{NS}Task")
    assert summary.findtext(f"{NS}UID") == "0"            # the project summary task
    assert task.findtext(f"{NS}Name") == "Bell task"
    assert task.findtext(f"{NS}Notes") == "abc\td"


# ── hostile or odd files (Review Focus 3) ────────────────────────────


@pytest.mark.parametrize("content", [
    # an external entity
    (b'<?xml version="1.0"?>\n<!DOCTYPE Project [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n'
     b'<Project xmlns="http://schemas.microsoft.com/project"><Name>&x;</Name></Project>'),
    # entity expansion (billion laughs)
    (b'<?xml version="1.0"?>\n<!DOCTYPE Project [<!ENTITY a "aaaaaaaaaa">'
     b'<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>\n'
     b'<Project xmlns="http://schemas.microsoft.com/project"><Name>&b;</Name></Project>'),
    # any DTD at all
    (b'<?xml version="1.0"?>\n<!DOCTYPE Project>\n'
     b'<Project xmlns="http://schemas.microsoft.com/project"><Name>x</Name></Project>'),
], ids=["external-entity", "entity-expansion", "dtd"])
async def test_xxe_rejected(client, db, content):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    detail = _bad_file(await _import(client, hdrs, plan, content, dry_run=False, mode="fill"))
    assert "DTD" in detail["message"]
    assert "passwd" not in str(detail)
    assert await _task_count(db, plan["id"]) == 0
    other = await _initiative(db, name="Other")
    _bad_file(await _post(client, hdrs, f"/initiatives/{other.id}/plan/import", content,
                          dry_run=False))
    assert await db.scalar(select(ProjectPlan.id).where(
        ProjectPlan.initiative_id == other.id)) is None


@pytest.mark.parametrize("content", [
    b"",
    b"not xml at all",
    b"<Project xmlns='http://schemas.microsoft.com/project'><Tasks>",     # truncated
    b'<?xml version="1.0"?><Workbook><Sheet/></Workbook>',              # XML, not MSPDI
    b"\xff\xfe\x00garbage",
], ids=["empty", "text", "truncated", "other-xml", "binary"])
async def test_not_an_ms_project_file(client, db, content):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    detail = _bad_file(await _import(client, hdrs, plan, content, dry_run=True, mode="fill"))
    assert detail["message"]


async def test_deep_nesting_is_refused(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    depth = 10_000
    content = (b'<Project xmlns="http://schemas.microsoft.com/project"><Tasks><Task>'
               + b"<a>" * depth + b"</a>" * depth + b"</Task></Tasks></Project>")
    _bad_file(await _import(client, hdrs, plan, content, dry_run=True, mode="fill"))


async def test_file_too_large(client, db):
    """Over 20 MB is 413 `file_too_large`: refused by its declared length,
    and a body without one (chunked) is cut off once it passes the cap."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    big = b"<Project>" + b" " * (mspdi.MAX_BYTES + 1) + b"</Project>"
    _bad_file(await _import(client, hdrs, plan, big, dry_run=True), 413, "file_too_large")

    boundary = "pln-boundary"
    sent = {"chunks": 0}

    async def body():
        yield (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
               f'filename="big.xml"\r\nContent-Type: application/xml\r\n\r\n').encode()
        for _ in range(60):                        # 60 MB if it were all read
            sent["chunks"] += 1
            yield b" " * (1024 * 1024)
        yield f"\r\n--{boundary}--\r\n".encode()

    resp = await client.post(
        f"/plans/{plan['id']}/import", params={"dry_run": "1"}, content=body(),
        headers={**hdrs, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    _bad_file(resp, 413, "file_too_large")
    assert sent["chunks"] <= 22, sent                 # stopped near the cap
    assert await _task_count(db, plan["id"]) == 0


async def test_no_file(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    resp = await client.post(f"/plans/{plan['id']}/import", headers=hdrs,
                             params={"dry_run": "1"}, data={"other": "x"})
    _bad_file(resp)


async def test_outline_jump(client, db):
    """1 → 3: a jump of more than one level attaches to the task above and
    says so; the task is still imported."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _edit(_sample(), "<OutlineNumber>1.1</OutlineNumber>\n      "
                               "<OutlineLevel>2</OutlineLevel>",
                    "<OutlineNumber>1.1.1</OutlineNumber>\n      <OutlineLevel>3</OutlineLevel>")
    body = await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    (problem,) = _rows(body)["Site survey"]["problems"]
    assert "Outline level" in problem and "1" in problem and "3" in problem
    got = _tasks(await _get(client, hdrs, plan))
    assert got["Site survey"]["parent_id"] == got["Phase 1 - Prep"]["id"]
    assert got["Site survey"]["outline_level"] == 2
    assert got["Pack equipment"]["parent_id"] == got["Phase 1 - Prep"]["id"]


async def test_first_task_below_the_top_level(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _edit(_sample(), "<OutlineNumber>1</OutlineNumber>\n      "
                               "<OutlineLevel>1</OutlineLevel>",
                    "<OutlineNumber>1</OutlineNumber>\n      <OutlineLevel>4</OutlineLevel>")
    body = await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    assert _rows(body)["Phase 1 - Prep"]["problems"]
    got = _tasks(await _get(client, hdrs, plan))
    assert got["Phase 1 - Prep"]["outline_level"] == 1


async def test_unknown_pred_uid(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _edit(_sample(), "<PredecessorUID>6</PredecessorUID>",
                    "<PredecessorUID>42</PredecessorUID>")
    body = await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    (problem,) = _rows(body)["Rack install"]["problems"]
    assert "42" in problem
    got = await _get(client, hdrs, plan)
    tasks = _tasks(got)
    assert tasks["Rack install"]["predecessors"] == ""
    assert tasks["Go live"]["predecessors"] == "7"
    assert len(got["links"]) == 4


async def test_links_a_summary_cannot_take_are_skipped(client, db):
    """FF into a summary, and a link between a task and its own summary,
    are skipped with a problem (the engine would refuse the whole file);
    so is a constraint a summary can't have."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _edit(_sample(),
                    "<Summary>1</Summary>\n      <PercentComplete>0</PercentComplete>\n"
                    "      <ConstraintType>0</ConstraintType>\n    </Task>\n    <Task>\n"
                    "      <UID>6</UID>",
                    "<Summary>1</Summary>\n      <PercentComplete>0</PercentComplete>\n"
                    "      <ConstraintType>7</ConstraintType>\n"
                    "      <ConstraintDate>2026-11-30T17:00:00</ConstraintDate>\n"
                    "      <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>0</Type>"
                    "<LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>\n"
                    "      <PredecessorLink><PredecessorUID>8</PredecessorUID><Type>1</Type>"
                    "<LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>\n"
                    "    </Task>\n    <Task>\n      <UID>6</UID>")
    body = await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    problems = _rows(body)["Phase 2 - Move"]["problems"]
    assert len(problems) == 3, problems
    got = _tasks(await _get(client, hdrs, plan))
    assert got["Phase 2 - Move"]["predecessors"] == ""
    assert got["Phase 2 - Move"]["constraint_type"] == "asap"


async def test_a_link_cycle_is_a_clear_error(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _edit(_sample(), "<Notes>Walk both halls &amp; count racks.</Notes>",
                    "<Notes>Walk both halls &amp; count racks.</Notes>\n"
                    "      <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>1</Type>"
                    "<LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>")
    for dry_run in (True, False):
        resp = await _import(client, hdrs, plan, content, dry_run=dry_run, mode="fill")
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "link_cycle"
    assert await _task_count(db, plan["id"]) == 0
    assert await _imports_audited(db) == []


async def test_odd_values_are_problems(client, db):
    """Unreadable values are per-row problems with a fallback, never a
    failure: a duration, a date, a constraint type, a % complete, a link
    type, a percent lag and a cross-project link."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _edit(_sample(), "<Duration>PT24H0M0S</Duration>\n      <DurationFormat>7"
                               "</DurationFormat>\n      <Milestone>0</Milestone>\n      "
                               "<Summary>0</Summary>",
                    "<Duration>three days</Duration>\n      <DurationFormat>7</DurationFormat>"
                    "\n      <Milestone>0</Milestone>\n      <Summary>0</Summary>")
    content = _edit(content, "<Deadline>2026-11-06T17:00:00</Deadline>",
                    "<Deadline>next Friday</Deadline>")
    content = _edit(content, "<ConstraintType>4</ConstraintType>",
                    "<ConstraintType>99</ConstraintType>")
    content = _edit(content, "<PercentComplete>0</PercentComplete>\n      "
                             "<ConstraintType>0</ConstraintType>\n      <PredecessorLink>\n"
                             "        <PredecessorUID>6</PredecessorUID>\n"
                             "        <Type>1</Type>",
                    "<PercentComplete>250</PercentComplete>\n      "
                    "<ConstraintType>0</ConstraintType>\n      <PredecessorLink>\n"
                    "        <PredecessorUID>6</PredecessorUID>\n        <Type>9</Type>")
    content = _edit(content, "<PredecessorUID>7</PredecessorUID>\n        <Type>1</Type>\n"
                             "        <CrossProject>0</CrossProject>",
                    "<PredecessorUID>7</PredecessorUID>\n        <Type>1</Type>\n"
                    "        <CrossProject>1</CrossProject>")
    body = await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    rows = _rows(body)
    assert len(rows["Pack equipment"]["problems"]) == 2      # duration, deadline
    assert len(rows["Truck loading"]["problems"]) == 1       # constraint type
    assert len(rows["Rack install"]["problems"]) == 2        # % complete, link type
    assert len(rows["Go live"]["problems"]) == 1             # cross-project link
    got = _tasks(await _get(client, hdrs, plan))
    assert got["Pack equipment"]["duration_text"] == "1 day"       # the default duration
    assert got["Pack equipment"]["deadline"] is None
    assert got["Truck loading"]["constraint_type"] == "asap"
    assert got["Rack install"]["percent_complete"] == 100
    assert got["Rack install"]["predecessors"] == "6"              # FS
    assert got["Go live"]["predecessors"] == ""


async def test_calendar_kept_when_it_does_not_map(client, db):
    """A recurring exception doesn't fit the week + dated exceptions model:
    a fill keeps the plan's calendar and says so; the tasks still import."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _edit(_sample(), "<Type>1</Type>\n          <DayWorking>0</DayWorking>",
                    "<Type>6</Type>\n          <DayWorking>0</DayWorking>")
    body = await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    (problem,) = body["problems"]
    assert problem.startswith("Kept this plan's calendar")
    assert body["summary"]["problems"] == 3
    got = await _get(client, hdrs, plan)
    assert got["calendar"] == plan["calendar"]
    assert len(got["tasks"]) == 8


async def test_too_many_rows(client, db, monkeypatch):
    monkeypatch.setattr(mspdi, "MAX_ROWS", 5)
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    detail = _bad_file(await _import(client, hdrs, plan, _sample(), dry_run=True, mode="fill"),
                       422, "too_many_rows")
    assert detail["limit"] == 5


# ── modes, the new-plan route, lock and access ──────────────────────


async def test_append_mode(client, db):
    """Append adds the file's tasks after the last task; the plan keeps its
    tasks, calendar and project start."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "Existing A", "Existing B")
    before = await _get(client, hdrs, plan)
    body = await _ok_import(client, hdrs, plan, _sample(), dry_run=False, mode="append")
    assert body["summary"]["created"] == 8
    got = await _get(client, hdrs, plan)
    assert [t["name"] for t in got["tasks"]] == ["Existing A", "Existing B", *SAMPLE_NAMES]
    tasks = _tasks(got)
    assert tasks["Existing A"]["id"] == ids["Existing A"]
    assert tasks["Phase 1 - Prep"]["wbs"] == "3" and tasks["Site survey"]["wbs"] == "3.1"
    assert tasks["Pack equipment"]["predecessors"] == "4SS+2 days"     # renumbered
    assert got["calendar"] == before["calendar"]
    assert got["project_start"] == before["project_start"]
    (row,) = await _imports_audited(db)
    assert row.changes["mode"] == "append"


async def test_append_keeps_day_counts_in_the_plans_units(client, db):
    """A file of 8-hour days appended to a plan of 10-hour days: a 2-day
    task stays 2 days (and an SS+2d lag 2 days), hours stay hours."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    calendar = {**plan["calendar"], "hours_per_day": 10, "hours_per_week": 50,
                "week": {**plan["calendar"]["week"], **{
                    day: [["07:00", "12:00"], ["13:00", "18:00"]]
                    for day in ("mon", "tue", "wed", "thu", "fri")}}}
    resp = await client.patch(f"/plans/{plan['id']}", headers=hdrs,
                              json={"base_version": plan["version"], "calendar": calendar})
    assert resp.status_code == 200, resp.text
    content = _edit(_sample(), "<Duration>PT8H0M0S</Duration>\n      <DurationFormat>7"
                               "</DurationFormat>\n      <Milestone>0</Milestone>\n      "
                               "<Summary>0</Summary>\n      <PercentComplete>0</PercentComplete>"
                               "\n      <ConstraintType>4</ConstraintType>",
                    "<Duration>PT4H0M0S</Duration>\n      <DurationFormat>5</DurationFormat>"
                    "\n      <Milestone>0</Milestone>\n      <Summary>0</Summary>\n      "
                    "<PercentComplete>0</PercentComplete>\n      "
                    "<ConstraintType>4</ConstraintType>")
    await _ok_import(client, hdrs, plan, content, dry_run=False, mode="append")
    got = await _get(client, hdrs, plan)
    tasks = _tasks(got)
    assert tasks["Site survey"]["duration_minutes"] == 1200
    assert tasks["Site survey"]["duration_text"] == "2 days"
    assert tasks["Truck loading"]["duration_minutes"] == 240
    assert tasks["Truck loading"]["duration_text"] == "4 hrs"
    assert tasks["Pack equipment"]["predecessors"] == "2SS+2 days"
    link = next(lk for lk in got["links"] if lk["link_type"] == "SS")
    assert link["lag_minutes"] == 1200


async def test_fill_needs_an_empty_plan(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    await _add(client, hdrs, plan, "Existing")
    for dry_run in (True, False):
        resp = await _import(client, hdrs, plan, _sample(), dry_run=dry_run, mode="fill")
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"]["code"] == "plan_not_empty"


async def test_bad_mode(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    resp = await _import(client, hdrs, plan, _sample(), dry_run=True, mode="replace")
    assert resp.status_code == 422, resp.text


async def test_locked(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    resp = await client.post(f"/plans/{plan['id']}/lock", headers=hdrs)
    assert resp.status_code == 200, resp.text
    for dry_run in (True, False):
        resp = await _import(client, hdrs, plan, _sample(), dry_run=dry_run, mode="append")
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"]["code"] == "plan_locked"
    assert await _task_count(db, plan["id"]) == 0


async def test_import_into_a_new_plan(client, db):
    """POST /initiatives/{id}/plan/import: the dry run creates nothing;
    applying creates the plan from the file's start date and calendar and
    fills it; a second import finds the plan there (409)."""
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    pat = await _pat(db, move)
    url = f"/initiatives/{move.id}/plan/import"

    resp = await _post(client, hdrs, url, _sample(), dry_run=True)
    assert resp.status_code == 200, resp.text
    preview = resp.json()
    assert preview["summary"] == {"created": 8, "problems": 2}
    assert (await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)).status_code == 404
    assert await _imports_audited(db) == []

    resp = await _post(client, hdrs, url, _sample(), dry_run=False)
    assert resp.status_code == 200, resp.text
    assert resp.json()["rows"] == preview["rows"]
    got = (await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)).json()
    assert got["project_start"] == "2026-11-02T08:00"
    assert got["calendar"]["exceptions"][0]["name"] == "Thanksgiving"
    assert [t["name"] for t in got["tasks"]] == SAMPLE_NAMES
    assert _tasks(got)["Site survey"]["assignees"][0]["id"] == str(pat.id)
    assert got["owner_name"] == "R X"                       # the creator, as on create
    actions = (await db.scalars(select(AuditLog.action).where(
        AuditLog.entity_id == got["id"]))).all()
    assert sorted(actions) == ["plan_create", "plan_import"]

    resp = await _post(client, hdrs, url, _sample(), dry_run=True)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "plan_exists"


async def test_resource_matched_by_email(client, db):
    hdrs, move, plan, _pat_row = await _setup(client, db)
    dana = Person(first_name="Danielle", last_name="Ng", email="DANA@elsewhere.example.com")
    db.add(dana)
    await db.flush()
    db.add(InitiativePerson(initiative_id=move.id, person_id=dana.id))
    await db.commit()
    body = await _ok_import(client, hdrs, plan, _sample(), dry_run=False, mode="fill")
    assert len(_rows(body)["Label racks"]["problems"]) == 1          # ALAP only
    got = _tasks(await _get(client, hdrs, plan))
    assert [a["id"] for a in got["Label racks"]["assignees"]] == [str(dana.id)]


async def test_staff_forbidden(client, db, seeded_user):
    admin = await _admin(db, client)
    move = await _initiative(db)
    plan = await _create(client, admin, move)
    hdrs = await login(client)
    resp = await client.get(f"/plans/{plan['id']}/export.xml", headers=hdrs)
    assert resp.status_code == 403
    for url in (f"/plans/{plan['id']}/import", f"/initiatives/{uuid4()}/plan/import"):
        resp = await _post(client, hdrs, url, _sample(), dry_run=True)
        assert resp.status_code == 403, url
        assert resp.json()["detail"]["code"] == "forbidden"


async def test_unknown_plan_and_initiative(client, db):
    hdrs = await _admin(db, client)
    resp = await client.get(f"/plans/{uuid4()}/export.xml", headers=hdrs)
    assert resp.status_code == 404
    resp = await _post(client, hdrs, f"/plans/{uuid4()}/import", _sample(), dry_run=True)
    assert resp.status_code == 404
    resp = await _post(client, hdrs, f"/initiatives/{uuid4()}/plan/import", _sample(),
                       dry_run=True)
    assert resp.status_code == 404


# ── the parser on its own ───────────────────────────────────────────


def test_parse_sample():
    parsed = mspdi.parse_xml(_sample())
    assert isinstance(parsed, importer.ParsedPlan)
    assert parsed.project_start == datetime(2026, 11, 2, 8, 0)
    assert [t.name for t in parsed.tasks] == SAMPLE_NAMES
    assert [t.outline_level for t in parsed.tasks] == [1, 2, 2, 2, 1, 2, 2, 2]
    by_name = {t.name: t for t in parsed.tasks}
    assert by_name["Label racks"].constraint_type == "alap"
    assert by_name["Site survey"].duration.minutes == 960
    assert by_name["Site survey"].color is None
    assert {(lk.predecessor, lk.successor, lk.link_type) for lk in parsed.links} == {
        ("2", "3", "SS"), ("3", "4", "FF"), ("4", "6", "FS"), ("6", "7", "FS"), ("7", "8", "FS")}
    assert [r.name for r in parsed.resources] == ["Pat Lee", "Dana Unknown"]
    assert parsed.calendar["exceptions"] == [
        {"date": "2026-11-26", "name": "Thanksgiving", "hours": []}]
    assert parsed.problems == []


@pytest.mark.parametrize(("text", "minutes"), [
    ("PT16H0M0S", 960), ("PT0H0M0S", 0), ("PT7H30M0S", 450), ("PT0H0M30S", 1),
    ("P2D", 960), ("P1W", 2400), ("PT1.5H", 90),
])
def test_iso_durations(text, minutes):
    assert mspdi.parse_iso_duration(text, mspdi.Units(), elapsed=False) == minutes


@pytest.mark.parametrize("text", ["", "16h", "P", "PT", "-PT1H", "PT99999999999H", "P1Y" * 30])
def test_bad_iso_durations(text):
    with pytest.raises(ValueError):
        mspdi.parse_iso_duration(text, mspdi.Units(), elapsed=False)


def test_mspdi_times_are_wall_clock():
    """No zone conversion: 08:00 in the file is 08:00 in the plan."""
    assert mspdi.parse_time("2026-11-02T08:00:00") == datetime(2026, 11, 2, 8, 0)
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d",
                        mspdi.format_time(datetime(2026, 11, 2, 8, 0)))
    with pytest.raises(ValueError):
        mspdi.format_time(datetime(2026, 11, 2, 8, 0, tzinfo=UTC))
