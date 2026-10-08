"""When may a notification email go out? Pure: no database, no settings.

Takes effective notification-group settings (the shape returned by
``notifications.settings.effective_settings``) and an aware ``now`` and
answers with the earliest UTC instant the email is allowed, or ``None``
when it is never allowed (no email channel, ``skip`` during quiet hours or
an inactive day, or nothing open within the search horizon).
"""

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_HORIZON = timedelta(days=8)
# Each step lands on the next quiet-end or local midnight, so a few per
# day is plenty; the cap only guards against a pathological zone.
_MAX_STEPS = 8 * 4


def _require_aware(now: datetime) -> None:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")


def _quiet_window(s: dict) -> tuple[time, time] | None:
    start, end = s.get("quiet_start"), s.get("quiet_end")
    if start is None or end is None or start == end:
        return None
    return start.replace(tzinfo=None), end.replace(tzinfo=None)


def _is_open(s: dict, local: datetime) -> bool:
    """On an active day and outside the quiet window [start, end)."""
    if _DAYS[local.weekday()] not in (s.get("active_days") or ()):
        return False
    window = _quiet_window(s)
    if window is None:
        return True
    start, end = window
    t = local.replace(tzinfo=None).time()
    in_quiet = (start <= t < end) if start < end else (t >= start or t < end)
    return not in_quiet


def _next_boundary(s: dict, cur_utc: datetime, tz: ZoneInfo) -> datetime:
    """The first instant after ``cur_utc`` where the open/closed answer can
    change: the next local midnight or the next quiet-end, whichever is
    sooner. Returned in UTC (compared in UTC, never as same-zone wall time)."""
    local = cur_utc.astimezone(tz)
    day = local.date()
    wall = [datetime.combine(day + timedelta(days=1), time.min)]
    window = _quiet_window(s)
    if window is not None:
        wall += [datetime.combine(day + timedelta(days=offset), window[1])
                 for offset in (0, 1)]
    # A wall time inside a DST fall-back hour happens twice (fold 0 and 1),
    # so both readings are candidates: with only fold=0, a "now" in the
    # second pass would find the quiet end already behind it and skip a day.
    # (In a spring-forward gap the two readings are the instants either side
    # of the gap; the extra one is closed and the loop moves on.)
    later = [c for w in wall for fold in (0, 1)
             for c in (w.replace(tzinfo=tz, fold=fold).astimezone(UTC),)
             if c > cur_utc]
    return min(later)


def allowed_at(s: dict, now: datetime, *, urgent: bool) -> datetime | None:
    """Earliest UTC instant one group's settings allow an email, or None."""
    _require_aware(now)
    now_utc = now.astimezone(UTC)
    if urgent and s.get("urgent_bypass"):
        return now_utc
    tz = ZoneInfo(s.get("timezone") or "UTC")
    if _is_open(s, now_utc.astimezone(tz)):
        return now_utc
    if s.get("dnd_behavior") != "defer":
        return None
    limit = now_utc + _HORIZON
    cur = now_utc
    for _ in range(_MAX_STEPS):
        cur = _next_boundary(s, cur, tz)
        if cur > limit:
            return None
        if _is_open(s, cur.astimezone(tz)):
            return cur
    return None


def email_send_time(settings: list[dict], now: datetime, *,
                    urgent: bool) -> datetime | None:
    """Earliest allowed send time across the email-enabled groups (the most
    permissive wins), as an aware UTC datetime; None when none allows it."""
    _require_aware(now)
    times = [
        t for s in settings
        if "email" in (s.get("channels") or ())
        for t in (allowed_at(s, now, urgent=urgent),)
        if t is not None
    ]
    return min(times) if times else None
