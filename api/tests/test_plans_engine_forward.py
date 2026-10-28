"""Scheduling engine, forward pass for leaf tasks: the four link types with
lag and lead, milestones, elapsed durations, constraints (Honor constraints
and conflict flags), manual tasks and actuals.

The reference week (Standard calendar, Mon-Fri 08:00-12:00 + 13:00-17:00):
Mon 2026-11-02 ... Fri 2026-11-06, Thu 2026-11-26 is a nonworking
"Thanksgiving" and Sat 2026-11-14 is a working 06:00-22:00 "Move weekend".
All datetimes are naive wall-clock times. Durations and lags are minutes
(1 day = 480).
"""

import copy
from dataclasses import replace
from datetime import datetime

import pytest

from serversherpa.plans.calendar import STANDARD_CALENDAR, CalendarError, WorkCalendar
from serversherpa.plans.engine import (
    CycleError,
    EngineSettings,
    LinkIn,
    ScheduleError,
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


def T(task_id: str, duration: int = 480, **fields) -> TaskIn:
    """A leaf task; `run` numbers positions in list order."""
    return TaskIn(id=task_id, parent_id=None, position=0, duration=duration, **fields)


def L(pred: str, succ: str, link_type: str = "FS", lag: int = 0,
      elapsed: bool = False) -> LinkIn:
    return LinkIn(predecessor_id=pred, successor_id=succ, link_type=link_type, lag=lag,
                  lag_elapsed=elapsed)


def run(tasks, links=(), start: datetime = PROJECT_START, **settings) -> dict[str, TaskOut]:
    numbered = [replace(task, position=index) for index, task in enumerate(tasks)]
    return schedule(numbered, list(links), CAL, start, EngineSettings(**settings))


def dates(out: TaskOut) -> tuple[datetime, datetime]:
    return out.start, out.finish


# --- plain tasks and the project start ----------------------------------------------


def test_single_task():
    out = run([T("A", 2400)])
    assert dates(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-06 17:00"))


def test_project_start_on_sunday():
    out = run([T("A", 480)], start=dt("2026-11-01 00:00"))
    assert dates(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))


# --- the four link types, lag and lead ----------------------------------------------


def test_fs():
    out = run([T("A", 960), T("B", 480)], [L("A", "B")])
    assert dates(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))


def test_fs_lag():
    out = run([T("A", 960), T("B", 480)], [L("A", "B", "FS", 480)])
    assert out["B"].start == dt("2026-11-05 08:00")


def test_fs_lead():
    out = run([T("A", 960), T("B", 480)], [L("A", "B", "FS", -240)])
    assert dates(out["B"]) == (dt("2026-11-03 13:00"), dt("2026-11-04 12:00"))


def test_fs_elapsed_lag():
    out = run([T("A", 480), T("B", 480)], [L("A", "B", "FS", 1440, elapsed=True)])
    assert out["B"].start == dt("2026-11-04 08:00")


def test_ss_lag():
    out = run([T("A", 1440), T("B", 480)], [L("A", "B", "SS", 480)])
    assert dates(out["B"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))


def test_ff():
    out = run([T("A", 1440), T("B", 480)], [L("A", "B", "FF")])
    assert dates(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))


def test_sf():
    tasks = [T("A", 480, constraint_type="snet", constraint_date=dt("2026-11-04 08:00")),
             T("B", 480)]
    out = run(tasks, [L("A", "B", "SF")])
    assert dates(out["B"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))


def test_max_of_predecessors():
    # C sits below B in the outline: the link order, not the position, decides
    out = run([T("A", 480), T("B", 480), T("C", 1440)], [L("A", "B"), L("C", "B")])
    assert out["B"].start == dt("2026-11-05 08:00")


# --- boundary snapping, milestones, elapsed durations -------------------------------


def test_lunch_snap():
    out = run([T("A", 240), T("B", 240)], [L("A", "B")])
    assert dates(out["B"]) == (dt("2026-11-02 13:00"), dt("2026-11-02 17:00"))


def test_milestone_no_snap():
    out = run([T("A", 960), T("M", 0)], [L("A", "M")])
    assert dates(out["M"]) == (dt("2026-11-03 17:00"), dt("2026-11-03 17:00"))


def test_elapsed_task():
    out = run([T("A", 480), T("E", 2880, elapsed=True)], [L("A", "E")])
    assert dates(out["E"]) == (dt("2026-11-02 17:00"), dt("2026-11-04 17:00"))


# --- constraints: floors, pins, ceilings and the Honor constraints rule -------------


def test_snet():
    out = run([T("A", 480, constraint_type="snet", constraint_date=dt("2026-11-05 08:00"))])
    assert dates(out["A"]) == (dt("2026-11-05 08:00"), dt("2026-11-05 17:00"))


def test_fnet():
    out = run([T("A", 480, constraint_type="fnet", constraint_date=dt("2026-11-06 17:00"))])
    assert dates(out["A"]) == (dt("2026-11-06 08:00"), dt("2026-11-06 17:00"))


def test_mfo():
    out = run([T("A", 960, constraint_type="mfo", constraint_date=dt("2026-11-06 17:00"))])
    assert dates(out["A"]) == (dt("2026-11-05 08:00"), dt("2026-11-06 17:00"))


def _mso_chain():
    return [T("A", 1920),
            T("B", 480, constraint_type="mso", constraint_date=dt("2026-11-04 08:00"))]


def test_mso_honored():
    out = run(_mso_chain(), [L("A", "B")])
    assert out["B"].start == dt("2026-11-04 08:00")
    assert out["B"].conflict == "link"


def test_mso_not_honored():
    out = run(_mso_chain(), [L("A", "B")], honor_constraints=False)
    assert out["B"].start == dt("2026-11-06 08:00")
    assert out["B"].conflict == "constraint"


def _snlt_chain():
    return [T("A", 960),
            T("B", 480, constraint_type="snlt", constraint_date=dt("2026-11-03 08:00"))]


def test_snlt_honored():
    out = run(_snlt_chain(), [L("A", "B")])
    assert out["B"].start == dt("2026-11-03 08:00")
    assert out["B"].conflict == "link"


def test_snlt_not_honored():
    out = run(_snlt_chain(), [L("A", "B")], honor_constraints=False)
    assert out["B"].start == dt("2026-11-04 08:00")
    assert out["B"].conflict == "constraint"


def test_fnlt_honored():
    tasks = [T("A", 960),
             T("B", 480, constraint_type="fnlt", constraint_date=dt("2026-11-03 17:00"))]
    out = run(tasks, [L("A", "B")])
    assert out["B"].finish == dt("2026-11-03 17:00")
    assert out["B"].conflict == "link"


def test_snlt_satisfied():
    out = run([T("B", 480, constraint_type="snlt", constraint_date=dt("2026-11-05 08:00"))])
    assert out["B"].start == dt("2026-11-02 08:00")
    assert out["B"].conflict is None


# --- manual tasks and actuals --------------------------------------------------------


def _manual():
    return T("M", 960, mode="manual", start=dt("2026-11-03 10:00"),
             finish=dt("2026-11-04 15:00"))


def test_manual_task_stays():
    out = run([T("A", 1920), _manual()], [L("A", "M")])
    assert dates(out["M"]) == (dt("2026-11-03 10:00"), dt("2026-11-04 15:00"))


def test_manual_drives_successor():
    out = run([_manual(), T("B", 480)], [L("M", "B")])
    assert dates(out["B"]) == (dt("2026-11-04 15:00"), dt("2026-11-05 15:00"))


def test_actual_start_pins():
    tasks = [T("A", 1920), T("B", 480, actual_start=dt("2026-11-02 10:00"))]
    out = run(tasks, [L("A", "B")])
    assert dates(out["B"]) == (dt("2026-11-02 10:00"), dt("2026-11-03 10:00"))


def test_actual_finish_pins():
    out = run([T("A", 480, actual_start=dt("2026-11-02 08:00"),
                 actual_finish=dt("2026-11-03 12:00"))])
    assert out["A"].finish == dt("2026-11-03 12:00")


def test_not_started_past_is_not_moved():
    out = run([T("A", 480)], start=dt("2026-01-05 08:00"))
    assert dates(out["A"]) == (dt("2026-01-05 08:00"), dt("2026-01-05 17:00"))


# --- calendar exceptions ------------------------------------------------------------


def test_holiday_skipped():
    out = run([T("A", 960)], start=dt("2026-11-25 08:00"))
    assert out["A"].finish == dt("2026-11-27 17:00")


def test_working_saturday():
    out = run([T("A", 960)], start=dt("2026-11-13 08:00"))
    assert dates(out["A"]) == (dt("2026-11-13 08:00"), dt("2026-11-14 14:00"))


# --- beyond the table: the edges the rules above leave open ---------------------------


def test_fs_after_milestone_snaps():
    out = run([T("A", 960), T("M", 0), T("B", 480)], [L("A", "M"), L("M", "B")])
    assert dates(out["M"]) == (dt("2026-11-03 17:00"), dt("2026-11-03 17:00"))
    assert dates(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))


def test_milestone_at_project_start_is_snapped():
    out = run([T("M", 0)], start=dt("2026-11-01 00:00"))
    assert dates(out["M"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 08:00"))


def test_ss_lead_crosses_weekend():
    tasks = [T("A", 480, constraint_type="snet", constraint_date=dt("2026-11-09 08:00")),
             T("B", 480)]
    out = run(tasks, [L("A", "B", "SS", -480)])
    assert dates(out["B"]) == (dt("2026-11-06 08:00"), dt("2026-11-06 17:00"))


def test_fs_elapsed_lead():
    out = run([T("A", 960), T("B", 480)], [L("A", "B", "FS", -720, elapsed=True)])
    assert dates(out["B"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))


def test_ff_into_elapsed_task():
    out = run([T("A", 1440), T("E", 1440, elapsed=True)], [L("A", "E", "FF")])
    assert dates(out["E"]) == (dt("2026-11-03 17:00"), dt("2026-11-04 17:00"))


def test_mso_after_links_is_no_conflict():
    tasks = [T("A", 480),
             T("B", 480, constraint_type="mso", constraint_date=dt("2026-11-05 08:00"))]
    out = run(tasks, [L("A", "B")])
    assert dates(out["B"]) == (dt("2026-11-05 08:00"), dt("2026-11-05 17:00"))
    assert out["B"].conflict is None


def test_mfo_honored():
    tasks = [T("A", 1920),
             T("B", 480, constraint_type="mfo", constraint_date=dt("2026-11-04 17:00"))]
    out = run(tasks, [L("A", "B")])
    assert dates(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert out["B"].conflict == "link"


def test_fnlt_not_honored():
    tasks = [T("A", 960),
             T("B", 480, constraint_type="fnlt", constraint_date=dt("2026-11-03 17:00"))]
    out = run(tasks, [L("A", "B")], honor_constraints=False)
    assert dates(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert out["B"].conflict == "constraint"


@pytest.mark.parametrize("honor", [True, False])
def test_ceiling_before_project_start_is_no_conflict(honor):
    """The project start is not a link: a ceiling before it wins quietly."""
    tasks = [T("B", 480, constraint_type="snlt", constraint_date=dt("2026-10-30 08:00"))]
    out = run(tasks, honor_constraints=honor)
    assert dates(out["B"]) == (dt("2026-10-30 08:00"), dt("2026-10-30 17:00"))
    assert out["B"].conflict is None


def test_constraint_without_date_is_ignored():
    out = run([T("A", 480, constraint_type="mso")])
    assert dates(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert out["A"].conflict is None


def test_actual_start_clears_conflict():
    tasks = [T("A", 1920),
             T("B", 480, constraint_type="mso", constraint_date=dt("2026-11-04 08:00"),
               actual_start=dt("2026-11-02 10:00"))]
    out = run(tasks, [L("A", "B")])
    assert dates(out["B"]) == (dt("2026-11-02 10:00"), dt("2026-11-03 10:00"))
    assert out["B"].conflict is None


def test_manual_ignores_constraint():
    manual = replace(_manual(), constraint_type="mso", constraint_date=dt("2026-11-06 08:00"))
    out = run([manual])
    assert dates(out["M"]) == (dt("2026-11-03 10:00"), dt("2026-11-04 15:00"))
    assert out["M"].conflict is None


def test_manual_start_only():
    out = run([T("M", 960, mode="manual", start=dt("2026-11-03 10:00"))])
    assert dates(out["M"]) == (dt("2026-11-03 10:00"), dt("2026-11-05 10:00"))


def test_manual_finish_only():
    out = run([T("M", 480, mode="manual", finish=dt("2026-11-04 15:00"))])
    assert dates(out["M"]) == (dt("2026-11-03 15:00"), dt("2026-11-04 15:00"))


def test_manual_without_dates_at_project_start():
    out = run([T("M", 480, mode="manual")])
    assert dates(out["M"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))


# --- the output shape and the error types later tasks raise --------------------------


def test_leaf_output_fields():
    out = run([T("A", 960, percent_complete=40)])
    a = out["A"]
    assert (a.duration, a.is_summary, a.percent_complete) == (960, False, 40)
    assert (a.late_start, a.late_finish, a.total_slack) == (None, None, None)
    assert a.is_critical is False
    assert a.conflict is None


def test_date_out_of_range_is_a_calendar_error():
    with pytest.raises(CalendarError):
        run([T("A"), T("B")], [L("A", "B", "FS", 5_000_000_000, elapsed=True)])


def test_leaf_cycle_rejected():
    tasks = [T("A"), T("B"), T("C"), T("D")]
    with pytest.raises(CycleError) as caught:
        run(tasks, [L("A", "B"), L("B", "C"), L("C", "A"), L("C", "D")])
    assert isinstance(caught.value, ScheduleError)
    assert caught.value.code == "link_cycle"
    assert set(caught.value.task_ids) == {"A", "B", "C"}
