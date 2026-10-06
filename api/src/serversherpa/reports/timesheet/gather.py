"""Step 1 of the Timesheet report: read the time entries for a date range
and filters, place each on its local day, compute verification flags, and
roll everything up into day rows and per-person / per-job totals.

Data rules are in docs/superpowers/specs/2026-10-06-timesheet-report-design.md.
The flag, day-row and rollup helpers are pure (no DB) so they can be tested
on their own; `gather` is the only async part.
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, Person, Site, StatusValue, TimeEntry
from serversherpa.db.ordering import natural_key
from serversherpa.services.timeclock import worked_minutes
from serversherpa.services.timezone import report_timezone

log = logging.getLogger(__name__)

__all__ = [
    "CLOSED_COUNTED",
    "FLAG_ADJUSTED",
    "FLAG_MANUAL",
    "FLAG_OPEN",
    "FLAG_OVERLAP",
    "FLAG_OVER_10",
    "FLAG_OVER_16",
    "MAX_ENTRIES",
    "STATUS_LABELS",
    "DayRow",
    "EntryRow",
    "JobTotal",
    "PersonTotal",
    "TimesheetData",
    "TimesheetFilters",
    "TimesheetTooLarge",
    "day_rows",
    "flags_for",
    "gather",
    "rollups",
]

MAX_ENTRIES = 20_000

FLAG_ADJUSTED = "Adjusted"
FLAG_MANUAL = "Manual entry"
FLAG_OVER_10 = "Over 10 h"
FLAG_OVER_16 = "Over 16 h"
FLAG_OVERLAP = "Overlap"
FLAG_OPEN = "Still clocked in"

# The spec's order; day rows list the union of their entries' flags in it.
_FLAG_ORDER = (FLAG_ADJUSTED, FLAG_MANUAL, FLAG_OVER_10, FLAG_OVER_16,
               FLAG_OVERLAP, FLAG_OPEN)

# Only closed approved and pending entries add to totals.
CLOSED_COUNTED = ("approved", "pending")

_OVER_10_MINUTES = 600
_OVER_16_MINUTES = 960

# The spec's day-status labels, by entry status key.
STATUS_LABELS = {
    "approved": "Approved",
    "pending": "Pending",
    "rejected": "Rejected",
    "open": "On the clock",
}
_MIXED = "Mixed"
_NO_JOB = "No job"


class TimesheetTooLarge(Exception):
    """More matching entries than the report will carry."""

    code = "too_many_entries"


@dataclass(frozen=True)
class TimesheetFilters:
    from_day: date
    to_day: date
    person_id: uuid.UUID | None
    initiative_id: uuid.UUID | None
    site_id: uuid.UUID | None
    statuses: tuple[str, ...]


@dataclass
class EntryRow:
    id: uuid.UUID
    person_id: uuid.UUID
    person_name: str
    initiative_id: uuid.UUID | None
    job_name: str | None
    site_name: str | None
    tz_name: str
    local_day: date
    clock_in: datetime            # aware, in the entry's local zone
    clock_out: datetime | None    # aware, local; None while open
    break_minutes: int
    worked_minutes: int
    status: str
    status_label: str
    source: str
    approved_by_name: str | None
    adjusted: bool
    adjust_reason: str | None
    notes: str | None
    flags: list[str] = field(default_factory=list)


@dataclass
class DayRow:
    day: date
    person_id: uuid.UUID
    person_name: str
    entries: int
    first_in: datetime
    last_out: datetime | None     # None while any of the day's entries is open
    worked_minutes: int
    status_label: str
    flags: list[str]


@dataclass
class PersonTotal:
    person_id: uuid.UUID
    person_name: str
    days: int
    entries: int
    approved_minutes: int
    pending_minutes: int
    flagged: int

    @property
    def total_minutes(self) -> int:
        return self.approved_minutes + self.pending_minutes


@dataclass
class JobTotal:
    initiative_id: uuid.UUID | None
    job_name: str
    people: int
    entries: int
    approved_minutes: int
    pending_minutes: int

    @property
    def total_minutes(self) -> int:
        return self.approved_minutes + self.pending_minutes


@dataclass
class TimesheetData:
    filters: TimesheetFilters
    person_label: str
    job_label: str
    site_label: str
    entries: list[EntryRow]
    days: list[DayRow]
    by_person: list[PersonTotal]
    by_job: list[JobTotal]
    approved_minutes: int
    pending_minutes: int
    people: int
    day_count: int
    flagged_entries: int
    default_tz: str


# ---------------------------------------------------------------- pure helpers

def _sort_key(e: EntryRow):
    return (e.local_day, natural_key(e.person_name), str(e.person_id), e.clock_in)


def flags_for(entries: list[EntryRow], now: datetime) -> None:
    """Fill each entry's `.flags` in place, in the spec's order.

    Overlap is judged per person over the entries given: sorted by clock-in,
    an entry overlaps when it starts before the latest end seen so far
    (an open entry ends `now`). Both entries of a pair are flagged: the
    later one and the earlier one holding that latest end. Touching spans
    (out == next in) do not overlap."""
    overlapping: set[int] = set()   # indexes into `entries`
    by_person: dict[uuid.UUID, list[int]] = {}
    for i, e in enumerate(entries):
        by_person.setdefault(e.person_id, []).append(i)
    for idxs in by_person.values():
        latest_end: datetime | None = None
        holder: int | None = None
        for i in sorted(idxs, key=lambda k: entries[k].clock_in):
            e = entries[i]
            if latest_end is not None and e.clock_in < latest_end:
                overlapping.add(i)
                overlapping.add(holder)
            end = e.clock_out if e.clock_out is not None else now
            if latest_end is None or end > latest_end:
                latest_end, holder = end, i

    for i, e in enumerate(entries):
        flags: list[str] = []
        if e.adjusted:
            flags.append(FLAG_ADJUSTED)
        if e.source == "manual":
            flags.append(FLAG_MANUAL)
        if e.worked_minutes >= _OVER_16_MINUTES:
            flags.append(FLAG_OVER_16)
        elif e.worked_minutes >= _OVER_10_MINUTES:
            flags.append(FLAG_OVER_10)
        if i in overlapping:
            flags.append(FLAG_OVERLAP)
        if e.status == "open":
            flags.append(FLAG_OPEN)
        e.flags = flags


def day_rows(entries: list[EntryRow]) -> list[DayRow]:
    """One row per person per local day, sorted by date, person (natural),
    first clock-in."""
    groups: dict[tuple[date, uuid.UUID], list[EntryRow]] = {}
    for e in entries:
        groups.setdefault((e.local_day, e.person_id), []).append(e)
    rows: list[DayRow] = []
    for (day, person_id), group in groups.items():
        group.sort(key=lambda r: r.clock_in)
        statuses = {e.status for e in group}
        if len(statuses) == 1:
            status = next(iter(statuses))
            label = STATUS_LABELS.get(status, status)
        else:
            label = _MIXED
        any_open = any(e.status == "open" for e in group)
        union = {f for e in group for f in e.flags}
        rows.append(DayRow(
            day=day, person_id=person_id, person_name=group[0].person_name,
            entries=len(group), first_in=group[0].clock_in,
            last_out=None if any_open else max(e.clock_out for e in group),
            worked_minutes=sum(e.worked_minutes for e in group),
            status_label=label,
            flags=[f for f in _FLAG_ORDER if f in union]))
    rows.sort(key=lambda r: (r.day, natural_key(r.person_name),
                             str(r.person_id), r.first_in))
    return rows


def rollups(entries: list[EntryRow]) -> tuple[
        list[PersonTotal], list[JobTotal], int, int]:
    """Per-person and per-job totals plus overall approved / pending minutes.

    Every entry counts toward `entries` (and `flagged`); only closed
    approved and pending entries add minutes. Rejected and open entries
    never do."""
    people: dict[uuid.UUID, PersonTotal] = {}
    person_days: dict[uuid.UUID, set[date]] = {}
    jobs: dict[uuid.UUID | None, JobTotal] = {}
    job_people: dict[uuid.UUID | None, set[uuid.UUID]] = {}
    approved = pending = 0

    for e in entries:
        p = people.get(e.person_id)
        if p is None:
            p = people[e.person_id] = PersonTotal(
                e.person_id, e.person_name, 0, 0, 0, 0, 0)
            person_days[e.person_id] = set()
        j = jobs.get(e.initiative_id)
        if j is None:
            j = jobs[e.initiative_id] = JobTotal(
                e.initiative_id, e.job_name or _NO_JOB, 0, 0, 0, 0)
            job_people[e.initiative_id] = set()
        person_days[e.person_id].add(e.local_day)
        job_people[e.initiative_id].add(e.person_id)
        p.entries += 1
        j.entries += 1
        if e.flags:
            p.flagged += 1
        if e.status in CLOSED_COUNTED:
            if e.status == "approved":
                p.approved_minutes += e.worked_minutes
                j.approved_minutes += e.worked_minutes
                approved += e.worked_minutes
            else:
                p.pending_minutes += e.worked_minutes
                j.pending_minutes += e.worked_minutes
                pending += e.worked_minutes

    for pid, p in people.items():
        p.days = len(person_days[pid])
    for jid, j in jobs.items():
        j.people = len(job_people[jid])

    by_person = sorted(people.values(),
                       key=lambda p: (natural_key(p.person_name), str(p.person_id)))
    # "No job" always last; named jobs in natural order.
    by_job = sorted(jobs.values(),
                    key=lambda j: (j.initiative_id is None,
                                   natural_key(j.job_name), str(j.initiative_id)))
    return by_person, by_job, approved, pending


# ------------------------------------------------------------------ DB reading

def _zone(name: str | None, default: ZoneInfo,
          cache: dict[str, ZoneInfo]) -> ZoneInfo:
    """A site's zone, or the report default when it has none or the stored
    name is not a valid IANA zone (warned about once per name per gather)."""
    if not name:
        return default
    zone = cache.get(name)
    if zone is None:
        try:
            zone = ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            log.warning("timesheet: site time zone %r is not a valid IANA "
                        "zone; using %s", name, default.key)
            zone = default
        cache[name] = zone
    return zone


def _window(f: TimesheetFilters) -> tuple[datetime, datetime]:
    """UTC window on clock_in_at wide enough to cover every local day in
    range for any zone (UTC-12 .. UTC+14)."""
    start = datetime.combine(f.from_day, time.min, tzinfo=UTC) - timedelta(days=1)
    end = datetime.combine(f.to_day, time.min, tzinfo=UTC) + timedelta(days=2)
    return start, end


async def gather(db: AsyncSession, filters: TimesheetFilters, *,
                 now: datetime | None = None,
                 limit: int | None = None) -> TimesheetData:
    now = now or datetime.now(UTC)
    limit = MAX_ENTRIES if limit is None else limit     # read at call time
    start, end = _window(filters)

    conds = [TimeEntry.clock_in_at >= start, TimeEntry.clock_in_at < end,
             TimeEntry.status.in_(filters.statuses)]
    if filters.person_id is not None:
        conds.append(TimeEntry.person_id == filters.person_id)
    if filters.initiative_id is not None:
        conds.append(TimeEntry.initiative_id == filters.initiative_id)
    if filters.site_id is not None:
        conds.append(TimeEntry.site_id == filters.site_id)

    # Counted over the padded UTC window, before local-day trimming, so
    # boundary entries outside [from, to] may count toward the limit.
    total = await db.scalar(select(func.count()).select_from(TimeEntry).where(*conds))
    if (total or 0) > limit:
        raise TimesheetTooLarge(f"{total} entries match; the limit is {limit}")

    rows = (await db.execute(
        select(TimeEntry, Site.timezone, Site.name, Initiative.name)
        .outerjoin(Site, Site.id == TimeEntry.site_id)
        .outerjoin(Initiative, Initiative.id == TimeEntry.initiative_id)
        .where(*conds).order_by(TimeEntry.clock_in_at))).all()

    person_ids = {e.person_id for e, *_ in rows} | {
        e.approved_by for e, *_ in rows if e.approved_by}
    names: dict[uuid.UUID, str] = {}
    if person_ids:
        names = {p.id: p.display_name for p in await db.scalars(
            select(Person).where(Person.id.in_(person_ids)))}
    vocab = {s.key: s.label for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "time_entry"))}

    default = report_timezone()
    cache: dict[str, ZoneInfo] = {}
    entries: list[EntryRow] = []
    for e, site_tz, site_name, job_name in rows:
        zone = _zone(site_tz, default, cache)
        clock_in = e.clock_in_at.astimezone(zone)
        local_day = clock_in.date()
        if not (filters.from_day <= local_day <= filters.to_day):
            continue
        entries.append(EntryRow(
            id=e.id, person_id=e.person_id,
            person_name=names.get(e.person_id, ""),
            initiative_id=e.initiative_id, job_name=job_name,
            site_name=site_name, tz_name=zone.key, local_day=local_day,
            clock_in=clock_in,
            clock_out=(e.clock_out_at.astimezone(zone)
                       if e.clock_out_at is not None else None),
            break_minutes=e.break_minutes, worked_minutes=worked_minutes(e),
            status=e.status, status_label=vocab.get(e.status, e.status),
            source=e.source,
            approved_by_name=names.get(e.approved_by) if e.approved_by else None,
            adjusted=bool(e.adjusted), adjust_reason=e.adjust_reason,
            notes=e.notes or None))

    entries.sort(key=_sort_key)
    flags_for(entries, now)
    days = day_rows(entries)
    by_person, by_job, approved, pending = rollups(entries)

    return TimesheetData(
        filters=filters,
        person_label=await _label(db, Person, filters.person_id, "Everyone",
                                  "Unknown person"),
        job_label=await _label(db, Initiative, filters.initiative_id,
                               "All jobs", "Unknown job"),
        site_label=await _label(db, Site, filters.site_id, "All sites",
                                "Unknown site"),
        entries=entries, days=days, by_person=by_person, by_job=by_job,
        approved_minutes=approved, pending_minutes=pending,
        people=len(by_person), day_count=len({d.day for d in days}),
        flagged_entries=sum(1 for e in entries if e.flags),
        default_tz=default.key)


async def _label(db: AsyncSession, model, key: uuid.UUID | None,
                 unfiltered: str, missing: str) -> str:
    if key is None:
        return unfiltered
    row = await db.get(model, key)
    if row is None:
        return missing
    return row.display_name if model is Person else row.name
