"""A person's own schedule: when may email reach them? Pure: no database, no
settings.

``schedule_from_prefs`` reads the ``notif.schedule`` preference (timezone, the
days they work, quiet hours). ``state_at`` says whether they are open at an
instant or closed, by a day off or by quiet hours (a day off wins). From that:

* ``back_online_after``: the first instant at or after ``at`` when they are
  open (``at`` itself when already open);
* ``summary_at``: one hour before that, when email that had to wait goes out
  as one summary;
* ``hold_decision``: what to do with an email decided now. Hold it for the
  summary, or send it right away: they are open, or it is the last hour
  before they are back online and that morning's summary has already gone.

Every time it returns is an aware UTC datetime. ``None`` means nothing opens
within the search horizon. ``zone_loads`` says whether a zone name loads at
all (saving preferences refuses a changed zone that does not).
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from serversherpa.services.timezone import DEFAULT_TIMEZONE

logger = logging.getLogger("serversherpa.notifications.schedule")

DAYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
State = Literal["open", "quiet_hours", "inactive_day"]

_SUMMARY_LEAD = timedelta(hours=1)
_HORIZON = timedelta(days=8)
# Each step lands on the next quiet end or local midnight, so a few per day is
# plenty; the cap only guards against a pathological zone.
_MAX_STEPS = _HORIZON.days * 4


@dataclass(frozen=True)
class Schedule:
    """``quiet_start`` and ``quiet_end`` are naive local clock times. Quiet
    hours count only when both are set and different; ``schedule_from_prefs``
    leaves both None otherwise."""

    zone: ZoneInfo
    days: frozenset[str]
    quiet_start: time | None
    quiet_end: time | None


def zone_loads(name: str) -> bool:
    """Whether ``name`` loads as a zone. ZoneInfo refuses a bad name in several
    ways: not found, a path outside the zone database or a file that is not a
    zone (ValueError), an unreadable file (OSError), and a name nested deep
    enough to exhaust the recursion limit (RecursionError)."""
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError, RecursionError):
        return False
    return True


# Zone names already warned about. The summary sweep reads the same stored
# zone every 60 s, so each bad name is logged once per process, not per read.
_warned_zones: set[str] = set()


def _zone(name: str | None) -> ZoneInfo:
    """The named zone; the company reference zone when unset, or when a stored
    name no longer loads (it must not crash a notification). That fallback is
    logged once per name."""
    if name:
        if zone_loads(name):
            return ZoneInfo(name)
        if name not in _warned_zones:
            _warned_zones.add(name)
            logger.warning("unknown notification timezone %r; using %s", name, DEFAULT_TIMEZONE)
    return ZoneInfo(DEFAULT_TIMEZONE)


def _clock(value: str | None) -> time | None:
    """'HH:MM' or 'HH:MM:SS' as a naive time; None when unset or unreadable."""
    if not value:
        return None
    try:
        return time.fromisoformat(value).replace(tzinfo=None)
    except ValueError:
        return None


def _quiet_window(start: time | None, end: time | None) -> tuple[time, time] | None:
    """Quiet hours count only when both times are set and different."""
    if start is None or end is None or start == end:
        return None
    return start, end


def schedule_from_prefs(raw: Mapping | None) -> Schedule:
    """The schedule a ``notif.schedule`` preference describes. Anything unset
    or unusable takes its default: the reference zone, every day, no quiet
    hours. Unknown day names are dropped; an empty result means every day."""
    raw = raw or {}
    window = _quiet_window(_clock(raw.get("quiet_start")), _clock(raw.get("quiet_end")))
    days = frozenset(d for d in raw.get("days") or () if d in DAYS)
    quiet_start, quiet_end = window or (None, None)
    return Schedule(_zone(raw.get("timezone")), days or frozenset(DAYS), quiet_start, quiet_end)


def _require_aware(at: datetime) -> None:
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("the time must be timezone-aware")


def _state(s: Schedule, local: datetime) -> State:
    """The state on the local wall clock. A day off wins over quiet hours."""
    if DAYS[local.weekday()] not in s.days:
        return "inactive_day"
    window = _quiet_window(s.quiet_start, s.quiet_end)
    if window is not None:
        start, end = window
        t = local.time()
        # [start, end), wrapping past midnight when the window starts later
        # than it ends
        in_quiet = (start <= t < end) if start < end else (t >= start or t < end)
        if in_quiet:
            return "quiet_hours"
    return "open"


def state_at(s: Schedule, at: datetime) -> State:
    """Whether the person is open at ``at``, or closed by a day off
    (``inactive_day``) or by ``quiet_hours``."""
    _require_aware(at)
    return _state(s, at.astimezone(s.zone))


def _next_boundary(s: Schedule, cur_utc: datetime) -> datetime:
    """The first instant after ``cur_utc`` where the person can become open:
    the next local midnight or the next quiet end, whichever is sooner.
    Returned in UTC (compared in UTC, never as same-zone wall time)."""
    day = cur_utc.astimezone(s.zone).date()
    wall = [datetime.combine(day + timedelta(days=1), time.min)]
    window = _quiet_window(s.quiet_start, s.quiet_end)
    if window is not None:
        wall += [datetime.combine(day + timedelta(days=offset), window[1]) for offset in (0, 1)]
    # A wall time inside a DST fall-back hour happens twice (fold 0 and 1), so
    # both readings are candidates: with only fold=0, a "now" in the second
    # pass would find the quiet end already behind it and skip a day. (In a
    # spring-forward gap the two readings are the instants either side of the
    # gap; the extra one is closed and the loop moves on. A quiet end inside
    # the gap itself reads with the pre-gap offset, which lands after the gap:
    # back online is a little later than the gap's end, never earlier.)
    later = [
        c
        for w in wall
        for fold in (0, 1)
        for c in (w.replace(tzinfo=s.zone, fold=fold).astimezone(UTC),)
        if c > cur_utc
    ]
    return min(later)


def back_online_after(s: Schedule, at: datetime) -> datetime | None:
    """The first instant at or after ``at`` when the person is open, in UTC
    (``at`` itself when already open). With no quiet hours that is 12:00 AM of
    their next working day. None when nothing opens within the horizon. Across
    a DST change the local wall clock decides (see ``_next_boundary``)."""
    _require_aware(at)
    start = at.astimezone(UTC)
    if _state(s, start.astimezone(s.zone)) == "open":
        return start
    limit = start + _HORIZON
    cur = start
    for _ in range(_MAX_STEPS):
        cur = _next_boundary(s, cur)
        if cur > limit:
            return None
        if _state(s, cur.astimezone(s.zone)) == "open":
            return cur
    return None


def summary_at(s: Schedule, at: datetime) -> datetime | None:
    """When email held at ``at`` goes out as one summary: an hour before the
    person is back online. None when they are not back within the horizon."""
    back = back_online_after(s, at)
    return None if back is None else back - _SUMMARY_LEAD


@dataclass(frozen=True)
class HoldDecision:
    """``reason`` is the state that closed the schedule (``quiet_hours`` or
    ``inactive_day``). ``summary_at`` is set only when the email is held.
    ``after_summary`` marks an email sent right away only because that
    morning's summary has already gone."""

    hold: bool
    reason: str | None
    summary_at: datetime | None
    after_summary: bool


def hold_decision(s: Schedule, now: datetime) -> HoldDecision:
    """Hold an email decided at ``now`` for the summary, or send it now?

    Open sends now. Closed holds it until the summary time, unless that time
    has already passed (the last hour before back online), which sends it now
    and marks ``after_summary``. Nothing opening within the horizon also sends
    now: there is no summary time to wait for."""
    state = state_at(s, now)
    summary = None if state == "open" else summary_at(s, now)
    if summary is None:  # open, or nothing opens within the horizon
        return HoldDecision(False, None, None, False)
    if summary > now:
        return HoldDecision(True, state, summary, False)
    # The last hour before back online: the summary time has passed, so a
    # held email would miss that morning's summary and wait a day.
    return HoldDecision(False, state, None, True)
