"""Progress on project plans: % complete with its actuals and completion
stamps, the completion rules (subtasks cascade / block / none, predecessors
block / warn / none), Mark on Track, Update project, and progress-only
batches that apply on a locked plan and with a stale version.

Reference week (Standard calendar): the plan starts Mon 2026-11-02 08:00."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.plans import service
from serversherpa.plans.completion import Blocker, check_completion
from serversherpa.plans.models import PlanTask
from serversherpa.plans.service import load_state
from serversherpa.plans.settings import Completion
from tests.test_plans_api import _plan_row, dt
from tests.test_plans_ops import _add, _by_id, _fails, _get, _ok, _ops, _setup, _update

# ── helpers ──────────────────────────────────────────────────────────


def _pct(ids, percent, **extra) -> dict:
    return {"op": "set_percent", "ids": list(ids), "percent": percent, **extra}


def _complete(*ids, **extra) -> dict:
    return {"op": "complete", "ids": list(ids), **extra}


def _on_track(*ids, **extra) -> dict:
    return {"op": "mark_on_track", "ids": list(ids), **extra}


def _confirmed(op: dict) -> dict:
    return {**op, "confirm": True}


def _link(pred, succ, **fields) -> dict:
    return {"op": "add_link", "predecessor_id": pred, "successor_id": succ, **fields}


def _named(body) -> dict[str, dict]:
    return {t["name"]: t for t in body["tasks"]}


def _blocker(ids, name, display_id, reason) -> dict:
    return {"task_id": ids[name], "display_id": display_id, "name": name, "reason": reason}


async def _settings(db, move, **completion):
    row = await _plan_row(db, move)
    row.settings = {"completion": completion}
    await db.commit()


async def _lock(db, move):
    row = await _plan_row(db, move)
    row.locked_at = datetime.now(UTC)
    await db.commit()


async def _summary(client, hdrs, plan) -> dict[str, str]:
    """S{A, B}: display IDs S 1, A 2, B 3."""
    ids = await _add(client, hdrs, plan, "S", "A", "B")
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["A"], ids["B"]]}])
    return ids


async def _update_project(client, hdrs, plan, **body):
    return await client.post(f"/plans/{plan['id']}/update-project", headers=hdrs,
                             json={"status_date": None, **body})


# ── % complete and actuals ───────────────────────────────────────────


async def test_percent_sets_actuals(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", duration="2d")
    a = ids["A"]
    body = await _ok(client, hdrs, plan, [_pct([a], 50)])
    task = _by_id(body)[a]
    assert task["percent_complete"] == 50
    assert task["actual_start"] == task["start"] == "2026-11-02T08:00"
    assert task["actual_finish"] is None and task["completed_by_name"] is None

    body = await _ok(client, hdrs, plan, [_pct([a], 100)])
    task = _by_id(body)[a]
    assert task["percent_complete"] == 100
    assert task["actual_finish"] == task["finish"] == "2026-11-03T17:00"
    assert task["completed_by_name"] is not None
    assert task["completed_at"] is not None
    assert task["status"] == "complete"

    body = await _ok(client, hdrs, plan, [_pct([a], 40)])
    task = _by_id(body)[a]
    assert task["percent_complete"] == 40
    assert task["actual_finish"] is None
    assert task["completed_at"] is None and task["completed_by_name"] is None
    assert task["actual_start"] == "2026-11-02T08:00"

    body = await _ok(client, hdrs, plan, [_pct([a], 0)])
    task = _by_id(body)[a]
    assert task["percent_complete"] == 0 and task["actual_start"] is None
    # the dates never moved
    assert (task["start"], task["finish"]) == ("2026-11-02T08:00", "2026-11-03T17:00")


async def test_percent_keeps_existing_actuals(client, db):
    hdrs, _move, plan = await _setup(client, db)
    a = (await _add(client, hdrs, plan, "A", duration="2d"))["A"]
    await _ok(client, hdrs, plan, [_update(a, actual_start="2026-11-02T10:00")])
    body = await _ok(client, hdrs, plan, [_pct([a], 100)])
    task = _by_id(body)[a]
    assert task["actual_start"] == "2026-11-02T10:00"
    # the finish the actual start moved it to
    assert task["actual_finish"] == task["finish"] == "2026-11-04T10:00"


async def test_completion_stamps_come_from_the_server(client, db):
    hdrs, _move, plan = await _setup(client, db)
    a = (await _add(client, hdrs, plan, "A"))["A"]
    before = datetime.now(UTC)
    await _ok(client, hdrs, plan, [_complete(a)])
    row = await db.scalar(select(PlanTask).where(PlanTask.id == uuid.UUID(a))
                          .execution_options(populate_existing=True))
    assert row.completed_by is not None
    assert before - timedelta(seconds=1) <= row.completed_at <= datetime.now(UTC)
    assert row.completed_at == row.updated_at
    # completing it again leaves the stamp alone
    stamp = row.completed_at
    body = await _ok(client, hdrs, plan, [_complete(a)])
    assert body["tasks"] == []
    await db.refresh(row)
    assert row.completed_at == stamp


async def test_bad_percent(client, db):
    hdrs, _move, plan = await _setup(client, db)
    a = (await _add(client, hdrs, plan, "A"))["A"]
    for bad in (-1, 101):
        detail = await _fails(client, hdrs, plan, [_pct([a], bad)], 422, "bad_field")
        assert detail["field"] == "percent"
        detail = await _fails(client, hdrs, plan, [_update(a, percent_complete=bad)],
                              422, "bad_field")
        assert detail["field"] == "percent_complete"
    await _fails(client, hdrs, plan, [_pct([str(uuid.uuid4())], 50)], 422, "unknown_task")


async def test_update_task_percent_routes_through_progress(client, db):
    hdrs, _move, plan = await _setup(client, db)
    a = (await _add(client, hdrs, plan, "A"))["A"]
    body = await _ok(client, hdrs, plan, [_update(a, percent_complete=100)])
    task = _by_id(body)[a]
    assert task["actual_start"] == "2026-11-02T08:00"
    assert task["actual_finish"] == "2026-11-02T17:00"
    assert task["completed_by_name"] is not None
    # an actual the same edit sends wins over the one % would fill
    body = await _ok(client, hdrs, plan, [
        _update(a, percent_complete=50, actual_finish="2026-11-02T16:00")])
    task = _by_id(body)[a]
    assert task["actual_finish"] == "2026-11-02T16:00"
    assert task["completed_at"] is None


async def test_progress_uses_the_batch_schedule(client, db):
    """% after a structural edit in the same batch fills from the new dates."""
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    body = await _ok(client, hdrs, plan, [
        _update(ids["A"], duration="3d"),
        _link(ids["A"], ids["B"]),
        _pct([ids["A"]], 100),
        _pct([ids["B"]], 50),
        _complete(ids["A"]),
    ])
    tasks = _by_id(body)
    assert tasks[ids["A"]]["actual_finish"] == "2026-11-04T17:00"
    assert tasks[ids["B"]]["actual_start"] == "2026-11-05T08:00"


async def test_progress_paste_recalculates_a_bounded_number_of_times(client, db, monkeypatch):
    """Duration + % on every row of a paste: the fills wait for the batch's
    one schedule instead of recalculating per row."""
    hdrs, _move, plan = await _setup(client, db)
    names = [f"T{i}" for i in range(250)]
    ids = await _add(client, hdrs, plan, *names)
    calls = []
    real = service.schedule

    def counted(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(service, "schedule", counted)
    batch = []
    for name in names:
        batch += [_update(ids[name], duration="2d"), _pct([ids[name]], 50)]
    assert len(batch) == 500
    body = await _ok(client, hdrs, plan, batch)
    assert len(calls) <= 3
    tasks = _by_id(body)
    assert all(tasks[ids[n]]["actual_start"] == "2026-11-02T08:00" for n in names)
    assert all(tasks[ids[n]]["finish"] == "2026-11-03T17:00" for n in names)


async def test_transient_state_in_a_progress_batch(client, db):
    """A task that is a summary (with a finish link into it) only for a
    moment inside the batch: only the batch's final state is scheduled."""
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"], link_type="FF")])
    body = await _ok(client, hdrs, plan, [
        {"op": "indent", "ids": [ids["C"]]},            # B: a summary with an FF into it
        _pct([ids["C"]], 50),
        _complete(ids["A"]),
        {"op": "outdent", "ids": [ids["C"]]},
    ])
    tasks = _by_id(body)
    assert tasks[ids["C"]]["actual_start"] == "2026-11-02T08:00"
    assert tasks[ids["A"]]["actual_finish"] == "2026-11-02T17:00"
    got = _named(await _get(client, hdrs, plan))
    assert got["C"]["parent_id"] is None and got["B"]["is_summary"] is False


async def test_full_percent_needs_an_actual_finish(client, db):
    hdrs, _move, plan = await _setup(client, db)
    a = (await _add(client, hdrs, plan, "A"))["A"]
    detail = await _fails(client, hdrs, plan,
                          [_update(a, percent_complete=100, actual_finish=None)],
                          422, "bad_field")
    assert detail["field"] == "actual_finish"
    # a later actual edit without % decides for itself
    body = await _ok(client, hdrs, plan, [_pct([a], 50), _update(a, actual_start=None)])
    assert _by_id(body)[a]["actual_start"] is None


# ── summaries ────────────────────────────────────────────────────────


async def test_summary_complete_cascades_with_confirm(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _summary(client, hdrs, plan)
    version = (await _get(client, hdrs, plan))["version"]
    detail = await _fails(client, hdrs, plan, [_complete(ids["S"])], 409, "completion_confirm")
    assert detail["will_complete"] == [_blocker(ids, "A", 2, "subtask"),
                                       _blocker(ids, "B", 3, "subtask")]
    assert detail["open_predecessors"] == []
    got = await _get(client, hdrs, plan)
    assert got["version"] == version
    assert all(t["percent_complete"] == 0 for t in got["tasks"])

    body = await _ok(client, hdrs, plan, [_complete(ids["S"], confirm=True)])
    tasks = _by_id(body)
    assert {ids["S"], ids["A"], ids["B"]} <= set(tasks)
    for name in "SAB":
        assert tasks[ids[name]]["percent_complete"] == 100, name
    for name in "AB":
        assert tasks[ids[name]]["actual_finish"] == "2026-11-02T17:00"
        assert tasks[ids[name]]["completed_by_name"] is not None


async def test_summary_open_leaves_only(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _summary(client, hdrs, plan)
    await _ok(client, hdrs, plan, [_complete(ids["A"])])
    detail = await _fails(client, hdrs, plan, [_complete(ids["S"])], 409, "completion_confirm")
    assert detail["will_complete"] == [_blocker(ids, "B", 3, "subtask")]
    # a summary with nothing open is already complete: nothing to confirm
    await _ok(client, hdrs, plan, [_complete(ids["B"])])
    body = await _ok(client, hdrs, plan, [_complete(ids["S"])])
    assert body["tasks"] == []


async def test_summary_percent_rules(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _summary(client, hdrs, plan)
    for op in (_pct([ids["S"]], 50), _update(ids["S"], percent_complete=50)):
        detail = await _fails(client, hdrs, plan, [op], 422, "summary_field")
        assert detail["task_id"] == ids["S"]
    # 100 is `complete [S]`, through the same rules
    for op in (_pct([ids["S"]], 100), _update(ids["S"], percent_complete=100)):
        await _fails(client, hdrs, plan, [op], 409, "completion_confirm")
    body = await _ok(client, hdrs, plan, [_confirmed(_update(ids["S"], percent_complete=100))])
    assert _by_id(body)[ids["S"]]["percent_complete"] == 100
    # its actuals stay derived
    await _fails(client, hdrs, plan, [_update(ids["S"], actual_start="2026-11-02")],
                 422, "summary_field")


async def test_later_op_wins_over_a_summary_completion(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _summary(client, hdrs, plan)
    # a later op taking a leaf below 100 voids the earlier `complete [S]`
    await _ok(client, hdrs, plan, [_complete(ids["S"], confirm=True), _pct([ids["A"]], 0)])
    got = _named(await _get(client, hdrs, plan))
    assert [got[n]["percent_complete"] for n in "SAB"] == [0, 0, 0]
    assert got["A"]["actual_start"] is None and got["A"]["completed_at"] is None
    # an earlier one is overridden by it
    await _ok(client, hdrs, plan, [_pct([ids["A"]], 40), _complete(ids["S"], confirm=True)])
    got = _named(await _get(client, hdrs, plan))
    assert [got[n]["percent_complete"] for n in "SAB"] == [100, 100, 100]


async def test_subtasks_block_rule(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _summary(client, hdrs, plan)
    await _settings(db, move, subtasks="block")
    detail = await _fails(client, hdrs, plan, [_complete(ids["S"], confirm=True)],
                          409, "completion_blocked")
    assert detail["blockers"] == [_blocker(ids, "A", 2, "subtask"),
                                  _blocker(ids, "B", 3, "subtask")]
    # once they are complete the summary is too
    body = await _ok(client, hdrs, plan, [_complete(ids["A"], ids["B"])])
    assert _by_id(body)[ids["S"]]["percent_complete"] == 100


async def test_subtasks_none_rule(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _summary(client, hdrs, plan)
    await _settings(db, move, subtasks="none")
    body = await _ok(client, hdrs, plan, [_complete(ids["S"])])
    tasks = _by_id(body)
    assert all(tasks[ids[n]]["percent_complete"] == 100 for n in "SAB")


async def test_nested_summary_cascades_to_every_leaf(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "S", "T", "A", "B")
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["T"], ids["A"], ids["B"]]},
                                   {"op": "indent", "ids": [ids["A"]]}])
    # S{T{A}, B}
    detail = await _fails(client, hdrs, plan, [_complete(ids["S"])], 409, "completion_confirm")
    assert [b["name"] for b in detail["will_complete"]] == ["A", "B"]
    body = await _ok(client, hdrs, plan, [_complete(ids["S"], confirm=True)])
    assert all(t["percent_complete"] == 100 for t in body["tasks"])
    assert {t["name"] for t in body["tasks"]} == {"S", "T", "A", "B"}


# ── predecessors ─────────────────────────────────────────────────────


async def test_predecessor_block_default(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    for op in (_complete(ids["B"], confirm=True), _pct([ids["B"]], 100),
               _update(ids["B"], percent_complete=100)):
        detail = await _fails(client, hdrs, plan, [op], 409, "completion_blocked")
        assert detail["blockers"] == [_blocker(ids, "A", 1, "predecessor")]
    assert all(t["percent_complete"] == 0 for t in (await _get(client, hdrs, plan))["tasks"])
    # below 100 nothing is checked
    await _ok(client, hdrs, plan, [_pct([ids["B"]], 99)])
    await _ok(client, hdrs, plan, [_complete(ids["A"])])
    await _ok(client, hdrs, plan, [_complete(ids["B"])])


async def test_predecessor_of_ancestor(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "X", "S", "B")
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["B"]]},
                                   _link(ids["X"], ids["S"])])
    detail = await _fails(client, hdrs, plan, [_complete(ids["B"])], 409, "completion_blocked")
    assert detail["blockers"] == [_blocker(ids, "X", 1, "predecessor")]


async def test_open_summary_predecessor(client, db):
    """A summary predecessor is open while any leaf below it is."""
    hdrs, _move, plan = await _setup(client, db)
    ids = await _summary(client, hdrs, plan)
    ids.update(await _add(client, hdrs, plan, "C"))
    await _ok(client, hdrs, plan, [_link(ids["S"], ids["C"]), _complete(ids["A"])])
    detail = await _fails(client, hdrs, plan, [_complete(ids["C"])], 409, "completion_blocked")
    assert detail["blockers"] == [_blocker(ids, "S", 1, "predecessor")]
    await _ok(client, hdrs, plan, [_complete(ids["B"]), _complete(ids["C"])])


async def test_cascaded_leaf_checks_its_predecessors(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "X")
    ids.update(await _summary(client, hdrs, plan))
    await _ok(client, hdrs, plan, [_link(ids["X"], ids["B"])])
    # X 1, S 2, A 3, B 4
    detail = await _fails(client, hdrs, plan, [_complete(ids["S"], confirm=True)],
                          409, "completion_blocked")
    assert detail["blockers"] == [_blocker(ids, "X", 1, "predecessor")]


async def test_predecessor_warn(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    await _settings(db, move, predecessors="warn")
    detail = await _fails(client, hdrs, plan, [_complete(ids["B"])], 409, "completion_confirm")
    assert detail["open_predecessors"] == [_blocker(ids, "A", 1, "predecessor")]
    assert detail["will_complete"] == []
    body = await _ok(client, hdrs, plan, [_complete(ids["B"], confirm=True)])
    tasks = _by_id(body)
    assert tasks[ids["B"]]["percent_complete"] == 100
    assert ids["A"] not in tasks
    got = _named(await _get(client, hdrs, plan))
    assert got["A"]["percent_complete"] == 0
    # update_task carries its own confirm
    await _ok(client, hdrs, plan, [_pct([ids["B"]], 0)])
    await _fails(client, hdrs, plan, [_update(ids["B"], percent_complete=100)],
                 409, "completion_confirm")
    await _ok(client, hdrs, plan, [_confirmed(_update(ids["B"], percent_complete=100))])


async def test_predecessors_none_rule(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    await _settings(db, move, predecessors="none")
    await _ok(client, hdrs, plan, [_complete(ids["B"])])


async def test_completing_a_complete_task_checks_nothing(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "X", "A")
    ids.update(await _add(client, hdrs, plan, "S", "C"))
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["C"]]},
                                   _link(ids["X"], ids["A"]), _link(ids["X"], ids["S"])])
    await _settings(db, move, predecessors="none")
    await _ok(client, hdrs, plan, [_complete(ids["A"], ids["S"], confirm=True)])
    await _settings(db, move, predecessors="block")
    # already complete: nothing reaches 100, so X (still open) is not asked about
    for op in (_complete(ids["A"]), _complete(ids["S"]), _pct([ids["S"]], 100),
               _update(ids["A"], percent_complete=100)):
        body = await _ok(client, hdrs, plan, [op])
        assert body["tasks"] == []


async def test_same_batch_counts(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"]), _link(ids["B"], ids["C"])])
    body = await _ok(client, hdrs, plan, [_complete(ids["A"], ids["B"])])
    tasks = _by_id(body)
    assert tasks[ids["A"]]["percent_complete"] == tasks[ids["B"]]["percent_complete"] == 100
    # in either order, across ops
    body = await _ok(client, hdrs, plan, [_pct([ids["A"], ids["B"]], 0)])
    await _ok(client, hdrs, plan, [_complete(ids["C"]), _complete(ids["B"]),
                                   _pct([ids["A"]], 100)])
    # a task the batch takes back below 100 does not count
    await _ok(client, hdrs, plan, [_pct([ids["A"], ids["B"], ids["C"]], 0)])
    await _fails(client, hdrs, plan, [_complete(ids["A"], ids["B"]), _pct([ids["A"]], 90)],
                 409, "completion_blocked")


async def test_confirm_belongs_to_its_op(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "P", "Q")
    ids.update(await _summary(client, hdrs, plan))
    await _ok(client, hdrs, plan, [_link(ids["P"], ids["Q"])])
    await _settings(db, move, predecessors="warn")
    # the summary's confirm does not answer Q's open predecessor
    detail = await _fails(client, hdrs, plan, [_complete(ids["S"], confirm=True),
                                               _complete(ids["Q"])],
                          409, "completion_confirm")
    assert detail["open_predecessors"] == [_blocker(ids, "P", 1, "predecessor")]
    assert detail["will_complete"] == []
    await _ok(client, hdrs, plan, [_complete(ids["S"], confirm=True),
                                   _complete(ids["Q"], confirm=True)])


async def test_restore_skips_the_rules(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    await _settings(db, move, predecessors="none")
    done = await _ok(client, hdrs, plan, [_complete(ids["B"])])
    undone = await _ok(client, hdrs, plan, done["inverse"])
    assert _by_id(undone)[ids["B"]]["percent_complete"] == 0
    await _settings(db, move, predecessors="block")
    # redo replays what the server recorded, whatever the rules say now
    redone = await _ok(client, hdrs, plan, undone["inverse"])
    b = _by_id(redone)[ids["B"]]
    assert b["percent_complete"] == 100
    assert b["completed_at"] == _by_id(done)[ids["B"]]["completed_at"]


def test_check_completion_unit():
    """check_completion over a hand-built state: (blocked, needs, cascade)."""
    from types import SimpleNamespace

    def task(name, parent=None, pct=0):
        return SimpleNamespace(id=uuid.uuid4(), name=name, parent_id=parent,
                               percent_complete=pct)

    x = task("X")
    s = task("S")
    a = task("A", s.id)
    b = task("B", s.id, pct=100)
    link = SimpleNamespace(id=uuid.uuid4(), predecessor_id=x.id, successor_id=s.id)
    state = SimpleNamespace(tasks={t.id: t for t in (x, s, a, b)}, links={link.id: link},
                            order=[x.id, s.id, a.id, b.id])

    blocked, needs, cascade = check_completion(state, [s.id], Completion("cascade", "warn"))
    assert blocked == []
    assert needs == [Blocker(x.id, 1, "X", "predecessor"), Blocker(a.id, 3, "A", "subtask")]
    assert cascade == [a.id]
    blocked, needs, cascade = check_completion(state, [s.id], Completion("block", "block"))
    assert blocked == [Blocker(x.id, 1, "X", "predecessor"), Blocker(a.id, 3, "A", "subtask")]
    assert needs == [] and cascade == []
    blocked, needs, cascade = check_completion(state, [s.id, x.id],
                                               Completion("none", "block"))
    assert blocked == [] and needs == [] and cascade == [a.id]


# ── lock and version ─────────────────────────────────────────────────


async def test_progress_skips_version_and_lock(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _lock(db, move)
    version = (await _get(client, hdrs, plan))["version"]
    for op in (_pct([ids["A"]], 30), _complete(ids["A"]), _on_track(ids["B"]),
               _update(ids["B"], percent_complete=10, notes="n",
                       actual_start="2026-11-02T08:00")):
        body = await _ok(client, hdrs, plan, [op], version=1)
        assert body["version"] == version + 1
        version = body["version"]
    # a structural op in the batch still needs the lock off
    await _fails(client, hdrs, plan, [_pct([ids["A"]], 50), _update(ids["A"], name="X")],
                 409, "plan_locked")


async def test_progress_undo_is_progress_only(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "T")
    ids.update(await _add(client, hdrs, plan, "M", mode="manual", duration="2d"))
    ids.update(await _summary(client, hdrs, plan))
    row = await _plan_row(db, move)
    row.status_date = dt("2026-11-02 12:00")
    await db.commit()
    await _lock(db, move)
    for ops in ([_pct([ids["M"]], 50)], [_pct([ids["M"]], 100)],
                [_pct([ids["M"]], 100), _pct([ids["M"]], 30)],
                [_complete(ids["S"], confirm=True)], [_on_track(ids["T"])],
                [_update(ids["T"], percent_complete=100)]):
        body = await _ok(client, hdrs, plan, ops, version=1)
        restore = body["inverse"][0]
        assert restore["tasks"] and restore["remove_tasks"] == [] and restore["links"] == []
        undone = await _ok(client, hdrs, plan, body["inverse"], version=1)
        assert undone["version"] == body["version"] + 1
        if ops[0]["op"] == "complete":
            # the cascade's undo takes A and B back to nothing done
            back = _by_id(undone)
            for name in "AB":
                task = back[ids[name]]
                assert task["percent_complete"] == 0, name
                assert task["actual_start"] is None and task["actual_finish"] is None
                assert task["completed_at"] is None and task["completed_by_name"] is None
            assert back[ids["S"]]["percent_complete"] == 0
    # the undo of a batch that changed nothing (T is complete already) is empty
    await _ok(client, hdrs, plan, [_complete(ids["T"])], version=1)
    body = await _ok(client, hdrs, plan, [_complete(ids["T"])], version=1)
    assert body["tasks"] == [] and body["inverse"][0]["tasks"] == []
    await _ok(client, hdrs, plan, body["inverse"], version=1)
    got = _named(await _get(client, hdrs, plan))
    assert got["M"]["start"] == "2026-11-02T08:00" and got["M"]["finish"] == "2026-11-03T17:00"


async def test_completion_409_writes_nothing(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    before = await _get(client, hdrs, plan)
    await _fails(client, hdrs, plan, [_update(ids["A"], name="A2"), _pct([ids["A"]], 50),
                                      _complete(ids["B"])], 409, "completion_blocked")
    after = await _get(client, hdrs, plan)
    assert after["version"] == before["version"]
    assert _named(after)["A"]["name"] == "A" and _named(after)["A"]["percent_complete"] == 0


# ── Mark on Track ────────────────────────────────────────────────────


async def test_mark_on_track(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", duration="5d")
    ids.update(await _add(client, hdrs, plan, "M", duration="0"))
    ids.update(await _add(client, hdrs, plan, "L", duration="1d",
                          start="2026-11-06T08:00"))
    row = await _plan_row(db, move)
    row.status_date = dt("2026-11-04 12:00")
    await db.commit()
    body = await _ok(client, hdrs, plan, [_on_track(ids["A"], ids["M"], ids["L"])])
    tasks = _by_id(body)
    # Mon 08:00 to Wed 12:00 is 20 of the 40 hours
    assert tasks[ids["A"]]["percent_complete"] == 50
    assert tasks[ids["A"]]["actual_start"] == "2026-11-02T08:00"
    assert tasks[ids["M"]]["percent_complete"] == 100       # a milestone already passed
    assert ids["L"] not in tasks                            # not started by then: stays 0
    got = _named(await _get(client, hdrs, plan))
    assert got["L"]["percent_complete"] == 0

    # past its finish it is complete, through the rules
    row.status_date = dt("2026-11-09 08:00")
    await db.commit()
    body = await _ok(client, hdrs, plan, [_on_track(ids["A"])])
    assert _by_id(body)[ids["A"]]["percent_complete"] == 100
    assert _by_id(body)[ids["A"]]["completed_by_name"] is not None


async def test_mark_on_track_summary_and_rules(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _summary(client, hdrs, plan)
    ids.update(await _add(client, hdrs, plan, "C"))
    await _ok(client, hdrs, plan, [_link(ids["S"], ids["C"])])
    row = await _plan_row(db, move)
    row.status_date = dt("2026-11-02 12:00")
    await db.commit()
    # a summary marks its subtasks
    body = await _ok(client, hdrs, plan, [_on_track(ids["S"])])
    tasks = _by_id(body)
    assert tasks[ids["A"]]["percent_complete"] == tasks[ids["B"]]["percent_complete"] == 50
    # reaching 100 goes through the predecessor rule
    row.status_date = dt("2026-11-04 08:00")
    await db.commit()
    detail = await _fails(client, hdrs, plan, [_on_track(ids["C"])], 409, "completion_blocked")
    assert detail["blockers"][0]["task_id"] == ids["S"]
    await _settings(db, move, predecessors="warn")
    await _fails(client, hdrs, plan, [_on_track(ids["C"])], 409, "completion_confirm")
    await _ok(client, hdrs, plan, [_on_track(ids["C"], confirm=True)])


# ── Update project ───────────────────────────────────────────────────


async def test_update_project(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"]), _link(ids["B"], ids["C"])])
    version = (await _get(client, hdrs, plan))["version"]
    resp = await _update_project(client, hdrs, plan, status_date="2026-11-03T17:00",
                                 complete_through="2026-11-03T17:00", confirm=True)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version"] == version + 1
    tasks = _by_id(body)
    assert tasks[ids["A"]]["percent_complete"] == 100
    assert tasks[ids["B"]]["percent_complete"] == 100
    got = await _get(client, hdrs, plan)
    assert _named(got)["C"]["percent_complete"] == 0
    assert got["status_date"] == "2026-11-03T17:00"
    assert (await _plan_row(db, move)).status_date == dt("2026-11-03 17:00")


async def test_update_project_on_track_and_rules(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "P", duration="2d")
    ids.update(await _add(client, hdrs, plan, "A", "C"))
    # P Mon-Tue; A starts with P and finishes Mon; C follows P (Wed)
    await _ok(client, hdrs, plan, [_link(ids["P"], ids["A"], link_type="SS"),
                                   _link(ids["P"], ids["C"])])
    await _lock(db, move)
    # a date alone is that day's end: A finishes by then, P spans it, and P
    # (A's open predecessor) blocks A by default
    body = {"status_date": "2026-11-02", "complete_through": "2026-11-02"}
    resp = await _update_project(client, hdrs, plan, **body, confirm=True)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"code": "completion_blocked",
                                     "blockers": [_blocker(ids, "P", 1, "predecessor")]}
    await _settings(db, move, predecessors="warn")
    resp = await _update_project(client, hdrs, plan, **body)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"code": "completion_confirm", "will_complete": [],
                                     "open_predecessors": [_blocker(ids, "P", 1, "predecessor")]}
    got = await _get(client, hdrs, plan)
    assert got["status_date"] is None and all(t["percent_complete"] == 0 for t in got["tasks"])

    resp = await _update_project(client, hdrs, plan, **body, confirm=True)
    assert resp.status_code == 200, resp.text
    tasks = _named(await _get(client, hdrs, plan))
    assert tasks["A"]["percent_complete"] == 100
    assert tasks["P"]["percent_complete"] == 50             # on track through Mon 17:00
    assert tasks["P"]["status"] == "in_progress"
    assert tasks["C"]["percent_complete"] == 0
    # its undo is a progress edit (the status date stays)
    resp = await _ops(client, hdrs, plan, resp.json()["inverse"], version=1)
    assert resp.status_code == 200, resp.text
    assert all(t["percent_complete"] == 0 for t in (await _get(client, hdrs, plan))["tasks"])

    # null status date is "now"; without complete_through nothing else changes
    resp = await _update_project(client, hdrs, plan)
    assert resp.status_code == 200, resp.text
    assert resp.json()["tasks"] == []
    got = await _get(client, hdrs, plan)
    assert got["status_date"] is None


async def test_update_project_never_lowers_progress(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", duration="4d")
    await _ok(client, hdrs, plan, [_pct([ids["A"]], 80), _pct([ids["B"]], 10)])
    # through Tue 17:00 both are on track at 50%: A keeps its 80, B rises to 50
    resp = await _update_project(client, hdrs, plan, status_date="2026-11-03",
                                 complete_through="2026-11-03")
    assert resp.status_code == 200, resp.text
    tasks = _named(await _get(client, hdrs, plan))
    assert tasks["A"]["percent_complete"] == 80
    assert tasks["B"]["percent_complete"] == 50
    # Mark on Track still sets the scheduled value
    await _ok(client, hdrs, plan, [_on_track(ids["A"])])
    assert _named(await _get(client, hdrs, plan))["A"]["percent_complete"] == 50
    assert (await _plan_row(db, move)).status_date == dt("2026-11-03 17:00")


async def test_update_project_errors(client, db):
    hdrs, _move, plan = await _setup(client, db)
    for body in ({"status_date": "nope"}, {"complete_through": "2026-11-02T25:00"}):
        resp = await _update_project(client, hdrs, plan, **body)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "bad_field"
    resp = await client.post(f"/plans/{uuid.uuid4()}/update-project", headers=hdrs,
                             json={"status_date": None})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "plan_not_found"


async def test_check_completion_reads_the_state(client, db):
    """check_completion runs on a loaded PlanState as well."""
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    state = await load_state(db, await _plan_row(db, move))
    blocked, needs, cascade = check_completion(
        state, [uuid.UUID(ids["B"])], Completion("cascade", "block"))
    assert blocked == [Blocker(uuid.UUID(ids["A"]), 1, "A", "predecessor")]
    assert needs == [] and cascade == []
    resp = await _ops(client, hdrs, plan, [_complete(ids["A"], ids["B"])])
    assert resp.status_code == 200
