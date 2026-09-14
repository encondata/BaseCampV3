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
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import TimeEntry
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


def worked_minutes(entry: TimeEntry) -> int:
    """Worked minutes, net of break. 0 while the entry is still open."""
    if entry.clock_out_at is None:
        return 0
    span = int((entry.clock_out_at - entry.clock_in_at).total_seconds() // 60)
    return max(0, span - entry.break_minutes)


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
    except IntegrityError:
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
