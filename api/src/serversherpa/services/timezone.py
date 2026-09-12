"""The house default time zone — shared by anything that renders a fixed
local time (reports, the label-generation worker). No system-wide
timezone config exists yet (grepped serversherpa/notifications/ and
serversherpa/system/config_store.py — neither defines a DEFAULT_TIMEZONE
constant or a system_config section key for it). This mirrors
NotificationGroup.timezone's own server_default (db/models.py) — the
closest thing V3 has today to a house-default time zone. Swap this for a
real system_config read if one is added later.

Originally lived in reports/move_scan_history (the first caller); moved
here so a non-report caller (labels/generate/values.py) doesn't have to
import the report package — and with it openpyxl/WeasyPrint — just for a
ZoneInfo. `reports/move_scan_history` re-exports both names so existing
`from serversherpa.reports.move_scan_history import report_timezone`
imports keep working."""

from zoneinfo import ZoneInfo

DEFAULT_TIMEZONE = "America/New_York"


def report_timezone() -> ZoneInfo:
    return ZoneInfo(DEFAULT_TIMEZONE)
