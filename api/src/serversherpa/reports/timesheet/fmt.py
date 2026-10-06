"""Small formatting helpers shared by the Excel and PDF outputs."""

from datetime import datetime
from zoneinfo import ZoneInfo

from serversherpa.reports.timesheet.gather import STATUS_LABELS

# Spec order, used wherever statuses are listed.
STATUS_ORDER = ("approved", "pending", "rejected", "open")


def clock(dt: datetime | None) -> str:
    """`07:02 EDT` — 24-hour time with the zone abbreviation of the zone
    `dt` already carries (each entry is converted to its own zone by gather)."""
    return "" if dt is None else dt.strftime("%H:%M %Z")


def worked(minutes: int) -> str:
    """`8h 05m`."""
    return f"{minutes // 60}h {minutes % 60:02d}m"


def hours(minutes: int) -> float:
    """Decimal hours to two places, for payroll."""
    return round(minutes / 60, 2)


def status_names(statuses) -> str:
    chosen = [s for s in STATUS_ORDER if s in statuses]
    return ", ".join(STATUS_LABELS[s] for s in chosen)


def generated_stamp(generated_at: datetime, tz_name: str) -> str:
    local = generated_at.astimezone(ZoneInfo(tz_name))
    return f"{local:%Y-%m-%d %H:%M} {local:%Z}"


def zone_note(tz_name: str) -> str:
    return (f"Times are in each entry's site time zone; entries without a "
            f"site time zone use {tz_name}.")
