"""people/time_parse: reading clock cells, zones, DST, and the shift text."""
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from serversherpa.people import time_parse as tp

NY = ZoneInfo("America/New_York")
LA = ZoneInfo("America/Los_Angeles")
SEVEN_AM_EDT = datetime(2026, 9, 24, 11, 0, tzinfo=UTC)


@pytest.mark.parametrize("text", [
    "9/24/2026 7:00 AM", "9/24/2026 7:00:00 AM", "09/24/2026 07:00", "9/24/2026 7:00am",
    "9/24/2026 7:00 a.m.", "9/24/26 7:00 AM", "2026-09-24 07:00", "2026-09-24T07:00",
    "2026-09-24 7:00", "2026-09-24 07:00:00", "2026-09-24 7:00 AM", "  9/24/2026   7:00 AM ",
    "46289.291666666664",
])
def test_wall_clock_formats_read_in_the_given_zone(text):
    assert tp.parse_clock(text, NY) == SEVEN_AM_EDT


def test_the_zone_moves_a_wall_clock_time():
    assert tp.parse_clock("9/24/2026 7:00 AM", LA) == datetime(2026, 9, 24, 14, 0, tzinfo=UTC)
    assert tp.parse_clock("9/24/2026 3:30 PM", NY) == datetime(2026, 9, 24, 19, 30, tzinfo=UTC)


@pytest.mark.parametrize(("text", "expected"), [
    ("2026-09-24T07:00:00-07:00", datetime(2026, 9, 24, 14, 0, tzinfo=UTC)),
    ("2026-09-24T14:00:00Z", datetime(2026, 9, 24, 14, 0, tzinfo=UTC)),
    ("2026-09-24 07:00-05:00", datetime(2026, 9, 24, 12, 0, tzinfo=UTC)),
])
def test_an_explicit_offset_is_taken_as_written(text, expected):
    assert tp.parse_clock(text, LA) == expected          # the zone is not used


def test_excel_serials():
    assert tp.parse_clock("46289.291666666664", NY) == SEVEN_AM_EDT
    assert tp.parse_clock("46289", NY) == datetime(2026, 9, 24, 4, 0, tzinfo=UTC)   # midnight


@pytest.mark.parametrize("text", [
    "", "   ", "someday", "9/24/2026", "2026-09-24", "7:00 AM", "13/45/2026 7:00",
    "12", "99999", "2026-09-24T25:00",
])
def test_unreadable_cells_are_none(text):
    assert tp.parse_clock(text, NY) is None


def test_daylight_saving_gaps_and_repeats_resolve_with_fold_0():
    # spring forward: 2:30 AM never happens on Mar 8, 2026 — read with the
    # offset in force before the change (EST)
    assert tp.parse_clock("2026-03-08 02:30", NY) == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    # fall back: 1:30 AM happens twice on Nov 1, 2026 — the first (EDT) one
    assert tp.parse_clock("2026-11-01 01:30", NY) == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)


def test_zone_for_falls_back_to_the_house_default():
    assert tp.zone_for("America/Chicago").key == "America/Chicago"
    assert tp.zone_for(" America/Chicago ").key == "America/Chicago"
    for bad in (None, "", "  ", "Mars/Base", "../etc/passwd"):
        assert tp.zone_for(bad).key == "America/New_York"


@pytest.mark.parametrize(("text", "minutes"), [
    ("", 0), ("  ", 0), ("0", 0), ("30", 30), ("30.0", 30),
    ("-5", None), ("abc", None), ("7.5", None),
])
def test_parse_break(text, minutes):
    assert tp.parse_break(text) == minutes


def test_shift_and_clock_text():
    utc = lambda *a: datetime(*a, tzinfo=UTC)
    assert tp.shift_text(utc(2026, 9, 24, 14), utc(2026, 9, 24, 22, 30), LA) \
        == "Sep 24, 7:00 AM – 3:30 PM PDT"
    assert tp.shift_text(utc(2026, 9, 25, 2), utc(2026, 9, 25, 10), NY) \
        == "Sep 24, 10:00 PM – Sep 25, 6:00 AM EDT"
    assert tp.shift_text(utc(2026, 11, 1, 5, 30), utc(2026, 11, 1, 14), NY) \
        == "Nov 1, 1:30 AM EDT – 9:00 AM EST"
    assert tp.shift_text(utc(2026, 9, 24, 4), utc(2026, 9, 24, 16), NY) \
        == "Sep 24, 12:00 AM – 12:00 PM EDT"
    assert tp.clock_text(utc(2026, 9, 24, 2), NY) == "Sep 23, 10:00 PM EDT"
