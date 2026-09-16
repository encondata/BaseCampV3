"""The house default time zone — shared by anything that renders a fixed
local time (reports, the label-generation worker) — plus `stored_day`,
the date-only reader for a TIMESTAMP(timezone=True) column that actually
holds a plain calendar day. No system-wide timezone config exists yet
(grepped serversherpa/notifications/ and
serversherpa/system/config_store.py — neither defines a DEFAULT_TIMEZONE
constant or a system_config section key for it). This mirrors
NotificationGroup.timezone's own server_default (db/models.py) — the
closest thing V3 has today to a house-default time zone. Swap this for a
real system_config read if one is added later.

Originally lived in reports/move_scan_history (the first caller); moved
here so a non-report caller (labels/generate/values.py) doesn't have to
import the report package — and with it openpyxl/WeasyPrint — just for a
ZoneInfo. `reports/move_scan_history` re-exports DEFAULT_TIMEZONE and
report_timezone (not stored_day) so existing
`from serversherpa.reports.move_scan_history import report_timezone`
imports keep working."""

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

DEFAULT_TIMEZONE = "America/New_York"


def report_timezone() -> ZoneInfo:
    return ZoneInfo(DEFAULT_TIMEZONE)


def stored_day(value: datetime) -> date:
    """The calendar day a date-only field holds.

    `scheduled_start` and friends are TIMESTAMP(timezone=True) columns that
    carry a plain YYYY-MM-DD input as MIDNIGHT UTC. Converting that into the
    report timezone lands on the previous evening anywhere west of UTC, which
    named the day BEFORE the one the user picked (fixed 2026-09-16; the same
    class of bug was found on the initiatives timeline on 2026-09-15). Read the
    UTC date parts instead — for a midnight-UTC value they ARE the picked day,
    and for a genuine timestamp this is still the UTC calendar day, which is
    the closest defensible reading of a field used as a date.

    `value` must be timezone-aware. `astimezone(UTC)` on a naive datetime
    treats it as the HOST's local time before converting, which would
    silently reproduce the exact bug this helper exists to prevent on any
    host not already running in UTC. Every current caller reads a
    TIMESTAMP(timezone=True) column through asyncpg, so its inputs are
    always aware."""
    return value.astimezone(UTC).date()
