"""Time — the punch clock, timesheet-approval, and per-initiative time
summary suite. Self-service endpoints (clock-in/out, /me) act strictly on
the caller's own person id and carry no resource gate; everything that
reads or edits OTHER people's entries sits behind the `time` resource."""

import uuid
from datetime import UTC, datetime, timedelta
from datetime import time as dt_time

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, CurrentUser, DbSession, require_permission
from serversherpa.api.schemas import (
    ClockInIn, ClockOutIn, PunchOption, TimeDayStat, TimeEntryCreateIn,
    TimeEntryItem, TimeEntryPatchIn, TimeEntryRejectIn, TimeMeOut,
    TimePunchOptionsOut, TimeStatsSummaryOut, TimeSummaryOut, TimeSummaryPerson,
)
from serversherpa.db.models import Initiative, Person, Site, StatusValue, TimeEntry
from serversherpa.services import timeclock
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/time", tags=["time"])

FALLBACK_COLOR = "#51606f"
# punch-options only offers initiatives someone could plausibly be
# clocking time against right now.
OPEN_INITIATIVE_STATUSES = ("planned", "scheduled", "in_progress", "on_hold")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _vocab(db: DbSession) -> dict:
    rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type == "time_entry"))).all()
    return {s.key: (s.label, s.color) for s in rows}


async def _people_names(db: DbSession, ids: set) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(
        select(Person.id, Person.first_name + " " + Person.last_name)
        .where(Person.id.in_(ids)))).all())


async def _site_names(db: DbSession, ids: set) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(ids)))).all())


async def _initiative_names(db: DbSession, ids: set) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(
        select(Initiative.id, Initiative.name)
        .where(Initiative.id.in_(ids)))).all())


# Worked minutes, net of break, 0 while still open — shared with the
# kiosk timeclock (services/timeclock.py).
_minutes = timeclock.worked_minutes


def _item(e: TimeEntry, vocab: dict, people: dict, sites: dict,
         initiatives: dict) -> TimeEntryItem:
    label, color = vocab.get(e.status, (e.status, FALLBACK_COLOR))
    return TimeEntryItem(
        id=e.id, person_id=e.person_id, person_name=people.get(e.person_id, ""),
        initiative_id=e.initiative_id,
        initiative_name=initiatives.get(e.initiative_id),
        site_id=e.site_id, site_name=sites.get(e.site_id),
        clock_in_at=e.clock_in_at, clock_out_at=e.clock_out_at,
        break_minutes=e.break_minutes, minutes=_minutes(e),
        status=e.status, status_label=label, status_color=color,
        source=e.source, notes=e.notes, adjusted=e.adjusted,
        adjust_reason=e.adjust_reason, approved_by=e.approved_by,
        approved_by_name=people.get(e.approved_by), approved_at=e.approved_at,
        reject_reason=e.reject_reason, created_at=e.created_at,
        updated_at=e.updated_at)


async def _to_item(db: DbSession, e: TimeEntry) -> TimeEntryItem:
    return (await _items(db, [e]))[0]


async def _items(db: DbSession, entries: list[TimeEntry]) -> list[TimeEntryItem]:
    vocab = await _vocab(db)
    people = await _people_names(
        db, {e.person_id for e in entries} | {e.approved_by for e in entries})
    sites = await _site_names(db, {e.site_id for e in entries})
    initiatives = await _initiative_names(db, {e.initiative_id for e in entries})
    return [_item(e, vocab, people, sites, initiatives) for e in entries]


def _can_clock(actor: AuthContext) -> bool:
    """Punch-clock gate for clock-in/clock-out. Rule: the actor may hold
    `time:view` (staff, admin, super_admin, founder, developer all do), OR
    hold the `worker` role itself — workers are the primary punch-clock
    users but the seeded `worker` role deliberately carries no `time`
    grant (it only needs to see its own records, which self-service
    already allows). Checking the role name (not the `self` scope_anchor,
    which `worker` shares with `external`) is what keeps `external` and
    every client/partner-anchored role out while every seeded
    worker/staff/admin-tier role stays in."""
    return actor.access.can("time", "view") or "worker" in actor.roles


@router.post("/clock-in", response_model=TimeEntryItem)
async def clock_in(body: ClockInIn, db: DbSession, user: CurrentUser) -> TimeEntryItem:
    if not _can_clock(user):
        raise _err(403, "forbidden")
    existing = await timeclock.open_entry_for(db, user.person.id)
    if existing is not None:
        raise _err(409, "already_clocked_in")
    if body.initiative_id is not None and \
            await db.get(Initiative, body.initiative_id) is None:
        raise _err(404, "initiative_not_found")
    if body.site_id is not None and await db.get(Site, body.site_id) is None:
        raise _err(404, "site_not_found")

    # the pre-check above is only advisory — a concurrent clock-in for the
    # same person can still race past it, so the actual guard is the
    # partial unique index (one_open_entry_per_person, migration 0028),
    # which create_open_entry turns into a clean 409 rather than an
    # unhandled IntegrityError (a 500).
    try:
        entry = await timeclock.create_open_entry(
            db, person_id=user.person.id, initiative_id=body.initiative_id,
            site_id=body.site_id, clock_in_at=datetime.now(UTC),
            notes=body.notes or "", created_by=user.person.id)
    except timeclock.AlreadyClockedIn:
        raise _err(409, "already_clocked_in") from None
    audit(db, actor_id=user.person.id, entity_type="time_entry",
          entity_id=str(entry.id), action="clock_in",
          changes={"status": {"from": None, "to": "open"}})
    await db.commit()
    return await _to_item(db, entry)


@router.post("/clock-out", response_model=TimeEntryItem)
async def clock_out(body: ClockOutIn, db: DbSession, user: CurrentUser) -> TimeEntryItem:
    if not _can_clock(user):
        raise _err(403, "forbidden")
    entry = await db.scalar(select(TimeEntry).where(
        TimeEntry.person_id == user.person.id, TimeEntry.clock_out_at.is_(None)))
    if entry is None:
        raise _err(409, "not_clocked_in")

    now = datetime.now(UTC)
    if body.break_minutes is not None:
        worked_span = int((now - entry.clock_in_at).total_seconds() // 60)
        if body.break_minutes < 0 or body.break_minutes >= worked_span:
            raise _err(422, "invalid_break")

    changes = timeclock.close_open_entry(
        entry, clock_out_at=now, now=now, break_minutes=body.break_minutes,
        notes=body.notes)
    audit(db, actor_id=user.person.id, entity_type="time_entry",
          entity_id=str(entry.id), action="clock_out", changes=changes)
    await db.commit()
    return await _to_item(db, entry)


@router.get("/me", response_model=TimeMeOut)
async def my_time(
    db: DbSession, user: CurrentUser,
    limit: int = Query(20, ge=1, le=100),
) -> TimeMeOut:
    entries = list(await db.scalars(
        select(TimeEntry).where(TimeEntry.person_id == user.person.id)
        .order_by(TimeEntry.clock_in_at.desc()).limit(limit)))
    items = await _items(db, entries)
    open_item = next((i for i in items if i.clock_out_at is None), None)
    return TimeMeOut(open=open_item, entries=items)


@router.get("/punch-options", response_model=TimePunchOptionsOut)
async def punch_options(db: DbSession, user: CurrentUser) -> TimePunchOptionsOut:
    # Sites stay internal-only (visible_to global, see access/resources.py);
    # initiatives are now client-visible for reads elsewhere, but this
    # picker still keys on is_global rather than initiatives:view/scope —
    # a client/partner-scoped actor gets empty lists here rather than a
    # roster of every open initiative/site name. Punching still works; the
    # entry is just unattributed to an initiative/site.
    if not user.access.is_global:
        return TimePunchOptionsOut(initiatives=[], sites=[])
    initiatives = list(await db.scalars(
        select(Initiative).where(
            Initiative.archived_at.is_(None),
            Initiative.status.in_(OPEN_INITIATIVE_STATUSES))
        .order_by(Initiative.name)))
    sites = list(await db.scalars(
        select(Site).where(Site.archived_at.is_(None)).order_by(Site.name)))
    return TimePunchOptionsOut(
        initiatives=[PunchOption(id=i.id, name=i.name) for i in initiatives],
        sites=[PunchOption(id=s.id, name=s.name) for s in sites])


@router.get("/entries", response_model=list[TimeEntryItem])
async def list_time_entries(
    db: DbSession,
    actor: AuthContext = require_permission("time", "view"),
    person_id: uuid.UUID | None = None,
    initiative_id: uuid.UUID | None = None,
    status: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = Query(500, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> list[TimeEntryItem]:
    query = (select(TimeEntry)
            .order_by(TimeEntry.clock_in_at.desc(), TimeEntry.id.desc())
            .offset(offset).limit(limit))
    if person_id is not None:
        query = query.where(TimeEntry.person_id == person_id)
    if initiative_id is not None:
        query = query.where(TimeEntry.initiative_id == initiative_id)
    if status is not None:
        query = query.where(TimeEntry.status == status)
    if since is not None:
        query = query.where(TimeEntry.clock_in_at >= since)
    if until is not None:
        query = query.where(TimeEntry.clock_in_at <= until)
    entries = list(await db.scalars(query))
    return await _items(db, entries)


@router.post("/entries", response_model=TimeEntryItem, status_code=201)
async def create_time_entry(
    body: TimeEntryCreateIn, db: DbSession,
    actor: AuthContext = require_permission("time", "add"),
) -> TimeEntryItem:
    if body.clock_out_at <= body.clock_in_at:
        raise _err(422, "invalid_range")
    if body.break_minutes is not None:
        worked_span = int(
            (body.clock_out_at - body.clock_in_at).total_seconds() // 60)
        if body.break_minutes < 0 or body.break_minutes >= worked_span:
            raise _err(422, "invalid_break")
    if await db.get(Person, body.person_id) is None:
        raise _err(404, "person_not_found")
    if body.initiative_id is not None and \
            await db.get(Initiative, body.initiative_id) is None:
        raise _err(404, "initiative_not_found")
    if body.site_id is not None and await db.get(Site, body.site_id) is None:
        raise _err(404, "site_not_found")

    entry = TimeEntry(
        person_id=body.person_id, initiative_id=body.initiative_id,
        site_id=body.site_id, clock_in_at=body.clock_in_at,
        clock_out_at=body.clock_out_at,
        break_minutes=body.break_minutes if body.break_minutes is not None else 0,
        status="pending", source="manual", notes=body.notes or "",
        created_by=actor.person.id)
    db.add(entry)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="time_entry",
          entity_id=str(entry.id), action="create",
          changes={"status": {"from": None, "to": "pending"}})
    await db.commit()
    return await _to_item(db, entry)


@router.patch("/entries/{entry_id}", response_model=TimeEntryItem)
async def update_time_entry(
    entry_id: uuid.UUID, body: TimeEntryPatchIn, db: DbSession,
    actor: AuthContext = require_permission("time", "change"),
) -> TimeEntryItem:
    entry = await db.get(TimeEntry, entry_id)
    if entry is None:
        raise _err(404, "time_entry_not_found")

    data = body.model_dump(exclude_unset=True)
    # Re-opening a closed entry isn't supported — a PATCH that explicitly
    # carries clock_out_at: null must be rejected rather than silently
    # nulling the column (which would collide with the one-open-entry-per-
    # person unique index, or 500, on the next clock-in).
    if "clock_out_at" in data and data["clock_out_at"] is None:
        raise _err(422, "invalid_range")

    time_fields = {"clock_in_at", "clock_out_at", "break_minutes"}
    is_adjustment = bool(time_fields & data.keys())
    if is_adjustment and not data.get("adjust_reason"):
        raise _err(422, "adjust_reason_required")

    if data.get("initiative_id") is not None and \
            await db.get(Initiative, data["initiative_id"]) is None:
        raise _err(404, "initiative_not_found")
    if data.get("site_id") is not None and \
            await db.get(Site, data["site_id"]) is None:
        raise _err(404, "site_not_found")

    new_clock_in = data.get("clock_in_at", entry.clock_in_at)
    new_clock_out = data.get("clock_out_at", entry.clock_out_at)
    if new_clock_out is not None and new_clock_in is not None \
            and new_clock_out <= new_clock_in:
        raise _err(422, "invalid_range")

    # Only re-validate the break/span relationship when the patch actually
    # touches clock_in_at/clock_out_at/break_minutes — otherwise a notes-only
    # PATCH on an entry whose existing (already-valid-at-save-time) span
    # happens to be 0 minutes would spuriously 422.
    new_break_minutes = data.get("break_minutes", entry.break_minutes)
    if is_adjustment and new_clock_out is not None and new_clock_in is not None:
        worked_span = int((new_clock_out - new_clock_in).total_seconds() // 60)
        if new_break_minutes < 0 or new_break_minutes >= worked_span:
            raise _err(422, "invalid_break")

    # Closing a still-open entry (status "open" has no clock_out_at yet)
    # via PATCH must graduate it into the pending queue — otherwise it's
    # stuck "open" forever with no way to reach approval.
    closes_open_entry = entry.status == "open" and data.get("clock_out_at") is not None

    fields = list(data.keys())
    if is_adjustment:
        fields.append("adjusted")
        if entry.status == "approved":
            fields += ["status", "approved_by", "approved_at"]
        elif closes_open_entry:
            fields.append("status")
    fields = list(dict.fromkeys(fields))

    before = snapshot(entry, fields)
    for field, value in data.items():
        setattr(entry, field, value)
    if is_adjustment:
        entry.adjusted = True
        if entry.status == "approved":
            entry.status = "pending"
            entry.approved_by = None
            entry.approved_at = None
        elif closes_open_entry:
            entry.status = "pending"
    changes = diff(before, snapshot(entry, fields))
    if changes:
        entry.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="time_entry",
              entity_id=str(entry_id), action="update", changes=changes)
    await db.commit()
    return await _to_item(db, entry)


@router.post("/entries/{entry_id}/approve", response_model=TimeEntryItem)
async def approve_time_entry(
    entry_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("time", "change"),
) -> TimeEntryItem:
    entry = await db.get(TimeEntry, entry_id)
    if entry is None:
        raise _err(404, "time_entry_not_found")
    if entry.person_id == actor.person.id:
        raise _err(403, "cannot_target_self")
    if entry.status != "pending":
        raise _err(409, "not_pending")

    fields = ["status", "approved_by", "approved_at"]
    before = snapshot(entry, fields)
    entry.status = "approved"
    entry.approved_by = actor.person.id
    entry.approved_at = datetime.now(UTC)
    entry.updated_at = entry.approved_at
    changes = diff(before, snapshot(entry, fields))
    audit(db, actor_id=actor.person.id, entity_type="time_entry",
          entity_id=str(entry_id), action="update", changes=changes)
    await db.commit()
    return await _to_item(db, entry)


@router.post("/entries/{entry_id}/reject", response_model=TimeEntryItem)
async def reject_time_entry(
    entry_id: uuid.UUID, body: TimeEntryRejectIn, db: DbSession,
    actor: AuthContext = require_permission("time", "change"),
) -> TimeEntryItem:
    entry = await db.get(TimeEntry, entry_id)
    if entry is None:
        raise _err(404, "time_entry_not_found")
    if entry.person_id == actor.person.id:
        raise _err(403, "cannot_target_self")
    if entry.status != "pending":
        raise _err(409, "not_pending")

    fields = ["status", "reject_reason"]
    before = snapshot(entry, fields)
    entry.status = "rejected"
    entry.reject_reason = body.reason
    entry.updated_at = datetime.now(UTC)
    changes = diff(before, snapshot(entry, fields))
    audit(db, actor_id=actor.person.id, entity_type="time_entry",
          entity_id=str(entry_id), action="update", changes=changes)
    await db.commit()
    return await _to_item(db, entry)


@router.get("/active", response_model=list[TimeEntryItem])
async def active_time_entries(
    db: DbSession, actor: AuthContext = require_permission("time", "view"),
) -> list[TimeEntryItem]:
    entries = list(await db.scalars(
        select(TimeEntry).where(TimeEntry.clock_out_at.is_(None))
        .order_by(TimeEntry.clock_in_at)))
    return await _items(db, entries)


@router.get("/summary", response_model=TimeSummaryOut)
async def time_summary(
    db: DbSession, initiative_id: uuid.UUID,
    actor: AuthContext = require_permission("time", "view"),
) -> TimeSummaryOut:
    query = select(Initiative).where(Initiative.id == initiative_id)
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    if (await db.execute(query)).scalar_one_or_none() is None:
        raise _err(404, "unknown_initiative")

    entries = list(await db.scalars(
        select(TimeEntry).where(TimeEntry.initiative_id == initiative_id)))
    open_count = sum(1 for e in entries if e.clock_out_at is None)
    closed = [e for e in entries if e.clock_out_at is not None]

    per_person: dict[uuid.UUID, dict] = {}
    for e in closed:
        if e.status not in ("approved", "pending"):
            continue
        agg = per_person.setdefault(e.person_id, {
            "approved_minutes": 0, "pending_minutes": 0,
            "entry_count": 0, "last_entry_at": None})
        m = _minutes(e)
        if e.status == "approved":
            agg["approved_minutes"] += m
        else:
            agg["pending_minutes"] += m
        agg["entry_count"] += 1
        if agg["last_entry_at"] is None or e.clock_out_at > agg["last_entry_at"]:
            agg["last_entry_at"] = e.clock_out_at

    people = await _people_names(db, set(per_person.keys()))
    people_out = [
        TimeSummaryPerson(
            person_id=pid, person_name=people.get(pid, ""),
            approved_minutes=agg["approved_minutes"],
            pending_minutes=agg["pending_minutes"],
            entry_count=agg["entry_count"], last_entry_at=agg["last_entry_at"])
        for pid, agg in per_person.items()
    ]
    people_out.sort(key=lambda p: p.approved_minutes + p.pending_minutes,
                    reverse=True)

    return TimeSummaryOut(
        approved_minutes=sum(p.approved_minutes for p in people_out),
        pending_minutes=sum(p.pending_minutes for p in people_out),
        open_count=open_count, people=people_out)


@router.get("/stats/summary", response_model=TimeStatsSummaryOut)
async def time_stats_summary(
    db: DbSession,
    _actor: AuthContext = require_permission("time", "view"),
    days: int = Query(14, ge=1, le=90),
) -> TimeStatsSummaryOut:
    """Dashboard aggregates: open/pending counts + worked minutes per UTC
    day, zero-filled oldest-first with today included (the
    /scans/stats/daily convention). Minutes follow _minutes(): open
    entries contribute 0; closed span minus break, clamped >= 0.
    Aggregated in Python — time_entries stays small (one row per shift).
    """
    clocked_in = (await db.execute(
        select(func.count()).select_from(TimeEntry)
        .where(TimeEntry.clock_out_at.is_(None)))).scalar_one()
    pending = (await db.execute(
        select(func.count()).select_from(TimeEntry)
        .where(TimeEntry.status == "pending"))).scalar_one()

    start_day = datetime.now(UTC).date() - timedelta(days=days - 1)
    start = datetime.combine(start_day, dt_time.min, tzinfo=UTC)
    rows = (await db.execute(select(TimeEntry).where(
        TimeEntry.clock_in_at >= start))).scalars().all()
    per_day: dict = {}
    for e in rows:
        d = e.clock_in_at.date()
        per_day[d] = per_day.get(d, 0) + _minutes(e)
    out_days = [
        TimeDayStat(day=start_day + timedelta(days=i),
                    minutes=per_day.get(start_day + timedelta(days=i), 0))
        for i in range(days)
    ]
    return TimeStatsSummaryOut(
        clocked_in=clocked_in, pending_entries=pending,
        minutes_today=out_days[-1].minutes, days=out_days)
