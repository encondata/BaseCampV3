"""Scheduling engine, backward pass: late start and finish, total slack and
the critical path, with deadlines and SNLT/FNLT/MSO/MFO capping late dates,
the four link types read backward, and summaries (links into and out of
them, their deadlines, their slack).

The reference week (Standard calendar, Mon-Fri 08:00-12:00 + 13:00-17:00):
Mon 2026-11-02 ... Fri 2026-11-06, Thu 2026-11-26 is a nonworking
"Thanksgiving" and Sat 2026-11-14 is a working 06:00-22:00 "Move weekend".
All datetimes are naive wall-clock times. Durations, lags and slack are
minutes (1 day = 480). `S{A, B}` means A and B are children of S.
"""

import copy
import random
import time
from dataclasses import replace
from datetime import datetime

import pytest

from serversherpa.plans.calendar import STANDARD_CALENDAR, WorkCalendar
from serversherpa.plans.engine import EngineSettings, LinkIn, TaskIn, TaskOut, schedule


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


def late(out: TaskOut) -> tuple[datetime, datetime]:
    return out.late_start, out.late_finish


def slack(out: dict[str, TaskOut], *task_ids: str) -> tuple[int, ...]:
    return tuple(out[task_id].total_slack for task_id in task_ids)


def _chain_and_c(**c_fields) -> list[TaskIn]:
    """A 960 -> B 480 is the chain (Mon 08:00 to Wed 17:00); C 480 stands alone."""
    return [T("A", 960), T("B", 480), T("C", 480, **c_fields)]


CHAIN = [L("A", "B")]


# --- the table ------------------------------------------------------------------------


def test_chain_is_critical():
    out = run(_chain_and_c(), CHAIN)
    assert slack(out, "A", "B", "C") == (0, 0, 960)
    assert out["A"].is_critical is True
    assert out["B"].is_critical is True
    assert out["C"].is_critical is False


def test_deadline_tightens_slack():
    out = run(_chain_and_c(deadline=dt("2026-11-02 17:00")), CHAIN)
    assert out["C"].total_slack == 0
    assert out["C"].is_critical is True


def test_missed_deadline_negative():
    out = run([T("D", 960, deadline=dt("2026-11-02 17:00"))])
    assert out["D"].total_slack == -480
    assert out["D"].is_critical is True


def test_threshold():
    out = run(_chain_and_c(), CHAIN, critical_slack_minutes=960)
    assert out["C"].is_critical is True


def test_complete_never_critical():
    out = run([T("A", 960, percent_complete=100), T("B", 480)], CHAIN)
    assert out["A"].is_critical is False


def test_summary_slack_is_min():
    out = run([T("S"), T("A", 960, "S"), T("B", 480, "S"), T("C", 480, "S")], CHAIN)
    assert out["S"].total_slack == 0
    assert out["S"].is_critical is True


def test_fs_lag_backward():
    out = run([T("A", 480), T("B", 480)], [L("A", "B", "FS", 480)])
    assert out["A"].total_slack == 0


def test_ss_backward():
    out = run([T("A", 1440), T("B", 480)], [L("A", "B", "SS")])
    assert slack(out, "A", "B") == (0, 960)


def test_fnlt_caps_late_finish():
    # honor off: the link wins, A runs Wed-Thu and misses its Mon 17:00
    # finish ceiling; X, which must finish before A starts, is as late
    tasks = [T("X", 960),
             T("A", 960, constraint_type="fnlt", constraint_date=dt("2026-11-02 17:00"))]
    out = run(tasks, [L("X", "A")], honor_constraints=False)
    assert (out["A"].start, out["A"].finish) == (dt("2026-11-04 08:00"),
                                                 dt("2026-11-05 17:00"))
    assert out["A"].conflict == "constraint"
    assert late(out["A"]) == (dt("2026-10-30 08:00"), dt("2026-11-02 17:00"))
    assert late(out["X"]) == (dt("2026-10-28 08:00"), dt("2026-10-29 17:00"))
    assert slack(out, "X", "A") == (-1440, -1440)
    assert out["A"].is_critical is True
    assert out["X"].is_critical is True


def test_perf_2000_tasks():
    rng = random.Random(7)
    tasks: list[TaskIn] = []
    leaves: list[str] = []
    for s in range(200):
        tasks.append(T(f"S{s}"))
        for c in range(10):
            leaf_id = f"S{s}.{c}"
            tasks.append(T(leaf_id, rng.choice((0, 240, 480, 960, 1440)), f"S{s}"))
            leaves.append(leaf_id)
    pairs: set[tuple[int, int]] = set()
    while len(pairs) < 3000:
        pairs.add(tuple(sorted(rng.sample(range(len(leaves)), 2))))
    links = [L(leaves[i], leaves[j]) for i, j in sorted(pairs)]
    numbered = [replace(task, position=index) for index, task in enumerate(tasks)]

    # CPU time of this thread (schedule() is synchronous and runs here), so a
    # loaded machine can't fail it. It guards the spec's budget for a plan
    # this size (2,000 tasks / 3,000 links in < 200 ms): about 35 ms today,
    # and the bound is 5x the budget (about 28x today), so what blows the
    # budget still fails: a calendar walked day by day, or a pass over the
    # whole plan repeated for each task (2,200 x ~35 ms is over a minute)
    began = time.thread_time()
    out = schedule(numbered, links, CAL, PROJECT_START, EngineSettings())
    took = time.thread_time() - began

    print(f"\nschedule(): {len(tasks)} tasks, {len(links)} links in {took * 1000:.0f} ms CPU")
    assert len(out) == 2200
    assert all(o.total_slack is not None and o.late_start is not None for o in out.values())
    assert any(o.is_critical for o in out.values())
    assert took < 1.0


# --- beyond the table: late dates read naturally --------------------------------------


def test_chain_late_dates():
    out = run(_chain_and_c(), CHAIN)
    # A's late finish is Tue 17:00, not the Wed 08:00 B's late start implies
    assert late(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-03 17:00"))
    assert late(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert late(out["C"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))


def test_threshold_is_inclusive():
    assert run(_chain_and_c(), CHAIN, critical_slack_minutes=959)["C"].is_critical is False


def test_complete_task_still_has_slack():
    out = run([T("A", 960, percent_complete=100), T("B", 480)], CHAIN)
    assert out["A"].total_slack == 0
    assert out["B"].is_critical is True


def test_project_finish_caps_every_task():
    # nothing follows C: it may finish as late as the project does
    out = run([T("A", 2400), T("C", 480)])
    assert late(out["C"]) == (dt("2026-11-06 08:00"), dt("2026-11-06 17:00"))
    assert out["C"].total_slack == 1920


def test_late_dates_cross_the_holiday():
    # project start Tue 11-24; A runs Tue-Fri (Thu is Thanksgiving)
    out = run([T("A", 1440), T("C", 480)], start=dt("2026-11-24 08:00"))
    assert out["A"].finish == dt("2026-11-27 17:00")
    assert late(out["C"]) == (dt("2026-11-27 08:00"), dt("2026-11-27 17:00"))
    assert out["C"].total_slack == 960


# --- beyond the table: links read backward --------------------------------------------


def test_fs_lead_backward():
    # B starts Tue 13:00 with a half-day lead; A must still finish by Tue 17:00
    out = run([T("A", 960), T("B", 480)], [L("A", "B", "FS", -240)])
    assert late(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-03 17:00"))
    assert slack(out, "A", "B") == (0, 0)


def test_fs_elapsed_lag_backward():
    # a 24 h wall-clock lag: back from B's Wed 08:00 late start is Tue 08:00,
    # read as Mon 17:00; a working-time lag would have meant Fri 10-30
    out = run([T("A", 480), T("B", 480)], [L("A", "B", "FS", 1440, elapsed=True)])
    assert late(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert out["A"].total_slack == 0


def test_ff_backward():
    # A must finish by B's late finish, Tue 17:00
    out = run([T("A", 480), T("B", 960)], [L("A", "B", "FF")])
    assert late(out["A"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))
    assert slack(out, "A", "B") == (480, 0)


def test_ff_lag_backward():
    out = run([T("A", 480), T("B", 480)], [L("A", "B", "FF", 480)])
    assert late(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert slack(out, "A", "B") == (0, 0)


def test_sf_lag_backward():
    # B (Tue) must finish 2 days after A starts: A's start is capped at Mon 08:00
    out = run([T("A", 480), T("B", 480)], [L("A", "B", "SF", 960)])
    assert out["B"].start == dt("2026-11-03 08:00")
    assert late(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert slack(out, "A", "B") == (0, 0)


def test_max_of_successors():
    # A feeds a short and a long branch: the long one decides
    tasks = [T("A", 480), T("B", 480), T("C", 1440), T("D", 480)]
    out = run(tasks, [L("A", "B"), L("A", "C"), L("B", "D"), L("C", "D")])
    assert slack(out, "A", "B", "C", "D") == (0, 960, 0, 0)


# --- beyond the table: milestones, elapsed, manual, actuals ---------------------------


def test_milestone_backward():
    tasks = [T("A", 480), T("M", 0), T("B", 480)]
    out = run(tasks, [L("A", "M"), L("M", "B")])
    assert out["M"].start == dt("2026-11-02 17:00")
    # a milestone's late date is not moved back across the night
    assert late(out["M"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 08:00"))
    assert slack(out, "A", "M", "B") == (0, 0, 0)
    assert out["M"].is_critical is True


def test_elapsed_task_late_dates_are_wall_clock():
    # E (2 h elapsed) feeds B with A; its late finish stays Tue 08:00
    tasks = [T("A", 480), T("E", 120, elapsed=True), T("B", 480)]
    out = run(tasks, [L("A", "B"), L("E", "B")])
    assert late(out["E"]) == (dt("2026-11-03 06:00"), dt("2026-11-03 08:00"))
    assert out["E"].total_slack == 480


def test_manual_task_uses_its_typed_span():
    tasks = [T("M", 480, mode="manual", start=dt("2026-11-03 10:00"),
               finish=dt("2026-11-04 15:00")),
             T("C", 2400)]
    out = run(tasks)
    assert late(out["M"]) == (dt("2026-11-05 13:00"), dt("2026-11-06 17:00"))
    assert out["M"].total_slack == 1080


def test_actual_finish_keeps_the_length_it_ran():
    # A was scheduled 2 days but finished in half of one
    tasks = [T("A", 960, actual_start=dt("2026-11-02 08:00"),
               actual_finish=dt("2026-11-02 12:00"), percent_complete=100),
             T("C", 2400)]
    out = run(tasks)
    assert late(out["A"]) == (dt("2026-11-06 13:00"), dt("2026-11-06 17:00"))
    assert out["A"].total_slack == 2160
    assert out["A"].is_critical is False


# --- beyond the table: constraints cap late dates -------------------------------------


def test_snlt_caps_late_start():
    out = run([T("A", 480, constraint_type="snlt", constraint_date=dt("2026-11-04 08:00")),
               T("C", 2400)])
    assert out["A"].start == dt("2026-11-02 08:00")
    assert late(out["A"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert out["A"].total_slack == 960


@pytest.mark.parametrize("kind,date", [("mso", "2026-11-04 08:00"),
                                       ("mfo", "2026-11-04 17:00")])
def test_pinned_task_has_no_slack(kind, date):
    out = run([T("A", 480, constraint_type=kind, constraint_date=dt(date)), T("C", 2400)])
    assert late(out["A"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert out["A"].total_slack == 0
    assert out["A"].is_critical is True


def test_fnet_and_snet_do_not_cap_late_dates():
    tasks = [T("A", 480, constraint_type="snet", constraint_date=dt("2026-11-03 08:00")),
             T("B", 480, constraint_type="fnet", constraint_date=dt("2026-11-03 17:00")),
             T("C", 2400)]
    out = run(tasks)
    assert slack(out, "A", "B") == (1440, 1440)


def test_honored_ceiling_pushes_negative_slack_onto_its_predecessor():
    # B is held at Mon (FNLT) against the link: X, which has to finish
    # before B starts, is two days late
    tasks = [T("X", 960),
             T("B", 480, constraint_type="fnlt", constraint_date=dt("2026-11-02 17:00"))]
    out = run(tasks, [L("X", "B")])
    assert out["B"].conflict == "link"
    assert slack(out, "X", "B") == (-960, 0)
    assert late(out["X"]) == (dt("2026-10-29 08:00"), dt("2026-10-30 17:00"))


@pytest.mark.parametrize("honor", [True, False])
def test_fnlt_before_project_start_without_links_has_no_slack(honor):
    # no link passes the ceiling, so it wins quietly, honor on or off: A is
    # placed before the project start and finishes on its FNLT date
    out = run([T("A", 960, constraint_type="fnlt", constraint_date=dt("2026-11-02 17:00"))],
              honor_constraints=honor)
    a = out["A"]
    assert (a.start, a.finish) == (dt("2026-10-30 08:00"), dt("2026-11-02 17:00"))
    assert late(a) == (dt("2026-10-30 08:00"), dt("2026-11-02 17:00"))
    assert a.total_slack == 0
    assert a.conflict is None


def test_manual_task_ignores_its_constraint_backward():
    # the engine ignores a manual task's constraint both ways
    tasks = [T("M", 480, mode="manual", start=dt("2026-11-02 08:00"),
               constraint_type="mfo", constraint_date=dt("2026-11-02 17:00")),
             T("C", 2400)]
    assert run(tasks)["M"].total_slack == 1920


def test_manual_task_deadline_caps_its_late_finish():
    tasks = [T("M", 480, mode="manual", start=dt("2026-11-02 08:00"),
               deadline=dt("2026-11-03 17:00")),
             T("C", 2400)]
    out = run(tasks)
    assert late(out["M"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))
    assert out["M"].total_slack == 480


def test_deadline_does_not_move_dates():
    out = run([T("D", 960, deadline=dt("2026-11-02 17:00"))])
    assert (out["D"].start, out["D"].finish) == (dt("2026-11-02 08:00"),
                                                 dt("2026-11-03 17:00"))
    assert late(out["D"]) == (dt("2026-10-30 08:00"), dt("2026-11-02 17:00"))


# --- beyond the table: summaries ------------------------------------------------------


def test_summary_late_dates_span_its_subtasks():
    out = run([T("S"), T("A", 960, "S"), T("B", 480, "S"), T("C", 480, "S")], CHAIN)
    assert late(out["S"]) == (dt("2026-11-02 08:00"), dt("2026-11-04 17:00"))


def test_summary_not_critical_when_every_critical_subtask_is_complete():
    out = run([T("S"), T("A", 480, "S", percent_complete=100), T("C", 480)])
    assert out["A"].total_slack == 0
    assert out["S"].total_slack == 0
    assert out["S"].is_critical is False


def test_link_into_summary_reads_its_earliest_late_start():
    # P -> S{A 1 day, B 2 days}: B decides, so P has no slack
    tasks = [T("P", 480), T("S"), T("A", 480, "S"), T("B", 960, "S")]
    out = run(tasks, [L("P", "S")])
    assert slack(out, "P", "A", "B", "S") == (0, 480, 0, 0)
    assert late(out["S"]) == (dt("2026-11-03 08:00"), dt("2026-11-04 17:00"))


def test_ss_into_summary_backward():
    # P -SS-> S{A 3 days}; C (4 days) sets the project finish
    tasks = [T("P", 480), T("S"), T("A", 1440, "S"), T("C", 1920)]
    out = run(tasks, [L("P", "S", "SS")])
    # A may start as late as Tue 08:00, so P may too
    assert late(out["P"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))
    assert slack(out, "P", "A") == (480, 480)


def test_fs_from_summary_caps_every_subtask():
    tasks = [T("S"), T("A", 480, "S"), T("B", 960, "S"), T("X", 480)]
    out = run(tasks, [L("S", "X")])
    assert late(out["A"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))
    assert slack(out, "A", "B", "X", "S") == (480, 0, 0, 0)


def test_ss_from_summary_caps_every_subtask_tied_for_its_start():
    # S must start by Mon 08:00 for X to keep its SS + 1 day; A and B both
    # start S, so each must start by then
    tasks = [T("S"), T("A", 480, "S"), T("B", 960, "S"), T("X", 960)]
    out = run(tasks, [L("S", "X", "SS", 480)])
    assert out["X"].start == dt("2026-11-03 08:00")
    assert late(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert late(out["B"]) == (dt("2026-11-02 08:00"), dt("2026-11-03 17:00"))
    assert slack(out, "A", "B", "X") == (0, 0, 0)


def _ss_probe(**x_fields) -> list[TaskIn]:
    """S{A 1 day -> B 1 day} (Mon-Tue) -SS-> X 3 days (Mon-Wed)."""
    return [T("S"), T("A", 480, "S"), T("B", 480, "S"), T("X", 1440, **x_fields)]


SS_PROBE = [L("A", "B"), L("S", "X", "SS")]


def test_ss_from_summary_caps_only_the_subtask_that_starts_it():
    # S must start by Mon 08:00, and A sets S's start; B may slip to the
    # project finish without moving it
    out = run(_ss_probe(), SS_PROBE)
    assert late(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert late(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert slack(out, "A", "B", "S", "X") == (0, 480, 0, 0)
    assert out["A"].is_critical is True
    assert out["B"].is_critical is False


def test_ss_from_summary_with_room_is_not_critical():
    # the same with C (4 days) setting the finish: S may start as late as
    # Tue 08:00
    out = run(_ss_probe() + [T("C", 1920)], SS_PROBE)
    assert late(out["A"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))
    assert late(out["B"]) == (dt("2026-11-05 08:00"), dt("2026-11-05 17:00"))
    assert slack(out, "A", "B", "S", "X") == (480, 960, 480, 480)
    for task_id in ("A", "B", "S", "X"):
        assert out[task_id].is_critical is False, task_id


def test_ss_from_summary_that_must_start_earlier_is_negative():
    # X's deadline needs it (so S) to start Fri 10-30: A, which starts S,
    # is a day late; B still is not
    out = run(_ss_probe(deadline=dt("2026-11-03 17:00")), SS_PROBE)
    assert late(out["A"]) == (dt("2026-10-30 08:00"), dt("2026-10-30 17:00"))
    assert slack(out, "A", "B", "S", "X") == (-480, 480, -480, -480)
    assert out["A"].is_critical is True
    assert out["B"].is_critical is False


def test_ss_from_summary_caps_an_elapsed_starter_in_wall_clock():
    # E (1 h elapsed) starts S at Mon 08:00 and must finish by 09:00; A
    # starts Mon 13:00, after S's start, and is not capped
    tasks = [T("S"), T("E", 60, "S", elapsed=True),
             T("A", 480, "S", constraint_type="snet", constraint_date=dt("2026-11-02 13:00")),
             T("X", 1440)]
    out = run(tasks, [L("S", "X", "SS")])
    assert late(out["E"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 09:00"))
    assert slack(out, "E", "A", "S") == (0, 720, 0)


def test_ss_from_outer_summary_compares_with_its_start():
    # P{C, N{B}} -SS-> X: C starts P and is capped; B starts N but not P, so
    # it is free (compared with N's start it would be a day late)
    tasks = [T("P"), T("C", 480, "P"), T("N", parent="P"),
             T("B", 480, "N", constraint_type="snet", constraint_date=dt("2026-11-03 08:00")),
             T("X", 1440)]
    out = run(tasks, [L("P", "X", "SS")])
    assert late(out["C"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert late(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert slack(out, "C", "B", "N", "P") == (0, 480, 480, 0)


def test_ss_from_outer_summary_reaches_a_nested_subtask_that_starts_it():
    # P{N{B}, C} -SS-> X: B, inside N, starts P, so P's bound reaches it
    tasks = [T("P"), T("N", parent="P"), T("B", 480, "N"),
             T("C", 480, "P", constraint_type="snet", constraint_date=dt("2026-11-03 08:00")),
             T("X", 1440)]
    out = run(tasks, [L("P", "X", "SS")])
    assert late(out["B"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert slack(out, "B", "C", "N", "P") == (0, 480, 0, 0)


def test_sf_from_summary_backward():
    # X must finish 3 days after S starts: A, which starts S, must start by
    # Mon 08:00; B is free
    out = run(_ss_probe()[:3] + [T("X", 480)], [L("A", "B"), L("S", "X", "SF", 1440)])
    assert out["X"].start == dt("2026-11-04 08:00")
    assert late(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert late(out["B"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert slack(out, "A", "B", "S", "X") == (0, 480, 0, 0)


def test_ff_from_summary_backward():
    tasks = [T("S"), T("A", 480, "S"), T("X", 960)]
    out = run(tasks, [L("S", "X", "FF", 480)])
    # X finishes Tue 17:00, a day after S: S (so A) must finish by Mon 17:00
    assert late(out["A"]) == (dt("2026-11-02 08:00"), dt("2026-11-02 17:00"))
    assert slack(out, "A", "X") == (0, 0)


def test_summary_deadline_caps_every_descendant():
    tasks = [T("S", deadline=dt("2026-11-02 17:00")), T("N", parent="S"),
             T("A", 480, "N"), T("B", 480, "S"), T("C", 1440)]
    out = run(tasks)
    assert slack(out, "A", "B", "N", "S", "C") == (0, 0, 0, 0, 0)
    assert out["S"].is_critical is True


def test_nested_summary_link_caps_grandchildren():
    tasks = [T("S"), T("N", parent="S"), T("A", 480, "N"), T("X", 480), T("C", 1440)]
    out = run(tasks, [L("S", "X")])
    # X may run Wed; A, two levels down, must finish by Tue 17:00
    assert late(out["A"]) == (dt("2026-11-03 08:00"), dt("2026-11-03 17:00"))
    assert slack(out, "A", "N", "S", "X") == (480, 480, 480, 480)


def test_link_between_summaries_backward():
    tasks = [T("S1"), T("A", 480, "S1"), T("S2"), T("B", 960, "S2"), T("C", 2400)]
    out = run(tasks, [L("S1", "S2")])
    # S2 may start as late as Thu 08:00, so S1's A may finish by Wed 17:00
    assert late(out["A"]) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    assert slack(out, "A", "B", "S1", "S2") == (960, 960, 960, 960)


def test_empty_plan():
    assert run([]) == {}


def test_every_task_gets_late_fields():
    tasks = [T("S"), T("A", 480, "S"), T("M", 0, "S"), T("E", 60, elapsed=True)]
    out = run(tasks, [L("A", "M")])
    for task_id, o in out.items():
        assert o.late_start is not None and o.late_finish is not None, task_id
        assert isinstance(o.total_slack, int), task_id
