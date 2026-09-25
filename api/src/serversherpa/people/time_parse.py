"""Reading clock times out of an uploaded timesheet (Bulk Actions › Add time
punches in bulk).

A cell with an explicit UTC offset (ISO 8601 `2026-09-24T07:00:00-07:00`, or
a trailing `Z`) is taken as written. Anything else is a wall-clock time in
the zone the caller passes: the row's site, else the job's site, else the
house default (services/timezone.DEFAULT_TIMEZONE). Daylight-saving gaps and
repeats resolve by zoneinfo's standard rule, fold=0. A time in the
spring-forward gap reads with the offset in force before the change, and a
time in the repeated fall-back hour reads as its first occurrence.

Excel: openpyxl hands a date-formatted cell over as a datetime, which the
bulk core turns into `2026-09-24 07:00:00`. An unformatted date cell is a
serial day count since 1899-12-30; it is read only between 1954 and 2119,
so a stray small number is never taken for a date."""

import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from serversherpa.services.timezone import DEFAULT_TIMEZONE

EXCEL_EPOCH = datetime(1899, 12, 30)  # noqa: DTZ001 — a naive reference point; localized in _serial
EXCEL_SERIAL_MIN = 20000     # 1954-10-03
EXCEL_SERIAL_MAX = 80000     # 2119-01-10

_SERIAL = re.compile(r"^\d+(\.\d+)?$")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")
_AMPM = re.compile(r"\s*([ap])\.?m\.?$", re.IGNORECASE)
_BREAK = re.compile(r"^\d+(\.0+)?$")
_NAIVE_FORMATS = (
    "%m/%d/%Y %I:%M %p", "%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S",
    "%m/%d/%y %I:%M %p", "%m/%d/%y %H:%M",
    "%Y-%m-%d %I:%M %p", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S",
)


def zone_for(name: str | None) -> ZoneInfo:
    """The named IANA zone, or the house default when the name is blank or
    not a zone this server knows (sites.timezone is free text)."""
    if name and name.strip():
        try:
            return ZoneInfo(name.strip())
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return ZoneInfo(DEFAULT_TIMEZONE)


def parse_clock(text: str, zone: ZoneInfo) -> datetime | None:
    """One clock_in / clock_out cell as an aware UTC datetime, or None when
    it is not a date and time this import reads. A date alone, or a time
    alone, is not enough."""
    raw = " ".join((text or "").split())
    if not raw:
        return None
    if _SERIAL.match(raw):
        return _serial(float(raw), zone)
    parsed = _iso(raw) or _naive(raw)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)          # fold=0
    return parsed.astimezone(UTC)


def _serial(value: float, zone: ZoneInfo) -> datetime | None:
    if not EXCEL_SERIAL_MIN <= value <= EXCEL_SERIAL_MAX:
        return None
    naive = EXCEL_EPOCH + timedelta(seconds=round(value * 86400))
    return naive.replace(tzinfo=zone).astimezone(UTC)


def _iso(raw: str) -> datetime | None:
    if not _ISO.match(raw):
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _naive(raw: str) -> datetime | None:
    text = _AMPM.sub(lambda m: f" {m.group(1).upper()}M", raw)
    for fmt in _NAIVE_FORMATS:
        try:
            return datetime.strptime(text, fmt)  # noqa: DTZ007 — naive; localized by the caller
        except ValueError:
            continue
    return None


def parse_break(text: str) -> int | None:
    """Break minutes: blank is 0; None when negative or not a whole number."""
    raw = (text or "").strip()
    if not raw:
        return 0
    if not _BREAK.match(raw):
        return None
    return int(float(raw))


def _day(local: datetime) -> str:
    return f"{local:%b} {local.day}"


def _time(local: datetime) -> str:
    return f"{(local.hour % 12) or 12}:{local:%M} {'AM' if local.hour < 12 else 'PM'}"


def clock_text(at: datetime, zone: ZoneInfo) -> str:
    """'Sep 23, 10:00 PM EDT' — one instant on `zone`'s wall clock."""
    local = at.astimezone(zone)
    return f"{_day(local)}, {_time(local)} {local.tzname()}"


def shift_text(start: datetime, end: datetime, zone: ZoneInfo) -> str:
    """'Sep 24, 7:00 AM – 3:30 PM PDT'. The end repeats the day when the
    shift crosses midnight, and each end carries its own abbreviation when a
    daylight-saving change falls inside the shift."""
    a, b = start.astimezone(zone), end.astimezone(zone)
    left = f"{_day(a)}, {_time(a)}"
    if a.tzname() != b.tzname():
        left += f" {a.tzname()}"
    right = f"{_time(b)} {b.tzname()}"
    if b.date() != a.date():
        right = f"{_day(b)}, {right}"
    return f"{left} – {right}"
