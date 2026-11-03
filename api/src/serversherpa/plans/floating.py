"""Floating plan times as text, and "now" in a plan's zone.

A plan time is a naive wall-clock moment in the plan's own timezone (see
plans/models.py). Over the API it is `YYYY-MM-DDTHH:MM`: never a zone, an
offset or `Z`, because the same 08:00 start must read 08:00 for everyone and
survive a DST change. The portal parses and formats the same text as
UTC-naive values (Plan B).

Plan times are whole minutes: seconds are accepted on input and dropped,
and never written back out."""

import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

_ASCII_WHITESPACE = " \t\n\r\f\v"
MAX_TEXT_LENGTH = 32

# A date, optionally followed by T and an HH:MM[:SS] time. Nothing else: no
# fraction, offset, `Z` or space separator. ASCII digits only.
_PATTERN = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?)?",
    re.ASCII,
)


def _bad(text) -> ValueError:
    """An error that never echoes unbounded input."""
    if not isinstance(text, str):
        return ValueError(f"not a date or date-time: <{type(text).__name__}>")
    shown = text if len(text) <= 40 else text[:40] + "..."
    return ValueError(f"not a YYYY-MM-DD date or YYYY-MM-DDTHH:MM time: {shown!r}")


def parse_floating(text: str, *, date_only_time: time) -> datetime:
    """`YYYY-MM-DD` (that day at `date_only_time`, usually the calendar's
    default start or end) or `YYYY-MM-DDTHH:MM[:SS]` as a naive datetime.
    Surrounding ASCII whitespace is trimmed. A zone, an offset or `Z`, a
    fraction of a second, or a date that does not exist raises ValueError."""
    if not isinstance(text, str):
        raise _bad(text)
    trimmed = text.strip(_ASCII_WHITESPACE)
    match = _PATTERN.fullmatch(trimmed) if len(trimmed) <= MAX_TEXT_LENGTH else None
    if match is None:
        raise _bad(text)
    year, month, day, hour, minute, seconds = match.groups()
    try:
        if hour is None:
            return datetime.combine(date(int(year), int(month), int(day)),
                                    date_only_time.replace(second=0, microsecond=0, tzinfo=None))
        # built with the seconds so 13:30:99 is refused, then dropped
        return datetime(int(year), int(month), int(day), int(hour), int(minute),
                        int(seconds or 0)).replace(second=0)
    except ValueError:
        raise _bad(text) from None


def format_floating(dt: datetime | None) -> str | None:
    """`YYYY-MM-DDTHH:MM`, or None for None. A zoned datetime is a bug (plan
    times never carry a zone) and raises ValueError."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        raise ValueError("a plan time must be a naive wall-clock time")
    return dt.isoformat(timespec="minutes")


def last_day(start: datetime, finish: datetime | None) -> date:
    """The day a task's work ends: that of its last working minute, so a
    finish at midnight ends the day before (Thu 00:00 is Wednesday's end).
    A zero-length task (a milestone), a finish not after the start, or none
    at all: the start's own day. The portal's lib/plans/floatingTime
    `lastDay`, the one finish-day rule every day label uses."""
    if finish is not None and finish > start:
        return (finish - timedelta(minutes=1)).date()
    return start.date()


def plan_now(zone_name: str) -> datetime:
    """The current wall-clock time in `zone_name` as a naive datetime, to
    the minute: what "now" is in a plan's own time. An unknown zone raises
    (plan timezones are checked when they are stored)."""
    return datetime.now(ZoneInfo(zone_name)).replace(tzinfo=None, second=0, microsecond=0)
