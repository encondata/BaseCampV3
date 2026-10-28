"""Work calendar arithmetic: the boundaries every scheduled date rests on.

The reference week (Standard calendar, Mon-Fri 08:00-12:00 + 13:00-17:00):
Mon 2026-11-02 ... Fri 2026-11-06, Thu 2026-11-26 is a nonworking
"Thanksgiving" and Sat 2026-11-14 is a working 06:00-22:00 "Move weekend".
All datetimes are naive wall-clock times.
"""

import copy
import random
from bisect import bisect_left
from datetime import date, datetime, time, timedelta

import pytest

from serversherpa.plans.calendar import (
    MAX_SEARCH_DAYS,
    STANDARD_CALENDAR,
    CalendarError,
    WorkCalendar,
)
from serversherpa.plans.durations import Units
from serversherpa.system.config_store import DEFAULTS

MINUTE = timedelta(minutes=1)
ONE_DAY = timedelta(days=1)


@pytest.fixture(autouse=True)
def clean_db():
    """These tests are pure and never touch the database: shadow the
    conftest fixture that truncates every table before each test (about a
    second apiece, which would dwarf this module's runtime)."""
    yield


THANKSGIVING = {"date": "2026-11-26", "name": "Thanksgiving", "hours": []}
MOVE_WEEKEND = {"date": "2026-11-14", "name": "Move weekend", "hours": [["06:00", "22:00"]]}


def dt(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%d %H:%M")


def calendar_json(**changes) -> dict:
    """The Standard calendar with `changes` applied (a deep copy each time)."""
    return {**copy.deepcopy(STANDARD_CALENDAR), **changes}


WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def empty_week() -> dict:
    return {day: [] for day in WEEKDAYS}


@pytest.fixture(scope="module")
def cal() -> WorkCalendar:
    return WorkCalendar.from_json(calendar_json(exceptions=[THANKSGIVING, MOVE_WEEKEND]))


def bad_calendar(data) -> CalendarError:
    with pytest.raises(CalendarError) as caught:
        WorkCalendar.from_json(data)
    assert caught.value.code == "bad_calendar"
    return caught.value


# --- the standard calendar and where it is stored ---------------------------------


def test_standard_calendar_matches_the_system_defaults():
    assert STANDARD_CALENDAR == DEFAULTS["project_plans"]["calendar"]
    assert STANDARD_CALENDAR["exceptions"] == []


def test_standard_calendar_is_a_valid_calendar():
    standard = WorkCalendar.from_json(STANDARD_CALENDAR)
    assert standard.units == Units(minutes_per_day=480, minutes_per_week=2400,
                                   minutes_per_month=9600)
    assert standard.default_start == time(8, 0)
    assert standard.default_end == time(17, 0)


# --- next_work_start: t if inside [s, e), else the next interval start -------------


def test_next_start_before_day(cal):
    assert cal.next_work_start(dt("2026-11-02 07:00")) == dt("2026-11-02 08:00")


def test_next_start_at_lunch(cal):
    assert cal.next_work_start(dt("2026-11-02 12:00")) == dt("2026-11-02 13:00")


def test_next_start_at_day_end(cal):
    assert cal.next_work_start(dt("2026-11-02 17:00")) == dt("2026-11-03 08:00")


def test_next_start_friday_end(cal):
    assert cal.next_work_start(dt("2026-11-06 17:00")) == dt("2026-11-09 08:00")


def test_next_start_skips_holiday(cal):
    assert cal.next_work_start(dt("2026-11-25 17:00")) == dt("2026-11-27 08:00")


def test_next_start_working_saturday(cal):
    assert cal.next_work_start(dt("2026-11-13 17:00")) == dt("2026-11-14 06:00")


@pytest.mark.parametrize("moment", [
    "2026-11-02 08:00",  # an interval's start is inside it
    "2026-11-02 10:30",
    "2026-11-02 11:59",
    "2026-11-02 13:00",
    "2026-11-02 16:59",
    "2026-11-14 06:00",
    "2026-11-14 21:59",
])
def test_next_start_inside_an_interval_does_not_move(cal, moment):
    assert cal.next_work_start(dt(moment)) == dt(moment)


def test_next_start_keeps_seconds_when_inside(cal):
    inside = datetime(2026, 11, 2, 10, 30, 15, 250)
    assert cal.next_work_start(inside) == inside


@pytest.mark.parametrize("moment,expected", [
    ("2026-11-02 00:00", "2026-11-02 08:00"),  # midnight is before the day
    ("2026-11-07 10:00", "2026-11-09 08:00"),  # Saturday, nonworking
    ("2026-11-08 23:59", "2026-11-09 08:00"),  # Sunday night
    ("2026-11-26 09:00", "2026-11-27 08:00"),  # on the holiday itself
    ("2026-11-14 22:00", "2026-11-16 08:00"),  # the working Saturday's end
])
def test_next_start_from_nonworking_time(cal, moment, expected):
    assert cal.next_work_start(dt(moment)) == dt(expected)


# --- prev_work_end: t if inside (s, e], else the previous interval end -------------


@pytest.mark.parametrize("moment,expected", [
    ("2026-11-02 17:00", "2026-11-02 17:00"),  # an interval's end is inside it
    ("2026-11-02 12:00", "2026-11-02 12:00"),
    ("2026-11-02 10:30", "2026-11-02 10:30"),
    ("2026-11-02 08:01", "2026-11-02 08:01"),
    ("2026-11-02 08:00", "2026-10-30 17:00"),  # a start is NOT inside (s, e]
    ("2026-11-02 13:00", "2026-11-02 12:00"),
    ("2026-11-02 12:30", "2026-11-02 12:00"),  # lunch
    ("2026-11-02 18:00", "2026-11-02 17:00"),
    ("2026-11-03 00:00", "2026-11-02 17:00"),
    ("2026-11-08 12:00", "2026-11-06 17:00"),  # Sunday
    ("2026-11-27 08:00", "2026-11-25 17:00"),  # across the holiday
    ("2026-11-16 08:00", "2026-11-14 22:00"),  # the working Saturday
])
def test_prev_end(cal, moment, expected):
    assert cal.prev_work_end(dt(moment)) == dt(expected)


# --- add_work -----------------------------------------------------------------------


def test_add_full_day_ends_at_17(cal):
    assert cal.add_work(dt("2026-11-02 08:00"), 480) == dt("2026-11-02 17:00")


def test_add_half_day_ends_at_lunch(cal):
    assert cal.add_work(dt("2026-11-02 08:00"), 240) == dt("2026-11-02 12:00")


def test_add_crosses_lunch(cal):
    assert cal.add_work(dt("2026-11-02 08:00"), 300) == dt("2026-11-02 14:00")


def test_add_from_day_end(cal):
    assert cal.add_work(dt("2026-11-02 17:00"), 60) == dt("2026-11-03 09:00")


def test_add_over_weekend(cal):
    assert cal.add_work(dt("2026-11-06 13:00"), 960) == dt("2026-11-10 12:00")


def test_add_zero_does_not_snap(cal):
    assert cal.add_work(dt("2026-11-02 17:00"), 0) == dt("2026-11-02 17:00")


def test_add_zero_does_not_snap_off_hours(cal):
    assert cal.add_work(dt("2026-11-07 10:00"), 0) == dt("2026-11-07 10:00")


@pytest.mark.parametrize("start,minutes,expected", [
    ("2026-11-02 12:00", 60, "2026-11-02 14:00"),  # starts after lunch
    ("2026-11-02 16:59", 1, "2026-11-02 17:00"),  # ends exactly at the day's end
    ("2026-11-02 17:00", 1, "2026-11-03 08:01"),
    ("2026-11-02 11:59", 2, "2026-11-02 13:01"),
    ("2026-11-02 07:00", 60, "2026-11-02 09:00"),  # snaps forward first
    ("2026-11-07 10:00", 60, "2026-11-09 09:00"),  # Saturday start
    ("2026-11-02 08:00", 2400, "2026-11-06 17:00"),  # exactly one week of work
    ("2026-11-02 08:00", 2401, "2026-11-09 08:01"),
    ("2026-11-25 16:00", 120, "2026-11-27 09:00"),  # across the holiday
    ("2026-11-13 17:00", 60, "2026-11-14 07:00"),  # into the working Saturday
    ("2026-11-14 06:00", 960, "2026-11-14 22:00"),  # a whole 16-hour Saturday
    ("2026-11-14 06:00", 961, "2026-11-16 08:01"),
])
def test_add_boundaries(cal, start, minutes, expected):
    assert cal.add_work(dt(start), minutes) == dt(expected)


def test_add_keeps_seconds(cal):
    start = datetime(2026, 11, 2, 8, 0, 30)
    assert cal.add_work(start, 60) == datetime(2026, 11, 2, 9, 0, 30)


def test_add_never_attaches_a_timezone(cal):
    assert cal.add_work(dt("2026-11-02 08:00"), 90).tzinfo is None
    assert cal.next_work_start(dt("2026-11-02 07:00")).tzinfo is None
    assert cal.prev_work_end(dt("2026-11-02 18:00")).tzinfo is None


def test_add_a_long_stretch_of_weeks():
    # 100 weeks of work from a Monday end on the Friday of week 100 (on a
    # calendar without exceptions, so it is plain date arithmetic)
    plain = WorkCalendar.from_json(STANDARD_CALENDAR)
    assert plain.add_work(dt("2026-11-02 08:00"), 2400 * 100) == dt("2028-09-29 17:00")


@pytest.mark.parametrize("bad", [-1, -480])
def test_add_and_sub_reject_negative_minutes(cal, bad):
    with pytest.raises(ValueError):
        cal.add_work(dt("2026-11-02 08:00"), bad)
    with pytest.raises(ValueError):
        cal.sub_work(dt("2026-11-02 08:00"), bad)


@pytest.mark.parametrize("bad", [1.5, "60", None, True])
def test_add_and_sub_reject_non_integer_minutes(cal, bad):
    with pytest.raises(TypeError):
        cal.add_work(dt("2026-11-02 08:00"), bad)
    with pytest.raises(TypeError):
        cal.sub_work(dt("2026-11-02 08:00"), bad)


# --- sub_work -----------------------------------------------------------------------


def test_sub_across_night(cal):
    assert cal.sub_work(dt("2026-11-03 08:00"), 60) == dt("2026-11-02 16:00")


def test_sub_across_lunch(cal):
    assert cal.sub_work(dt("2026-11-02 13:00"), 60) == dt("2026-11-02 11:00")


def test_sub_full_day(cal):
    assert cal.sub_work(dt("2026-11-02 17:00"), 480) == dt("2026-11-02 08:00")


def test_sub_zero_does_not_snap(cal):
    assert cal.sub_work(dt("2026-11-02 08:00"), 0) == dt("2026-11-02 08:00")
    assert cal.sub_work(dt("2026-11-07 10:00"), 0) == dt("2026-11-07 10:00")


@pytest.mark.parametrize("end,minutes,expected", [
    ("2026-11-02 12:00", 240, "2026-11-02 08:00"),  # back to the start of the morning
    ("2026-11-02 12:00", 1, "2026-11-02 11:59"),
    ("2026-11-02 18:00", 60, "2026-11-02 16:00"),  # snaps back to 17:00 first
    ("2026-11-02 13:00", 240, "2026-11-02 08:00"),  # lunch snaps back to 12:00
    ("2026-11-09 08:00", 60, "2026-11-06 16:00"),  # over the weekend
    ("2026-11-27 09:00", 120, "2026-11-25 16:00"),  # over the holiday
    ("2026-11-16 08:00", 960, "2026-11-14 06:00"),  # the whole working Saturday
    ("2026-11-06 17:00", 2400, "2026-11-02 08:00"),  # one week of work
    ("2026-11-06 17:00", 2401, "2026-10-30 16:59"),
])
def test_sub_boundaries(cal, end, minutes, expected):
    assert cal.sub_work(dt(end), minutes) == dt(expected)


def test_sub_a_long_stretch_of_weeks():
    plain = WorkCalendar.from_json(STANDARD_CALENDAR)
    assert plain.sub_work(dt("2028-09-29 17:00"), 2400 * 100) == dt("2026-11-02 08:00")


# --- work_between -------------------------------------------------------------------


def test_between_forward(cal):
    assert cal.work_between(dt("2026-11-02 08:00"), dt("2026-11-03 12:00")) == 720


def test_between_backward(cal):
    assert cal.work_between(dt("2026-11-03 12:00"), dt("2026-11-02 08:00")) == -720


def test_between_inside_day(cal):
    assert cal.work_between(dt("2026-11-02 11:00"), dt("2026-11-02 14:00")) == 120


@pytest.mark.parametrize("a,b,expected", [
    ("2026-11-02 08:00", "2026-11-02 08:00", 0),
    ("2026-11-02 17:00", "2026-11-03 08:00", 0),  # overnight is not work
    ("2026-11-02 12:00", "2026-11-02 13:00", 0),  # neither is lunch
    ("2026-11-07 10:00", "2026-11-08 10:00", 0),  # a weekend day
    ("2026-11-06 13:00", "2026-11-09 13:00", 480),  # over a weekend
    ("2026-11-25 08:00", "2026-11-27 08:00", 480),  # over the holiday
    ("2026-11-13 08:00", "2026-11-16 08:00", 480 + 960),  # over the working Saturday
    ("2026-11-02 00:00", "2026-11-09 00:00", 2400),  # a whole week
    ("2026-11-02 07:00", "2026-11-02 18:00", 480),  # wider than the working day
])
def test_between_boundaries(cal, a, b, expected):
    assert cal.work_between(dt(a), dt(b)) == expected
    assert cal.work_between(dt(b), dt(a)) == -expected


def test_between_rounds_a_partial_minute_down(cal):
    start = datetime(2026, 11, 2, 8, 0, 0)
    assert cal.work_between(start, datetime(2026, 11, 2, 8, 0, 59)) == 0
    assert cal.work_between(start, datetime(2026, 11, 2, 8, 1, 59)) == 1
    assert cal.work_between(datetime(2026, 11, 2, 8, 1, 59), start) == -1


def test_between_a_very_long_range_with_exceptions():
    """A century is thousands of weeks: whole weeks are summed, not walked, but
    an exception in the middle of them must still count."""
    exceptions = [
        {"date": "2040-07-04", "name": "Independence Day", "hours": []},  # a Wednesday
        {"date": "2040-07-07", "name": "Saturday shift", "hours": [["09:00", "13:00"]]},
    ]
    long = WorkCalendar.from_json(calendar_json(exceptions=exceptions))
    first, last = date(2026, 1, 1), date(2125, 12, 31)
    expected = 0
    day = first
    while day <= last:
        expected += sum(int((e - s).total_seconds() // 60) for s, e in long.intervals(day))
        day += ONE_DAY
    assert long.work_between(datetime.combine(first, time.min),
                             datetime.combine(last + ONE_DAY, time.min)) == expected


# --- exceptions, intervals ----------------------------------------------------------


def test_intervals_standard_day(cal):
    assert cal.intervals(date(2026, 11, 3)) == [
        (dt("2026-11-03 08:00"), dt("2026-11-03 12:00")),
        (dt("2026-11-03 13:00"), dt("2026-11-03 17:00")),
    ]


def test_intervals_weekend_is_nonworking(cal):
    assert cal.intervals(date(2026, 11, 7)) == []
    assert cal.intervals(date(2026, 11, 8)) == []


def test_intervals_holiday_is_nonworking(cal):
    assert cal.intervals(date(2026, 11, 26)) == []


def test_intervals_exception_hours_replace_the_weekday_pattern(cal):
    assert cal.intervals(date(2026, 11, 14)) == [(dt("2026-11-14 06:00"), dt("2026-11-14 22:00"))]
    odd_monday = WorkCalendar.from_json(calendar_json(
        exceptions=[{"date": "2026-11-09", "name": "Short day", "hours": [["10:00", "14:00"]]}]))
    assert odd_monday.intervals(date(2026, 11, 9)) == [
        (dt("2026-11-09 10:00"), dt("2026-11-09 14:00"))]
    # the rest of the week keeps its pattern
    assert len(odd_monday.intervals(date(2026, 11, 10))) == 2


def test_intervals_returns_a_copy(cal):
    first = cal.intervals(date(2026, 11, 3))
    first.clear()
    assert len(cal.intervals(date(2026, 11, 3))) == 2


def test_intervals_accepts_a_datetime_for_the_day(cal):
    assert cal.intervals(dt("2026-11-26 13:00")) == []  # the holiday, not "no match"


def test_intervals_match_each_weekday_pattern():
    week = {
        "mon": [["06:00", "10:00"]],
        "tue": [["07:00", "09:00"], ["10:00", "12:00"]],
        "wed": [],
        "thu": [["08:00", "09:00"]],
        "fri": [["22:00", "23:59"]],
        "sat": [["00:00", "01:00"]],
        "sun": [["12:00", "13:00"]],
    }
    odd = WorkCalendar.from_json(calendar_json(week=week))
    monday = date(2026, 11, 2)
    for offset, key in enumerate(("mon", "tue", "wed", "thu", "fri", "sat", "sun")):
        got = [(s.time().strftime("%H:%M"), e.time().strftime("%H:%M"))
               for s, e in odd.intervals(monday + timedelta(days=offset))]
        assert got == [tuple(pair) for pair in week[key]]


def test_touching_intervals_are_allowed_and_unsorted_ones_are_sorted():
    week = calendar_json()["week"]
    week["mon"] = [["13:00", "17:00"], ["08:00", "13:00"]]
    touching = WorkCalendar.from_json(calendar_json(week=week))
    assert touching.intervals(date(2026, 11, 2)) == [
        (dt("2026-11-02 08:00"), dt("2026-11-02 13:00")),
        (dt("2026-11-02 13:00"), dt("2026-11-02 17:00")),
    ]
    assert touching.add_work(dt("2026-11-02 08:00"), 540) == dt("2026-11-02 17:00")


def test_a_full_interval_cache_does_not_change_any_answer(monkeypatch):
    data = calendar_json(exceptions=[THANKSGIVING, MOVE_WEEKEND])
    cases = (("2026-11-02 08:00", 3000), ("2026-11-25 16:00", 960), ("2026-11-13 17:00", 1500))
    roomy = WorkCalendar.from_json(data)
    expected = [(roomy.add_work(dt(start), minutes), roomy.sub_work(dt(start), minutes))
                for start, minutes in cases]
    monkeypatch.setattr("serversherpa.plans.calendar._CACHE_LIMIT", 3)
    tiny = WorkCalendar.from_json(data)
    for (start, minutes), (later, earlier) in zip(cases, expected, strict=True):
        assert tiny.add_work(dt(start), minutes) == later
        assert tiny.sub_work(dt(start), minutes) == earlier
        assert tiny.work_between(dt(start), later) == minutes
    assert len(tiny._cache) <= 3


def test_calendar_is_a_snapshot_of_the_json():
    data = calendar_json(exceptions=[copy.deepcopy(THANKSGIVING)])
    snapshot = copy.deepcopy(data)
    snap = WorkCalendar.from_json(data)
    assert data == snapshot  # from_json does not modify its input
    data["week"]["mon"].clear()
    data["exceptions"].clear()
    data["hours_per_day"] = 4
    assert len(snap.intervals(date(2026, 11, 2))) == 2
    assert snap.intervals(date(2026, 11, 26)) == []
    assert snap.units.minutes_per_day == 480


# --- 24:00: round-the-clock days, shifts across midnight ------------------------------


@pytest.fixture(scope="module")
def clock_cal() -> WorkCalendar:
    """Mon-Sun 00:00-24:00, a move crew that never goes home."""
    week = {day: [["00:00", "24:00"]] for day in WEEKDAYS}
    return WorkCalendar.from_json(calendar_json(
        week=week, hours_per_day=24, hours_per_week=168, exceptions=[THANKSGIVING]))


def test_24_hour_day_is_a_full_1440_minutes(clock_cal):
    assert clock_cal.intervals(date(2026, 11, 2)) == [
        (dt("2026-11-02 00:00"), dt("2026-11-03 00:00"))]
    assert clock_cal.work_between(dt("2026-11-02 00:00"), dt("2026-11-03 00:00")) == 1440
    assert clock_cal.work_between(dt("2026-11-03 00:00"), dt("2026-11-02 00:00")) == -1440
    assert clock_cal.work_between(dt("2026-11-02 00:00"), dt("2026-11-09 00:00")) == 10080
    assert clock_cal.units.minutes_per_day == 1440


def test_24_hour_days_lose_no_minute_at_midnight(clock_cal):
    assert clock_cal.add_work(dt("2026-11-02 00:00"), 2880) == dt("2026-11-04 00:00")
    assert clock_cal.add_work(dt("2026-11-02 00:00"), 1440) == dt("2026-11-03 00:00")
    assert clock_cal.add_work(dt("2026-11-02 00:00"), 1441) == dt("2026-11-03 00:01")
    assert clock_cal.add_work(dt("2026-11-02 23:59"), 1) == dt("2026-11-03 00:00")
    assert clock_cal.add_work(dt("2026-11-02 23:59"), 2) == dt("2026-11-03 00:01")
    assert clock_cal.sub_work(dt("2026-11-04 00:00"), 2880) == dt("2026-11-02 00:00")
    assert clock_cal.sub_work(dt("2026-11-03 00:00"), 1) == dt("2026-11-02 23:59")
    assert clock_cal.sub_work(dt("2026-11-03 00:01"), 2) == dt("2026-11-02 23:59")


def test_24_hour_midnight_is_inside_the_next_day_for_starting_work(clock_cal):
    assert clock_cal.next_work_start(dt("2026-11-03 00:00")) == dt("2026-11-03 00:00")
    assert clock_cal.next_work_start(dt("2026-11-02 23:59")) == dt("2026-11-02 23:59")


def test_24_hour_midnight_is_inside_the_previous_day_for_finishing_work(clock_cal):
    assert clock_cal.prev_work_end(dt("2026-11-03 00:00")) == dt("2026-11-03 00:00")
    assert clock_cal.prev_work_end(dt("2026-11-03 00:01")) == dt("2026-11-03 00:01")
    assert clock_cal.prev_work_end(dt("2026-11-02 00:00")) == dt("2026-11-02 00:00")


def test_24_hour_days_touch_at_midnight(clock_cal):
    assert clock_cal.intervals(date(2026, 11, 2))[-1][1] == clock_cal.intervals(
        date(2026, 11, 3))[0][0] == dt("2026-11-03 00:00")


def test_24_hour_weeks_are_jumped_whole(clock_cal):
    week = 10080
    monday, in_three_weeks = dt("2026-11-30 00:00"), dt("2026-12-21 00:00")  # after Thanksgiving
    assert clock_cal.add_work(monday, 3 * week) == in_three_weeks
    assert clock_cal.add_work(monday, 3 * week + 1) == dt("2026-12-21 00:01")
    assert clock_cal.sub_work(in_three_weeks, 3 * week) == monday
    assert clock_cal.work_between(monday, in_three_weeks) == 3 * week
    # the same three weeks with the holiday inside them take one more day
    before = dt("2026-11-16 00:00")
    assert clock_cal.add_work(before, 3 * week) == dt("2026-12-08 00:00")
    assert clock_cal.sub_work(dt("2026-12-08 00:00"), 3 * week) == before
    assert clock_cal.work_between(before, dt("2026-12-07 00:00")) == 3 * week - 1440


def test_24_hour_calendar_still_honors_a_holiday(clock_cal):
    # Wed noon + 24 h: 12 h left of Wednesday, nothing on Thanksgiving, 12 h of Friday
    assert clock_cal.add_work(dt("2026-11-25 12:00"), 1440) == dt("2026-11-27 12:00")
    assert clock_cal.next_work_start(dt("2026-11-26 00:00")) == dt("2026-11-27 00:00")
    assert clock_cal.prev_work_end(dt("2026-11-27 00:00")) == dt("2026-11-26 00:00")


@pytest.fixture(scope="module")
def night_cal() -> WorkCalendar:
    """Standard week, except Mon 11-09 is an evening shift ending at 24:00 and
    Wed 11-11 starts at midnight: an overnight shift is two entries."""
    return WorkCalendar.from_json(calendar_json(exceptions=[
        {"date": "2026-11-09", "name": "Evening", "hours": [["18:00", "24:00"]]},
        {"date": "2026-11-11", "name": "Small hours", "hours": [["00:00", "06:00"]]},
    ]))


def test_an_evening_to_24_00_runs_into_a_normal_next_day(night_cal):
    assert night_cal.intervals(date(2026, 11, 9)) == [
        (dt("2026-11-09 18:00"), dt("2026-11-10 00:00"))]
    # six hours fill Monday evening exactly, and the finish stays at midnight
    assert night_cal.add_work(dt("2026-11-09 18:00"), 360) == dt("2026-11-10 00:00")
    # one more minute goes to Tuesday's normal 08:00 start
    assert night_cal.add_work(dt("2026-11-09 18:00"), 361) == dt("2026-11-10 08:01")
    assert night_cal.next_work_start(dt("2026-11-10 00:00")) == dt("2026-11-10 08:00")
    assert night_cal.prev_work_end(dt("2026-11-10 08:00")) == dt("2026-11-10 00:00")
    assert night_cal.work_between(dt("2026-11-09 18:00"), dt("2026-11-10 12:00")) == 360 + 240
    assert night_cal.sub_work(dt("2026-11-10 09:00"), 120) == dt("2026-11-09 23:00")


def test_two_entries_across_midnight_are_one_continuous_stretch():
    both = WorkCalendar.from_json(calendar_json(exceptions=[
        {"date": "2026-11-09", "name": "Night", "hours": [["18:00", "24:00"]]},
        {"date": "2026-11-10", "name": "Night, cont.", "hours": [["00:00", "06:00"]]},
    ]))
    assert both.add_work(dt("2026-11-09 18:00"), 480) == dt("2026-11-10 02:00")
    assert both.add_work(dt("2026-11-09 18:00"), 720) == dt("2026-11-10 06:00")
    assert both.add_work(dt("2026-11-09 18:00"), 721) == dt("2026-11-11 08:01")
    assert both.sub_work(dt("2026-11-10 02:00"), 480) == dt("2026-11-09 18:00")
    assert both.work_between(dt("2026-11-09 12:00"), dt("2026-11-10 02:00")) == 360 + 120
    assert both.next_work_start(dt("2026-11-10 00:00")) == dt("2026-11-10 00:00")
    assert both.prev_work_end(dt("2026-11-10 00:00")) == dt("2026-11-10 00:00")


def test_a_midnight_start_follows_a_normal_day(night_cal):
    # Wed 11-11 works 00:00-06:00; Tuesday (a normal day) ends at 17:00
    assert night_cal.next_work_start(dt("2026-11-10 17:00")) == dt("2026-11-11 00:00")
    assert night_cal.add_work(dt("2026-11-10 16:00"), 120) == dt("2026-11-11 01:00")


def test_a_24_00_end_on_the_last_day_is_off_the_end_of_the_calendar():
    all_day = WorkCalendar.from_json(calendar_json(
        week={day: [["00:00", "24:00"]] for day in WEEKDAYS}))
    assert all_day.intervals(date(9999, 12, 30)) == [
        (datetime(9999, 12, 30), datetime(9999, 12, 31))]
    with pytest.raises(CalendarError) as caught:
        all_day.intervals(date(9999, 12, 31))
    assert caught.value.code == "no_working_time"


# --- no working time ----------------------------------------------------------------


def test_no_working_time():
    empty = WorkCalendar.from_json(calendar_json(week=empty_week()))
    with pytest.raises(CalendarError) as caught:
        empty.next_work_start(dt("2026-11-02 08:00"))
    assert caught.value.code == "no_working_time"
    assert isinstance(caught.value, ValueError)


def test_no_working_time_in_every_direction():
    empty = WorkCalendar.from_json(calendar_json(week=empty_week()))
    start = dt("2026-11-02 08:00")
    for call in (lambda: empty.prev_work_end(start),
                 lambda: empty.add_work(start, 60),
                 lambda: empty.sub_work(start, 60)):
        with pytest.raises(CalendarError) as caught:
            call()
        assert caught.value.code == "no_working_time"
    # zero work needs none
    assert empty.add_work(start, 0) == start
    assert empty.sub_work(start, 0) == start
    # and there is none to count
    assert empty.work_between(start, dt("2026-12-25 08:00")) == 0


def only_these_days(*days: date) -> WorkCalendar:
    """A calendar that works 09:00-10:00 on the given days and never otherwise."""
    return WorkCalendar.from_json(calendar_json(week=empty_week(), exceptions=[
        {"date": day.isoformat(), "name": "Only day", "hours": [["09:00", "10:00"]]}
        for day in days]))


def test_next_start_search_limit():
    origin = dt("2026-11-02 08:00")
    assert MAX_SEARCH_DAYS == 3660
    reachable = origin.date() + timedelta(days=MAX_SEARCH_DAYS)
    assert only_these_days(reachable).next_work_start(origin) == datetime.combine(
        reachable, time(9, 0))
    with pytest.raises(CalendarError) as caught:
        only_these_days(reachable + ONE_DAY).next_work_start(origin)
    assert caught.value.code == "no_working_time"


def test_prev_end_search_limit():
    origin = dt("2026-11-02 08:00")
    reachable = origin.date() - timedelta(days=MAX_SEARCH_DAYS)
    assert only_these_days(reachable).prev_work_end(origin) == datetime.combine(
        reachable, time(10, 0))
    with pytest.raises(CalendarError):
        only_these_days(reachable - ONE_DAY).prev_work_end(origin)


def test_a_long_gap_in_the_middle_of_a_walk_is_a_search_limit_too():
    first = date(2026, 11, 2)
    reachable = first + timedelta(days=MAX_SEARCH_DAYS)
    assert only_these_days(first, reachable).add_work(dt("2026-11-02 09:00"), 90) == (
        datetime.combine(reachable, time(9, 30)))
    too_far = reachable + ONE_DAY
    far = only_these_days(first, too_far)
    with pytest.raises(CalendarError):
        far.add_work(dt("2026-11-02 09:00"), 90)
    with pytest.raises(CalendarError):
        far.sub_work(datetime.combine(too_far, time(10, 0)), 90)


def test_running_off_the_end_of_the_calendar_is_a_calendar_error():
    standard = WorkCalendar.from_json(STANDARD_CALENDAR)
    assert datetime.max.date().weekday() == 4  # 9999-12-31 is a Friday
    with pytest.raises(CalendarError):
        standard.next_work_start(datetime(9999, 12, 31, 17, 0))
    with pytest.raises(CalendarError):
        standard.add_work(datetime(9999, 12, 31, 9, 0), 481)
    with pytest.raises(CalendarError):
        standard.prev_work_end(datetime(1, 1, 1, 8, 0))  # 0001-01-01 is a Monday
    with pytest.raises(CalendarError):
        standard.sub_work(datetime(1, 1, 1, 9, 0), 61)


def limit_day_lookups(calendar: WorkCalendar, limit: int) -> list:
    """Make `calendar` fail the moment it looks at more than `limit` days: a
    deterministic stand-in for 'it must not walk every day', which a stopwatch
    would only measure loosely. Returns the list of days looked at."""
    looked_at = []
    real = calendar._day

    def counted(day):
        looked_at.append(day)
        assert len(looked_at) <= limit, f"walked more than {limit} days"
        return real(day)

    calendar._day = counted
    return looked_at


def test_an_absurd_duration_fails_fast_instead_of_walking_every_day():
    standard = WorkCalendar.from_json(STANDARD_CALENDAR)
    # walking day by day would visit millions of days before running out of dates
    looked_at = limit_day_lookups(standard, 1000)
    for huge in (10**12, 10**15, 10**30):
        with pytest.raises(CalendarError):
            standard.add_work(dt("2026-11-02 08:00"), huge)
        with pytest.raises(CalendarError):
            standard.sub_work(dt("2026-11-02 17:00"), huge)
    assert len(looked_at) <= 1000


def test_a_millennium_between_two_dates_is_summed_not_walked():
    standard = WorkCalendar.from_json(STANDARD_CALENDAR)
    looked_at = limit_day_lookups(standard, 1000)  # 3.6 million days if walked
    total = standard.work_between(datetime(1, 1, 1), datetime(9999, 12, 31, 23, 59))
    assert total > 0 and total % 480 == 0
    assert len(looked_at) <= 1000


# --- from_json validation -----------------------------------------------------------


def test_bad_calendar():
    week = {**calendar_json()["week"], "mon": [["17:00", "08:00"]]}
    assert isinstance(bad_calendar(calendar_json(week=week)), ValueError)


@pytest.mark.parametrize("hours", [
    [["08:00", "08:00"]],  # empty interval
    [["17:00", "08:00"]],  # reversed
    [["08:00", "12:00"], ["11:59", "17:00"]],  # overlap
    [["08:00", "12:00"], ["08:00", "12:00"]],  # the same interval twice
    [["08:00", "17:00"], ["10:00", "11:00"]],  # nested
    [["8:00", "12:00"]],  # not zero padded
    [["24:00", "24:00"]],  # 24:00 only ever ends an interval
    [["24:00", "08:00"]],
    [["00:00", "24:00"], ["24:00", "24:00"]],
    [["08:00", "24:01"]],  # and nothing runs past it
    [["08:00", "25:00"]],
    [["08:00", "24:00:00"]],
    [["08:00", "24"]],
    [["00:00", "24:00"], ["23:00", "24:00"]],  # overlap at the end of the day
    [["12:00", "24:00"], ["18:00", "24:00"]],
    [["08:00", "12:60"]],
    [["08:00", "12:00:00"]],
    [["08:00", "12h"]],
    [["08:00", " 12:00"]],
    [["08:00", "12:00\n"]],
    [["08:00", "１２:００"]],  # full-width digits
    [[800, 1200]],
    [[None, "12:00"]],
    [["08:00"]],  # one end only
    [["08:00", "09:00", "10:00"]],
    ["08:00-12:00"],
    "08:00-12:00",
    None,
    {"08:00": "12:00"},
    7,
])
def test_bad_week_hours(hours):
    week = calendar_json()["week"]
    week["tue"] = hours
    bad_calendar(calendar_json(week=week))


@pytest.mark.parametrize("week", [
    None,
    [],
    "mon-fri",
    {k: v for k, v in calendar_json()["week"].items() if k != "sun"},  # a day is missing
])
def test_bad_week(week):
    data = calendar_json()
    data["week"] = week
    bad_calendar(data)


def test_missing_week_is_a_bad_calendar():
    data = calendar_json()
    del data["week"]
    bad_calendar(data)


@pytest.mark.parametrize("data", [None, [], "standard", 7])
def test_calendar_must_be_an_object(data):
    bad_calendar(data)


@pytest.mark.parametrize("exceptions", [
    "2026-11-26",
    {"date": "2026-11-26", "hours": []},
    ["2026-11-26"],
    [{"hours": []}],  # no date
    [{"date": None, "hours": []}],
    [{"date": "2026-13-01", "hours": []}],
    [{"date": "2026-02-30", "hours": []}],
    [{"date": "2026-1-5", "hours": []}],
    [{"date": "20261126", "hours": []}],
    [{"date": "2026-11-26T00:00", "hours": []}],
    [{"date": 20261126, "hours": []}],
    [{"date": "2026-11-26"}],  # no hours: not silently a holiday
    [{"date": "2026-11-26", "hours": None}],
    [{"date": "2026-11-26", "hours": [["12:00", "08:00"]]}],
    [{"date": "2026-11-26", "hours": [["08:00", "12:00"], ["10:00", "14:00"]]}],
    [{"date": "2026-11-26", "hours": [["8", "12"]]}],
    [{"date": "2026-11-26", "hours": [["24:00", "24:00"]]}],  # 24:00 never starts one
    [{"date": "2026-11-26", "hours": [["18:00", "24:01"]]}],
    [{"date": "2026-11-26", "name": 7, "hours": []}],
    [THANKSGIVING, THANKSGIVING],  # one day, two rules
    [{"date": "2026-11-26", "hours": []}, {"date": "2026-11-26", "hours": [["09:00", "10:00"]]}],
])
def test_bad_exceptions(exceptions):
    bad_calendar(calendar_json(exceptions=exceptions))


def test_exceptions_may_be_missing_or_null_and_need_no_name():
    data = calendar_json()
    del data["exceptions"]
    thursday = date(2026, 11, 26)
    assert WorkCalendar.from_json(data).intervals(thursday) != []
    assert WorkCalendar.from_json(calendar_json(exceptions=None)).intervals(thursday) != []
    nameless = WorkCalendar.from_json(
        calendar_json(exceptions=[{"date": "2026-11-26", "hours": []}]))
    assert nameless.intervals(thursday) == []


def test_bad_calendar_messages_do_not_echo_unbounded_input():
    week = calendar_json()["week"]
    week["mon"] = [["x" * 10_000, "12:00"]]
    assert len(str(bad_calendar(calendar_json(week=week)))) < 300


@pytest.mark.parametrize("key,value", [
    ("hours_per_day", 0),
    ("hours_per_day", -8),
    ("hours_per_day", 0.0),
    ("hours_per_day", "eight"),
    ("hours_per_day", "8"),  # JSON numbers only
    ("hours_per_day", "1e9999999"),  # would take seconds to expand as a fraction
    ("hours_per_day", True),
    ("hours_per_day", float("nan")),
    ("hours_per_day", float("inf")),
    ("hours_per_day", [8]),
    ("hours_per_week", 0),
    ("hours_per_week", -1),
    ("days_per_month", 0),
    ("days_per_month", -20),
    ("days_per_month", 0.00001),  # rounds to under a minute
])
def test_bad_units(key, value):
    bad_calendar(calendar_json(**{key: value}))


@pytest.mark.parametrize("key,value", [
    ("default_start", "8:00"),
    ("default_start", "25:00"),
    ("default_start", 800),
    ("default_end", "5pm"),
    ("default_end", "08:00"),  # not after the default start
    ("default_start", "17:00"),  # not before the default end
    ("default_start", "24:00"),  # 24:00 ends intervals only, never a default time
    ("default_end", "24:00"),
])
def test_bad_default_times(key, value):
    bad_calendar(calendar_json(**{key: value}))


def test_units_from_calendar():
    ten_hour = WorkCalendar.from_json(calendar_json(hours_per_day=10))
    assert ten_hour.units.minutes_per_day == 600
    assert ten_hour.units == Units.from_calendar(calendar_json(hours_per_day=10))


@pytest.mark.parametrize("key", ["hours_per_day", "hours_per_week", "days_per_month"])
@pytest.mark.parametrize("how", ["missing", "null"])
def test_each_unit_key_defaults_to_the_standard_value(key, how):
    data = calendar_json()
    if how == "missing":
        del data[key]
    else:
        data[key] = None
    assert WorkCalendar.from_json(data).units == Units()


@pytest.mark.parametrize("how", ["missing", "null"])
def test_a_missing_hours_per_week_keeps_the_other_keys(how):
    data = calendar_json(hours_per_day=10, days_per_month=22)
    if how == "missing":
        del data["hours_per_week"]
    else:
        data["hours_per_week"] = None
    units = WorkCalendar.from_json(data).units
    assert units == Units(minutes_per_day=600, minutes_per_week=2400, minutes_per_month=13200)


def test_all_three_unit_keys_missing_is_the_standard_calendar_units():
    data = calendar_json()
    for key in ("hours_per_day", "hours_per_week", "days_per_month"):
        del data[key]
    assert WorkCalendar.from_json(data).units == Units()


def test_default_times():
    custom = WorkCalendar.from_json(calendar_json(default_start="07:30", default_end="16:15"))
    assert custom.default_start == time(7, 30)
    assert custom.default_end == time(16, 15)
    assert custom.at_default_start(date(2026, 11, 2)) == dt("2026-11-02 07:30")
    assert custom.at_default_end(date(2026, 11, 2)) == dt("2026-11-02 16:15")


def test_default_times_fall_back_to_the_standard_ones():
    data = calendar_json()
    del data["default_start"]
    data["default_end"] = None
    plain = WorkCalendar.from_json(data)
    assert plain.at_default_start(date(2026, 11, 2)) == dt("2026-11-02 08:00")
    assert plain.at_default_end(date(2026, 11, 2)) == dt("2026-11-02 17:00")


# --- differential test against a minute-by-minute reference -----------------------------

BRUTE_EXCEPTIONS = [
    THANKSGIVING,
    MOVE_WEEKEND,
    {"date": "2026-12-09", "name": "Split shift",
     "hours": [["07:00", "09:30"], ["10:00", "11:15"]]},
    {"date": "2026-12-24", "name": "Christmas Eve", "hours": []},
    {"date": "2026-12-25", "name": "Christmas", "hours": []},
    {"date": "2027-01-01", "name": "New Year", "hours": []},
    {"date": "2027-01-02", "name": "Saturday shift", "hours": [["09:00", "13:00"]]},
    {"date": "2027-02-15", "name": "Presidents Day", "hours": []},
]
SUN_THU_WEEK = {
    "mon": [["07:00", "11:30"], ["12:30", "16:00"]],
    "tue": [["07:00", "11:30"], ["12:30", "16:00"]],
    "wed": [["07:00", "11:30"]],
    "thu": [["07:00", "11:30"], ["12:30", "16:00"]],
    "fri": [],
    "sat": [],
    "sun": [["09:00", "10:00"], ["10:30", "18:00"]],
}
# 24:00 ends: a round-the-clock week, and night shifts written as two entries
# (18:00-24:00 then 00:00-06:00 the next day) with exceptions across a month and a
# year boundary.
AROUND_THE_CLOCK_WEEK = {day: [["00:00", "24:00"]] for day in WEEKDAYS}
NIGHT_WEEK = {
    "mon": [["00:00", "06:00"], ["18:00", "24:00"]],
    "tue": [["00:00", "06:00"], ["18:00", "24:00"]],
    "wed": [["00:00", "06:00"], ["18:00", "24:00"]],
    "thu": [["00:00", "06:00"], ["18:00", "24:00"]],
    "fri": [["00:00", "06:00"], ["18:00", "24:00"]],
    "sat": [["00:00", "06:00"]],
    "sun": [["18:00", "24:00"]],
}
NIGHT_EXCEPTIONS = [
    {"date": "2026-11-26", "name": "Thanksgiving", "hours": []},
    {"date": "2026-11-27", "name": "Day after", "hours": [["00:00", "24:00"]]},
    {"date": "2026-12-12", "name": "Evening shift", "hours": [["12:00", "24:00"]]},
    {"date": "2026-12-31", "name": "New Year's Eve", "hours": [["18:00", "24:00"]]},
    {"date": "2027-01-01", "name": "New Year", "hours": [["00:00", "02:00"], ["20:00", "24:00"]]},
    {"date": "2027-01-02", "name": "Quiet", "hours": []},
]
BOUNDARY_TIMES = [time(0, 0), time(0, 1), time(5, 59), time(6, 0), time(6, 1), time(7, 0),
                  time(7, 59), time(8, 0), time(8, 1), time(9, 30), time(11, 29),
                  time(11, 30), time(11, 59), time(12, 0), time(12, 1), time(12, 30),
                  time(12, 59), time(13, 0), time(13, 1), time(16, 0), time(16, 59),
                  time(17, 0), time(17, 1), time(18, 0), time(18, 1), time(21, 59),
                  time(22, 0), time(23, 58), time(23, 59)]
SPAN_FIRST, SPAN_LAST = date(2026, 10, 1), date(2027, 3, 31)


def working_minutes(calendar: WorkCalendar) -> list[datetime]:
    """The start of every working minute in the span, in order."""
    minutes = []
    day = SPAN_FIRST
    while day <= SPAN_LAST:
        for start, end in calendar.intervals(day):
            moment = start
            while moment < end:
                minutes.append(moment)
                moment += MINUTE
        day += ONE_DAY
    return minutes


def random_moment(rng: random.Random, first: date, last: date) -> datetime:
    day = first + timedelta(days=rng.randrange((last - first).days + 1))
    if rng.random() < 0.6:
        return datetime.combine(day, rng.choice(BOUNDARY_TIMES))
    return datetime.combine(day, time.min) + timedelta(minutes=rng.randrange(1440))


def weekly_minutes(calendar: WorkCalendar) -> int:
    """Work in one ordinary week (Mon 2026-10-05 ... Sun, before any exception)."""
    first = date(2026, 10, 5)
    return sum((end - start) // MINUTE
               for offset in range(7)
               for start, end in calendar.intervals(first + timedelta(days=offset)))


def random_minutes(rng: random.Random, week: int = 2400) -> int:
    """From a minute to six weeks of work, so whole-week skipping is exercised."""
    roll = rng.random()
    if roll < 0.35:
        return rng.randrange(1, 60)
    if roll < 0.7:
        return rng.randrange(1, week + 1)
    return rng.randrange(1, 6 * week)


@pytest.mark.parametrize("name,data", [
    ("with exceptions", calendar_json(exceptions=BRUTE_EXCEPTIONS)),
    ("odd week", calendar_json(week=SUN_THU_WEEK)),
    ("odd week with exceptions", calendar_json(week=SUN_THU_WEEK, exceptions=BRUTE_EXCEPTIONS)),
    ("no exceptions", calendar_json()),
    ("around the clock", calendar_json(week=AROUND_THE_CLOCK_WEEK)),
    ("around the clock with exceptions",
     calendar_json(week=AROUND_THE_CLOCK_WEEK, exceptions=BRUTE_EXCEPTIONS)),
    ("night shifts", calendar_json(week=NIGHT_WEEK)),
    ("night shifts with exceptions", calendar_json(week=NIGHT_WEEK, exceptions=NIGHT_EXCEPTIONS)),
    ("standard week with night exceptions", calendar_json(exceptions=NIGHT_EXCEPTIONS)),
])
def test_arithmetic_matches_a_minute_by_minute_reference(name, data):
    calendar = WorkCalendar.from_json(data)
    minutes = working_minutes(calendar)
    week = weekly_minutes(calendar)
    rng = random.Random(f"plans-calendar-{name}")
    # keep every walk inside the span the reference covers
    early, late = date(2026, 10, 15), date(2026, 12, 31)
    for _ in range(300):
        t = random_moment(rng, early, late)
        n = random_minutes(rng, week)
        index = bisect_left(minutes, t)
        assert calendar.next_work_start(t) == minutes[index]
        assert calendar.add_work(t, n) == minutes[index + n - 1] + MINUTE, (t, n)
    for _ in range(300):
        t = random_moment(rng, date(2026, 12, 1), date(2027, 2, 28))
        n = random_minutes(rng, week)
        index = bisect_left(minutes, t)
        assert calendar.prev_work_end(t) == minutes[index - 1] + MINUTE
        assert calendar.sub_work(t, n) == minutes[index - n], (t, n)
    for _ in range(300):
        a = random_moment(rng, early, date(2027, 3, 15))
        b = random_moment(rng, early, date(2027, 3, 15))
        expected = bisect_left(minutes, b) - bisect_left(minutes, a)
        assert calendar.work_between(a, b) == expected, (a, b)
        assert calendar.work_between(b, a) == -expected, (b, a)


@pytest.mark.parametrize("name,data", [
    ("standard", calendar_json(exceptions=BRUTE_EXCEPTIONS)),
    ("around the clock", calendar_json(week=AROUND_THE_CLOCK_WEEK, exceptions=BRUTE_EXCEPTIONS)),
    ("night shifts", calendar_json(week=NIGHT_WEEK, exceptions=NIGHT_EXCEPTIONS)),
])
def test_adding_then_subtracting_and_counting_agree(name, data):
    calendar = WorkCalendar.from_json(data)
    week = weekly_minutes(calendar)
    rng = random.Random(f"plans-calendar-round-trip-{name}")
    for _ in range(400):
        t = random_moment(rng, date(2026, 10, 15), date(2027, 1, 31))
        n = random_minutes(rng, week)
        end = calendar.add_work(t, n)
        start = calendar.next_work_start(t)
        assert calendar.work_between(start, end) == n, (t, n)
        assert calendar.work_between(t, end) == n, (t, n)
        assert calendar.sub_work(end, n) == start, (t, n)
        assert calendar.prev_work_end(end) == end  # a finish is a finish
