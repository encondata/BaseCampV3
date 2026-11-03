"""Plan templates (plans/templates.py and the /plan-templates routes): save a
plan's structure as a template, list / rename / describe / delete them, and
create an initiative's plan from one, its dates shifted to the new project
start. A template keeps names, outline, durations, links, constraints,
deadlines, notes, timeline flags, colors, the calendar and the settings
overrides; never assignees, progress, actuals or the baseline.

Reference week (Standard calendar): the source plan starts Mon 2026-11-02
08:00; the plan made from it starts a week later, Mon 2026-11-09 08:00."""

import copy
from uuid import uuid4

import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog
from serversherpa.plans import templates
from serversherpa.plans.models import PlanTemplate
from serversherpa.plans.service import load_state
from tests.test_plans_api import _admin, _create, _initiative, _plan_row
from tests.test_plans_links import _assign, _resources
from tests.test_plans_ops import _add, _get, _ok, _update
from tests.test_sites_api import login

# ── helpers ──────────────────────────────────────────────────────────


def _tasks(body) -> dict[str, dict]:
    return {t["name"]: t for t in body["tasks"]}


async def _source(client, db):
    """A 4-task plan: summary "Phase 1" over Survey (2d) and Pack (3d,
    Survey SS+1d, deadline at the end of the third working day), then Move
    (1d, Start No Earlier Than the next Monday). Survey is colored, assigned
    and half done; Move is colored, has notes and is on the timeline; the
    plan has a baseline."""
    hdrs = await _admin(db, client)
    move = await _initiative(db, name="Source move")
    plan = await _create(client, hdrs, move)
    worker, shipper = await _resources(db, move)
    ids = await _add(client, hdrs, plan, "Phase 1")
    ids.update(await _add(client, hdrs, plan, "Survey", duration="2d"))
    ids.update(await _add(client, hdrs, plan, "Pack", duration="3d"))
    ids.update(await _add(client, hdrs, plan, "Move"))
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["Survey"], ids["Pack"]]}])
    await _ok(client, hdrs, plan, [
        _update(ids["Survey"], color="#1F77B4"),
        _update(ids["Pack"], predecessors="2SS+1d", deadline="2026-11-04T17:00"),
        _update(ids["Move"], constraint_type="snet", constraint_date="2026-11-09T08:00",
                color="#d62728", notes="Bring the carts", show_on_timeline=True),
        _assign(ids["Survey"], ("person", worker.id), ("partner", shipper.id)),
        {"op": "set_percent", "ids": [ids["Survey"]], "percent": 50},
    ])
    resp = await client.post(f"/plans/{plan['id']}/baseline", headers=hdrs)
    assert resp.status_code == 200, resp.text
    return hdrs, move, plan, ids


async def _save(client, hdrs, plan, name="Standard move", description="Our usual hall move"):
    resp = await client.post(f"/plans/{plan['id']}/save-as-template", headers=hdrs,
                             json={"name": name, "description": description})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _list(client, hdrs) -> list[dict]:
    resp = await client.get("/plan-templates", headers=hdrs)
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── save → create from it ───────────────────────────────────────────


async def test_create_from_a_template_shifts_the_dates(client, db):
    hdrs, _move, plan, _ids = await _source(client, db)
    source = _tasks(await _get(client, hdrs, plan))
    saved = await _save(client, hdrs, plan)
    assert saved["name"] == "Standard move"
    assert saved["description"] == "Our usual hall move"
    assert saved["task_count"] == 4
    assert saved["created_by_name"] == "R X"

    other = await _initiative(db, name="Next move")
    body = await _create(client, hdrs, other, project_start="2026-11-09",
                         template_id=saved["id"])
    assert body["project_start"] == "2026-11-09T08:00"
    tasks = _tasks(body)

    # same names, outline and links
    assert [t["name"] for t in body["tasks"]] == ["Phase 1", "Survey", "Pack", "Move"]
    assert [t["wbs"] for t in body["tasks"]] == ["1", "1.1", "1.2", "2"]
    assert tasks["Survey"]["parent_id"] == tasks["Pack"]["parent_id"] == tasks["Phase 1"]["id"]
    assert tasks["Phase 1"]["is_summary"] and tasks["Move"]["parent_id"] is None
    assert tasks["Pack"]["predecessors"] == "2SS+1 day"
    assert len(body["links"]) == 1
    link = body["links"][0]
    assert (link["predecessor_id"], link["successor_id"]) == (tasks["Survey"]["id"],
                                                              tasks["Pack"]["id"])
    assert (link["link_type"], link["lag_minutes"], link["lag_unit"]) == ("SS", 480, "d")

    # the deadline and the SNET date exactly 7 days later
    assert source["Pack"]["deadline"] == "2026-11-04T17:00"
    assert tasks["Pack"]["deadline"] == "2026-11-11T17:00"
    assert source["Move"]["constraint_date"] == "2026-11-09T08:00"
    assert tasks["Move"]["constraint_type"] == "snet"
    assert tasks["Move"]["constraint_date"] == "2026-11-16T08:00"

    # scheduled from the new start, a week on
    assert tasks["Survey"]["start"] == "2026-11-09T08:00"
    assert tasks["Survey"]["finish"] == "2026-11-10T17:00"
    assert tasks["Pack"]["start"] == "2026-11-10T08:00"
    assert tasks["Move"]["start"] == "2026-11-16T08:00"
    for name in ("Phase 1", "Survey", "Pack", "Move"):
        for key in ("start", "finish"):
            assert tasks[name][key] == _week_later(source[name][key]), (name, key)

    # durations, colors, notes, the timeline flag kept
    assert tasks["Survey"]["duration_text"] == "2 days"
    assert tasks["Pack"]["duration_text"] == "3 days"
    assert tasks["Survey"]["color"] == "#1f77b4"
    assert tasks["Move"]["color"] == "#d62728"
    assert tasks["Move"]["notes"] == "Bring the carts"
    assert tasks["Move"]["show_on_timeline"] is True

    # never assignees, progress, actuals or the baseline
    for task in body["tasks"]:
        assert task["assignees"] == [], task["name"]
        assert task["percent_complete"] == 0, task["name"]
        assert task["actual_start"] is None and task["actual_finish"] is None
        assert task["completed_at"] is None
        assert task["baseline_start"] is None and task["baseline_finish"] is None
        assert task["status"] == "not_started"
    assert source["Survey"]["percent_complete"] == 50 and source["Survey"]["assignees"]
    assert body["baseline_set_at"] is None
    assert body["version"] == 1

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "plan_create",
                                                 AuditLog.entity_id == body["id"]))
    assert row.changes["template_id"] == saved["id"]


def _week_later(text: str) -> str:
    from datetime import datetime, timedelta
    return (datetime.fromisoformat(text) + timedelta(days=7)).isoformat(timespec="minutes")


async def test_snapshot_keeps_structure_only(client, db):
    _hdrs, move, _plan, _ids = await _source(client, db)
    state = await load_state(db, await _plan_row(db, move))
    data = templates.snapshot(state)
    assert data["version"] == 1
    assert data["calendar"] == {k: v for k, v in state.plan.calendar.items() if k != "exceptions"}
    assert data["settings"] == {}
    assert [t["name"] for t in data["tasks"]] == ["Phase 1", "Survey", "Pack", "Move"]
    by_name = {t["name"]: t for t in data["tasks"]}
    assert set(by_name["Pack"]) == {
        "key", "parent_key", "name", "duration_minutes", "duration_unit", "elapsed", "mode",
        "is_milestone", "constraint_type", "constraint_offset", "deadline_offset",
        "start_offset", "finish_offset", "notes", "show_on_timeline", "color"}
    assert by_name["Phase 1"]["parent_key"] is None
    assert by_name["Survey"]["parent_key"] == by_name["Pack"]["parent_key"] == by_name["Phase 1"]["key"]
    # wall-clock minutes from the project start (Mon 08:00)
    assert by_name["Pack"]["deadline_offset"] == (2 * 24 + 9) * 60      # Wed 17:00
    assert by_name["Move"]["constraint_offset"] == 7 * 24 * 60          # next Mon 08:00
    # an auto task's dates are the engine's: not stored
    assert by_name["Survey"]["start_offset"] is None and by_name["Survey"]["finish_offset"] is None
    assert data["links"] == [{"from": by_name["Survey"]["key"], "to": by_name["Pack"]["key"],
                              "link_type": "SS", "lag_minutes": 480, "lag_unit": "d",
                              "lag_elapsed": False}]
    text = repr(data)
    for leaked in ("percent", "assign", "actual", "baseline", "Wanda", "Champagne"):
        assert leaked not in text, leaked


async def test_manual_task_dates_shift(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    plan = await _create(client, hdrs, move)
    ids = await _add(client, hdrs, plan, "Walkthrough", mode="manual",
                     start="2026-11-03T10:00", finish="2026-11-03T15:00")
    ids.update(await _add(client, hdrs, plan, "Go live", is_milestone=True, duration="0"))
    saved = await _save(client, hdrs, plan, name="Manual one")

    other = await _initiative(db, name="Later")
    body = await _create(client, hdrs, other, project_start="2026-11-09", template_id=saved["id"])
    tasks = _tasks(body)
    assert tasks["Walkthrough"]["mode"] == "manual"
    assert (tasks["Walkthrough"]["start"], tasks["Walkthrough"]["finish"]) == (
        "2026-11-10T10:00", "2026-11-10T15:00")
    assert tasks["Go live"]["is_milestone"] is True


async def test_template_keeps_the_calendar_and_settings(client, db):
    """A template keeps the working week, the hours and units and the
    default times, and the settings overrides, but no dated exceptions: a
    plan made from it takes the system calendar's exceptions, and a
    date-only project start begins at the template's default start."""
    hdrs = await _admin(db, client)
    system = (await client.get("/system/project-plans", headers=hdrs)).json()["calendar"]
    christmas = [{"date": "2026-12-25", "name": "Christmas Day", "hours": []}]
    resp = await client.put("/system/project-plans", headers=hdrs,
                            json={"calendar": {**system, "exceptions": christmas}})
    assert resp.status_code == 200, resp.text
    move = await _initiative(db)
    plan = await _create(client, hdrs, move)
    calendar = (await _get(client, hdrs, plan))["calendar"]
    calendar["week"]["sat"] = [["09:00", "13:00"]]
    calendar["default_start"] = "07:00"
    calendar["exceptions"] = [{"date": "2026-11-26", "name": "Thanksgiving", "hours": []}]
    resp = await client.patch(f"/plans/{plan['id']}", headers=hdrs, json={
        "base_version": 1, "calendar": calendar,
        "settings": {"honor_constraints": False, "reminders": {"enabled": False}}})
    assert resp.status_code == 200, resp.text
    await _add(client, hdrs, plan, "A")
    saved = await _save(client, hdrs, plan, name="Weekend crew")
    stored = (await db.get(PlanTemplate, saved["id"])).data["calendar"]
    assert "exceptions" not in stored
    assert stored["week"]["sat"] == [["09:00", "13:00"]]

    other = await _initiative(db, name="Other")
    body = await _create(client, hdrs, other, project_start="2026-11-09", template_id=saved["id"])
    assert body["calendar"]["week"] == calendar["week"]                 # the template's
    assert body["calendar"]["default_start"] == "07:00"
    assert body["calendar"]["exceptions"] == christmas                  # the system's
    assert body["project_start"] == "2026-11-09T07:00"                  # merged default start
    assert body["settings_overrides"] == {"honor_constraints": False,
                                          "reminders": {"enabled": False}}


async def test_unknown_template(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    resp = await client.post(f"/initiatives/{move.id}/plan", headers=hdrs,
                             json={"project_start": "2026-11-02", "template_id": str(uuid4())})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "template_not_found"
    assert (await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)).status_code == 404


async def _refused_from(client, db, hdrs, template_id, code="bad_template"):
    """Creating a plan from the template is refused with `code`, and the
    initiative is left with no plan."""
    move = await _initiative(db, name="Target")
    resp = await client.post(f"/initiatives/{move.id}/plan", headers=hdrs,
                             json={"project_start": "2026-11-09", "template_id": str(template_id)})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == code
    assert (await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)).status_code == 404


async def _broken(client, db):
    """A saved template of A, B, C with a link A -> B, and its stored row."""
    hdrs = await _admin(db, client)
    plan = await _create(client, hdrs, await _initiative(db))
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    await _ok(client, hdrs, plan, [{"op": "add_link", "predecessor_id": ids["A"],
                                    "successor_id": ids["B"]}])
    saved = await _save(client, hdrs, plan, name="Broken")
    row = await db.get(PlanTemplate, saved["id"])
    return hdrs, row, copy.deepcopy(row.data)


def _with_task(good, index, **fields):
    tasks = copy.deepcopy(good["tasks"])
    tasks[index].update(fields)
    return {**good, "tasks": tasks}


def _without(good, index, key):
    tasks = copy.deepcopy(good["tasks"])
    del tasks[index][key]
    return {**good, "tasks": tasks}


def _link(frm, to, **fields):
    return {"from": frm, "to": to, "link_type": "FS", "lag_minutes": 0, "lag_unit": "d",
            "lag_elapsed": False, **fields}


async def test_template_this_code_cannot_apply(client, db):
    """Stored data this code can't apply: 422 `bad_template` (never a 500
    from the database or the engine), and no plan is made. A parent must be
    a task listed before it (snapshots are in outline order, so no parent
    loop can be written); a link's type must be one MS Project has and a
    pair is linked once."""
    hdrs, row, good = await _broken(client, db)
    a, b, c = (t["key"] for t in good["tasks"])
    cases = {
        "version": {**good, "version": 2},
        "link to no task": {**good, "links": [_link(a, "9")]},
        "no name": _without(good, 0, "name"),
        "no parent_key": _without(good, 1, "parent_key"),
        "parent names no task": _with_task(good, 1, parent_key="9"),
        "parent listed later": _with_task(good, 0, parent_key=c),
        "own parent": _with_task(good, 1, parent_key=b),
        "parent loop": _with_task(_with_task(good, 1, parent_key=c), 2, parent_key=b),
        "link type": {**good, "links": [_link(a, b, link_type="XX")]},
        "duplicate link": {**good, "links": [_link(a, b), _link(a, b, link_type="SS")]},
        "self link": {**good, "links": [_link(a, a)]},
        "mode": _with_task(good, 0, mode="sometimes"),
        "duration unit": _with_task(good, 0, duration_unit="fortnight"),
        "negative duration": _with_task(good, 0, duration_minutes=-60),
        "duration not a number": _with_task(good, 0, duration_minutes="8h"),
        "constraint type": _with_task(good, 0, constraint_type="whenever"),
        "color": _with_task(good, 0, color="red"),
        "name not text": _with_task(good, 0, name=42),
        "offset not whole minutes": _with_task(good, 0, deadline_offset=1.5),
        "lag unit": {**good, "links": [_link(a, b, lag_unit="ages")]},
        "lag not a number": {**good, "links": [_link(a, b, lag_minutes="1d")]},
        "duration over the cap": _with_task(good, 0, duration_minutes=10**12),
        "lag over the cap": {**good, "links": [_link(a, b, lag_minutes=-(10**12))]},
        "offset out of range": _with_task(good, 0, deadline_offset=10**13),
        "tasks not a list": {**good, "tasks": {"1": good["tasks"][0]}},
    }
    for name, data in cases.items():
        row.data = data
        await db.commit()
        try:
            await _refused_from(client, db, hdrs, row.id)
        except AssertionError as exc:
            raise AssertionError(name) from exc


async def test_a_link_loop_in_a_template_is_the_engines_refusal(client, db):
    """A -> B and B -> A gets past the data checks; the engine refuses it
    with its own code, still a 422 with no plan made."""
    hdrs, row, good = await _broken(client, db)
    a, b, _c = (t["key"] for t in good["tasks"])
    row.data = {**good, "links": [_link(a, b), _link(b, a)]}
    await db.commit()
    await _refused_from(client, db, hdrs, row.id, code="link_cycle")


async def test_any_other_engine_refusal_is_bad_template(client, db, monkeypatch):
    """A ValueError out of the recalc (the engine's own input checks) is the
    template's fault: 422 `bad_template`, nothing created."""
    from serversherpa.plans import service

    hdrs, row, _good = await _broken(client, db)

    def refuse(_state, _settings):
        raise ValueError("task x: unknown mode 'sometimes'")

    monkeypatch.setattr(service, "recalc", refuse)
    await _refused_from(client, db, hdrs, row.id)


async def test_size_cap(client, db, monkeypatch):
    """More than MAX_RESTORE_ROWS tasks or links (the restore op's cap) is
    refused before anything is added."""
    hdrs, row, good = await _broken(client, db)
    monkeypatch.setattr(templates, "MAX_RESTORE_ROWS", 2)
    await _refused_from(client, db, hdrs, row.id)              # 3 tasks
    a, b, c = (t["key"] for t in good["tasks"])
    with pytest.raises(templates.TemplateError, match="tasks"):
        templates.check(good)
    two = {**good, "tasks": good["tasks"][:2], "links": [_link(a, b), _link(b, a), _link(a, c)]}
    with pytest.raises(templates.TemplateError, match="links"):
        templates.check(two)
    monkeypatch.setattr(templates, "MAX_RESTORE_ROWS", 3)
    templates.check(good)                                       # at the cap: fine


async def test_elapsed_lag_survives(client, db):
    hdrs = await _admin(db, client)
    plan = await _create(client, hdrs, await _initiative(db))
    ids = await _add(client, hdrs, plan, "A", duration="2d")
    ids.update(await _add(client, hdrs, plan, "B"))
    await _ok(client, hdrs, plan, [{"op": "add_link", "predecessor_id": ids["A"],
                                    "successor_id": ids["B"], "link_type": "SS",
                                    "lag": "+2ed"}])
    source = await _get(client, hdrs, plan)
    saved = await _save(client, hdrs, plan, name="Elapsed")
    body = await _create(client, hdrs, await _initiative(db, name="Later"),
                         project_start="2026-11-09", template_id=saved["id"])
    [link] = body["links"]
    assert (link["link_type"], link["lag_minutes"], link["lag_elapsed"]) == ("SS", 2880, True)
    assert link["lag_text"] == source["links"][0]["lag_text"]
    assert _tasks(body)["B"]["predecessors"] == _tasks(source)["B"]["predecessors"] == "1SS+2 edays"
    # two elapsed days from Mon 08:00 run to Wed 08:00
    assert _tasks(body)["B"]["start"] == "2026-11-11T08:00"


async def test_out_of_scope_initiative(client, db, monkeypatch):
    """A template_id never gets past the initiatives scope: an initiative
    the actor can't see is 404 `initiative_not_found`, whether or not the
    template exists."""
    from serversherpa.db.models import Initiative
    from serversherpa.plans import service

    hdrs = await _admin(db, client)
    plan = await _create(client, hdrs, await _initiative(db))
    await _add(client, hdrs, plan, "A")
    saved = await _save(client, hdrs, plan, name="Scoped")
    hidden = await _initiative(db, name="Hidden")
    monkeypatch.setattr(service, "scope_conditions",
                        lambda resource, access, person_id: Initiative.id != hidden.id)
    for template_id in (saved["id"], str(uuid4())):
        resp = await client.post(f"/initiatives/{hidden.id}/plan", headers=hdrs,
                                 json={"project_start": "2026-11-09", "template_id": template_id})
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "initiative_not_found"
    monkeypatch.undo()
    assert (await client.get(f"/initiatives/{hidden.id}/plan", headers=hdrs)).status_code == 404


# ── save ─────────────────────────────────────────────────────────────


async def test_duplicate_name(client, db):
    hdrs, _move, plan, _ids = await _source(client, db)
    await _save(client, hdrs, plan, name="Standard move")
    resp = await client.post(f"/plans/{plan['id']}/save-as-template", headers=hdrs,
                             json={"name": "  standard MOVE ", "description": ""})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "template_exists"
    assert len(await _list(client, hdrs)) == 1


async def test_name_required_and_trimmed(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    plan = await _create(client, hdrs, move)
    for name in ("", "   ", "x" * 121):
        resp = await client.post(f"/plans/{plan['id']}/save-as-template", headers=hdrs,
                                 json={"name": name})
        assert resp.status_code == 422, name
        assert resp.json()["detail"] == {"code": "bad_field", "field": "name"}
    resp = await client.post(f"/plans/{plan['id']}/save-as-template", headers=hdrs,
                             json={"name": "y", "description": "d" * 1001})
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "bad_field", "field": "description"}

    saved = await _save(client, hdrs, plan, name="  Empty plan  ", description="   ")
    assert saved["name"] == "Empty plan"
    assert saved["description"] is None
    assert saved["task_count"] == 0


async def test_save_is_audited_and_listed(client, db):
    hdrs, _move, plan, _ids = await _source(client, db)
    saved = await _save(client, hdrs, plan)
    await _save(client, hdrs, plan, name="Another one", description=None)
    listed = await _list(client, hdrs)
    assert [t["name"] for t in listed] == ["Another one", "Standard move"]
    mine = next(t for t in listed if t["id"] == saved["id"])
    assert set(mine) == {"id", "name", "description", "task_count", "created_by_name",
                         "updated_at"}
    assert mine["task_count"] == 4
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "plan_template_save",
                                                 AuditLog.entity_id == saved["id"]))
    assert row is not None and row.entity_type == "plan_template"
    assert row.changes["plan_id"] == plan["id"]
    assert row.changes["name"] == "Standard move"
    assert row.changes["tasks"] == 4


async def test_unknown_plan(client, db):
    hdrs = await _admin(db, client)
    resp = await client.post(f"/plans/{uuid4()}/save-as-template", headers=hdrs,
                             json={"name": "X"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "plan_not_found"


# ── rename / describe / delete ───────────────────────────────────────


async def test_rename_and_describe(client, db):
    hdrs, _move, plan, _ids = await _source(client, db)
    saved = await _save(client, hdrs, plan)
    taken = await _save(client, hdrs, plan, name="Taken")

    resp = await client.patch(f"/plan-templates/{saved['id']}", headers=hdrs,
                              json={"name": "  Hall move  "})
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Hall move"
    assert resp.json()["description"] == "Our usual hall move"

    resp = await client.patch(f"/plan-templates/{saved['id']}", headers=hdrs,
                              json={"description": "Two halls"})
    assert resp.status_code == 200
    assert (resp.json()["name"], resp.json()["description"]) == ("Hall move", "Two halls")

    # its own name in another case is not a clash
    resp = await client.patch(f"/plan-templates/{saved['id']}", headers=hdrs,
                              json={"name": "HALL MOVE"})
    assert resp.status_code == 200 and resp.json()["name"] == "HALL MOVE"

    resp = await client.patch(f"/plan-templates/{saved['id']}", headers=hdrs,
                              json={"name": "taken"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "template_exists"

    resp = await client.patch(f"/plan-templates/{saved['id']}", headers=hdrs, json={"name": " "})
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "bad_field", "field": "name"}

    resp = await client.patch(f"/plan-templates/{saved['id']}", headers=hdrs,
                              json={"description": None})
    assert resp.status_code == 200 and resp.json()["description"] is None

    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "plan_template_update", AuditLog.entity_id == saved["id"])
        .order_by(AuditLog.at))).all()
    assert rows[0].changes == {"name": {"from": "Standard move", "to": "Hall move"}}
    assert taken["name"] == "Taken"

    resp = await client.patch(f"/plan-templates/{uuid4()}", headers=hdrs, json={"name": "Z"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "template_not_found"


async def test_delete(client, db):
    hdrs, _move, plan, _ids = await _source(client, db)
    saved = await _save(client, hdrs, plan)
    resp = await client.delete(f"/plan-templates/{saved['id']}", headers=hdrs)
    assert resp.status_code == 204
    assert await _list(client, hdrs) == []
    assert await db.get(PlanTemplate, saved["id"]) is None
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "plan_template_delete",
                                                 AuditLog.entity_id == saved["id"]))
    assert row is not None and row.changes["name"] == "Standard move"
    # the plan it came from is untouched
    assert len((await _get(client, hdrs, plan))["tasks"]) == 4

    resp = await client.delete(f"/plan-templates/{saved['id']}", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "template_not_found"


# ── access ───────────────────────────────────────────────────────────


async def test_staff_forbidden(client, db, seeded_user):
    admin = await _admin(db, client)
    move = await _initiative(db)
    plan = await _create(client, admin, move)
    saved = await _save(client, admin, plan)
    hdrs = await login(client)
    calls = [
        ("get", "/plan-templates", None),
        ("post", f"/plans/{plan['id']}/save-as-template", {"name": "Mine"}),
        ("patch", f"/plan-templates/{saved['id']}", {"name": "Mine"}),
        ("delete", f"/plan-templates/{saved['id']}", None),
    ]
    for method, path, body in calls:
        kwargs = {"json": body} if body is not None else {}
        resp = await getattr(client, method)(path, headers=hdrs, **kwargs)
        assert resp.status_code == 403, (method, path)
        assert resp.json()["detail"]["code"] == "forbidden"
    other = await _initiative(db, name="Other")
    resp = await client.post(f"/initiatives/{other.id}/plan", headers=hdrs,
                             json={"project_start": "2026-11-09", "template_id": saved["id"]})
    assert resp.status_code == 403
