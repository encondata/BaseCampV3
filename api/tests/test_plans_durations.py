"""Duration and lag text: parsed and formatted from the vectors file the
portal's vitest suite reads too, so both sides agree on every string."""

import json
import time
from pathlib import Path

import pytest

from serversherpa.plans.durations import (
    MAX_YEARS,
    Duration,
    DurationError,
    Units,
    format_duration,
    format_lag,
    max_minutes,
    parse_duration,
    parse_lag,
)

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "plans" / "durations.json").read_text()
)
UNITS = Units.from_calendar(VECTORS["units"])
UNITS_ALT = Units.from_calendar(VECTORS["units_alt"])


def _exact(minutes, unit, elapsed, units=UNITS):
    """True when the minutes are a whole number of hundredths of the unit, so
    two-decimal text can return to the same value."""
    return (abs(minutes) * 100) % units.unit_minutes(unit, elapsed) == 0


def test_vector_units_are_the_standard_calendar():
    assert UNITS == Units(minutes_per_day=480, minutes_per_week=2400, minutes_per_month=9600)
    assert UNITS_ALT == Units(minutes_per_day=600, minutes_per_week=3000, minutes_per_month=13200)


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


@pytest.mark.parametrize("text", VECTORS["invalid_lag"])
def test_invalid_lag_vectors(text):
    with pytest.raises(DurationError) as exc:
        parse_lag(text, UNITS)
    assert exc.value.code == "bad_duration"


@pytest.mark.parametrize("minutes,unit,elapsed,text", VECTORS["format"])
def test_format_vectors(minutes, unit, elapsed, text):
    assert format_duration(Duration(minutes, unit, elapsed), UNITS) == text


@pytest.mark.parametrize("minutes,unit,elapsed,text", VECTORS["format_lag"])
def test_format_lag_vectors(minutes, unit, elapsed, text):
    assert format_lag(Duration(minutes, unit, elapsed), UNITS) == text


@pytest.mark.parametrize(
    "minutes,unit,elapsed,text",
    # only values the two-decimal text can hold exactly: 160 minutes is
    # 0.3333 days and 481 is 1.002, so their text returns a different value
    [row for row in VECTORS["format"] if _exact(*row[:3])],
)
def test_round_trip(minutes, unit, elapsed, text):
    d = Duration(minutes, unit, elapsed)
    assert parse_duration(format_duration(d, UNITS), UNITS) == d


@pytest.mark.parametrize(
    "minutes,unit,elapsed,text",
    [row for row in VECTORS["format_lag"] if _exact(*row[:3])],
)
def test_lag_round_trip(minutes, unit, elapsed, text):
    d = Duration(minutes, unit, elapsed)
    assert parse_lag(format_lag(d, UNITS), UNITS) == d


@pytest.mark.parametrize("text,minutes,unit,elapsed", VECTORS["parse_alt"])
def test_parse_alt_units_vectors(text, minutes, unit, elapsed):
    assert parse_duration(text, UNITS_ALT) == Duration(minutes, unit, elapsed)


@pytest.mark.parametrize("minutes,unit,elapsed,text", VECTORS["format_alt"])
def test_format_alt_units_vectors(minutes, unit, elapsed, text):
    assert format_duration(Duration(minutes, unit, elapsed), UNITS_ALT) == text


@pytest.mark.parametrize("text,minutes,unit,elapsed", VECTORS["parse_default_h"])
def test_parse_default_unit_vectors(text, minutes, unit, elapsed):
    assert parse_duration(text, UNITS, default_unit="h") == Duration(minutes, unit, elapsed)


def test_custom_units():
    units = Units.from_calendar({"hours_per_day": 10, "hours_per_week": 50, "days_per_month": 22})
    assert units == Units(minutes_per_day=600, minutes_per_week=3000, minutes_per_month=13200)
    assert parse_duration("1d", units) == Duration(600, "d", False)
    assert parse_duration("1w", units) == Duration(3000, "w", False)
    assert parse_duration("1mo", units) == Duration(13200, "mo", False)
    assert format_duration(Duration(600, "d", False), units) == "1 day"
    # elapsed units never depend on the calendar
    assert parse_duration("1ed", units) == Duration(1440, "d", True)


def test_from_calendar_missing_or_null_keys_keep_the_standard_values():
    assert Units.from_calendar({}) == Units()
    assert Units.from_calendar({"hours_per_day": None, "days_per_month": None}) == Units()
    assert Units.from_calendar({"hours_per_day": 4}) == Units(
        minutes_per_day=240, minutes_per_week=2400, minutes_per_month=4800
    )


def test_from_calendar_rounds_half_up():
    # 0.5 days x 441 minutes = 220.5 -> 221 (banker's round() gives 220)
    units = Units.from_calendar(
        {"hours_per_day": 7.35, "hours_per_week": 36.75, "days_per_month": 0.5}
    )
    assert units == Units(minutes_per_day=441, minutes_per_week=2205, minutes_per_month=221)


@pytest.mark.parametrize(
    "cal",
    [
        {"hours_per_day": 0},
        {"hours_per_day": -8},
        {"hours_per_week": 0},
        {"hours_per_week": -1},
        {"days_per_month": 0},
        {"days_per_month": -20},
        {"hours_per_day": 0.001},   # under a minute a day
        {"hours_per_day": "eight"},
        {"hours_per_week": float("nan")},
        {"days_per_month": float("inf")},
        {"hours_per_day": True},
    ],
)
def test_from_calendar_rejects_a_non_positive_or_non_numeric_value(cal):
    with pytest.raises(ValueError) as exc:
        Units.from_calendar(cal)
    assert not isinstance(exc.value, DurationError)


def test_bare_number_takes_the_default_unit():
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
    for text in VECTORS["invalid"]:
        if text.lstrip(" ").startswith(("-", "+")):
            continue
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
    with pytest.raises(DurationError):
        parse_duration("1234567890m", UNITS)      # ten digits before the point
    assert parse_duration("999999999m", UNITS).minutes == 999999999


def test_input_length_is_capped_after_trimming():
    padded = " " * 100 + "5d" + " " * 100
    assert parse_duration(padded, UNITS).minutes == 2400
    with pytest.raises(DurationError):
        parse_duration("5" + " " * 70 + "d", UNITS)


def test_error_message_does_not_echo_unbounded_input():
    with pytest.raises(DurationError) as exc:
        parse_duration("x" * 100_000, UNITS)
    assert len(str(exc.value)) < 100


@pytest.mark.parametrize(
    "text",
    [
        "1" + " " * 100_000 + "x",
        "1" + " " * 100_000 + "d",
        " " * 100_000,
        "1 " * 50_000,
        "1" + "e" * 100_000,
    ],
)
def test_long_input_fails_fast(text):
    # the whitespace around the unit used to backtrack quadratically
    started = time.perf_counter()
    for parser in (parse_duration, parse_lag):
        with pytest.raises(DurationError):
            parser(text, UNITS)
    assert time.perf_counter() - started < 0.1


def test_only_ascii_whitespace_counts():
    assert parse_duration("\t\n\r\f\v 5d \v\f\r\n\t", UNITS).minutes == 2400
    assert parse_duration("5 \t d", UNITS).minutes == 2400
    for space in (" ", " ", "　", " "):
        for text in (f"5{space}d", f"{space}5d", f"5d{space}"):
            with pytest.raises(DurationError):
                parse_duration(text, UNITS)


def test_non_string_input_is_a_duration_error():
    for value in (None, 5, 2.5, b"5d", ["5d"]):
        with pytest.raises(DurationError):
            parse_duration(value, UNITS)  # type: ignore[arg-type]


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


def test_the_ten_year_cap():
    """260 working days a year of the plan's own day, or 365 wall-clock days
    for elapsed time (the cap every plan duration and lag has)."""
    assert MAX_YEARS == 10
    assert max_minutes(Units(), elapsed=False) == 480 * 260 * 10
    assert max_minutes(UNITS_ALT, elapsed=False) == 600 * 260 * 10
    assert max_minutes(Units(), elapsed=True) == 1440 * 365 * 10
