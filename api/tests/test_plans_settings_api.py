"""Plan settings and the plan-level writes around the schedule: PATCH
/plans/{id} (overrides, calendar, timezone, status date, owner), the
schedule lock, the baseline, the version probe, and the system section
GET|PUT /system/project-plans.

Reference week (Standard calendar): the plan starts Mon 2026-11-02 08:00."""

import copy
from uuid import uuid4

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Person
from serversherpa.plans import plan_writes, service
from serversherpa.plans.calendar import STANDARD_CALENDAR
from serversherpa.plans.models import PlanLink, PlanTask
from serversherpa.plans.schemas import MAX_RESTORE_ROWS
from serversherpa.system.config_store import DEFAULTS
from tests.test_plans_api import _make, _person_id, _plan_row
from tests.test_plans_ops import _add, _by_id, _fails, _get, _ok, _setup
from tests.test_sites_api import login

# ── helpers ──────────────────────────────────────────────────────────


async def _patch(client, hdrs, plan, version=None, **fields):
    """PATCH the plan with its current version unless one is given."""
    if version is None:
        version = (await _get(client, hdrs, plan))["version"]
    return await client.patch(f"/plans/{plan['id']}", headers=hdrs,
                              json={"base_version": version, **fields})


async def _patched(client, hdrs, plan, **fields) -> dict:
    resp = await _patch(client, hdrs, plan, **fields)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _refused(client, hdrs, plan, status, code, **fields) -> dict:
    resp = await _patch(client, hdrs, plan, **fields)
    assert resp.status_code == status, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == code, detail
    return detail


def _calendar(**changes) -> dict:
    return {**copy.deepcopy(STANDARD_CALENDAR), **changes}


def _week(hours) -> dict:
    return {day: copy.deepcopy(hours) if day not in ("sat", "sun") else []
            for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}


async def _audits(db, action) -> list[AuditLog]:
    return list(await db.scalars(
        select(AuditLog).where(AuditLog.action == action).order_by(AuditLog.at)))


async def _task_row(db, task_id) -> PlanTask:
    return await db.scalar(select(PlanTask).where(PlanTask.id == task_id)
                           .execution_options(populate_existing=True))


async def _loop(db, ids):
    """A link loop A -> B -> A written straight to the table (the ops refuse
    one), so the next engine run raises link_cycle."""
    a, b = (await _task_row(db, ids["A"])), (await _task_row(db, ids["B"]))
    db.add_all([PlanLink(plan_id=a.plan_id, predecessor_id=a.id, successor_id=b.id),
                PlanLink(plan_id=a.plan_id, predecessor_id=b.id, successor_id=a.id)])
    await db.commit()


async def _put_system(client, hdrs, **body):
    resp = await client.put("/system/project-plans", headers=hdrs, json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _raw(client, method, url, hdrs, text):
    """A body sent as raw JSON text (NaN and Infinity are not JSON values)."""
    return await client.request(method, url, content=text,
                                headers={**hdrs, "Content-Type": "application/json"})


SYSTEM_DEFAULTS = {k: v for k, v in DEFAULTS["project_plans"].items()}

REMINDERS = {
    "enabled": True, "offsets_days": [7, 2], "on_due_day": False,
    "overdue": "once", "send_time": "09:30",
    "use_finish_without_deadline": True, "notify_on_assign": False,
    "overdue_to_owner": False, "email_assignees": False,
}

# ── PATCH: settings overrides ────────────────────────────────────────


async def test_patch_overrides_and_inherit(client, db):
    hdrs, _move, plan = await _setup(client, db)
    body = await _patched(client, hdrs, plan,
                          settings={"completion": {"predecessors": "warn"}})
    assert body["settings"]["completion"] == {"subtasks": "cascade", "predecessors": "warn"}
    assert body["settings_overrides"] == {"completion": {"predecessors": "warn"}}
    assert body["version"] == plan["version"] + 1

    body = await _patched(client, hdrs, plan,
                          settings={"completion": {"predecessors": None}})
    assert body["settings"]["completion"]["predecessors"] == "block"
    assert body["settings_overrides"] == {}


async def test_patch_overrides_merge_key_by_key(client, db):
    hdrs, _move, plan = await _setup(client, db)
    await _patched(client, hdrs, plan, settings={
        "honor_constraints": False, "reminders": {"offsets_days": [1, 5, 3]}})
    body = await _patched(client, hdrs, plan, settings={
        "completion": {"subtasks": "block"}, "reminders": {"send_time": "07:15"}})
    # stored sorted descending; untouched keys stay
    assert body["settings_overrides"] == {
        "honor_constraints": False,
        "completion": {"subtasks": "block"},
        "reminders": {"offsets_days": [5, 3, 1], "send_time": "07:15"},
    }
    assert body["settings"]["reminders"]["offsets_days"] == [5, 3, 1]
    assert body["settings"]["reminders"]["overdue"] == "daily"
    assert body["settings"]["honor_constraints"] is False

    # slack in days, fractions allowed; whole days stay whole
    body = await _patched(client, hdrs, plan, settings={"critical_slack_days": 1.5})
    assert body["settings_overrides"]["critical_slack_days"] == 1.5
    body = await _patched(client, hdrs, plan, settings={"critical_slack_days": 2.0})
    assert body["settings_overrides"]["critical_slack_days"] == 2
    assert isinstance(body["settings_overrides"]["critical_slack_days"], int)
    body = await _patched(client, hdrs, plan, settings={"critical_slack_days": None})

    # a null group drops every override in it; a null scalar inherits
    body = await _patched(client, hdrs, plan,
                          settings={"reminders": None, "honor_constraints": None})
    assert body["settings_overrides"] == {"completion": {"subtasks": "block"}}
    assert body["settings"]["reminders"]["offsets_days"] == [3, 1]


async def test_patch_settings_recalculates(client, db):
    """A scheduling setting moves the computed fields at once: B (1 day
    beside a 3-day A) has 2 days of slack, critical once slack up to 2
    days counts as critical."""
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", duration="3d")
    ids |= await _add(client, hdrs, plan, "B", duration="1d")
    before = _by_id(await _get(client, hdrs, plan))
    assert before[ids["B"]]["total_slack_minutes"] == 960
    assert (before[ids["A"]]["is_critical"], before[ids["B"]]["is_critical"]) == (True, False)
    body = await _patched(client, hdrs, plan, settings={"critical_slack_days": 2})
    assert _by_id(body)[ids["B"]]["is_critical"] is True


async def test_patch_bad_settings(client, db):
    hdrs, _move, plan = await _setup(client, db)
    for settings, field in (
        ({"completion": {"predecessors": "sometimes"}}, "settings.completion.predecessors"),
        ({"completion": {"subtasks": "skip"}}, "settings.completion.subtasks"),
        ({"reminders": {"overdue": "weekly"}}, "settings.reminders.overdue"),
        ({"reminders": {"offsets_days": [0]}}, "settings.reminders.offsets_days"),
        ({"reminders": {"offsets_days": [3, 3]}}, "settings.reminders.offsets_days"),
        ({"reminders": {"offsets_days": []}}, "settings.reminders.offsets_days"),
        ({"reminders": {"offsets_days": [1, 2, 3, 4, 5, 6]}}, "settings.reminders.offsets_days"),
        ({"reminders": {"offsets_days": [366]}}, "settings.reminders.offsets_days"),
        ({"reminders": {"send_time": "8:00"}}, "settings.reminders.send_time"),
        ({"reminders": {"send_time": "24:00"}}, "settings.reminders.send_time"),
        ({"reminders": {"enabled": "yes"}}, "settings.reminders.enabled"),
        ({"critical_slack_days": 31}, "settings.critical_slack_days"),
        ({"critical_slack_days": -1}, "settings.critical_slack_days"),
        ({"critical_slack_days": True}, "settings.critical_slack_days"),
        ({"critical_slack_days": "2"}, "settings.critical_slack_days"),
        ({"default_task_mode": "fixed"}, "settings.default_task_mode"),
        ({"default_duration": "two days"}, "settings.default_duration"),
        ({"default_duration": "-1d"}, "settings.default_duration"),
        ({"calendar": {}}, "settings.calendar"),
        ({"completion": {"other": "block"}}, "settings.completion.other"),
    ):
        detail = await _refused(client, hdrs, plan, 422, "bad_field", settings=settings)
        assert detail["field"] == field, (settings, detail)
    await _refused(client, hdrs, plan, 422, "bad_field", settings=None)
    assert (await _get(client, hdrs, plan))["version"] == plan["version"]


async def test_patch_default_duration_is_capped(client, db):
    """10 years of the plan's own working time (the cap every duration has),
    in the units of the calendar sent with it, else the plan's."""
    hdrs, _move, plan = await _setup(client, db)
    for text in ("2601d", "3651ed", "521w"):
        detail = await _refused(client, hdrs, plan, 422, "bad_field",
                                settings={"default_duration": text})
        assert detail["field"] == "settings.default_duration", text
    await _patched(client, hdrs, plan, settings={"default_duration": "2600d"})
    # 20,000 h is under 10 years of 8-hour days, over 10 years of 4-hour ones
    four_hours = _calendar(hours_per_day=4)
    detail = await _refused(client, hdrs, plan, 422, "bad_field", calendar=four_hours,
                            settings={"default_duration": "20000h"})
    assert detail["field"] == "settings.default_duration"
    await _patched(client, hdrs, plan, settings={"default_duration": "20000h"})
    await _patched(client, hdrs, plan, calendar=four_hours,
                   settings={"default_duration": None})
    detail = await _refused(client, hdrs, plan, 422, "bad_field",
                            settings={"default_duration": "20000h"})
    assert detail["field"] == "settings.default_duration"


async def test_patch_non_finite_slack_days(client, db):
    hdrs, _move, plan = await _setup(client, db)
    for number in ("NaN", "Infinity", "-Infinity"):
        resp = await _raw(client, "PATCH", f"/plans/{plan['id']}", hdrs,
                          f'{{"base_version": {plan["version"]}, '
                          f'"settings": {{"critical_slack_days": {number}}}}}')
        assert resp.status_code == 422, (number, resp.text)
        assert resp.json()["detail"] == {"code": "bad_field",
                                         "field": "settings.critical_slack_days"}


async def test_patch_maps_engine_errors(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", duration="2d")
    # the work runs past the last date the calendar reaches
    detail = await _refused(client, hdrs, plan, 422, "no_working_time",
                            project_start="9999-12-31")
    assert set(detail) == {"code"}
    await _loop(db, ids)
    detail = await _refused(client, hdrs, plan, 422, "link_cycle",
                            settings={"honor_constraints": False})
    assert sorted(detail["task_ids"]) == sorted([ids["A"], ids["B"]])
    assert detail["display_ids"] == [1, 2]
    body = await _get(client, hdrs, plan)
    assert body["settings_overrides"] == {} and body["project_start"] == "2026-11-02T08:00"


async def test_patch_needs_the_current_version(client, db):
    hdrs, _move, plan = await _setup(client, db)
    await _add(client, hdrs, plan, "A")
    resp = await _patch(client, hdrs, plan, version=plan["version"],
                        settings={"honor_constraints": False})
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "plan_changed", "version": plan["version"] + 1}


async def test_patch_audits_and_stamps(client, db):
    """The audit row, the plan's stamps, and the stamps of the task rows the
    recalc moved (only those: B stays where it was)."""
    email = f"ps-{uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    me = await _person_id(db, email)
    other, move, plan = await _setup(client, db)
    ids = await _add(client, other, plan, "A")
    row = await _task_row(db, ids["A"])
    added = (row.updated_by, row.updated_at)
    body = await _patched(client, hdrs, plan, settings={"show_times": True},
                          status_date="2026-11-04T12:00")
    [row] = await _audits(db, "plan_settings")
    assert row.entity_type == "project_plan" and row.entity_id == plan["id"]
    assert row.actor_person_id == me
    assert row.changes["settings"] == {"from": {}, "to": {"show_times": True}}
    assert row.changes["status_date"] == {"from": None, "to": "2026-11-04T12:00"}
    probe = (await client.get(f"/plans/{plan['id']}/version", headers=hdrs)).json()
    assert probe["version"] == body["version"]
    assert probe["updated_by_name"] == "R X"
    # nothing the recalc stores moved, so A keeps its stamps
    kept = await _task_row(db, ids["A"])
    assert (kept.updated_by, kept.updated_at) == added
    assert kept.updated_by != me

    await _patched(client, hdrs, plan, project_start="2026-11-09")
    moved = await _task_row(db, ids["A"])
    stamped = await _plan_row(db, move)
    assert moved.start.isoformat() == "2026-11-09T08:00:00"
    assert moved.updated_by == me == stamped.updated_by
    assert moved.updated_at == stamped.updated_at > added[1]


async def test_patch_without_changes_keeps_the_version(client, db):
    hdrs, _move, plan = await _setup(client, db)
    body = await _patched(client, hdrs, plan, project_start=plan["project_start"])
    assert body["version"] == plan["version"]
    assert await _audits(db, "plan_settings") == []


# ── PATCH: calendar, project start, timezone, status date, owner ─────


async def test_patch_calendar_reschedules(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", duration="2d")
    assert (await _get(client, hdrs, plan))["tasks"][0]["finish"] == "2026-11-03T17:00"
    calendar = _calendar(week=_week([["07:00", "11:00"], ["12:00", "16:00"]]))
    body = await _patched(client, hdrs, plan, calendar=calendar)
    assert _by_id(body)[ids["A"]]["finish"] == "2026-11-04T08:00"
    assert body["calendar"]["week"]["mon"] == [["07:00", "11:00"], ["12:00", "16:00"]]


async def test_patch_calendar_is_stored_canonical(client, db):
    hdrs, _move, plan = await _setup(client, db)
    calendar = _calendar(exceptions=[
        {"date": "2026-11-26", "name": "Thanksgiving", "hours": []},
        {"date": "2026-11-14", "hours": [["06:00", "22:00"]]},
    ])
    del calendar["hours_per_week"]
    body = await _patched(client, hdrs, plan, calendar=calendar)
    assert body["calendar"]["exceptions"] == [
        {"date": "2026-11-14", "name": None, "hours": [["06:00", "22:00"]]},
        {"date": "2026-11-26", "name": "Thanksgiving", "hours": []},
    ]
    assert body["calendar"]["hours_per_week"] == 40


async def test_patch_calendar_in_another_order_changes_nothing(client, db):
    hdrs, _move, plan = await _setup(client, db)
    exceptions = [{"date": "2026-11-26", "name": "Thanksgiving", "hours": []},
                  {"date": "2026-11-14", "name": "Move", "hours": [["13:00", "22:00"],
                                                                   ["06:00", "12:00"]]}]
    body = await _patched(client, hdrs, plan, calendar=_calendar(exceptions=exceptions))
    assert body["calendar"]["exceptions"][0]["hours"] == [["06:00", "12:00"],
                                                          ["13:00", "22:00"]]
    week = {day: list(reversed(hours)) for day, hours in STANDARD_CALENDAR["week"].items()}
    again = await _patched(client, hdrs, plan, calendar=_calendar(
        week=week, exceptions=list(reversed(copy.deepcopy(exceptions)))))
    assert again["version"] == body["version"]
    assert again["calendar"] == body["calendar"]
    assert len(await _audits(db, "plan_settings")) == 1


async def test_bad_calendar(client, db):
    hdrs, _move, plan = await _setup(client, db)
    for calendar in (
        _calendar(week=_week([["08:00", "25:00"]])),
        _calendar(hours_per_day=25),
        _calendar(hours_per_week=169),
        _calendar(days_per_month=32),
        _calendar(color="blue"),
        _calendar(exceptions=[{"date": "2026-11-26", "hours": [], "recurring": True}]),
        _calendar(exceptions=[{"date": "2026-11-26", "name": "Thanks\ngiving", "hours": []}]),
        _calendar(exceptions=[{"date": "2026-11-26", "hours": []}] * (MAX_RESTORE_ROWS + 1)),
        {"week": {}},
        None,
    ):
        detail = await _refused(client, hdrs, plan, 422, "bad_calendar", calendar=calendar)
        assert "message" in detail
    assert (await _get(client, hdrs, plan))["calendar"] == STANDARD_CALENDAR


async def test_bad_timezone(client, db):
    hdrs, _move, plan = await _setup(client, db)
    for zone in ("Mars/Olympus_Mons", "", "../etc/passwd", "America/New_York\x00", None,
                 "x" * 5000):
        await _refused(client, hdrs, plan, 422, "bad_timezone", timezone=zone)
    body = await _patched(client, hdrs, plan, timezone="Europe/Amsterdam")
    assert body["timezone"] == "Europe/Amsterdam"


async def test_patch_project_start_reschedules(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    body = await _patched(client, hdrs, plan, project_start="2026-11-09")
    assert body["project_start"] == "2026-11-09T08:00"
    assert _by_id(body)[ids["A"]]["start"] == "2026-11-09T08:00"
    for bad in ("Nov 9", "2026-11-09T08:00Z", None):
        detail = await _refused(client, hdrs, plan, 422, "bad_field", project_start=bad)
        assert detail["field"] == "project_start"


async def test_patch_status_date(client, db):
    hdrs, _move, plan = await _setup(client, db)
    # a date alone is the end of that working day (as Update project reads it)
    body = await _patched(client, hdrs, plan, status_date="2026-11-04")
    assert body["status_date"] == "2026-11-04T17:00"
    body = await _patched(client, hdrs, plan, status_date=None)
    assert body["status_date"] is None
    detail = await _refused(client, hdrs, plan, 422, "bad_field", status_date="soon")
    assert detail["field"] == "status_date"


async def test_patch_date_only_uses_the_new_calendar(client, db):
    hdrs, _move, plan = await _setup(client, db)
    calendar = _calendar(default_start="07:00", default_end="16:00",
                         week=_week([["07:00", "11:00"], ["12:00", "16:00"]]))
    body = await _patched(client, hdrs, plan, calendar=calendar,
                          project_start="2026-11-09", status_date="2026-11-10")
    assert body["project_start"] == "2026-11-09T07:00"
    assert body["status_date"] == "2026-11-10T16:00"


async def test_patch_owner(client, db):
    email = f"po-{uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    me = await _person_id(db, email)
    _h, _move, plan = await _setup(client, db)
    body = await _patched(client, hdrs, plan, owner_id=str(me))
    assert body["owner_id"] == str(me) and body["owner_name"] == "R X"

    worker = Person(first_name="Wanda", last_name="Worker")
    db.add(worker)
    await db.commit()
    for owner in (uuid4(), worker.id):
        await _refused(client, hdrs, plan, 422, "bad_owner", owner_id=str(owner))

    body = await _patched(client, hdrs, plan, owner_id=None)
    assert body["owner_id"] is None and body["owner_name"] is None


async def test_patch_unknown_field(client, db):
    hdrs, _move, plan = await _setup(client, db)
    resp = await _patch(client, hdrs, plan, version=plan["version"], name="Renamed")
    assert resp.status_code == 422


# ── lock ─────────────────────────────────────────────────────────────


async def test_lock_unlock(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    resp = await client.post(f"/plans/{plan['id']}/lock", headers=hdrs)
    assert resp.status_code == 200, resp.text
    locked = resp.json()
    assert locked["locked_at"] is not None
    assert locked["locked_by_name"] == "R X"

    await _refused(client, hdrs, plan, 409, "plan_locked", project_start="2026-11-09")
    for fields in ({"calendar": _calendar()}, {"timezone": "UTC"},
                   {"settings": {"show_times": True}},
                   {"status_date": "2026-11-04", "timezone": "UTC"}):
        await _refused(client, hdrs, plan, 409, "plan_locked", **fields)
    body = await _patched(client, hdrs, plan, status_date="2026-11-04T12:00")
    assert body["status_date"] == "2026-11-04T12:00"
    await _fails(client, hdrs, plan, [{"op": "add_task", "name": "B"}], 409, "plan_locked")

    resp = await client.delete(f"/plans/{plan['id']}/lock", headers=hdrs)
    assert resp.status_code == 200, resp.text
    unlocked = resp.json()
    assert unlocked["locked_at"] is None and unlocked["locked_by_name"] is None
    out = await _ok(client, hdrs, plan, [{"op": "add_task", "temp_id": "b", "name": "B"},
                                         {"op": "delete_tasks", "ids": [ids["A"]]}])
    assert out["deleted_tasks"] == [ids["A"]]


async def test_lock_bumps_the_version_and_audits(client, db):
    hdrs, _move, plan = await _setup(client, db)
    locked = (await client.post(f"/plans/{plan['id']}/lock", headers=hdrs)).json()
    assert locked["version"] == plan["version"] + 1
    # locking a locked plan changes nothing
    again = (await client.post(f"/plans/{plan['id']}/lock", headers=hdrs)).json()
    assert again["version"] == locked["version"] and again["locked_at"] == locked["locked_at"]
    unlocked = (await client.delete(f"/plans/{plan['id']}/lock", headers=hdrs)).json()
    assert unlocked["version"] == locked["version"] + 1
    again = (await client.delete(f"/plans/{plan['id']}/lock", headers=hdrs)).json()
    assert again["version"] == unlocked["version"]
    assert [r.entity_id for r in await _audits(db, "plan_lock")] == [plan["id"]]
    assert [r.entity_id for r in await _audits(db, "plan_unlock")] == [plan["id"]]


async def test_locked_plan_accepts_an_owner(client, db):
    email = f"pl-{uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    me = await _person_id(db, email)
    _h, _move, plan = await _setup(client, db)
    await client.post(f"/plans/{plan['id']}/lock", headers=hdrs)
    body = await _patched(client, hdrs, plan, owner_id=str(me))
    assert body["owner_id"] == str(me)


# ── baseline ─────────────────────────────────────────────────────────


async def test_baseline(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", duration="2d")
    await _ok(client, hdrs, plan, [{"op": "add_link", "predecessor_id": ids["A"],
                                    "successor_id": ids["B"]}])
    resp = await client.post(f"/plans/{plan['id']}/baseline", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["baseline_set_at"] is not None
    for task in body["tasks"]:
        assert task["baseline_start"] == task["start"]
        assert task["baseline_finish"] == task["finish"]
        assert task["baseline_duration_minutes"] == task["duration_minutes"]

    resp = await client.post(f"/plans/{plan['id']}/baseline", headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "baseline_exists",
                                     "set_at": body["baseline_set_at"]}

    # the schedule moves; the baseline stays until it is replaced
    await _ok(client, hdrs, plan, [{"op": "update_task", "id": ids["A"],
                                    "fields": {"duration": "3d"}}])
    moved = _by_id(await _get(client, hdrs, plan))[ids["B"]]
    assert moved["start"] == "2026-11-05T08:00"
    assert moved["baseline_start"] == "2026-11-04T08:00"

    resp = await client.post(f"/plans/{plan['id']}/baseline", headers=hdrs,
                             json={"replace": True})
    assert resp.status_code == 200, resp.text
    replaced = resp.json()
    assert _by_id(replaced)[ids["B"]]["baseline_start"] == "2026-11-05T08:00"
    assert replaced["version"] == body["version"] + 2

    resp = await client.delete(f"/plans/{plan['id']}/baseline", headers=hdrs)
    assert resp.status_code == 200, resp.text
    cleared = resp.json()
    assert cleared["baseline_set_at"] is None
    for task in cleared["tasks"]:
        assert task["baseline_start"] is None and task["baseline_finish"] is None
        assert task["baseline_duration_minutes"] is None
    assert cleared["version"] == replaced["version"] + 1
    actions = [r.action for r in await _audits(db, "plan_baseline_set")
               + await _audits(db, "plan_baseline_clear")]
    assert actions == ["plan_baseline_set", "plan_baseline_set", "plan_baseline_clear"]


async def test_baseline_on_a_locked_plan(client, db, monkeypatch):
    hdrs, _move, plan = await _setup(client, db)
    await _add(client, hdrs, plan, "A")
    await client.post(f"/plans/{plan['id']}/lock", headers=hdrs)

    async def no_load(*_args):
        raise AssertionError("a locked plan is refused before its tasks are loaded")

    monkeypatch.setattr(plan_writes, "load_state", no_load)
    monkeypatch.setattr(service, "load_state", no_load)
    for method in ("post", "delete"):
        resp = await getattr(client, method)(f"/plans/{plan['id']}/baseline", headers=hdrs)
        assert resp.status_code == 409, method
        assert resp.json()["detail"]["code"] == "plan_locked"


async def test_baseline_unknown_body_field(client, db):
    hdrs, _move, plan = await _setup(client, db)
    resp = await client.post(f"/plans/{plan['id']}/baseline", headers=hdrs,
                             json={"replace": True, "when": "now"})
    assert resp.status_code == 422


# ── version probe ────────────────────────────────────────────────────


async def test_version_probe(client, db):
    hdrs, _move, plan = await _setup(client, db)
    out = await _ok(client, hdrs, plan, [{"op": "add_task", "name": "A"}])
    resp = await client.get(f"/plans/{plan['id']}/version", headers=hdrs)
    assert resp.status_code == 200, resp.text
    probe = resp.json()
    assert probe["version"] == out["version"]
    assert set(probe) == {"version", "updated_at", "updated_by_name"}
    assert probe["updated_by_name"] == "R X"
    assert probe["updated_at"] is not None


# ── access ───────────────────────────────────────────────────────────


async def test_plan_routes_need_project_plans(client, db, seeded_user):
    hdrs, _move, plan = await _setup(client, db)
    staff = await login(client)
    calls = (
        ("patch", f"/plans/{plan['id']}", {"base_version": 1}),
        ("post", f"/plans/{plan['id']}/lock", None),
        ("delete", f"/plans/{plan['id']}/lock", None),
        ("post", f"/plans/{plan['id']}/baseline", None),
        ("delete", f"/plans/{plan['id']}/baseline", None),
        ("get", f"/plans/{plan['id']}/version", None),
    )
    for method, url, body in calls:
        kwargs = {"json": body} if body is not None else {}
        resp = await client.request(method.upper(), url, headers=staff, **kwargs)
        assert resp.status_code == 403, (method, url)
        resp = await client.request(method.upper(), url.replace(plan["id"], str(uuid4())),
                                    headers=hdrs, **kwargs)
        assert resp.status_code == 404, (method, url)
        assert resp.json()["detail"]["code"] == "plan_not_found"


# ── system settings ──────────────────────────────────────────────────


async def test_system_settings_round_trip(client, db, seeded_user):
    hdrs, _move, plan = await _setup(client, db)
    resp = await client.get("/system/project-plans", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == SYSTEM_DEFAULTS

    resp = await client.put("/system/project-plans", headers=hdrs,
                            json={"reminders": REMINDERS})
    assert resp.status_code == 200, resp.text
    assert resp.json()["reminders"]["offsets_days"] == [7, 2]
    got = (await client.get("/system/project-plans", headers=hdrs)).json()
    assert got == {**SYSTEM_DEFAULTS, "reminders": REMINDERS}

    staff = await login(client)
    assert (await client.get("/system/project-plans", headers=staff)).status_code == 200
    resp = await client.put("/system/project-plans", headers=staff,
                            json={"honor_constraints": False})
    assert resp.status_code == 403

    resp = await client.put("/system/project-plans", headers=hdrs,
                            json={"reminders": {**REMINDERS, "offsets_days": [0]}})
    assert resp.status_code == 422

    # a plan inherits the system values it does not override, live
    body = await _get(client, hdrs, plan)
    assert body["settings"]["reminders"]["offsets_days"] == [7, 2]


async def test_system_settings_validate(client, db):
    hdrs, _move, _plan = await _setup(client, db)
    for bad in (
        {"reminders": {**REMINDERS, "offsets_days": [3, 3]}},
        {"reminders": {**REMINDERS, "offsets_days": []}},
        {"reminders": {**REMINDERS, "offsets_days": [1, 2, 3, 4, 5, 6]}},
        {"reminders": {**REMINDERS, "offsets_days": [366]}},
        {"reminders": {**REMINDERS, "send_time": "7:30"}},
        {"reminders": {**REMINDERS, "overdue": "weekly"}},
        {"reminders": {"offsets_days": [7, 2]}},            # a group is replaced whole
        {"completion": {"subtasks": "skip", "predecessors": "block"}},
        {"completion": {"subtasks": "cascade", "predecessors": "maybe"}},
        {"completion": {"subtasks": "cascade"}},
        {"default_task_mode": "fixed"},
        {"critical_slack_days": 31},
        {"critical_slack_days": -1},
        {"critical_slack_days": False},
        {"show_times": "true"},
        {"default_duration": "soon"},
        {"honor_constraints": None},
        {"unknown": 1},
    ):
        resp = await client.put("/system/project-plans", headers=hdrs, json=bad)
        assert resp.status_code == 422, (bad, resp.text)
    for calendar in (_calendar(hours_per_day=25), {"week": {}}, _calendar(extra=1)):
        resp = await client.put("/system/project-plans", headers=hdrs,
                                json={"calendar": calendar})
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "bad_calendar"
    assert await _audits(db, "project_plans_config_update") == []


async def test_system_settings_put_audits_and_sorts(client, db):
    hdrs, _move, _plan = await _setup(client, db)
    calendar = _calendar(exceptions=[{"date": "2026-11-26", "name": "Thanksgiving",
                                      "hours": []}])
    resp = await client.put("/system/project-plans", headers=hdrs, json={
        "reminders": {**REMINDERS, "offsets_days": [2, 14, 7]},
        "completion": {"subtasks": "block", "predecessors": "warn"},
        "critical_slack_days": 2, "default_duration": "4h", "calendar": calendar,
        "honor_constraints": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reminders"]["offsets_days"] == [14, 7, 2]
    assert body["calendar"]["exceptions"] == calendar["exceptions"]
    [row] = await _audits(db, "project_plans_config_update")
    assert row.entity_type == "system" and row.entity_id == "project_plans"
    assert row.changes["critical_slack_days"] == {"from": 0, "to": 2}
    assert row.changes["completion"] == {
        "from": {"subtasks": "cascade", "predecessors": "block"},
        "to": {"subtasks": "block", "predecessors": "warn"}}
    assert "honor_constraints" not in row.changes          # unchanged
    # the defaults themselves were not edited through the shared dicts
    assert DEFAULTS["project_plans"]["reminders"]["offsets_days"] == [3, 1]
    assert DEFAULTS["project_plans"]["calendar"]["exceptions"] == []

    # a new plan copies the system calendar
    _h, _move2, plan2 = await _setup(client, db)
    assert plan2["calendar"]["exceptions"] == calendar["exceptions"]


async def test_system_default_duration_is_capped(client, db):
    """10 years of working time in the units of the calendar sent with it,
    else the system calendar's."""
    hdrs, _move, _plan = await _setup(client, db)
    four_hours = _calendar(hours_per_day=4)
    for body in ({"default_duration": "2601d"}, {"default_duration": "3651ed"},
                 {"default_duration": "20000h", "calendar": four_hours}):
        resp = await client.put("/system/project-plans", headers=hdrs, json=body)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json()["detail"] == {"code": "bad_field", "field": "default_duration"}
    await _put_system(client, hdrs, default_duration="20000h")
    await _put_system(client, hdrs, default_duration="1d", calendar=four_hours)
    resp = await client.put("/system/project-plans", headers=hdrs,
                            json={"default_duration": "20000h"})
    assert resp.status_code == 422, resp.text
    assert (await client.get("/system/project-plans", headers=hdrs)).json()[
        "default_duration"] == "1d"


async def test_system_non_finite_slack_days(client, db):
    hdrs, _move, _plan = await _setup(client, db)
    for number in ("NaN", "Infinity", "-Infinity"):
        resp = await _raw(client, "PUT", "/system/project-plans", hdrs,
                          f'{{"critical_slack_days": {number}}}')
        assert resp.status_code == 422, (number, resp.text)
    assert await _audits(db, "project_plans_config_update") == []


async def test_system_put_recalculates_inheriting_plans(client, db):
    """B (1 day beside a 3-day A) has 2 days of slack. Raising the system's
    critical slack to 2 days marks it critical in every plan that inherits
    the setting, locked or not, and bumps those plans; a plan overriding
    the key is left alone, and a PUT of anything else bumps no plan."""
    hdrs, _move, inherits = await _setup(client, db)
    _h2, _move2, overrides = await _setup(client, db)
    ids, other = {}, {}
    for plan, named in ((inherits, ids), (overrides, other)):
        named |= await _add(client, hdrs, plan, "A", duration="3d")
        named |= await _add(client, hdrs, plan, "B", duration="1d")
    await _patched(client, hdrs, overrides, settings={"critical_slack_days": 0})
    await client.post(f"/plans/{inherits['id']}/lock", headers=hdrs)
    before = {p["id"]: (await _get(client, hdrs, p))["version"] for p in (inherits, overrides)}

    await _put_system(client, hdrs, critical_slack_days=2)
    got = await _get(client, hdrs, inherits)
    assert _by_id(got)[ids["B"]]["is_critical"] is True
    assert got["version"] == before[inherits["id"]] + 1
    assert got["locked_at"] is not None
    kept = await _get(client, hdrs, overrides)
    assert _by_id(kept)[other["B"]]["is_critical"] is False
    assert kept["version"] == before[overrides["id"]]
    probe = (await client.get(f"/plans/{inherits['id']}/version", headers=hdrs)).json()
    assert probe["updated_by_name"] == "R X"

    # a PUT that leaves both scheduling keys as they are bumps nothing
    await _put_system(client, hdrs, default_task_mode="manual", critical_slack_days=2,
                      honor_constraints=True)
    assert (await _get(client, hdrs, inherits))["version"] == got["version"]
    assert (await _get(client, hdrs, overrides))["version"] == kept["version"]

    # honor_constraints reaches plans the same way
    await _put_system(client, hdrs, honor_constraints=False)
    assert (await _get(client, hdrs, inherits))["version"] == got["version"] + 1
    assert (await _get(client, hdrs, overrides))["version"] == kept["version"] + 1


async def test_system_put_keeps_dates_of_a_plan_the_engine_refuses(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", duration="2d")
    before = await _get(client, hdrs, plan)
    await _loop(db, ids)
    await _put_system(client, hdrs, honor_constraints=False)
    after = await _get(client, hdrs, plan)
    assert [(t["start"], t["finish"]) for t in after["tasks"]] == [
        (t["start"], t["finish"]) for t in before["tasks"]]
    assert after["settings"]["honor_constraints"] is False
    # its next write reports the loop
    await _refused(client, hdrs, plan, 422, "link_cycle", project_start="2026-11-09")
