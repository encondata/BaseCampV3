"""Duration and lag text: parsed and formatted from the vectors file the
portal's vitest suite reads too, so both sides agree on every string."""

import json
from pathlib import Path

import pytest

from serversherpa.plans.durations import (
    Duration,
    DurationError,
    Units,
    format_duration,
    format_lag,
    parse_duration,
    parse_lag,
)

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "plans" / "durations.json").read_text()
)
UNITS = Units.from_calendar(VECTORS["units"])


def test_vector_units_are_the_standard_calendar():
    assert UNITS == Units(minutes_per_day=480, minutes_per_week=2400, minutes_per_month=9600)


@pytest.mark.parametrize("text,minutes,unit,elapsed", VECTORS["parse"])
def test_parse_vectors(text, minutes, unit, elapsed):
    assert parse_duration(text, UNITS) == Duration(minutes, unit, elapsed)


@pytest.mark.parametrize("text", VECTORS["invalid"])
def test_invalid_vectors(text):
    with pytest.raises(DurationError) as exc:
        parse_duration(text, UNITS)
    assert exc.value.code == "bad_duration"


@pytest.mark.parametrize("text,minutes,unit,elapsed", VECTORS["lag"])
def test_lag_vectors(text, minutes, unit, elapsed):
    assert parse_lag(text, UNITS) == Duration(minutes, unit, elapsed)


@pytest.mark.parametrize("minutes,unit,elapsed,text", VECTORS["format"])
def test_format_vectors(minutes, unit, elapsed, text):
    assert format_duration(Duration(minutes, unit, elapsed), UNITS) == text


@pytest.mark.parametrize("minutes,unit,elapsed,text", VECTORS["format_lag"])
def test_format_lag_vectors(minutes, unit, elapsed, text):
    assert format_lag(Duration(minutes, unit, elapsed), UNITS) == text


@pytest.mark.parametrize(
    "minutes,unit,elapsed,text",
    # 160 minutes is 0.3333 days: the two-decimal text cannot return to it
    [row for row in VECTORS["format"] if row[3] != "0.33 days"],
)
def test_round_trip(minutes, unit, elapsed, text):
    d = Duration(minutes, unit, elapsed)
    assert parse_duration(format_duration(d, UNITS), UNITS) == d


def test_custom_units():
    units = Units.from_calendar({"hours_per_day": 10, "hours_per_week": 50, "days_per_month": 22})
    assert units == Units(minutes_per_day=600, minutes_per_week=3000, minutes_per_month=13200)
    assert parse_duration("1d", units) == Duration(600, "d", False)
    assert parse_duration("1w", units) == Duration(3000, "w", False)
    assert parse_duration("1mo", units) == Duration(13200, "mo", False)
    assert format_duration(Duration(600, "d", False), units) == "1 day"
    # elapsed units never depend on the calendar
    assert parse_duration("1ed", units) == Duration(1440, "d", True)


def test_bare_number_takes_the_default_unit():
    assert parse_duration("3", UNITS, default_unit="h") == Duration(180, "h", False)
    assert parse_duration("2", UNITS, default_unit="w") == Duration(4800, "w", False)
    assert parse_lag("-2", UNITS, default_unit="h") == Duration(-120, "h", False)
    assert parse_duration("3d", UNITS, default_unit="h") == Duration(1440, "d", False)


def test_a_sign_is_only_accepted_by_lag():
    for text in ("+2d", "-2d", "-1"):
        with pytest.raises(DurationError):
            parse_duration(text, UNITS)
    assert parse_lag("-2d", UNITS).minutes == -960
    assert parse_lag("+2d", UNITS).minutes == 960


def test_lag_rejects_what_duration_rejects():
    for text in ("", "abc", "5x", "1.2.3d", "d", "1e", "-", "+"):
        with pytest.raises(DurationError):
            parse_lag(text, UNITS)


def test_minutes_round_half_up():
    # a 100-minute day makes the halves exact: 2.5 -> 3 and 1.5 -> 2 (banker's gives 2 and 2)
    units = Units(minutes_per_day=100, minutes_per_week=500, minutes_per_month=2000)
    assert parse_duration("0.025d", units).minutes == 3
    assert parse_duration("0.015d", units).minutes == 2
    assert parse_duration("0.5m", UNITS).minutes == 1
    # a negative lag rounds the same way on its size: -0.5 min -> -1
    assert parse_lag("-0.5m", UNITS).minutes == -1


def test_oversized_number_is_a_duration_error():
    with pytest.raises(DurationError):
        parse_duration("9" * 5000 + "d", UNITS)


def test_error_carries_a_code():
    assert DurationError.code == "bad_duration"
    assert issubclass(DurationError, ValueError)


def test_unknown_default_unit_is_a_programming_error():
    with pytest.raises(ValueError):
        parse_duration("3", UNITS, default_unit="x")


def test_duration_is_frozen_and_hashable():
    d = Duration(480, "d", False)
    with pytest.raises(AttributeError):
        d.minutes = 1  # type: ignore[misc]
    assert {d, Duration(480, "d", False)} == {d}
