"""Work-time arithmetic for project plans: working hours, lunch, weekends and
holidays. Pure, no I/O. The scheduling engine builds every date on this.

A calendar is a weekly pattern of working intervals plus dated exceptions
(holidays, or custom hours on a given day, like a Saturday move). All
datetimes here are naive wall-clock times of the plan's own timezone; never
attach a tzinfo.

Boundaries (they match MS Project and decide every scheduled date):
- Working time is a set of half-open minutes: an interval [s, e) holds the
  minutes that start at s ... e-1 minute. A moment is *inside* an interval for
  starting work when s <= t < e, and for finishing work when s < t <= e.
- `next_work_start(t)` keeps t when work can start there; at an interval's
  end it moves forward (Mon 17:00 -> Tue 08:00, Mon 12:00 -> Mon 13:00).
- `prev_work_end(t)` is the mirror: it keeps t when work can finish there,
  at an interval's start it moves back (Tue 08:00 -> Mon 17:00).
- `add_work` snaps to a working start first, then counts forward, and the
  result may sit exactly on an interval end (08:00 + 8 h = 17:00, not Tue
  08:00). `sub_work` mirrors it. Zero minutes returns the moment unchanged,
  so a milestone does not snap.

An interval never crosses midnight: an overnight shift is two entries on
consecutive days, and `24:00` is a valid interval END (the next midnight, so
00:00-24:00 is a full 1,440-minute day and neighboring days touch there). It
is never valid as a start or as a default start/end time.
"""

import re
from bisect import bisect_left, bisect_right
from datetime import date, datetime, time, timedelta
from itertools import pairwise

from serversherpa.plans.durations import Units
from serversherpa.plans.limits import MAX_RESTORE_ROWS
from serversherpa.services.text import has_control_chars

STANDARD_CALENDAR: dict = {
    "week": {
        "mon": [["08:00", "12:00"], ["13:00", "17:00"]],
        "tue": [["08:00", "12:00"], ["13:00", "17:00"]],
        "wed": [["08:00", "12:00"], ["13:00", "17:00"]],
        "thu": [["08:00", "12:00"], ["13:00", "17:00"]],
        "fri": [["08:00", "12:00"], ["13:00", "17:00"]],
        "sat": [],
        "sun": [],
    },
    "exceptions": [],
    "hours_per_day": 8,
    "hours_per_week": 40,
    "days_per_month": 20,
    "default_start": "08:00",
    "default_end": "17:00",
}
# MS Project's Standard calendar. It is the same data as
# config_store.DEFAULTS["project_plans"]["calendar"] (written inline there so
# the system layer does not import this package; a test keeps them equal).
# Copy it before changing anything: it is shared.

# Index == date.weekday() (Monday is 0).
DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

# Looking for working time never goes more than this many days from the
# starting day (the starting day is offset 0), whichever direction.
MAX_SEARCH_DAYS = 3660

_CACHE_LIMIT = 20_000  # days of intervals kept; cleared (not evicted) when full
_ONE_DAY = timedelta(days=1)
_MINUTE = timedelta(minutes=1)
_HHMM = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])")
_ISO_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_UNIT_KEYS = ("hours_per_day", "hours_per_week", "days_per_month")
# the most each unit key can be: the hours in a day and in a week, the days
# in the longest month
_UNIT_MAX = {"hours_per_day": 24, "hours_per_week": 168, "days_per_month": 31}
_DEFAULT_KEYS = ("default_start", "default_end")
_CALENDAR_KEYS = frozenset({"week", "exceptions", *_UNIT_KEYS, *_DEFAULT_KEYS})
_EXCEPTION_KEYS = frozenset({"date", "name", "hours"})
# the most exceptions a stored calendar lists: the cap the restore op's
# lists have (plans/limits.py)
MAX_EXCEPTIONS = MAX_RESTORE_ROWS


class CalendarError(ValueError):
    """The calendar cannot answer. `code` is `no_working_time` when a search
    finds no working time (or runs off the end of the date range), and
    `bad_calendar` when `WorkCalendar.from_json` rejects a calendar."""

    code = "no_working_time"

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        if code is not None:
            self.code = code


def _bad(message: str) -> CalendarError:
    return CalendarError(message, "bad_calendar")


def _shown(value) -> str:
    """How a bad value is named in a message: never unbounded input."""
    if isinstance(value, str):
        return repr(value if len(value) <= 40 else value[:40] + "...")
    return f"<{type(value).__name__}>"


def _parse_time(value, where: str) -> time:
    match = _HHMM.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise _bad(f"{where}: not an HH:MM time: {_shown(value)}")
    return time(int(match[1]), int(match[2]))


def _parse_offset(value, where: str, *, is_end: bool) -> timedelta:
    """An interval's HH:MM as the time since midnight. `24:00` (the next
    midnight) is accepted only as an end."""
    if value == "24:00":
        if not is_end:
            raise _bad(f"{where}: 24:00 can end an interval but not start one")
        return _ONE_DAY
    clock = _parse_time(value, where)
    return timedelta(hours=clock.hour, minutes=clock.minute)


def _clock(offset: timedelta) -> str:
    minutes = offset // _MINUTE
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _parse_date(value, where: str) -> date:
    match = _ISO_DATE.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise _bad(f"{where}: not a YYYY-MM-DD date: {_shown(value)}")
    try:
        return date(int(match[1]), int(match[2]), int(match[3]))
    except ValueError:
        raise _bad(f"{where}: not a real date: {_shown(value)}") from None


def _parse_hours(value, where: str) -> tuple[tuple[timedelta, timedelta], ...]:
    """A list of [start, end] pairs as offsets from midnight, returned sorted.
    Intervals may touch (a day split at 13:00) but not overlap, and each must
    end after it starts (so none crosses midnight; the end may be 24:00)."""
    if not isinstance(value, (list, tuple)):
        raise _bad(f"{where}: hours must be a list of [start, end] pairs")
    spans = []
    for pair in value:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise _bad(f"{where}: each interval must be [start, end]")
        start = _parse_offset(pair[0], where, is_end=False)
        end = _parse_offset(pair[1], where, is_end=True)
        if end <= start:
            raise _bad(f"{where}: {_clock(start)}-{_clock(end)} must end after it starts")
        spans.append((start, end))
    spans.sort()
    for (start1, end1), (start2, end2) in pairwise(spans):
        if start2 < end1:
            raise _bad(f"{where}: {_clock(start1)}-{_clock(end1)} overlaps "
                       f"{_clock(start2)}-{_clock(end2)}")
    return tuple(spans)


def _check_minutes(minutes) -> None:
    if isinstance(minutes, bool) or not isinstance(minutes, int):
        raise TypeError(f"minutes must be an int, got {type(minutes).__name__}")
    if minutes < 0:
        raise ValueError(f"minutes must not be negative, got {minutes}")


def _off_the_end() -> CalendarError:
    return CalendarError("the work runs past the last date the calendar can reach")


class WorkCalendar:
    """An immutable work calendar. Build it with `from_json`."""

    def __init__(self, week, exceptions, units, default_start, default_end):
        self._week = week                  # tuple of 7 interval tuples, Monday first
        self._exceptions = exceptions      # {date: interval tuple}, replaces the weekday
        self._exception_days = sorted(exceptions)
        self._units = units
        self._default_start = default_start
        self._default_end = default_end
        self._week_work = sum(
            (e - s for pattern in week for s, e in pattern), timedelta(0))
        self._cache: dict[date, tuple[tuple[datetime, datetime], ...]] = {}

    @classmethod
    def from_json(cls, data: dict) -> "WorkCalendar":
        """Parse and validate a stored calendar (see `STANDARD_CALENDAR`).
        Anything malformed raises `CalendarError` with code `bad_calendar`.
        Interval times are `HH:MM`; `24:00` is valid as an interval end only.
        `week` must name all seven days; `exceptions`, the three unit keys and
        the two default times keep the Standard value when missing or null.
        A unit key is a positive number of at most 24 hours a day, 168 hours
        a week, 31 days a month. The input is only read, never kept or
        modified. (A write stores `clean_calendar` instead.)"""
        if not isinstance(data, dict):
            raise _bad("calendar must be an object")
        week = data.get("week")
        if not isinstance(week, dict):
            raise _bad("calendar.week must be an object with mon ... sun")
        pattern = []
        for key in DAY_KEYS:
            if key not in week:
                raise _bad(f"calendar.week is missing {key}")
            pattern.append(_parse_hours(week[key], f"week.{key}"))

        raw = data.get("exceptions")
        if raw is None:
            raw = []
        if not isinstance(raw, (list, tuple)):
            raise _bad("calendar.exceptions must be a list")
        exceptions: dict[date, tuple[tuple[timedelta, timedelta], ...]] = {}
        for index, item in enumerate(raw):
            where = f"exceptions[{index}]"
            if not isinstance(item, dict):
                raise _bad(f"{where} must be an object")
            day = _parse_date(item.get("date"), f"{where}.date")
            if day in exceptions:
                raise _bad(f"{where}: {day} is listed twice")
            if item.get("name") is not None and not isinstance(item["name"], str):
                raise _bad(f"{where}.name must be text")
            if "hours" not in item:
                raise _bad(f"{where}: hours is required (an empty list makes {day} nonworking)")
            exceptions[day] = _parse_hours(item["hours"], f"{where} ({day})")

        # Units.from_calendar also reads numeric strings; they are refused
        # here because a long exponent string is slow to expand.
        for key in _UNIT_KEYS:
            value = data.get(key)
            is_number = isinstance(value, (int, float)) and not isinstance(value, bool)
            if value is not None and not is_number:
                raise _bad(f"calendar.{key} must be a number")
            if is_number and value > _UNIT_MAX[key]:
                raise _bad(f"calendar.{key} must be at most {_UNIT_MAX[key]}")
        try:
            units = Units.from_calendar(data)
        except ValueError as exc:
            raise _bad(str(exc)) from None

        def default_time(key: str) -> time:
            value = data.get(key)
            return _parse_time(STANDARD_CALENDAR[key] if value is None else value,
                               f"calendar.{key}")

        default_start, default_end = default_time("default_start"), default_time("default_end")
        if default_end <= default_start:
            raise _bad("calendar.default_end must be after calendar.default_start")
        return cls(tuple(pattern), exceptions, units, default_start, default_end)

    @property
    def units(self) -> Units:
        return self._units

    @property
    def default_start(self) -> time:
        return self._default_start

    @property
    def default_end(self) -> time:
        return self._default_end

    def at_default_start(self, d: date) -> datetime:
        """A date-only start: the calendar's default start time that day."""
        return datetime.combine(d, self._default_start)

    def at_default_end(self, d: date) -> datetime:
        """A date-only finish: the calendar's default end time that day."""
        return datetime.combine(d, self._default_end)

    # --- the day's working intervals -------------------------------------------------

    def _day(self, day: date) -> tuple[tuple[datetime, datetime], ...]:
        cached = self._cache.get(day)
        if cached is None:
            pattern = self._exceptions.get(day)
            if pattern is None:
                pattern = self._week[day.weekday()]
            midnight = datetime.combine(day, time.min)
            try:
                cached = tuple((midnight + s, midnight + e) for s, e in pattern)
            except OverflowError:  # a 24:00 end on the very last day
                raise _off_the_end() from None
            if len(self._cache) >= _CACHE_LIMIT:
                self._cache.clear()
            self._cache[day] = cached
        return cached

    def intervals(self, day: date) -> list[tuple[datetime, datetime]]:
        """The day's working intervals in order. An exception's hours replace
        the weekday pattern; `[]` is a nonworking day. A new list each call."""
        if isinstance(day, datetime):
            day = day.date()
        return list(self._day(day))

    # --- finding working moments -----------------------------------------------------

    @staticmethod
    def _step(day: date, days: int) -> date:
        try:
            return day + timedelta(days=days)
        except OverflowError:
            raise _off_the_end() from None

    def _next_slot(self, t: datetime) -> tuple[datetime, datetime]:
        """The stretch of work that starts at or after t: (start, end), where
        start is t itself when t is inside [s, e) of an interval."""
        day = t.date()
        for _ in range(MAX_SEARCH_DAYS + 1):
            for s, e in self._day(day):
                if t < e:
                    return (s if t < s else t), e
            day = self._step(day, 1)
        raise CalendarError(
            f"no working time within {MAX_SEARCH_DAYS} days after {t:%Y-%m-%d %H:%M}")

    def _prev_slot(self, t: datetime) -> tuple[datetime, datetime]:
        """The stretch of work that ends at or before t: (start, end), where
        end is t itself when t is inside (s, e] of an interval."""
        day = t.date()
        for _ in range(MAX_SEARCH_DAYS + 1):
            for s, e in reversed(self._day(day)):
                if t > s:
                    return s, (e if t > e else t)
            day = self._step(day, -1)
        raise CalendarError(
            f"no working time within {MAX_SEARCH_DAYS} days before {t:%Y-%m-%d %H:%M}")

    def next_work_start(self, t: datetime) -> datetime:
        """`t` if work can start there ([s, e): an interval's end is not
        inside), else the next interval's start."""
        return self._next_slot(t)[0]

    def prev_work_end(self, t: datetime) -> datetime:
        """`t` if work can finish there ((s, e]: an interval's start is not
        inside), else the previous interval's end."""
        return self._prev_slot(t)[1]

    # --- arithmetic ------------------------------------------------------------------

    def _whole_weeks(self, day: date, remaining: timedelta, forward: bool) -> int:
        """How many whole weeks a walk standing on `day` may jump instead of
        crossing them day by day. Every week of the pattern holds the same
        work, so jumping n weeks consumes exactly n * a week's work, as long as
        no exception falls in the days covered and the work still left stays
        above zero (the walk must finish inside an interval, not beyond a
        jump). Zero when there is nothing to gain."""
        if not self._week_work:
            return 0
        weeks = (remaining - timedelta.resolution) // self._week_work
        days = self._exception_days
        if forward:
            i = bisect_left(days, day)
            if i < len(days):
                weeks = min(weeks, ((days[i] - day).days - 1) // 7)
        else:
            i = bisect_right(days, day) - 1
            if i >= 0:
                weeks = min(weeks, ((day - days[i]).days - 1) // 7)
        return max(weeks, 0)

    def add_work(self, t: datetime, minutes: int) -> datetime:
        """Move `minutes` of working time forward from `t`. Zero returns `t`
        unchanged; otherwise the walk begins at `next_work_start(t)` and may
        end exactly on an interval's end."""
        _check_minutes(minutes)
        if minutes == 0:
            return t
        try:
            remaining = timedelta(minutes=minutes)
        except OverflowError:
            raise _off_the_end() from None
        start, end = self._next_slot(t)
        while True:
            available = end - start
            if remaining <= available:
                return start + remaining
            remaining -= available
            cursor = end
            weeks = self._whole_weeks(cursor.date(), remaining, forward=True)
            if weeks:
                remaining -= weeks * self._week_work
                try:
                    cursor += timedelta(weeks=weeks)
                except OverflowError:
                    raise _off_the_end() from None
            start, end = self._next_slot(cursor)

    def sub_work(self, t: datetime, minutes: int) -> datetime:
        """Move `minutes` of working time back from `t`: the mirror of
        `add_work`, starting from `prev_work_end(t)`. Zero returns `t`."""
        _check_minutes(minutes)
        if minutes == 0:
            return t
        try:
            remaining = timedelta(minutes=minutes)
        except OverflowError:
            raise _off_the_end() from None
        start, end = self._prev_slot(t)
        while True:
            available = end - start
            if remaining <= available:
                return end - remaining
            remaining -= available
            cursor = start
            weeks = self._whole_weeks(cursor.date(), remaining, forward=False)
            if weeks:
                remaining -= weeks * self._week_work
                try:
                    cursor -= timedelta(weeks=weeks)
                except OverflowError:
                    raise _off_the_end() from None
            start, end = self._prev_slot(cursor)

    def work_between(self, a: datetime, b: datetime) -> int:
        """Working minutes from `a` to `b`; negative when `b` is earlier.
        Neither end needs to be a working moment. A partial minute rounds
        toward zero. Zero for a calendar with no working time."""
        if b < a:
            return -self.work_between(b, a)
        total = timedelta(0)
        day, last = a.date(), b.date()
        while True:
            for s, e in self._day(day):
                lo, hi = max(s, a), min(e, b)
                if hi > lo:
                    total += hi - lo
            if day >= last:
                break
            day += _ONE_DAY
            # days strictly before the last one lie wholly inside [a, b]:
            # whole weeks of them are summed rather than walked
            weeks = (last - day).days // 7
            days = self._exception_days
            i = bisect_left(days, day)
            if i < len(days):
                weeks = min(weeks, (days[i] - day).days // 7)
            if weeks:
                total += weeks * self._week_work
                day += timedelta(weeks=weeks)
        return total // _MINUTE


def _pairs(hours) -> list[list[str]]:
    """A day's [start, end] pairs (already checked) by start. Zero-padded
    HH:MM text sorts as time does, and no two intervals share a start."""
    return sorted(list(pair) for pair in hours)


def clean_calendar(data) -> dict:
    """The calendar a write stores (plan settings, the system section): the
    checks of `from_json`, and a key it does not know (in the calendar, its
    week or an exception) is refused too, since it would be stored without
    meaning anything. So is a week with no working time on any day. An
    exception's name is one line of text (no control characters), and
    there are at most MAX_EXCEPTIONS exceptions.

    Answers a new dict in one canonical form, so the same calendar sent in
    another order stores the same value: every key (a missing or null unit
    key or default time takes the Standard value), the week Monday first,
    each day's intervals by start, the exceptions by date, each with its
    `name` (null when none). Raises `CalendarError` (`bad_calendar`); the
    input is only read."""
    listed = data.get("exceptions") if isinstance(data, dict) else None
    if isinstance(listed, (list, tuple)) and len(listed) > MAX_EXCEPTIONS:
        raise _bad(f"calendar.exceptions: at most {MAX_EXCEPTIONS} exceptions")
    WorkCalendar.from_json(data)
    unknown = sorted(str(key) for key in data if key not in _CALENDAR_KEYS)
    if unknown:
        raise _bad(f"calendar: {_shown(unknown[0])} is not a calendar setting")
    unknown = sorted(str(key) for key in data["week"] if key not in DAY_KEYS)
    if unknown:
        raise _bad(f"calendar.week: {_shown(unknown[0])} is not a day (mon ... sun)")
    # every plan scheduled on it would fail `no_working_time` (the system
    # calendar is copied into each new plan); exceptions do not count
    if not any(data["week"][key] for key in DAY_KEYS):
        raise _bad("calendar.week: the week has no working time")
    exceptions = []
    for index, item in enumerate(data.get("exceptions") or []):
        unknown = sorted(str(key) for key in item if key not in _EXCEPTION_KEYS)
        if unknown:
            raise _bad(f"exceptions[{index}]: {_shown(unknown[0])} is not an exception field")
        name = item.get("name")
        if name is not None and has_control_chars(name):
            raise _bad(f"exceptions[{index}].name: a control character (a line break, "
                       "a tab, ...) is not allowed")
        exceptions.append({"date": item["date"], "name": name, "hours": _pairs(item["hours"])})
    exceptions.sort(key=lambda item: item["date"])

    def kept(key: str):
        value = data.get(key)
        return STANDARD_CALENDAR[key] if value is None else value

    return {
        "week": {key: _pairs(data["week"][key]) for key in DAY_KEYS},
        "exceptions": exceptions,
        **{key: kept(key) for key in (*_UNIT_KEYS, *_DEFAULT_KEYS)},
    }
