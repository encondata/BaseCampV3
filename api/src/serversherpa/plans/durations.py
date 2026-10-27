"""Duration and lag text for project plans: `5d`, `4 hrs`, `3ed`, `+2d`.

Pure parsing and formatting, no I/O. The portal's editor ports these rules
and both sides are held to the same vectors file
(api/tests/fixtures/plans/durations.json), so a change here is a change
there.

A duration is stored as whole minutes plus the unit the user typed (display
uses that unit back) and an `elapsed` flag. Working units (m h d w mo) scale
with the plan calendar through `Units`; elapsed units (em eh ed ew emo) are
wall-clock and fixed, so a `3ed` task is 4320 minutes in every calendar.
"""

import re
from dataclasses import dataclass
from fractions import Fraction

UNITS = ("m", "h", "d", "w", "mo")

# Elapsed units never depend on the calendar: a wall-clock minute count.
ELAPSED_MINUTES = {"m": 1, "h": 60, "d": 1440, "w": 10080, "mo": 43200}

_WORKING_LABELS = {
    "m": ("min", "mins"),
    "h": ("hr", "hrs"),
    "d": ("day", "days"),
    "w": ("wk", "wks"),
    "mo": ("mon", "mons"),
}

# Every spelling the parser accepts, lower-cased, to its unit.
_UNIT_WORDS = {
    **dict.fromkeys(("mo", "mon", "mons", "month", "months"), "mo"),
    **dict.fromkeys(("m", "min", "mins", "minute", "minutes"), "m"),
    **dict.fromkeys(("h", "hr", "hrs", "hour", "hours"), "h"),
    **dict.fromkeys(("d", "day", "days"), "d"),
    **dict.fromkeys(("w", "wk", "wks", "week", "weeks"), "w"),
}

# Input limits, shared with the portal parser through the vectors file.
# Only ASCII whitespace is trimmed or allowed (NBSP and other Unicode spaces
# are invalid), the trimmed text is at most MAX_TEXT_LENGTH characters, and
# the number has at most MAX_INTEGER_DIGITS digits before the decimal point.
_ASCII_WHITESPACE = " \t\n\r\f\v"
MAX_TEXT_LENGTH = 64
MAX_INTEGER_DIGITS = 9

# Matched with fullmatch() on the trimmed text, so there is no leading or
# trailing whitespace pattern to backtrack through. The `mo...` spellings
# come before the `m...` ones so "mon" reads as a month; the regex would
# backtrack to it anyway, the order keeps the intent readable.
_PATTERN = re.compile(
    r"([+-]?)(\d+(?:\.\d+)?)\s*(e?)"
    r"(mo|mons?|months?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)?",
    re.IGNORECASE | re.ASCII,
)


class DurationError(ValueError):
    """The text is not a duration (or lag)."""

    code = "bad_duration"


@dataclass(frozen=True)
class Units:
    """How many working minutes a day, week and month are in one plan's
    calendar. The defaults are MS Project's Standard calendar."""

    minutes_per_day: int = 480
    minutes_per_week: int = 2400
    minutes_per_month: int = 9600

    @classmethod
    def from_calendar(cls, cal: dict) -> "Units":
        """Read `hours_per_day`, `hours_per_week` and `days_per_month` from a
        plan calendar; a missing or null key keeps the Standard value.
        Minutes are rounded half up like parsed durations are. A value that
        is not a positive number (or rounds to under a minute) raises a plain
        ValueError: that is a bad calendar, not bad duration text, so it is
        not a DurationError."""

        def minutes(key: str, default, per: int) -> int:
            value = cal.get(key)
            value = default if value is None else value
            try:
                exact = Fraction(str(value)) * per
            except ValueError:
                raise ValueError(f"{key} must be a number, got {value!r}") from None
            result = _half_up(exact) if exact > 0 else 0
            if result < 1:
                raise ValueError(f"{key} must be positive, got {value!r}")
            return result

        per_day = minutes("hours_per_day", 8, 60)
        per_week = minutes("hours_per_week", 40, 60)
        per_month = minutes("days_per_month", 20, per_day)
        return cls(minutes_per_day=per_day, minutes_per_week=per_week,
                   minutes_per_month=per_month)

    def unit_minutes(self, unit: str, elapsed: bool = False) -> int:
        """Minutes in one `unit` (working, or wall-clock when `elapsed`)."""
        if unit not in UNITS:
            raise ValueError(f"unknown duration unit {unit!r}")
        if elapsed:
            return ELAPSED_MINUTES[unit]
        return {
            "m": 1,
            "h": 60,
            "d": self.minutes_per_day,
            "w": self.minutes_per_week,
            "mo": self.minutes_per_month,
        }[unit]


@dataclass(frozen=True)
class Duration:
    minutes: int
    unit: str          # m h d w mo: the unit shown back to the user
    elapsed: bool


def _half_up(value: Fraction) -> int:
    """Round a non-negative exact value to a whole number, halves up, so
    0.5 minutes is 1 (Python's round() would give 0)."""
    return (value * 2 + 1) // 2


def _bad(text) -> DurationError:
    """An error that never echoes unbounded input."""
    shown = text if isinstance(text, str) else f"<{type(text).__name__}>"
    if len(shown) > 40:
        shown = shown[:40] + "..."
    return DurationError(f"not a duration: {shown!r}")


def _parse(text: str, units: Units, default_unit: str, signed: bool) -> Duration:
    if default_unit not in UNITS:
        raise ValueError(f"unknown default unit {default_unit!r}")
    if not isinstance(text, str):
        raise _bad(text)
    trimmed = text.strip(_ASCII_WHITESPACE)
    if len(trimmed) > MAX_TEXT_LENGTH:
        raise _bad(text)
    match = _PATTERN.fullmatch(trimmed)
    if match is None:
        raise _bad(text)
    sign, number, elapsed_flag, word = match.groups()
    if sign and not signed:
        raise _bad(text)
    if len(number.partition(".")[0]) > MAX_INTEGER_DIGITS:
        raise _bad(text)
    if word is None:
        if elapsed_flag:
            # "1e" names the elapsed prefix but no unit
            raise _bad(text)
        unit, elapsed = default_unit, False
    else:
        unit, elapsed = _UNIT_WORDS[word.lower()], bool(elapsed_flag)
    minutes = _half_up(Fraction(number) * units.unit_minutes(unit, elapsed))
    return Duration(-minutes if sign == "-" else minutes, unit, elapsed)


def parse_duration(text: str, units: Units, default_unit: str = "d") -> Duration:
    """`5d`, `4 hrs`, `0.5d`, `3ed`, `2 wks`; a bare number takes
    `default_unit`. Never negative, so a sign is an error."""
    return _parse(text, units, default_unit, signed=False)


def parse_lag(text: str, units: Units, default_unit: str = "d") -> Duration:
    """A duration with an optional sign: `+2d`, `-4h`, `2d`. A lead is a
    negative `minutes`."""
    return _parse(text, units, default_unit, signed=True)


def _format(d: Duration, units: Units, plus: bool) -> str:
    per_unit = units.unit_minutes(d.unit, d.elapsed)
    # hundredths of a unit, halves up: at most two decimals shown
    hundredths = _half_up(Fraction(abs(d.minutes) * 100, per_unit))
    whole, frac = divmod(hundredths, 100)
    number = str(whole) if frac == 0 else f"{whole}.{frac:02d}".rstrip("0")
    singular, plural = _WORKING_LABELS[d.unit]
    label = singular if number == "1" else plural
    if d.elapsed:
        label = "e" + label
    if hundredths == 0:
        sign = ""
    elif d.minutes < 0:
        sign = "-"
    else:
        sign = "+" if plus else ""
    return f"{sign}{number} {label}"


def format_duration(d: Duration, units: Units) -> str:
    """`5 days`, `1 day`, `4 hrs`, `0.5 days`, `3 edays`, `0 days`."""
    return _format(d, units, plus=False)


def format_lag(d: Duration, units: Units) -> str:
    """Like `format_duration` with an explicit sign: `+2 days`, `-4 hrs`,
    `0 days`."""
    return _format(d, units, plus=True)
