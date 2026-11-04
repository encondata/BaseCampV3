"""GET /plans/timeline: the plan overlay on the all-initiatives Timeline page
(plans/timeline.py). Milestones are the tasks flagged Show on timeline whose
finish day falls in the asked range (both ends included); each visible plan
gets a summary: its top-level % complete (the engine's rollup rule over the
plan's leaves) and the next incomplete flagged task finishing on or after
the plan's own now.

Reference plan: created through the API on Mon 2026-11-02 (project start
08:00, America/New_York, the standard 8-hour calendar), every task ASAP from
the project start unless it carries a constraint."""

from datetime import UTC, datetime

from sqlalchemy import event

from serversherpa.db.engine import get_engine
from serversherpa.db.models import Initiative
from serversherpa.plans import service, timeline
from tests.test_plans_api import _admin, _create, _initiative, _plan_row, _task, dt
from tests.test_sites_api import login

# ── helpers ──────────────────────────────────────────────────────────


def _now(monkeypatch, text: str) -> None:
    """Every plan's "now" (the plan-local wall clock) at "YYYY-MM-DD HH:MM"."""
    at = dt(text)
    monkeypatch.setattr(timeline, "plan_now", lambda _zone: at)
    monkeypatch.setattr(service, "plan_now", lambda _zone: at)


async def _plan_with(db, client, hdrs, name, tasks):
    """An initiative and its plan holding `tasks` (built by `tasks(plan)`),
    scheduled by the engine and committed. Returns (initiative, plan, rows)."""
    move = await _initiative(db, name=name)
    await _create(client, hdrs, move)
    plan = await _plan_row(db, move)
    rows = tasks(plan)
    db.add_all(rows)
    await db.commit()
    state = await service.load_state(db, plan)
    service.recalc(state, await service.settings_of(db, plan))
    await db.commit()
    return move, plan, rows


async def _get(client, hdrs, start="2026-11-01", end="2026-11-30"):
    return await client.get("/plans/timeline", headers=hdrs,
                            params={"from": start, "to": end})


def _mine(body, move) -> list[dict]:
    return [m for m in body["milestones"] if m["initiative_id"] == str(move.id)]


# ── milestones ───────────────────────────────────────────────────────


async def test_milestones_in_range_only(client, db, monkeypatch):
    _now(monkeypatch, "2026-11-01 09:00")
    hdrs = await _admin(db, client)

    def tasks(plan):
        return [
            # Mon Nov 2 08:00 → Fri Nov 6 17:00
            _task(plan, 0, "Crates", duration_minutes=2400, show_on_timeline=True),
            # flagged, but finishes Fri Nov 20: outside the range asked
            _task(plan, 1, "Go live", duration_minutes=0, is_milestone=True,
                  show_on_timeline=True, constraint_type="snet",
                  constraint_date=dt("2026-11-20 08:00")),
            # in range, not flagged
            _task(plan, 2, "Pack", duration_minutes=960),
        ]

    move, plan, rows = await _plan_with(db, client, hdrs, "NAP11", tasks)
    resp = await _get(client, hdrs, "2026-11-01", "2026-11-10")
    assert resp.status_code == 200, resp.text
    assert _mine(resp.json(), move) == [{
        "initiative_id": str(move.id), "plan_id": str(plan.id), "task_id": str(rows[0].id),
        "name": "Crates", "at": "2026-11-06T17:00", "day": "2026-11-06",
        "complete": False, "late": False,
    }]

    later = await _get(client, hdrs, "2026-11-11", "2026-11-30")
    assert [m["name"] for m in _mine(later.json(), move)] == ["Go live"]
    assert _mine(later.json(), move)[0]["at"] == "2026-11-20T08:00"


async def test_range_ends_are_included(client, db, monkeypatch):
    _now(monkeypatch, "2026-11-01 09:00")
    hdrs = await _admin(db, client)
    move, _plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        _task(plan, 0, "Crates", duration_minutes=2400, show_on_timeline=True),
    ])
    for start, end in (("2026-11-06", "2026-11-06"), ("2026-11-01", "2026-11-06"),
                       ("2026-11-06", "2026-11-30")):
        body = (await _get(client, hdrs, start, end)).json()
        assert [m["name"] for m in _mine(body, move)] == ["Crates"], (start, end)
    for start, end in (("2026-11-01", "2026-11-05"), ("2026-11-07", "2026-11-30")):
        body = (await _get(client, hdrs, start, end)).json()
        assert _mine(body, move) == [], (start, end)


async def test_a_midnight_finish_is_the_day_before(client, db, monkeypatch):
    """The plan tab's finish-day rule (floatingTime `lastDay`): a task's day
    is that of its last working minute, so a finish at 00:00 ends the day
    before — unless the task is zero-length, which stays on its own day."""
    _now(monkeypatch, "2026-11-01 09:00")
    hdrs = await _admin(db, client)
    move, _plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        # manual, both dates typed: kept as they are
        _task(plan, 0, "Cure", mode="manual", start=dt("2026-11-03 20:00"),
              finish=dt("2026-11-05 00:00"), show_on_timeline=True),
        _task(plan, 1, "Cutover", mode="manual", is_milestone=True, duration_minutes=0,
              start=dt("2026-11-06 00:00"), finish=dt("2026-11-06 00:00"),
              show_on_timeline=True),
    ])
    body = (await _get(client, hdrs)).json()
    days = {m["name"]: (m["at"], m["day"]) for m in _mine(body, move)}
    assert days == {
        "Cure": ("2026-11-05T00:00", "2026-11-04"),
        "Cutover": ("2026-11-06T00:00", "2026-11-06"),
    }
    # the range is tested on the day: Cure is in a range ending Nov 4, not
    # in one starting Nov 5
    for start, end, want in (("2026-11-01", "2026-11-04", {"Cure"}),
                             ("2026-11-05", "2026-11-05", set()),
                             ("2026-11-06", "2026-11-06", {"Cutover"})):
        got = {m["name"] for m in _mine((await _get(client, hdrs, start, end)).json(), move)}
        assert got == want, (start, end)


async def test_next_carries_its_day(client, db, monkeypatch):
    _now(monkeypatch, "2026-11-01 09:00")
    hdrs = await _admin(db, client)
    move, _plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        _task(plan, 0, "Cure", mode="manual", start=dt("2026-11-03 20:00"),
              finish=dt("2026-11-05 00:00"), show_on_timeline=True),
    ])
    nxt = (await _get(client, hdrs)).json()["summaries"][str(move.id)]["next"]
    assert nxt == {"name": "Cure", "at": "2026-11-05T00:00", "day": "2026-11-04"}


async def test_complete_and_late(client, db, monkeypatch):
    _now(monkeypatch, "2026-11-05 12:00")
    hdrs = await _admin(db, client)
    move, _plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        # finishes Tue Nov 3 17:00, before now
        _task(plan, 0, "Late one", duration_minutes=960, show_on_timeline=True),
        _task(plan, 1, "Done one", duration_minutes=960, percent_complete=100,
              show_on_timeline=True),
        # finishes Fri Nov 6, but its deadline (Wed) has passed
        _task(plan, 2, "Missed deadline", duration_minutes=2400, show_on_timeline=True,
              deadline=dt("2026-11-04 17:00")),
        _task(plan, 3, "On time", duration_minutes=2400, show_on_timeline=True),
    ])
    states = {m["name"]: (m["complete"], m["late"]) for m in _mine((await _get(client, hdrs)).json(), move)}
    assert states == {
        "Late one": (False, True),
        "Done one": (True, False),
        "Missed deadline": (False, True),
        "On time": (False, False),
    }


async def test_late_reads_the_status_date(client, db, monkeypatch):
    """Lateness is the plan tab's status (service.task_status): against the
    status date when one is set."""
    _now(monkeypatch, "2026-11-05 12:00")
    hdrs = await _admin(db, client)
    move, plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        _task(plan, 0, "Pack", duration_minutes=960, show_on_timeline=True),
    ])
    plan.status_date = dt("2026-11-02 12:00")
    await db.commit()
    [only] = _mine((await _get(client, hdrs)).json(), move)
    assert only["late"] is False


# ── summaries ────────────────────────────────────────────────────────


async def test_percent_and_next_for_a_three_task_plan(client, db, monkeypatch):
    _now(monkeypatch, "2026-11-03 10:00")
    hdrs = await _admin(db, client)
    move, _plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        # complete: never "next", though it finishes after now (Fri Nov 6)
        _task(plan, 0, "Crates", duration_minutes=2400, percent_complete=100,
              show_on_timeline=True),
        # incomplete and after now, but not flagged
        _task(plan, 1, "Pack", duration_minutes=960, percent_complete=50),
        _task(plan, 2, "Move day", duration_minutes=0, is_milestone=True,
              show_on_timeline=True, constraint_type="snet",
              constraint_date=dt("2026-11-13 08:00")),
    ])
    body = (await _get(client, hdrs, "2026-12-01", "2026-12-31")).json()
    # duration-weighted over the leaves: (100*2400 + 50*960 + 0*0) / 3360 = 85.7
    # (a plain average of the three would be 50)
    assert body["summaries"][str(move.id)] == {
        "percent_complete": 86,
        "next": {"name": "Move day", "at": "2026-11-13T08:00", "day": "2026-11-13"},
    }


async def test_percent_counts_leaves_only(client, db, monkeypatch):
    _now(monkeypatch, "2026-11-03 10:00")
    hdrs = await _admin(db, client)

    def tasks(plan):
        phase = _task(plan, 0, "Phase")
        return [
            phase,
            _task(plan, 1, "Crates", parent_id=phase.id, duration_minutes=2400,
                  percent_complete=100),
            _task(plan, 2, "Pack", parent_id=phase.id, duration_minutes=480),
            _task(plan, 3, "Ship", duration_minutes=480, percent_complete=50),
        ]

    # (100*2400 + 0*480 + 50*480) / 3360 = 78.6; the summary's own row is skipped
    move, _plan, _rows = await _plan_with(db, client, hdrs, "NAP11", tasks)
    assert (await _get(client, hdrs)).json()["summaries"][str(move.id)]["percent_complete"] == 79


async def test_percent_of_zero_length_leaves_is_a_plain_average(client, db, monkeypatch):
    """Every leaf zero-length: each counts once (the engine's rule)."""
    _now(monkeypatch, "2026-11-03 10:00")
    hdrs = await _admin(db, client)
    move, _plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        _task(plan, 0, "Kickoff", duration_minutes=0, is_milestone=True, percent_complete=100),
        _task(plan, 1, "Sign-off", duration_minutes=0, is_milestone=True),
    ])
    assert (await _get(client, hdrs)).json()["summaries"][str(move.id)]["percent_complete"] == 50


async def test_next_is_the_earliest_on_or_after_now(client, db, monkeypatch):
    # Pack finishes Tue Nov 3 17:00: exactly now, so it is still next
    _now(monkeypatch, "2026-11-03 17:00")
    hdrs = await _admin(db, client)
    move, _plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        # Mon Nov 2 17:00: before now
        _task(plan, 0, "Labels", duration_minutes=480, show_on_timeline=True),
        _task(plan, 1, "Crates", duration_minutes=2400, show_on_timeline=True),
        _task(plan, 2, "Pack", duration_minutes=960, show_on_timeline=True),
    ])
    nxt = (await _get(client, hdrs)).json()["summaries"][str(move.id)]["next"]
    assert nxt == {"name": "Pack", "at": "2026-11-03T17:00", "day": "2026-11-03"}


async def test_next_ties_go_to_outline_order(client, db, monkeypatch):
    _now(monkeypatch, "2026-11-02 09:00")
    hdrs = await _admin(db, client)
    move, _plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        _task(plan, 0, "First", duration_minutes=480, show_on_timeline=True),
        _task(plan, 1, "Second", duration_minutes=480, show_on_timeline=True),
    ])
    nxt = (await _get(client, hdrs)).json()["summaries"][str(move.id)]["next"]
    assert nxt["name"] == "First"


async def test_next_uses_the_plan_now_not_the_status_date(client, db, monkeypatch):
    _now(monkeypatch, "2026-11-04 09:00")
    hdrs = await _admin(db, client)
    move, plan, _rows = await _plan_with(db, client, hdrs, "NAP11", lambda plan: [
        # Tue Nov 3 17:00: after the status date, before now
        _task(plan, 0, "Pack", duration_minutes=960, show_on_timeline=True),
    ])
    plan.status_date = dt("2026-11-02 09:00")
    await db.commit()
    assert (await _get(client, hdrs)).json()["summaries"][str(move.id)]["next"] is None


async def test_empty_plan_and_no_plan(client, db, monkeypatch):
    _now(monkeypatch, "2026-11-03 10:00")
    hdrs = await _admin(db, client)
    empty = await _initiative(db, name="Empty")
    await _create(client, hdrs, empty)
    bare = await _initiative(db, name="No plan")
    body = (await _get(client, hdrs)).json()
    assert body["summaries"][str(empty.id)] == {"percent_complete": 0, "next": None}
    assert str(bare.id) not in body["summaries"]


# ── access ───────────────────────────────────────────────────────────


async def test_staff_forbidden(client, db, seeded_user):
    hdrs = await login(client)
    resp = await _get(client, hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_initiatives_scope_applies(client, db, monkeypatch):
    """The plans are those of the initiatives the actor's scope reaches
    (`scope_conditions`, as GET /initiatives filters): an out-of-scope
    initiative's milestones and summary are left out."""
    _now(monkeypatch, "2026-11-01 09:00")
    hdrs = await _admin(db, client)

    def tasks(plan):
        return [_task(plan, 0, "Crates", duration_minutes=2400, show_on_timeline=True)]

    seen, _p1, _r1 = await _plan_with(db, client, hdrs, "Seen", tasks)
    await _plan_with(db, client, hdrs, "Hidden", tasks)
    calls = []

    def scoped(resource, access, person_id):
        calls.append(resource)
        return Initiative.id == seen.id

    monkeypatch.setattr(timeline, "scope_conditions", scoped)
    body = (await _get(client, hdrs)).json()
    assert calls and set(calls) == {"initiatives"}
    assert {m["initiative_id"] for m in body["milestones"]} == {str(seen.id)}
    assert set(body["summaries"]) == {str(seen.id)}


async def test_archived_initiatives_are_left_out(client, db, monkeypatch):
    """The Timeline page never shows an archived initiative, so its plan's
    milestones and summary aren't sent."""
    _now(monkeypatch, "2026-11-01 09:00")
    hdrs = await _admin(db, client)

    def tasks(plan):
        return [_task(plan, 0, "Crates", duration_minutes=2400, show_on_timeline=True)]

    live, _p1, _r1 = await _plan_with(db, client, hdrs, "Live", tasks)
    gone, _p2, _r2 = await _plan_with(db, client, hdrs, "Archived", tasks)
    gone.archived_at = datetime.now(UTC)
    await db.commit()
    body = (await _get(client, hdrs)).json()
    assert {m["initiative_id"] for m in body["milestones"]} == {str(live.id)}
    assert set(body["summaries"]) == {str(live.id)}


async def test_bad_range(client, db):
    hdrs = await _admin(db, client)
    resp = await _get(client, hdrs, "2026-11-30", "2026-11-01")
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "bad_range"}
    for params in ({"from": "2026-11-01"}, {"to": "2026-11-30"},
                   {"from": "11/01/2026", "to": "2026-11-30"}):
        resp = await client.get("/plans/timeline", headers=hdrs, params=params)
        assert resp.status_code == 422, params


# ── cost ─────────────────────────────────────────────────────────────


async def test_query_count_does_not_grow_with_plans(client, db, monkeypatch):
    """One query per plan set, never one per initiative."""
    _now(monkeypatch, "2026-11-01 09:00")
    hdrs = await _admin(db, client)

    def tasks(plan):
        return [_task(plan, 0, "Crates", duration_minutes=2400, show_on_timeline=True)]

    async def count() -> int:
        statements: list[str] = []

        def listener(conn, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        engine = get_engine().sync_engine
        event.listen(engine, "before_cursor_execute", listener)
        try:
            resp = await _get(client, hdrs)
        finally:
            event.remove(engine, "before_cursor_execute", listener)
        assert resp.status_code == 200
        return len(statements)

    await _plan_with(db, client, hdrs, "One", tasks)
    one = await count()
    for name in ("Two", "Three", "Four"):
        await _plan_with(db, client, hdrs, name, tasks)
    assert await count() == one

