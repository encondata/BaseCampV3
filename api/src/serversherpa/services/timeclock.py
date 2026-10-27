"""Punch-clock entry mechanics, shared by the self-service /time
endpoints (the caller clocking themselves in and out) and the kiosk
timeclock (a kiosk operator clocking the worker in front of the screen).

The rules that must not drift between the two live here: at most one
open entry per person (enforced for real by the partial unique index
`one_open_entry_per_person`, migration 0028 — the pre-check in a route
is only advisory and can lose a race), a closed entry graduating into
the `pending` approval queue, and worked minutes being the span net of
break, never negative.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Site, TimeEntry
from serversherpa.services.audit import diff, snapshot

# The columns a clock-out touches — the audit diff is taken over these.
CLOSE_FIELDS = ["status", "clock_out_at", "break_minutes", "notes"]


class AlreadyClockedIn(Exception):
    """The one-open-entry-per-person index rejected the insert: someone
    (or a racing request) already has an open entry for this person."""


async def open_entry_for(db: AsyncSession, person_id: uuid.UUID) -> TimeEntry | None:
    """The person's open entry (no clock_out_at yet), or None."""
    return await db.scalar(select(TimeEntry).where(
        TimeEntry.person_id == person_id, TimeEntry.clock_out_at.is_(None)))


async def last_closed_entry_for(db: AsyncSession, person_id: uuid.UUID) -> TimeEntry | None:
    """The person's most recently CLOSED entry (clock_out_at IS NOT
    NULL), ordered by clock_out_at so this is the true most recent
    shift rather than merely the most recently created row — or None if
    they have never clocked out. Used for "Last clock-out {time}" when
    there is no open entry to show instead."""
    return await db.scalar(select(TimeEntry).where(
        TimeEntry.person_id == person_id, TimeEntry.clock_out_at.isnot(None))
        .order_by(TimeEntry.clock_out_at.desc()).limit(1))


def worked_minutes(entry: TimeEntry) -> int:
    """Worked minutes, net of break. 0 while the entry is still open."""
    if entry.clock_out_at is None:
        return 0
    span = int((entry.clock_out_at - entry.clock_in_at).total_seconds() // 60)
    return max(0, span - entry.break_minutes)


@dataclass
class TodaySpan:
    """One entry's share of today: `clock_out_at` is None while open."""

    clock_in_at: datetime
    clock_out_at: datetime | None
    minutes: int


def zone_named(name: str | None) -> ZoneInfo | None:
    """`name` as a zone, or None when it is empty or not one this host knows.
    The kiosk's `tz` is client input, so any lookup failure (an odd path
    included) counts as unknown."""
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return None


async def site_zone(
    db: AsyncSession, site_id: uuid.UUID | None, fallback: str | None = None,
) -> ZoneInfo:
    """The zone "today" is read in: the site's own zone; else `fallback`
    (the kiosk's own zone, sent by its browser as `tz`); else UTC. A name
    that is empty or not one this host knows is skipped, never an error."""
    name = None
    if site_id is not None:
        name = await db.scalar(select(Site.timezone).where(Site.id == site_id))
    return zone_named(name) or zone_named(fallback) or ZoneInfo("UTC")


async def today_summary(
    db: AsyncSession, person_id: uuid.UUID, *, tz: ZoneInfo, now: datetime,
) -> tuple[int, list[TodaySpan]]:
    """Minutes worked so far today (local to `tz`) and the spans behind
    them, oldest first — "You've been working for 7h 24m today".

    A span counts only its overlap with [local midnight, now], so a shift
    that started yesterday is clipped at midnight and an open one runs to
    `now`. Break comes off only a shift that started today (a shift from
    yesterday has nowhere today to put it); each span floors at 0."""
    # All arithmetic in UTC: subtracting two aware datetimes that share a
    # ZoneInfo is wall-clock math, which loses or gains an hour on a DST day.
    now = now.astimezone(UTC)
    day_start = datetime.combine(
        now.astimezone(tz).date(), time.min, tzinfo=tz).astimezone(UTC)
    entries = (await db.scalars(select(TimeEntry).where(
        TimeEntry.person_id == person_id,
        TimeEntry.clock_in_at < now,
        TimeEntry.clock_out_at.is_(None) | (TimeEntry.clock_out_at > day_start))
        .order_by(TimeEntry.clock_in_at))).all()
    spans = []
    for entry in entries:
        start = max(entry.clock_in_at, day_start)
        end = min(entry.clock_out_at or now, now)
        minutes = int((end - start).total_seconds() // 60)
        if entry.clock_in_at >= day_start:
            minutes -= entry.break_minutes
        spans.append(TodaySpan(clock_in_at=entry.clock_in_at,
                               clock_out_at=entry.clock_out_at,
                               minutes=max(0, minutes)))
    return sum(s.minutes for s in spans), spans


async def create_open_entry(
    db: AsyncSession, *,
    person_id: uuid.UUID,
    clock_in_at: datetime,
    initiative_id: uuid.UUID | None = None,
    site_id: uuid.UUID | None = None,
    notes: str = "",
    created_by: uuid.UUID | None = None,
    source: str | None = None,
    device_id: uuid.UUID | None = None,
) -> TimeEntry:
    """Open a new entry for `person_id`, flushed so its id is available.

    Raises AlreadyClockedIn when the partial unique index rejects the
    insert. The flush happens inside a savepoint so that conflict comes
    back as a clean, recoverable error instead of poisoning the session
    with an unhandled IntegrityError (a 500).

    `source` and `device_id` are left to their column defaults when not
    given — `source` is NOT NULL with a 'punch' default, so it must not
    be written as NULL by a caller that has nothing to say about it.
    """
    fields: dict = {
        "person_id": person_id, "initiative_id": initiative_id,
        "site_id": site_id, "clock_in_at": clock_in_at, "notes": notes,
        "created_by": created_by,
    }
    if source is not None:
        fields["source"] = source
    if device_id is not None:
        fields["device_id"] = device_id
    entry = TimeEntry(**fields)
    try:
        async with db.begin_nested():
            db.add(entry)
            await db.flush()
    except IntegrityError as exc:
        # Only the one-open-entry index means "already clocked in" — a
        # bogus initiative_id/site_id/device_id (a caller's FK pointing
        # nowhere) is also an IntegrityError but a different bug, and
        # must not be misreported as a 409 the caller could reasonably
        # act on. The constraint name lives on the *original* asyncpg
        # exception, not SQLAlchemy's DBAPI-wrapper `exc.orig` (which
        # only carries the message and sqlstate) — the wrapper chains
        # asyncpg's own exception on as `__cause__`.
        asyncpg_exc = exc.orig.__cause__ if exc.orig is not None else None
        if getattr(asyncpg_exc, "constraint_name", None) != "one_open_entry_per_person":
            raise
        raise AlreadyClockedIn from None
    return entry


def close_open_entry(
    entry: TimeEntry, *,
    clock_out_at: datetime,
    now: datetime,
    break_minutes: int | None = None,
    notes: str | None = None,
) -> dict:
    """Close `entry` and return the audit diff over CLOSE_FIELDS.

    `clock_out_at` is when the shift ended (the kiosk may back-date it);
    `now` is when the row was touched, and only stamps updated_at. Notes
    append rather than replace, and the entry graduates to `pending` so
    it lands in the timesheet-approval queue.
    """
    before = snapshot(entry, CLOSE_FIELDS)
    entry.clock_out_at = clock_out_at
    if break_minutes is not None:
        entry.break_minutes = break_minutes
    if notes:
        entry.notes = f"{entry.notes}\n{notes}".strip() if entry.notes else notes
    entry.status = "pending"
    entry.updated_at = now
    return diff(before, snapshot(entry, CLOSE_FIELDS))
