"""POST /plans/{plan_id}/ops: atomic batches of task edits (add, update,
delete, move, indent, outdent, restore) with optimistic versioning, the
generic undo (`inverse`), the schedule lock and MS Project's editing rules.

Reference week (Standard calendar): the plan starts Mon 2026-11-02 08:00."""

import copy
import json
import uuid
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, InitiativePerson, Partner, Person
from serversherpa.plans import ops, ops_inverse
from serversherpa.plans.models import PlanAssignment, PlanLink, PlanTask, ProjectPlan
from serversherpa.plans.ops_inverse import check_signature, sign_restore
from serversherpa.plans.schemas import RestoreOp
from tests.test_plans_api import _admin, _create, _initiative, _plan_row

# ── helpers ──────────────────────────────────────────────────────────


async def _setup(client, db, **body):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    plan = await _create(client, hdrs, move, **body)
    return hdrs, move, plan


async def _get(client, hdrs, plan) -> dict:
    resp = await client.get(f"/initiatives/{plan['initiative_id']}/plan", headers=hdrs)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _ops(client, hdrs, plan, ops, version=None):
    """Post a batch with the plan's current version unless one is given."""
    if version is None:
        version = (await _get(client, hdrs, plan))["version"]
    return await client.post(f"/plans/{plan['id']}/ops", headers=hdrs,
                             json={"base_version": version, "ops": ops})


async def _ok(client, hdrs, plan, ops, version=None) -> dict:
    resp = await _ops(client, hdrs, plan, ops, version)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _fails(client, hdrs, plan, ops, status, code, version=None) -> dict:
    resp = await _ops(client, hdrs, plan, ops, version)
    assert resp.status_code == status, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == code, detail
    return detail


async def _add(client, hdrs, plan, *names, **fields) -> dict[str, str]:
    """Add top-level tasks (1 day each unless `duration` is given); name -> id."""
    ops = [{"op": "add_task", "temp_id": n, "name": n, **fields} for n in names]
    body = await _ok(client, hdrs, plan, ops)
    return {n: body["temp_ids"][n] for n in names}


def _by_id(body) -> dict[str, dict]:
    return {t["id"]: t for t in body["tasks"]}


def _update(task_id, **fields) -> dict:
    return {"op": "update_task", "id": task_id, "fields": fields}


def _signed(plan, **fields) -> dict:
    """A restore op signed the way the server signs the inverses it sends,
    to reach the content checks behind the signature."""
    op = {"op": "restore", "tasks": [], "links": [], "assignments": [],
          "remove_tasks": [], "remove_links": [], **fields}
    return {**op, "sig": sign_restore(plan["id"], op)}


def _comparable(body) -> list[dict]:
    """A plan's tasks without the edit stamps."""
    return [{k: v for k, v in t.items() if k != "updated_at"} for t in body["tasks"]]


# ── add / insert / update ────────────────────────────────────────────


async def test_add_tasks_and_schedule(client, db):
    hdrs, _move, plan = await _setup(client, db)
    body = await _ok(client, hdrs, plan, [
        {"op": "add_task", "temp_id": "a", "name": "A", "duration": "2d"},
        {"op": "add_task", "temp_id": "b", "name": "B", "duration": "1d"},
    ])
    a, b = body["temp_ids"]["a"], body["temp_ids"]["b"]
    assert body["version"] == 2
    assert body["order"] == [a, b]
    tasks = _by_id(body)
    assert set(tasks) == {a, b}
    assert tasks[a]["start"] == tasks[b]["start"] == "2026-11-02T08:00"
    assert tasks[a]["finish"] == "2026-11-03T17:00"
    assert tasks[b]["finish"] == "2026-11-02T17:00"
    assert tasks[a]["display_id"] == 1 and tasks[b]["display_id"] == 2
    assert body["deleted_tasks"] == [] and body["deleted_links"] == []
    assert body["notices"] == []
    assert len(body["inverse"]) == 1 and body["inverse"][0]["op"] == "restore"
    assert sorted(body["inverse"][0]["remove_tasks"]) == sorted([a, b])

    got = await _get(client, hdrs, plan)
    assert got["version"] == 2
    assert [t["name"] for t in got["tasks"]] == ["A", "B"]


async def test_insert_before(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    body = await _ok(client, hdrs, plan, [
        {"op": "add_task", "temp_id": "c", "name": "C", "before_id": ids["B"]}])
    c = body["temp_ids"]["c"]
    assert body["order"] == [ids["A"], c, ids["B"]]
    got = await _get(client, hdrs, plan)
    assert [t["name"] for t in got["tasks"]] == ["A", "C", "B"]
    assert [t["position"] for t in got["tasks"]] == [0, 1, 2]


async def test_add_as_last_child(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    body = await _ok(client, hdrs, plan, [
        {"op": "add_task", "temp_id": "x", "name": "X", "parent_id": ids["A"]},
        {"op": "add_task", "temp_id": "y", "name": "Y", "parent_id": ids["A"]},
        {"op": "add_task", "temp_id": "z", "name": "Z"},
    ])
    x, y, z = (body["temp_ids"][k] for k in "xyz")
    assert body["order"] == [ids["A"], x, y, ids["B"], z]
    got = await _get(client, hdrs, plan)
    tasks = {t["name"]: t for t in got["tasks"]}
    assert tasks["X"]["parent_id"] == tasks["Y"]["parent_id"] == ids["A"]
    assert tasks["A"]["is_summary"] is True
    assert [t["wbs"] for t in got["tasks"]] == ["1", "1.1", "1.2", "2", "3"]


async def test_add_task_defaults(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    got = await _get(client, hdrs, plan)
    a = got["tasks"][0]
    assert a["id"] == ids["A"]
    # system defaults: auto, 1 day, not on the timeline
    assert a["mode"] == "auto"
    assert a["duration_minutes"] == 480 and a["duration_text"] == "1 day"
    assert a["show_on_timeline"] is False and a["is_milestone"] is False

    # plan overrides: manual tasks of 4 hours; a milestone shows on the timeline
    row = await _plan_row(db, move)
    row.settings = {"default_task_mode": "manual", "default_duration": "4h"}
    await db.commit()
    body = await _ok(client, hdrs, plan, [
        {"op": "add_task", "temp_id": "b", "name": "B"},
        {"op": "add_task", "temp_id": "m", "name": "M", "duration": "0"},
    ])
    tasks = _by_id(body)
    b, m = tasks[body["temp_ids"]["b"]], tasks[body["temp_ids"]["m"]]
    assert b["mode"] == "manual" and b["duration_text"] == "4 hrs"
    assert b["start"] == "2026-11-02T08:00" and b["finish"] == "2026-11-02T12:00"
    assert m["is_milestone"] is True and m["show_on_timeline"] is True


async def test_update_duration_reschedules(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    body = await _ok(client, hdrs, plan, [_update(ids["A"], duration="3d")])
    tasks = _by_id(body)
    # the rows whose stored fields changed: A, and B through its slack
    assert set(tasks) == {ids["A"], ids["B"]}
    assert tasks[ids["B"]]["total_slack_minutes"] == 960
    assert tasks[ids["A"]]["finish"] == "2026-11-04T17:00"
    assert tasks[ids["A"]]["duration_text"] == "3 days"
    assert body["order"] is None          # no outline change


async def test_zero_duration_makes_milestone(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    body = await _ok(client, hdrs, plan, [_update(ids["A"], duration="0")])
    a = _by_id(body)[ids["A"]]
    assert a["is_milestone"] is True
    assert a["start"] == a["finish"] == "2026-11-02T08:00"
    assert a["duration_text"] == "0 days"

    # a non-zero duration on a milestone made by a 0 duration clears the flag
    body = await _ok(client, hdrs, plan, [_update(ids["A"], duration="2d")])
    assert _by_id(body)[ids["A"]]["is_milestone"] is False

    # a flagged milestone with work keeps the flag when its duration changes
    await _ok(client, hdrs, plan, [_update(ids["A"], is_milestone=True)])
    body = await _ok(client, hdrs, plan, [_update(ids["A"], duration="3d")])
    assert _by_id(body)[ids["A"]]["is_milestone"] is True


async def test_typed_start_adds_snet(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    body = await _ok(client, hdrs, plan, [_update(ids["A"], start="2026-11-05")])
    a = _by_id(body)[ids["A"]]
    assert a["constraint_type"] == "snet"
    assert a["constraint_date"] == "2026-11-05T08:00"
    assert a["start"] == "2026-11-05T08:00"
    assert a["duration_minutes"] == 480
    assert body["notices"] == [
        {"code": "constraint_added", "task_id": ids["A"], "constraint_type": "snet"}]


async def test_typed_finish_adds_fnet(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    body = await _ok(client, hdrs, plan, [_update(ids["A"], finish="2026-11-05")])
    a = _by_id(body)[ids["A"]]
    # a date-only finish is the calendar's default end time
    assert a["constraint_type"] == "fnet"
    assert a["constraint_date"] == "2026-11-05T17:00"
    assert (a["start"], a["finish"]) == ("2026-11-05T08:00", "2026-11-05T17:00")
    assert body["notices"] == [
        {"code": "constraint_added", "task_id": ids["A"], "constraint_type": "fnet"}]


async def test_typed_start_and_finish_on_auto(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    body = await _ok(client, hdrs, plan, [
        _update(ids["A"], start="2026-11-03", finish="2026-11-05")])
    a = _by_id(body)[ids["A"]]
    assert a["constraint_type"] == "snet"
    assert a["constraint_date"] == "2026-11-03T08:00"
    assert a["duration_minutes"] == 3 * 480
    assert (a["start"], a["finish"]) == ("2026-11-03T08:00", "2026-11-05T17:00")
    assert [n["constraint_type"] for n in body["notices"]] == ["snet"]

    detail = await _fails(client, hdrs, plan, [
        _update(ids["A"], start="2026-11-05", finish="2026-11-03")], 422, "bad_field")
    assert detail["field"] == "finish"


async def test_manual_task_dates(client, db):
    hdrs, _move, plan = await _setup(client, db)
    body = await _ok(client, hdrs, plan, [{
        "op": "add_task", "temp_id": "m", "name": "M", "mode": "manual",
        "start": "2026-11-03T10:00", "finish": "2026-11-04T15:00"}])
    m = _by_id(body)[body["temp_ids"]["m"]]
    assert (m["start"], m["finish"]) == ("2026-11-03T10:00", "2026-11-04T15:00")
    assert m["duration_minutes"] == 720
    assert m["constraint_type"] == "asap"
    assert body["notices"] == []

    # a finish before the start is refused
    detail = await _fails(client, hdrs, plan, [
        _update(m["id"], finish="2026-11-03T09:00")], 422, "bad_field")
    assert detail["field"] == "finish"

    # a finish alone keeps the start and changes the duration
    body = await _ok(client, hdrs, plan, [_update(m["id"], finish="2026-11-03T17:00")])
    m = _by_id(body)[m["id"]]
    assert (m["start"], m["finish"]) == ("2026-11-03T10:00", "2026-11-03T17:00")
    assert m["duration_minutes"] == 360


async def test_manual_duration_moves_finish(client, db):
    hdrs, _move, plan = await _setup(client, db)
    body = await _ok(client, hdrs, plan, [{
        "op": "add_task", "temp_id": "m", "name": "M", "mode": "manual",
        "start": "2026-11-03T10:00", "finish": "2026-11-04T15:00"}])
    mid = body["temp_ids"]["m"]
    body = await _ok(client, hdrs, plan, [_update(mid, duration="1d")])
    m = _by_id(body)[mid]
    assert (m["start"], m["finish"]) == ("2026-11-03T10:00", "2026-11-04T10:00")
    assert m["duration_minutes"] == 480 and m["duration_text"] == "1 day"
    # and it sticks: the next recalc does not write the old span back
    await _ok(client, hdrs, plan, [_update(mid, name="M2")])
    m = {t["id"]: t for t in (await _get(client, hdrs, plan))["tasks"]}[mid]
    assert m["finish"] == "2026-11-04T10:00" and m["duration_minutes"] == 480

    # a start alone moves the task and keeps its duration
    body = await _ok(client, hdrs, plan, [_update(mid, start="2026-11-05T08:00")])
    m = _by_id(body)[mid]
    assert (m["start"], m["finish"]) == ("2026-11-05T08:00", "2026-11-05T17:00")
    assert m["constraint_type"] == "asap"


async def test_constraint_fields(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    # a non-ASAP constraint needs a date
    detail = await _fails(client, hdrs, plan, [
        _update(ids["A"], constraint_type="mso")], 422, "bad_field")
    assert detail["field"] == "constraint_date"

    body = await _ok(client, hdrs, plan, [
        _update(ids["A"], constraint_type="mso", constraint_date="2026-11-04")])
    a = _by_id(body)[ids["A"]]
    assert a["constraint_date"] == "2026-11-04T08:00"
    assert a["start"] == "2026-11-04T08:00"

    # finish constraints read a date-only value as the default end time
    body = await _ok(client, hdrs, plan, [
        _update(ids["A"], constraint_type="mfo", constraint_date="2026-11-05")])
    a = _by_id(body)[ids["A"]]
    assert a["constraint_date"] == "2026-11-05T17:00"
    assert a["finish"] == "2026-11-05T17:00"

    # ASAP drops the date
    body = await _ok(client, hdrs, plan, [
        _update(ids["A"], constraint_type="asap", constraint_date="2026-11-05")])
    a = _by_id(body)[ids["A"]]
    assert a["constraint_type"] == "asap" and a["constraint_date"] is None
    assert a["start"] == "2026-11-02T08:00"


async def test_other_fields(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    body = await _ok(client, hdrs, plan, [_update(
        ids["A"], name="Pack", notes="fragile", deadline="2026-11-04",
        show_on_timeline=True, percent_complete=40, actual_start="2026-11-02")])
    a = _by_id(body)[ids["A"]]
    assert a["name"] == "Pack" and a["notes"] == "fragile"
    assert a["deadline"] == "2026-11-04T17:00"
    assert a["show_on_timeline"] is True
    assert a["percent_complete"] == 40
    assert a["actual_start"] == "2026-11-02T08:00"

    body = await _ok(client, hdrs, plan, [_update(ids["A"], deadline=None, notes=None)])
    a = _by_id(body)[ids["A"]]
    assert a["deadline"] is None and a["notes"] is None


async def test_bad_fields(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    cases = [
        ({"start": "Nov 5"}, "bad_field", "start"),
        ({"deadline": "2026-02-30"}, "bad_field", "deadline"),
        ({"mode": "fixed"}, "bad_field", "mode"),
        ({"constraint_type": "never"}, "bad_field", "constraint_type"),
        ({"percent_complete": 101}, "bad_field", "percent_complete"),
        ({"name": None}, "bad_field", "name"),
        ({"duration": None}, "bad_field", "duration"),
        ({"duration": "soon"}, "bad_duration", "duration"),
        ({"duration": "-1d"}, "bad_duration", "duration"),
    ]
    for fields, code, field in cases:
        detail = await _fails(client, hdrs, plan, [_update(ids["A"], **fields)], 422, code)
        assert detail["field"] == field, fields


async def test_bad_placement(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["B"]]}])
    # before_id and parent_id must agree
    detail = await _fails(client, hdrs, plan, [
        {"op": "add_task", "name": "X", "before_id": ids["B"], "parent_id": ids["B"]}],
        422, "bad_field")
    assert detail["field"] == "parent_id"
    detail = await _fails(client, hdrs, plan, [
        {"op": "move_tasks", "ids": [ids["A"]], "before_id": ids["B"], "parent_id": None}],
        422, "bad_field")
    assert detail["field"] == "parent_id"
    body = await _ok(client, hdrs, plan, [
        {"op": "add_task", "temp_id": "x", "name": "X", "before_id": ids["B"],
         "parent_id": ids["A"]}])
    assert body["order"] == [ids["A"], body["temp_ids"]["x"], ids["B"]]
    # a temp id names one task
    detail = await _fails(client, hdrs, plan, [
        {"op": "add_task", "temp_id": "t", "name": "1"},
        {"op": "add_task", "temp_id": "t", "name": "2"}], 422, "bad_field")
    assert detail["field"] == "temp_id"


async def test_duration_cap(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    # 10 years of working time: 260 days a year
    body = await _ok(client, hdrs, plan, [_update(ids["A"], duration="2600d")])
    assert _by_id(body)[ids["A"]]["duration_minutes"] == 2600 * 480
    detail = await _fails(client, hdrs, plan, [_update(ids["A"], duration="2601d")],
                          422, "bad_duration")
    assert detail["field"] == "duration"
    await _fails(client, hdrs, plan, [_update(ids["A"], duration="999999999w")],
                 422, "bad_duration")
    await _fails(client, hdrs, plan, [{"op": "add_task", "name": "B", "duration": "99999ed"}],
                 422, "bad_duration")


# ── outline ──────────────────────────────────────────────────────────


async def test_indent_outdent(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    a, b, c = ids["A"], ids["B"], ids["C"]

    body = await _ok(client, hdrs, plan, [{"op": "indent", "ids": [b]}])
    assert _by_id(body)[b]["parent_id"] == a
    assert body["order"] == [a, b, c]
    got = {t["id"]: t for t in (await _get(client, hdrs, plan))["tasks"]}
    assert got[a]["is_summary"] is True

    body = await _ok(client, hdrs, plan, [{"op": "indent", "ids": [c]}])
    assert _by_id(body)[c]["parent_id"] == a

    # outdent: B moves up a level and the siblings after it become its subtasks
    body = await _ok(client, hdrs, plan, [{"op": "outdent", "ids": [b]}])
    got = {t["id"]: t for t in (await _get(client, hdrs, plan))["tasks"]}
    assert got[b]["parent_id"] is None
    assert got[c]["parent_id"] == b
    assert got[a]["is_summary"] is False and got[b]["is_summary"] is True
    assert body["order"] == [a, b, c]

    detail = await _fails(client, hdrs, plan, [{"op": "indent", "ids": [a]}],
                          422, "cannot_indent")
    assert detail["task_id"] == a
    detail = await _fails(client, hdrs, plan, [{"op": "outdent", "ids": [a]}],
                          422, "cannot_outdent")
    assert detail["task_id"] == a


async def test_insert_summary_task(client, db):
    """MS Project's Insert Summary Task in one batch: a new row above B, then
    B indented under it. B's UPDATE points at a row inserted in the same
    flush (the parent FK is checked at commit)."""
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    before = await _get(client, hdrs, plan)
    body = await _ok(client, hdrs, plan, [
        {"op": "add_task", "temp_id": "s", "name": "Summary", "before_id": ids["B"]},
        {"op": "indent", "ids": [ids["B"]]},
    ])
    s = body["temp_ids"]["s"]
    assert body["order"] == [ids["A"], s, ids["B"], ids["C"]]
    after = await _get(client, hdrs, plan)
    got = {t["id"]: t for t in after["tasks"]}
    assert got[ids["B"]]["parent_id"] == s and got[s]["is_summary"] is True

    undo = await _ok(client, hdrs, plan, body["inverse"])
    assert _comparable(await _get(client, hdrs, plan)) == _comparable(before)
    await _ok(client, hdrs, plan, undo["inverse"])
    assert _comparable(await _get(client, hdrs, plan)) == _comparable(after)


async def test_indent_and_outdent_several(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "P", "A", "B", "C")
    p, a, b, c = (ids[k] for k in "PABC")

    def levels(body):
        return [(t["name"], t["outline_level"]) for t in body["tasks"]]

    # given out of order; processed in outline order
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [c, b]}])
    got = await _get(client, hdrs, plan)
    assert levels(got) == [("P", 1), ("A", 1), ("B", 2), ("C", 2)]
    assert {t["name"]: t["parent_id"] for t in got["tasks"]}["C"] == a

    # a summary selected with its subtasks moves as one block
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [a, b, c]}])
    got = await _get(client, hdrs, plan)
    assert levels(got) == [("P", 1), ("A", 2), ("B", 3), ("C", 3)]
    assert {t["name"]: t["parent_id"] for t in got["tasks"]}["A"] == p

    # two siblings outdented together both move up one level
    await _ok(client, hdrs, plan, [{"op": "outdent", "ids": [b, c]}])
    got = await _get(client, hdrs, plan)
    assert levels(got) == [("P", 1), ("A", 2), ("B", 2), ("C", 2)]


async def test_move_tasks(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C", "D")
    a, b, c, d = (ids[k] for k in "ABCD")

    body = await _ok(client, hdrs, plan, [{"op": "move_tasks", "ids": [d, c], "before_id": a}])
    assert body["order"] == [c, d, a, b]

    body = await _ok(client, hdrs, plan, [{"op": "move_tasks", "ids": [c], "parent_id": b}])
    assert body["order"] == [d, a, b, c]
    got = {t["id"]: t for t in (await _get(client, hdrs, plan))["tasks"]}
    assert got[c]["parent_id"] == b and got[b]["is_summary"] is True

    # to the end of the plan
    body = await _ok(client, hdrs, plan, [{"op": "move_tasks", "ids": [d]}])
    assert body["order"] == [a, b, c, d]

    # never under itself or its own subtask
    for target in ({"parent_id": c}, {"parent_id": b}, {"before_id": c}, {"before_id": b}):
        await _fails(client, hdrs, plan, [{"op": "move_tasks", "ids": [b], **target}],
                     422, "cannot_move")


async def test_new_summary_drops_its_constraint(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [
        _update(ids["A"], constraint_type="mfo", constraint_date="2026-11-04")])
    body = await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["B"]]}])
    a = _by_id(body)[ids["A"]]
    assert a["is_summary"] is True
    assert a["constraint_type"] == "asap" and a["constraint_date"] is None
    assert body["notices"] == [{"code": "constraint_cleared", "task_id": ids["A"]}]

    # an SNET constraint is fine on a summary and stays
    ids = await _add(client, hdrs, plan, "C", "D")
    await _ok(client, hdrs, plan, [_update(ids["C"], start="2026-11-04")])
    body = await _ok(client, hdrs, plan, [
        {"op": "add_task", "name": "E", "parent_id": ids["C"]}])
    assert body["notices"] == []
    got = {t["id"]: t for t in (await _get(client, hdrs, plan))["tasks"]}
    assert got[ids["C"]]["is_summary"] is True
    assert got[ids["C"]]["constraint_type"] == "snet"


async def test_new_summary_with_a_finish_link_into_it_fails(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    row = await _plan_row(db, move)
    link = PlanLink(plan_id=row.id, predecessor_id=uuid.UUID(ids["C"]),
                    successor_id=uuid.UUID(ids["A"]), link_type="FF")
    db.add(link)
    await db.commit()
    version = (await _get(client, hdrs, plan))["version"]

    # indenting B makes A a summary, and an FF link cannot lead into one:
    # the batch fails rather than silently deleting the link
    detail = await _fails(client, hdrs, plan, [{"op": "indent", "ids": [ids["B"]]}],
                          422, "bad_summary_link")
    assert sorted(detail["task_ids"]) == sorted([ids["A"], ids["C"]])
    assert detail["display_ids"] == [1, 3]
    assert detail["link_ids"] == [str(link.id)]
    got = await _get(client, hdrs, plan)
    assert got["version"] == version
    assert all(t["parent_id"] is None for t in got["tasks"])
    assert len(got["links"]) == 1


async def test_summary_field_rejected(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["B"]]}])
    for fields in ({"duration": "2d"}, {"start": "2026-11-03"}, {"finish": "2026-11-03"},
                   {"percent_complete": 50}):
        detail = await _fails(client, hdrs, plan, [_update(ids["A"], **fields)],
                              422, "summary_field")
        assert detail["task_id"] == ids["A"]
        assert detail["field"] == next(iter(fields))
    # its name and notes are its own
    await _ok(client, hdrs, plan, [_update(ids["A"], name="Phase 1", notes="n")])
    # the rule follows the outline inside a batch
    ids = await _add(client, hdrs, plan, "C", "D")
    await _fails(client, hdrs, plan, [{"op": "indent", "ids": [ids["D"]]},
                                      _update(ids["C"], duration="3d")], 422, "summary_field")


async def test_delete_subtree(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C", "D")
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["B"], ids["C"]]}])
    row = await _plan_row(db, move)
    link = PlanLink(plan_id=row.id, predecessor_id=uuid.UUID(ids["B"]),
                    successor_id=uuid.UUID(ids["D"]))
    db.add(link)
    await db.commit()

    body = await _ok(client, hdrs, plan, [{"op": "delete_tasks", "ids": [ids["A"]]}])
    assert sorted(body["deleted_tasks"]) == sorted([ids["A"], ids["B"], ids["C"]])
    assert body["deleted_links"] == [str(link.id)]
    assert body["order"] == [ids["D"]]
    got = await _get(client, hdrs, plan)
    assert [t["name"] for t in got["tasks"]] == ["D"]
    assert got["links"] == []
    assert got["tasks"][0]["position"] == 0


# ── versioning, lock, atomicity, scope ───────────────────────────────


async def test_stale_version(client, db):
    hdrs, _move, plan = await _setup(client, db)
    await _add(client, hdrs, plan, "A")
    before = await _get(client, hdrs, plan)
    detail = await _fails(client, hdrs, plan, [{"op": "add_task", "name": "B"}],
                          409, "plan_changed", version=before["version"] - 1)
    assert detail == {"code": "plan_changed", "version": before["version"]}
    after = await _get(client, hdrs, plan)
    assert after["version"] == before["version"]
    assert _comparable(after) == _comparable(before)


async def test_batch_is_atomic(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    before = await _get(client, hdrs, plan)
    unknown = str(uuid4())
    detail = await _fails(client, hdrs, plan, [
        _update(ids["A"], name="X"),
        {"op": "add_task", "name": "New"},
        {"op": "delete_tasks", "ids": [ids["B"]]},      # written to the database
        _update(unknown, name="Y"),
    ], 422, "unknown_task")
    assert detail["task_id"] == unknown
    after = await _get(client, hdrs, plan)
    assert after["version"] == before["version"]
    assert _comparable(after) == _comparable(before)
    assert await db.scalar(select(func.count()).select_from(PlanTask)) == 2
    assert await db.scalar(select(func.count()).select_from(AuditLog)
                           .where(AuditLog.action == "plan_update")) == 1


async def test_other_plans_task_id(client, db):
    hdrs, _move, plan = await _setup(client, db)
    await _add(client, hdrs, plan, "A")
    other_move = await _initiative(db, name="Other")
    other = await _create(client, hdrs, other_move)
    theirs = await _add(client, hdrs, other, "Theirs")
    foreign = theirs["Theirs"]

    for op in (_update(foreign, name="Hijacked"),
               {"op": "delete_tasks", "ids": [foreign]},
               {"op": "indent", "ids": [foreign]},
               {"op": "move_tasks", "ids": [foreign]},
               {"op": "add_task", "name": "X", "parent_id": foreign},
               {"op": "add_task", "name": "X", "before_id": foreign},
               # behind a valid signature the rows are still checked
               _signed(plan, tasks=[{"id": foreign, "name": "Hijacked"}]),
               _signed(plan, remove_tasks=[foreign]),
               # re-creating a row under another plan's task id
               _signed(plan, tasks=[{"id": foreign, "name": "Hijacked", "position": 0}])):
        await _fails(client, hdrs, plan, [op], 422, "unknown_task")
    # and an unsigned one is not read at all
    await _fails(client, hdrs, plan, [{"op": "restore", "remove_tasks": [foreign]}],
                 422, "bad_restore")
    got = await _get(client, hdrs, other)
    assert [t["name"] for t in got["tasks"]] == ["Theirs"]


async def test_locked_refuses_structure(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    row = await _plan_row(db, move)
    row.locked_at = datetime.now(UTC)
    await db.commit()
    await _fails(client, hdrs, plan, [{"op": "add_task", "name": "B"}], 409, "plan_locked")
    await _fails(client, hdrs, plan, [_update(ids["A"], name="X")], 409, "plan_locked")
    await _fails(client, hdrs, plan, [_update(ids["A"], notes="n", name="X")],
                 409, "plan_locked")


async def test_progress_only_skips_version_and_lock(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    row = await _plan_row(db, move)
    row.locked_at = datetime.now(UTC)
    await db.commit()
    body = await _ok(client, hdrs, plan, [_update(ids["A"], notes="on site", percent_complete=20)],
                     version=1)
    assert body["version"] == 3
    assert _by_id(body)[ids["A"]]["notes"] == "on site"
    # its undo is a progress edit too
    body = await _ok(client, hdrs, plan, body["inverse"], version=1)
    a = _by_id(body)[ids["A"]]
    assert a["notes"] is None and a["percent_complete"] == 0


async def test_unknown_plan_and_permissions(client, db, seeded_user):
    from tests.test_sites_api import login

    hdrs, _move, plan = await _setup(client, db)
    resp = await client.post(f"/plans/{uuid4()}/ops", headers=hdrs,
                             json={"base_version": 1, "ops": [{"op": "add_task"}]})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "plan_not_found"

    staff = await login(client)
    resp = await client.post(f"/plans/{plan['id']}/ops", headers=staff,
                             json={"base_version": 1, "ops": [{"op": "add_task"}]})
    assert resp.status_code == 403


async def test_audit_row(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [_update(ids["A"], name="X"), _update(ids["B"], name="Y"),
                                   {"op": "indent", "ids": [ids["B"]]}])
    rows = (await db.scalars(select(AuditLog).where(AuditLog.action == "plan_update")
                             .order_by(AuditLog.at))).all()
    assert len(rows) == 2
    assert all(r.entity_type == "project_plan" and r.entity_id == plan["id"] for r in rows)
    assert rows[0].changes == {"ops": {"add_task": 2}}
    assert rows[1].changes == {"ops": {"update_task": 2, "indent": 1}}


async def test_rows_and_plan_stamped(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    a_id, b_id = uuid.UUID(ids["A"]), uuid.UUID(ids["B"])

    async def fresh(model, row_id):
        return await db.scalar(select(model).where(model.id == row_id)
                               .execution_options(populate_existing=True))

    a0 = (await fresh(PlanTask, a_id)).updated_at
    b0 = (await fresh(PlanTask, b_id)).updated_at
    # an edit that changes nothing stamps nothing
    body = await _ok(client, hdrs, plan, [_update(ids["B"], name="B")])
    assert body["tasks"] == [] and body["version"] == 3
    assert (await fresh(PlanTask, b_id)).updated_at == b0

    row = await _plan_row(db, move)
    db.add(PlanLink(plan_id=row.id, predecessor_id=a_id, successor_id=b_id))
    await db.commit()
    # lengthening A moves B through recalc alone; both rows are stamped
    body = await _ok(client, hdrs, plan, [_update(ids["A"], duration="2d")])
    assert set(_by_id(body)) == {ids["A"], ids["B"]}
    assert _by_id(body)[ids["B"]]["start"] == "2026-11-04T08:00"
    a, b = await fresh(PlanTask, a_id), await fresh(PlanTask, b_id)
    assert a.updated_at > a0 and b.updated_at > b0
    plan_row = await fresh(ProjectPlan, row.id)
    assert plan_row.version == 4
    assert a.updated_by == b.updated_by == plan_row.updated_by is not None


# ── undo ─────────────────────────────────────────────────────────────


async def test_inverse_round_trip(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    before = await _get(client, hdrs, plan)

    body = await _ok(client, hdrs, plan, [
        _update(ids["A"], name="A2"),
        {"op": "delete_tasks", "ids": [ids["B"]]},
        {"op": "add_task", "temp_id": "d", "name": "D"},
    ])
    d = body["temp_ids"]["d"]
    after = await _get(client, hdrs, plan)
    assert [t["name"] for t in after["tasks"]] == ["A2", "C", "D"]

    undo = await _ok(client, hdrs, plan, body["inverse"])
    assert undo["deleted_tasks"] == [d]
    assert undo["order"] == [ids["A"], ids["B"], ids["C"]]
    restored = await _get(client, hdrs, plan)
    assert _comparable(restored) == _comparable(before)

    await _ok(client, hdrs, plan, undo["inverse"])
    redone = await _get(client, hdrs, plan)
    assert _comparable(redone) == _comparable(after)
    assert [t["id"] for t in redone["tasks"]] == [ids["A"], ids["C"], d]


async def test_inverse_of_outline_edits(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C", "D", "E")
    await _ok(client, hdrs, plan, [_update(ids["A"], constraint_type="mso",
                                           constraint_date="2026-11-03")])
    before = await _get(client, hdrs, plan)
    body = await _ok(client, hdrs, plan, [
        {"op": "indent", "ids": [ids["B"], ids["C"]]},
        {"op": "move_tasks", "ids": [ids["E"]], "before_id": ids["A"]},
        {"op": "outdent", "ids": [ids["B"]]},
        _update(ids["D"], mode="manual", start="2026-11-04T10:00"),
    ])
    after = await _get(client, hdrs, plan)
    assert _comparable(after) != _comparable(before)
    undo = await _ok(client, hdrs, plan, body["inverse"])
    assert _comparable(await _get(client, hdrs, plan)) == _comparable(before)
    await _ok(client, hdrs, plan, undo["inverse"])
    assert _comparable(await _get(client, hdrs, plan)) == _comparable(after)


async def test_inverse_restores_links_and_assignments(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    worker = Person(first_name="Wanda", last_name="Worker")
    shipper = Partner(name="Champagne Logistics")
    db.add_all([worker, shipper])
    await db.flush()
    db.add(InitiativePerson(initiative_id=move.id, person_id=worker.id))
    row = await _plan_row(db, move)
    a, b, c = (uuid.UUID(ids[k]) for k in "ABC")
    ab = PlanLink(plan_id=row.id, predecessor_id=a, successor_id=b, lag_minutes=240,
                  lag_unit="h")
    bc = PlanLink(plan_id=row.id, predecessor_id=b, successor_id=c, link_type="SS")
    db.add_all([ab, bc, PlanAssignment(task_id=b, person_id=worker.id),
                PlanAssignment(task_id=b, partner_id=shipper.id)])
    await db.commit()
    # one recalc so the direct rows are scheduled before the snapshot
    await _ok(client, hdrs, plan, [_update(ids["A"], name="A")])
    before = await _get(client, hdrs, plan)

    body = await _ok(client, hdrs, plan, [{"op": "delete_tasks", "ids": [ids["B"]]}])
    assert sorted(body["deleted_links"]) == sorted([str(ab.id), str(bc.id)])
    undo = await _ok(client, hdrs, plan, body["inverse"])
    assert sorted(lk["id"] for lk in undo["links"]) == sorted([str(ab.id), str(bc.id)])
    restored = await _get(client, hdrs, plan)
    assert _comparable(restored) == _comparable(before)
    assert sorted(restored["links"], key=lambda lk: lk["id"]) == sorted(
        before["links"], key=lambda lk: lk["id"])
    b_task = {t["name"]: t for t in restored["tasks"]}["B"]
    assert {x["name"] for x in b_task["assignees"]} == {"Wanda Worker", "Champagne Logistics"}


async def test_restore_rejects_bad_rows(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    a, b = ids["A"], ids["B"]
    cases = [
        ({"tasks": [{"id": a, "colour": "red"}]}, "bad_field"),
        ({"tasks": [{"id": a, "position": "first"}]}, "bad_field"),
        ({"tasks": [{"id": a, "mode": "fixed"}]}, "bad_field"),
        ({"tasks": [{"id": a, "start": "soon"}]}, "bad_field"),
        ({"tasks": [{"id": a, "parent_id": b}, {"id": b, "parent_id": a}]}, "bad_field"),
        ({"tasks": [{"id": a, "parent_id": str(uuid4())}]}, "unknown_task"),
        ({"tasks": [{"id": str(uuid4()), "notes": "x"}]}, "unknown_task"),
        ({"remove_links": [str(uuid4())]}, "unknown_link"),
        ({"links": [{"id": str(uuid4()), "predecessor_id": a, "successor_id": a,
                     "link_type": "FS", "lag_minutes": 0, "lag_unit": "d",
                     "lag_elapsed": False}]}, "bad_link"),
        ({"assignments": [{"task_id": a, "resources": [
            {"kind": "person", "id": str(uuid4())}]}]}, "bad_resource"),
        ({"assignments": [{"task_id": a, "resources": [
            {"kind": "partner", "id": str(uuid4())}]}]}, "bad_resource"),
        ({"tasks": [{"id": a, "actual_start": "2026-11-03T08:00",
                     "actual_finish": "2026-11-02T17:00"}]}, "bad_field"),
        ({"tasks": [{"id": a, "position": 1_000_000}]}, "bad_restore"),
        ({"tasks": [{"id": a, "position": -1}]}, "bad_restore"),
    ]
    for body, code in cases:
        await _fails(client, hdrs, plan, [_signed(plan, **body)], 422, code)


async def test_restore_needs_the_server_signature(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    forger = Person(first_name="Fake", last_name="Finisher")
    shipper = Partner(name="Sham Freight")
    db.add_all([forger, shipper])
    await db.commit()
    body = await _ok(client, hdrs, plan, [_update(ids["A"], notes="on site")])
    inverse = body["inverse"][0]
    assert len(inverse["sig"]) == 64
    version = body["version"]

    def forged(**changes) -> dict:
        return {**copy.deepcopy(inverse), **changes}

    row = inverse["tasks"][0]
    stamped = forged(tasks=[{**row, "completed_by": str(forger.id),
                             "completed_at": "2026-11-02T09:00:00+00:00"}])
    for op in (
        {k: v for k, v in inverse.items() if k != "sig"},          # unsigned
        forged(sig="0" * 64),
        forged(sig="\u00e9" * 64),                                # not even hex
        forged(tasks=[{**row, "notes": "forged"}]),                # a tampered field
        stamped,                                                   # forged attribution
        forged(assignments=[{"task_id": ids["A"], "resources": [
            {"kind": "partner", "id": str(shipper.id)}]}]),        # an extra assignee
        forged(remove_tasks=[ids["A"]]),
    ):
        await _fails(client, hdrs, plan, [op], 422, "bad_restore")
    got = await _get(client, hdrs, plan)
    assert got["version"] == version
    assert got["tasks"][0]["notes"] == "on site"
    assert got["tasks"][0]["assignees"] == [] and got["tasks"][0]["completed_at"] is None

    # a forged progress-only restore gets no further on a locked plan
    row_plan = await _plan_row(db, move)
    row_plan.locked_at = datetime.now(UTC)
    await db.commit()
    await _fails(client, hdrs, plan, [stamped], 422, "bad_restore", version=1)

    # the genuine one applies (key order is not part of the signature), and
    # the undo it answers is signed too
    genuine = dict(reversed(list(copy.deepcopy(inverse).items())))
    body = await _ok(client, hdrs, plan, [genuine], version=1)
    assert _by_id(body)[ids["A"]]["notes"] is None
    redo = body["inverse"][0]
    assert len(redo["sig"]) == 64 and redo["sig"] != inverse["sig"]
    body = await _ok(client, hdrs, plan, [redo], version=1)
    assert _by_id(body)[ids["A"]]["notes"] == "on site"


async def test_restore_signature_is_bound_to_its_plan(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    body = await _ok(client, hdrs, plan, [_update(ids["A"], name="A2")])
    other = await _create(client, hdrs, await _initiative(db, name="Other"))
    await _add(client, hdrs, other, "B")
    await _fails(client, hdrs, other, body["inverse"], 422, "bad_restore")
    assert [t["name"] for t in (await _get(client, hdrs, other))["tasks"]] == ["B"]
    # still good on the plan it was issued for
    await _ok(client, hdrs, plan, body["inverse"])
    assert [t["name"] for t in (await _get(client, hdrs, plan))["tasks"]] == ["A"]


async def test_restore_signatures_are_checked_before_anything_runs(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    body = await _ok(client, hdrs, plan, [_update(ids["A"], name="A2")])
    forged = {**body["inverse"][0], "sig": "0" * 64}
    # an op that would fail runs first in the batch, but the forgery is named
    await _fails(client, hdrs, plan, [_update(str(uuid4()), name="X"), forged],
                 422, "bad_restore")
    # a structural forgery: refused for its signature, not for the stale
    # version or the lock (it never reaches the progress-only check)
    await _fails(client, hdrs, plan, [forged], 422, "bad_restore", version=1)
    row = await _plan_row(db, move)
    row.locked_at = datetime.now(UTC)
    await db.commit()
    await _fails(client, hdrs, plan, [forged], 422, "bad_restore")
    assert (await _get(client, hdrs, plan))["tasks"][0]["name"] == "A2"


async def test_restore_refuses_non_finite_numbers(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    body = await _ok(client, hdrs, plan, [_update(ids["A"], notes="on site")])
    inverse = body["inverse"][0]
    assert inverse["tasks"] == [{"id": ids["A"], "notes": None}]
    url, headers = f"/plans/{plan['id']}/ops", {**hdrs, "content-type": "application/json"}
    text = json.dumps({"base_version": body["version"], "ops": [inverse]})
    assert text.count('"notes": null') == 1
    for bad in ("NaN", "Infinity", "-Infinity"):
        # json reads these as floats; a normalized dump would sign them as null
        resp = await client.post(url, headers=headers,
                                 content=text.replace('"notes": null', f'"notes": {bad}'))
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == {"code": "bad_restore"}
        # anywhere in the payload
        nested = json.dumps({"base_version": body["version"], "ops": [
            {**inverse, "links": [{"lag_minutes": "@"}]}]}).replace('"@"', bad)
        resp = await client.post(url, headers=headers, content=nested)
        assert resp.json()["detail"] == {"code": "bad_restore"}, resp.text
    assert (await _get(client, hdrs, plan))["tasks"][0]["notes"] == "on site"


def test_every_restore_field_is_signed(monkeypatch):
    plan_id = uuid4()

    class Later(RestoreOp):
        note: str | None = None             # a field added after this test was written

    monkeypatch.setattr(ops_inverse, "RestoreOp", Later)
    sig = sign_restore(plan_id, {"op": "restore", "note": "a"})
    assert sign_restore(plan_id, {"op": "restore", "note": "b"}) != sig
    assert sign_restore(plan_id, {"op": "restore"}) != sig
    check_signature(plan_id, Later(op="restore", note="a", sig=sig))
    with pytest.raises(HTTPException) as exc:
        check_signature(plan_id, Later(op="restore", note="b", sig=sig))
    assert exc.value.detail == {"code": "bad_restore"}

    # and each field there is today (the signature never covers itself)
    base = {"op": "restore"}
    for name in Later.model_fields:
        if name not in ("op", "sig"):
            assert sign_restore(plan_id, {**base, name: ["x"]}) != sign_restore(plan_id, base)
    assert sign_restore(plan_id, {**base, "sig": "x"}) == sign_restore(plan_id, base)


async def test_dangling_parent_is_refused_inside_the_batch(client, db, monkeypatch):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A")
    real = ops.apply_ops

    async def dangling(db_, state, batch, actor, settings):
        result = await real(db_, state, batch, actor, settings)
        state.tasks[uuid.UUID(ids["A"])].parent_id = uuid4()     # no such task
        return result

    monkeypatch.setattr(ops, "apply_ops", dangling)
    detail = await _fails(client, hdrs, plan, [_update(ids["A"], name="B")], 422, "bad_field")
    assert detail["field"] == "parent_id"
    got = await _get(client, hdrs, plan)
    assert got["version"] == 2 and got["tasks"][0]["name"] == "A"
