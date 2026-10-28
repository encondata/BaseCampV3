"""Scheduling engine, summary tasks: rollup of dates, duration and % complete,
links into and out of summaries (entry gate and rollup), nested summaries,
the outline / summary-link / summary-constraint rules and cycle detection.

The reference week (Standard calendar, Mon-Fri 08:00-12:00 + 13:00-17:00):
Mon 2026-11-02 ... Fri 2026-11-06, Thu 2026-11-26 is a nonworking
"Thanksgiving" and Sat 2026-11-14 is a working 06:00-22:00 "Move weekend".
All datetimes are naive wall-clock times. Durations and lags are minutes
(1 day = 480). `S{A, B}` means A and B are children of S.
"""

import copy
from dataclasses import replace
from datetime import datetime

import pytest

from serversherpa.plans.calendar import STANDARD_CALENDAR, WorkCalendar
from serversherpa.plans.engine import (
    CycleError,
    EngineSettings,
    LinkIn,
    OutlineLinkError,
    ScheduleError,
    SummaryConstraintError,
    SummaryLinkError,
    TaskIn,
    TaskOut,
    schedule,
)


@pytest.fixture(autouse=True)
def clean_db():
    """These tests are pure and never touch the database: shadow the
    conftest fixture that truncates every table before each test."""
    yield


THANKSGIVING = {"date": "2026-11-26", "name": "Thanksgiving", "hours": []}
MOVE_WEEKEND = {"date": "2026-11-14", "name": "Move weekend", "hours": [["06:00", "22:00"]]}

CAL = WorkCalendar.from_json(
    {**copy.deepcopy(STANDARD_CALENDAR), "exceptions": [THANKSGIVING, MOVE_WEEKEND]})


def dt(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%d %H:%M")


PROJECT_START = dt("2026-11-02 08:00")


def T(task_id: str, duration: int = 480, parent: str | None = None, **fields) -> TaskIn:
    """A task under `parent`; `run` numbers positions in list order, so list
    a summary before its children."""
    return TaskIn(id=task_id, parent_id=parent, position=0, duration=duration, **fields)


def L(pred: str, succ: str, link_type: str = "FS", lag: int = 0,
      elapsed: bool = False) -> LinkIn:
    return LinkIn(predecessor_id=pred, successor_id=succ, link_type=link_type, lag=lag,
                  lag_elapsed=elapsed)


def run(tasks, links=(), start: datetime = PROJECT_START, **settings) -> dict[str, TaskOut]:
    numbered = [replace(task, position=index) for index, task in enumerate(tasks)]
    return schedule(numbered, list(links), CAL, start, EngineSettings(**settings))


def dates(out: TaskOut) -> tuple[datetime, datetime]:
    return out.start, out.finish


# --- the table: rollups, links into and out of summaries ----------------------------


def test_summary_rollup_dates():
    out = run([T("S"), T("A", 960, "S"), T("B", 1440, "S")])
    assert dates(out["S"]) == (dt("2026-11-02 08:00"), dt("2026-11-04 17:00"))
    assert out["S"].duration == 1440
    assert out["S"].is_summary
    assert not out["A"].is_summary


def test_link_into_summary_moves_children():
    out = run([T("X", 960), T("S"), T("A", 480, "S"), T("B", 480, "S")], [L("X", "S")])
    assert out["A"].start == dt("2026-11-04 08:00")
    assert out["B"].start == dt("2026-11-04 08:00")


def test_ss_into_summary():
    out = run([T("X", 960), T("S"), T("A", 480, "S")], [L("X", "S", "SS", 480)])
    assert out["A"].start == dt("2026-11-03 08:00")


def test_link_from_summary():
    out = run([T("S"), T("A", 960, "S"), T("Y", 480)], [L("S", "Y")])
    assert out["Y"].start == dt("2026-11-04 08:00")


def test_nested_summary_gate():
    out = run([T("X", 480), T("S1"), T("S2", parent="S1"), T("A", 480, "S2")],
              [L("X", "S1")])
    assert out["A"].start == dt("2026-11-03 08:00")


def test_child_link_inside_summary():
    out = run([T("S"), T("A", 960, "S"), T("B", 480, "S")], [L("A", "B")])
    assert dates(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert out["S"].finish == dt("2026-11-04 17:00")


# --- the table: outline links, cycles, summary links and constraints -----------------


def test_link_to_own_parent_rejected():
    with pytest.raises(OutlineLinkError) as caught:
        run([T("S"), T("A", parent="S")], [L("A", "S")])
    assert caught.value.code == "link_to_outline"
    assert set(caught.value.task_ids) == {"A", "S"}


def test_link_from_parent_to_child_rejected():
    with pytest.raises(OutlineLinkError):
        run([T("S"), T("A", parent="S")], [L("S", "A")])


def test_link_to_grandchild_rejected():
    with pytest.raises(OutlineLinkError):
        run([T("S1"), T("S2", parent="S1"), T("A", parent="S2")], [L("S1", "A")])


def test_cycle_rejected():
    with pytest.raises(CycleError) as caught:
        run([T("A"), T("B"), T("C")], [L("A", "B"), L("B", "C"), L("C", "A")])
    assert set(caught.value.task_ids) == {"A", "B", "C"}


def test_cycle_through_rollup():
    with pytest.raises(CycleError):
        run([T("S"), T("A", parent="S"), T("B")], [L("S", "B"), L("B", "A")])


def test_ff_into_summary_rejected():
    with pytest.raises(SummaryLinkError) as caught:
        run([T("X"), T("S"), T("A", parent="S")], [L("X", "S", "FF")])
    assert caught.value.code == "bad_summary_link"


def test_summary_constraint_rejected():
    with pytest.raises(SummaryConstraintError) as caught:
        run([T("S", constraint_type="mso", constraint_date=dt("2026-11-04 08:00")),
             T("A", parent="S")])
    assert caught.value.code == "bad_summary_constraint"
    assert caught.value.task_ids == ["S"]


def test_summary_snet_applies():
    out = run([T("S", constraint_type="snet", constraint_date=dt("2026-11-04 08:00")),
               T("A", 480, "S")])
    assert out["A"].start == dt("2026-11-04 08:00")


def test_rollup_percent_weighted():
    out = run([T("S"), T("A", 480, "S", percent_complete=100),
               T("B", 1440, "S", percent_complete=0)])
    assert out["S"].percent_complete == 25


def test_rollup_percent_milestones():
    out = run([T("S"), T("M1", 0, "S", is_milestone=True, percent_complete=100),
               T("M2", 0, "S", is_milestone=True, percent_complete=0)])
    assert out["S"].percent_complete == 50


# --- beyond the table: rollups ---------------------------------------------------------


def test_nested_rollup():
    tasks = [T("S1"), T("S2", parent="S1"), T("A", 480, "S2"), T("B", 960, "S1")]
    out = run(tasks, [L("A", "B")])
    assert dates(out["S2"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert dates(out["S1"]) == (dt("2026-11-02 08:00"), dt("2026-11-04 17:00"))
    assert (out["S1"].duration, out["S2"].duration) == (1440, 480)
    assert out["S2"].is_summary and out["S1"].is_summary


def test_rollup_duration_is_working_time():
    # A ends Fri 17:00, B starts the next Monday: the weekend adds no duration
    tasks = [T("S"), T("A", 480, "S", constraint_type="snet",
                       constraint_date=dt("2026-11-06 08:00")),
             T("B", 480, "S")]
    out = run(tasks, [L("A", "B")])
    assert dates(out["S"]) == (dt("2026-11-06 08:00"), dt("2026-11-09 17:00"))
    assert out["S"].duration == 960


def test_rollup_percent_counts_leaves_not_child_summaries():
    # S2's own rollup (480 at 50%) would give 17; its two leaves give 25
    tasks = [T("S1"), T("S2", parent="S1"),
             T("A", 480, "S2", percent_complete=100), T("B", 480, "S2"),
             T("C", 960, "S1")]
    out = run(tasks)
    assert out["S2"].percent_complete == 50
    assert out["S1"].percent_complete == 25


def test_rollup_percent_rounds_half_up():
    out = run([T("S"), T("A", 480, "S", percent_complete=25), T("B", 480, "S")])
    assert out["S"].percent_complete == 13


def test_summary_inputs_are_ignored():
    # a summary's own duration, mode, dates, actuals and % come from its subtasks
    summary = T("S", 9999, mode="manual", start=dt("2026-11-09 08:00"),
                finish=dt("2026-11-20 17:00"), actual_start=dt("2026-11-10 08:00"),
                actual_finish=dt("2026-11-11 08:00"), elapsed=True, is_milestone=True,
                percent_complete=90)
    out = run([summary, T("A", 960, "S")])
    s = out["S"]
    assert dates(s) == (dt("2026-11-02 08:00"), dt("2026-11-03 17:00"))
    assert (s.duration, s.percent_complete) == (960, 0)


def test_summary_output_fields():
    out = run([T("S"), T("A", 480, "S")])
    s = out["S"]
    assert (s.late_start, s.late_finish, s.total_slack) == (None, None, None)
    assert s.is_critical is False
    assert s.conflict is None


def test_rollup_spans_manual_and_actual_children():
    tasks = [T("S"), T("M", 480, "S", mode="manual", start=dt("2026-11-04 10:00")),
             T("A", 480, "S", actual_start=dt("2026-11-02 10:00"))]
    out = run(tasks)
    assert dates(out["S"]) == (dt("2026-11-02 10:00"), dt("2026-11-05 10:00"))


# --- beyond the table: links into summaries -----------------------------------------


def test_link_into_summary_only_floors_children():
    # a child with its own later SNET keeps it; the gate is only a floor
    tasks = [T("X", 480), T("S"),
             T("A", 480, "S", constraint_type="snet", constraint_date=dt("2026-11-05 08:00"))]
    out = run(tasks, [L("X", "S")])
    assert out["A"].start == dt("2026-11-05 08:00")


def test_link_into_summary_with_lag():
    out = run([T("X", 480), T("S"), T("A", 480, "S")], [L("X", "S", "FS", 480)])
    assert out["A"].start == dt("2026-11-04 08:00")


def test_link_into_summary_elapsed_lag():
    out = run([T("X", 480), T("S"), T("A", 480, "S")],
              [L("X", "S", "FS", 1440, elapsed=True)])
    assert out["A"].start == dt("2026-11-04 08:00")


def test_lead_into_summary_clamped_to_project_start():
    out = run([T("X", 480), T("S"), T("A", 480, "S")], [L("X", "S", "SS", -480)])
    assert dates(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))


def test_milestone_under_linked_summary_does_not_snap():
    out = run([T("X", 960), T("S"), T("M", 0, "S", is_milestone=True)], [L("X", "S")])
    assert dates(out["M"]) == (dt("2026-11-03 17:00"), dt("2026-11-03 17:00"))


def test_manual_child_ignores_summary_link():
    tasks = [T("X", 960), T("S"),
             T("M", 480, "S", mode="manual", start=dt("2026-11-02 10:00"))]
    out = run(tasks, [L("X", "S")])
    assert dates(out["M"]) == (dt("2026-11-02 10:00"), dt("2026-11-03 10:00"))


def test_nested_gates_take_the_latest():
    # X → S1 and Y → S2 (inside S1): A waits for both
    tasks = [T("X", 480), T("Y", 1440), T("S1"), T("S2", parent="S1"), T("A", 480, "S2"),
             T("B", 480, "S1")]
    out = run(tasks, [L("X", "S1"), L("Y", "S2")])
    assert out["A"].start == dt("2026-11-05 08:00")
    assert out["B"].start == dt("2026-11-03 08:00")


def test_summary_snet_and_link_take_the_later():
    tasks = [T("X", 1440),
             T("S", constraint_type="snet", constraint_date=dt("2026-11-03 08:00")),
             T("A", 480, "S")]
    out = run(tasks, [L("X", "S")])
    assert out["A"].start == dt("2026-11-05 08:00")


def test_parent_snet_reaches_grandchildren():
    tasks = [T("S1", constraint_type="snet", constraint_date=dt("2026-11-04 08:00")),
             T("S2", parent="S1"), T("A", 480, "S2")]
    out = run(tasks)
    assert out["A"].start == dt("2026-11-04 08:00")


def test_summary_snet_without_date_is_ignored():
    out = run([T("S", constraint_type="snet"), T("A", 480, "S")])
    assert out["A"].start == dt("2026-11-02 08:00")


def test_summary_to_summary_link():
    tasks = [T("S1"), T("A", 960, "S1"), T("S2"), T("B", 480, "S2")]
    out = run(tasks, [L("S1", "S2")])
    assert dates(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))


def test_link_between_cousins():
    tasks = [T("S1"), T("A", 960, "S1"), T("S2"), T("B", 480, "S2")]
    out = run(tasks, [L("A", "B")])
    assert out["B"].start == dt("2026-11-04 08:00")
    assert dates(out["S2"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))


# --- beyond the table: a link into a summary is a link for the conflict rule ---------


def _ceiling_under_linked_summary():
    return [T("X", 960), T("S"),
            T("A", 480, "S", constraint_type="snlt", constraint_date=dt("2026-11-03 08:00"))]


def test_summary_link_vs_child_ceiling_honored():
    out = run(_ceiling_under_linked_summary(), [L("X", "S")])
    assert out["A"].start == dt("2026-11-03 08:00")
    assert out["A"].conflict == "link"


def test_summary_link_vs_child_ceiling_not_honored():
    out = run(_ceiling_under_linked_summary(), [L("X", "S")], honor_constraints=False)
    assert out["A"].start == dt("2026-11-04 08:00")
    assert out["A"].conflict == "constraint"


@pytest.mark.parametrize("honor", [True, False])
def test_summary_snet_is_not_a_link(honor):
    # like the project start, a summary's SNET floors its subtasks but never
    # conflicts with a subtask's own pin
    tasks = [T("S", constraint_type="snet", constraint_date=dt("2026-11-04 08:00")),
             T("A", 480, "S", constraint_type="mso", constraint_date=dt("2026-11-02 08:00"))]
    out = run(tasks, honor_constraints=honor)
    assert out["A"].start == dt("2026-11-02 08:00")
    assert out["A"].conflict is None
    assert out["S"].start == dt("2026-11-02 08:00")


# --- beyond the table: links out of summaries -----------------------------------------


def test_ss_from_summary():
    tasks = [T("S"), T("A", 480, "S", constraint_type="snet",
                       constraint_date=dt("2026-11-03 08:00")),
             T("Y", 480)]
    out = run(tasks, [L("S", "Y", "SS")])
    assert out["Y"].start == dt("2026-11-03 08:00")


def test_ff_from_summary():
    out = run([T("S"), T("A", 960, "S"), T("Y", 480)], [L("S", "Y", "FF")])
    assert dates(out["Y"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))


def test_sf_from_summary():
    tasks = [T("S"), T("A", 480, "S", constraint_type="snet",
                       constraint_date=dt("2026-11-04 08:00")),
             T("Y", 480)]
    out = run(tasks, [L("S", "Y", "SF")])
    assert dates(out["Y"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))


def test_link_from_nested_summary():
    tasks = [T("S1"), T("S2", parent="S1"), T("A", 960, "S2"), T("B", 480, "S1"),
             T("Y", 480)]
    out = run(tasks, [L("S2", "Y")])
    assert out["Y"].start == dt("2026-11-04 08:00")


def test_link_from_summary_reads_its_latest_child():
    # S finishes with its latest subtask, wherever that sits in the outline
    tasks = [T("S"), T("A", 1440, "S"), T("B", 480, "S"), T("Y", 480)]
    out = run(tasks, [L("S", "Y")])
    assert out["Y"].start == dt("2026-11-05 08:00")


# --- beyond the table: the outline, summary-link and constraint rules ----------------


@pytest.mark.parametrize("pred,succ", [("A", "S1"), ("S2", "A"), ("A", "S2"), ("S1", "S2")])
def test_every_outline_link_rejected(pred, succ):
    tasks = [T("S1"), T("S2", parent="S1"), T("A", parent="S2")]
    with pytest.raises(OutlineLinkError) as caught:
        run(tasks, [L(pred, succ)])
    assert caught.value.task_ids == sorted({pred, succ}, key=["S1", "S2", "A"].index)


@pytest.mark.parametrize("link_type", ["FF", "SF"])
def test_finish_links_into_summary_rejected(link_type):
    with pytest.raises(SummaryLinkError) as caught:
        run([T("X"), T("S"), T("A", parent="S")], [L("X", "S", link_type)])
    assert caught.value.task_ids == ["X", "S"]


@pytest.mark.parametrize("kind", ["snlt", "fnet", "fnlt", "mso", "mfo"])
def test_every_other_summary_constraint_rejected(kind):
    with pytest.raises(SummaryConstraintError):
        run([T("S", constraint_type=kind, constraint_date=dt("2026-11-04 08:00")),
             T("A", parent="S")])


def test_leaf_constraint_is_not_a_summary_constraint():
    out = run([T("S"), T("A", 480, "S", constraint_type="mso",
                         constraint_date=dt("2026-11-04 08:00"))])
    assert out["A"].start == dt("2026-11-04 08:00")


def test_outline_link_checked_before_summary_link():
    with pytest.raises(OutlineLinkError):
        run([T("S"), T("A", parent="S")], [L("A", "S", "FF")])


def test_schedule_errors_are_schedule_errors():
    for error in (OutlineLinkError, SummaryLinkError, SummaryConstraintError, CycleError):
        assert issubclass(error, ScheduleError)


# --- beyond the table: cycles through summaries ---------------------------------------


def test_cycle_through_rollup_names_the_summary():
    with pytest.raises(CycleError) as caught:
        run([T("S"), T("A", parent="S"), T("B")], [L("S", "B"), L("B", "A")])
    assert caught.value.code == "link_cycle"
    assert caught.value.task_ids == ["S", "A", "B"]


def test_cycle_through_gate():
    # A (in S) → B → S: S's subtasks wait for B, which waits for A
    with pytest.raises(CycleError) as caught:
        run([T("S"), T("A", parent="S"), T("B")], [L("A", "B"), L("B", "S")])
    assert set(caught.value.task_ids) == {"S", "A", "B"}


def test_cycle_between_summaries():
    tasks = [T("S1"), T("A", parent="S1"), T("S2"), T("B", parent="S2"), T("C")]
    with pytest.raises(CycleError) as caught:
        run(tasks, [L("S1", "S2"), L("B", "A"), L("S2", "C")])
    # C hangs off the loop but is not on it
    assert set(caught.value.task_ids) == {"S1", "A", "S2", "B"}


def test_ss_from_summary_to_own_subtask_path_is_a_cycle():
    # S →SS Y → C with C inside S: S's rollup waits for C, so this loops
    tasks = [T("S"), T("A", parent="S"), T("C", parent="S"), T("Y")]
    with pytest.raises(CycleError):
        run(tasks, [L("S", "Y", "SS"), L("Y", "C")])


def test_no_false_cycle_from_sibling_summaries():
    # S1 → S2 and a link between their subtasks in the same direction
    tasks = [T("S1"), T("A", 480, parent="S1"), T("S2"), T("B", 480, parent="S2")]
    out = run(tasks, [L("S1", "S2"), L("A", "B")])
    assert out["B"].start == dt("2026-11-03 08:00")


# --- input the schema never stores is a caller's bug ----------------------------------


@pytest.mark.parametrize("tasks,message", [
    ([T("A", parent="X")], "unknown parent X"),
    ([T("A", parent="A")], "parents loop"),
    ([T("A", parent="B"), T("B", parent="A")], "parents loop"),
])
def test_bad_outline_is_a_value_error(tasks, message):
    with pytest.raises(ValueError, match=message) as caught:
        run(tasks)
    assert not isinstance(caught.value, ScheduleError)
