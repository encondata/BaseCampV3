"""services/timezone.py: the shared house time-zone helpers. Pure unit
tests — no DB."""

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from serversherpa.services.timezone import stored_day


def test_midnight_utc_returns_that_same_calendar_day():
    value = datetime(2026, 9, 15, 0, 0, tzinfo=UTC)
    assert stored_day(value) == date(2026, 9, 15)


def test_a_genuine_midday_timestamp_returns_its_utc_day():
    value = datetime(2026, 9, 15, 13, 30, tzinfo=UTC)
    assert stored_day(value) == date(2026, 9, 15)


def test_a_non_utc_value_is_normalized_to_utc_before_the_date_is_read():
    # Midnight in America/New_York (UTC-4 in September) is 04:00 UTC the
    # same day, so the UTC date is unaffected here — pick a time where the
    # local and UTC calendar days actually differ to prove the normalization.
    value = datetime(2026, 9, 15, 23, 30, tzinfo=ZoneInfo("America/New_York"))
    assert stored_day(value) == date(2026, 9, 16)
