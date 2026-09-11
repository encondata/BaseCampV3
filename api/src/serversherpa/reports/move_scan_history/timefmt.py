"""Time zone callout for the report outputs.

Every timestamp in this report is rendered in one zone (`report_timezone()`),
but the rows themselves carry no zone marker — so each output names the
zone once, up front, and tags the generated stamp with its abbreviation.
"""

from datetime import datetime
from zoneinfo import ZoneInfo


def zone_abbrev(tz: ZoneInfo, at: datetime) -> str:
    """"EDT"/"EST" etc. for `at` in `tz` (DST-aware)."""
    return at.astimezone(tz).strftime("%Z")


def timezone_label(tz: ZoneInfo, at: datetime) -> str:
    """"America/New_York (EDT, UTC-04:00)" — the IANA name plus the
    abbreviation and offset in effect at `at`, so a reader can place every
    timestamp in the report without guessing."""
    local = at.astimezone(tz)
    offset = local.strftime("%z")            # -0400
    return f"{tz.key} ({local.strftime('%Z')}, UTC{offset[:3]}:{offset[3:]})"
