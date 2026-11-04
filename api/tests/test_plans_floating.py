"""Floating plan times: the wall-clock text the plan API reads and writes,
and "now" in a plan's zone. Plan times never carry a zone or offset."""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from serversherpa.plans.floating import format_floating, last_day, parse_floating, plan_now


def test_date_only_takes_the_given_time():
    assert parse_floating("2026-11-02", date_only_time=time(8)) == datetime(2026, 11, 2, 8, 0)
    assert parse_floating("2026-11-02", date_only_time=time(17)) == datetime(2026, 11, 2, 17, 0)


def test_date_and_time():
    assert parse_floating("2026-11-02T13:30", date_only_time=time(8)) == datetime(
        2026, 11, 2, 13, 30)


def test_seconds_are_accepted_and_dropped():
    # plan times are whole minutes
    assert parse_floating("2026-11-02T13:30:00", date_only_time=time(8)) == datetime(
        2026, 11, 2, 13, 30)
    assert parse_floating("2026-11-02T13:30:59", date_only_time=time(8)) == datetime(
        2026, 11, 2, 13, 30)


def test_surrounding_whitespace_is_trimmed():
    assert parse_floating(" 2026-11-02T13:30 ", date_only_time=time(8)) == datetime(
        2026, 11, 2, 13, 30)


def test_result_is_naive():
    assert parse_floating("2026-11-02T13:30", date_only_time=time(8)).tzinfo is None


@pytest.mark.parametrize("text", [
    "2026-11-02T13:30:00Z",
    "2026-11-02T13:30Z",
    "2026-11-02T13:30+00:00",
    "2026-11-02T13:30:00-05:00",
    "2026-11-02T13:30:00.000",
    "2026-11-02 13:30",
    "2026-11-02T1:30",
    "2026-11-02T24:00",
    "2026-11-02T13:30:60",
    "2026-02-30",
    "2026-13-01",
    "26-11-02",
    "11/02/2026",
    "",
    "   ",
    "x" * 10_000,
])
def test_rejects(text):
    with pytest.raises(ValueError):
        parse_floating(text, date_only_time=time(8))


def test_rejects_non_text():
    with pytest.raises(ValueError):
        parse_floating(None, date_only_time=time(8))  # type: ignore[arg-type]


def test_error_never_echoes_long_input():
    with pytest.raises(ValueError) as caught:
        parse_floating("9" * 5_000, date_only_time=time(8))
    assert len(str(caught.value)) < 200


def test_format():
    assert format_floating(datetime(2026, 11, 2, 8, 0)) == "2026-11-02T08:00"
    assert format_floating(datetime(2026, 11, 2, 17, 5, 59)) == "2026-11-02T17:05"
    assert format_floating(None) is None


def test_format_refuses_a_zoned_time():
    with pytest.raises(ValueError):
        format_floating(datetime(2026, 11, 2, 8, 0, tzinfo=ZoneInfo("UTC")))


def test_round_trip():
    value = datetime(2026, 11, 2, 13, 30)
    assert parse_floating(format_floating(value), date_only_time=time(8)) == value


def test_plan_now_is_naive_wall_clock_in_the_zone():
    now = plan_now("America/Chicago")
    assert now.tzinfo is None
    expected = datetime.now(ZoneInfo("America/Chicago")).replace(tzinfo=None)
    assert abs(now - expected) < timedelta(minutes=2)


def test_plan_now_is_whole_minutes():
    now = plan_now("America/New_York")
    assert now.second == 0 and now.microsecond == 0


def _at(text: str) -> datetime:
    return parse_floating(text, date_only_time=time(0))


@pytest.mark.parametrize(("start", "finish", "day"), [
    # the day of the last working minute: a finish at midnight ends the day before
    ("2026-11-03T08:00", "2026-11-04T17:00", date(2026, 11, 4)),
    ("2026-11-03T20:00", "2026-11-05T00:00", date(2026, 11, 4)),
    ("2026-11-03T08:00", "2026-11-03T08:01", date(2026, 11, 3)),
    # a milestone, a finish not after the start, or none: the start's day
    ("2026-11-06T17:00", "2026-11-06T17:00", date(2026, 11, 6)),
    ("2026-11-06T00:00", "2026-11-06T00:00", date(2026, 11, 6)),
    ("2026-11-06T17:00", "2026-11-05T17:00", date(2026, 11, 6)),
    ("2026-11-06T17:00", None, date(2026, 11, 6)),
])
def test_last_day_matches_the_portal(start, finish, day):
    """The portal's lib/plans/floatingTime `lastDay`, vector for vector
    (floatingTime.test.ts), plus a zero-length task at midnight."""
    assert last_day(_at(start), None if finish is None else _at(finish)) == day
