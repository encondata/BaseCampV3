"""Invites: the per-initiative schedule (manual or a scheduled send, the
reminder days, the due offset, late adds), sending invites now or on
schedule, late adds, resend / regenerate / revoke, and the printable code
sheet for people without email.

An invite is always a fresh code: the raw code is never stored, so it can
only be emailed (or printed) the moment it is issued, and issuing revokes
the person's previous code for that initiative.

A schedule row is created the first time someone saves it or invites go
out; until then the learning settings' defaults apply (`schedule_for`).
Nothing here commits."""
import uuid
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, InitiativePerson, Person
from serversherpa.db.ordering import natural
from serversherpa.learning import codes, emails
from serversherpa.learning.assign import OPEN_STATUSES
from serversherpa.learning.models import (
    LearningAssignment,
    LearningCode,
    LearningEmailLog,
    LearningInviteSchedule,
    LearningPacket,
)
from serversherpa.learning.settings import load_settings
from serversherpa.services.audit import audit
from serversherpa.services.timezone import stored_day

SCHEDULE_FIELDS = ("mode", "send_offset_days", "send_time", "reminder_offsets",
                   "due_offset_days", "late_adds")

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"),
                   autoescape=select_autoescape(["html"]), trim_blocks=True,
                   lstrip_blocks=True)


def _now() -> datetime:
    return datetime.now(UTC)


def parse_hhmm(value: str) -> time:
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


# ── the schedule ─────────────────────────────────────────────────────


async def default_schedule(db: AsyncSession,
                           initiative_id: uuid.UUID) -> LearningInviteSchedule:
    """An unsaved schedule holding the learning settings' defaults."""
    s = await load_settings(db)
    return LearningInviteSchedule(
        initiative_id=initiative_id, mode="manual", send_offset_days=s.invite_offset_days,
        send_time=parse_hhmm(s.invite_time), reminder_offsets=list(s.reminder_offsets),
        due_offset_days=s.due_offset_days, late_adds=True, sent_at=None)


async def schedule_for(db: AsyncSession, initiative_id: uuid.UUID, *,
                       create: bool = False) -> LearningInviteSchedule:
    """The initiative's schedule row; with no row, the defaults (unsaved),
    or with `create` a new row holding them. A concurrent create is
    absorbed (ON CONFLICT DO NOTHING)."""
    row = await db.get(LearningInviteSchedule, initiative_id)
    if row is not None:
        return row
    defaults = await default_schedule(db, initiative_id)
    if not create:
        return defaults
    await db.execute(
        pg_insert(LearningInviteSchedule)
        .values(**{f: getattr(defaults, f) for f in ("initiative_id", *SCHEDULE_FIELDS)})
        .on_conflict_do_nothing())
    return await db.get(LearningInviteSchedule, initiative_id)


def local_at(day, at: time, zone: ZoneInfo) -> datetime:
    return datetime.combine(day, at, tzinfo=zone)


async def send_at(db: AsyncSession, initiative: Initiative,
                  schedule: LearningInviteSchedule) -> datetime | None:
    """When a scheduled send goes out: `send_offset_days` before the start,
    at `send_time` in the initiative's zone (its site's, else UTC)."""
    if initiative.scheduled_start is None:
        return None
    zone = await codes.initiative_zone(db, initiative)
    day = stored_day(initiative.scheduled_start) - timedelta(days=schedule.send_offset_days)
    return local_at(day, schedule.send_time, zone)


async def send_markers(db: AsyncSession,
                       initiatives: list[Initiative]) -> dict[uuid.UUID, datetime | None]:
    """For the initiatives timeline: when each initiative's invites went
    out, or when its scheduled send will; None for a manual schedule that
    hasn't sent (or no schedule). Two or three queries for any number."""
    ids = [i.id for i in initiatives]
    schedules = {s.initiative_id: s for s in await db.scalars(
        select(LearningInviteSchedule).where(LearningInviteSchedule.initiative_id.in_(ids)))
                 } if ids else {}
    pending = [i for i in initiatives if i.id in schedules and i.scheduled_start is not None
               and schedules[i.id].sent_at is None and schedules[i.id].mode == "scheduled"]
    zones = await codes.initiative_zones(db, pending)
    out: dict[uuid.UUID, datetime | None] = {}
    for i in initiatives:
        schedule = schedules.get(i.id)
        if schedule is not None and schedule.sent_at is not None:
            out[i.id] = schedule.sent_at
        elif i.id in zones:
            day = stored_day(i.scheduled_start) - timedelta(days=schedule.send_offset_days)
            out[i.id] = local_at(day, schedule.send_time, zones[i.id])
        else:
            out[i.id] = None
    return out


async def save_schedule(db: AsyncSession, initiative: Initiative, changes: dict, *,
                        actor_id: uuid.UUID | None) -> LearningInviteSchedule:
    """Apply a partial update (already validated). A new due offset moves the
    due date of open assignments that follow the schedule (no packet offset
    of their own)."""
    row = await schedule_for(db, initiative.id, create=True)
    before = {f: getattr(row, f) for f in SCHEDULE_FIELDS}
    for key, value in changes.items():
        setattr(row, key, value)
    row.updated_by = actor_id
    row.updated_at = _now()
    if ("due_offset_days" in changes and changes["due_offset_days"] != before["due_offset_days"]
            and initiative.scheduled_start is not None):
        due = stored_day(initiative.scheduled_start) - timedelta(days=row.due_offset_days)
        own_offset = select(LearningPacket.id).where(LearningPacket.due_offset_days.is_not(None))
        await db.execute(
            update(LearningAssignment)
            .where(LearningAssignment.initiative_id == initiative.id,
                   LearningAssignment.status.in_(OPEN_STATUSES),
                   (LearningAssignment.packet_id.is_(None))
                   | (LearningAssignment.packet_id.not_in(own_offset)))
            .values(due_on=due))
    after = {f: getattr(row, f) for f in SCHEDULE_FIELDS}
    diff = {k: {"from": str(before[k]), "to": str(after[k])}
            for k in SCHEDULE_FIELDS if before[k] != after[k]}
    if diff:
        audit(db, actor_id=actor_id, entity_type="learning_invite_schedule",
              entity_id=str(initiative.id), action="update", changes=diff)
    await db.flush()
    return row


# ── sending ──────────────────────────────────────────────────────────


async def open_people(db: AsyncSession, initiative_id: uuid.UUID) -> list[uuid.UUID]:
    """People with open assignments on the initiative, by name."""
    return list(await db.scalars(
        select(Person.id)
        .where(Person.id.in_(select(LearningAssignment.person_id).where(
            LearningAssignment.initiative_id == initiative_id,
            LearningAssignment.status.in_(OPEN_STATUSES))))
        .order_by(natural(Person.last_name), natural(Person.first_name), Person.id)))


async def due_on(db: AsyncSession, person_id: uuid.UUID, initiative_id: uuid.UUID):
    """The earliest due date among the person's open assignments."""
    return await db.scalar(
        select(func.min(LearningAssignment.due_on))
        .where(LearningAssignment.person_id == person_id,
               LearningAssignment.initiative_id == initiative_id,
               LearningAssignment.status.in_(OPEN_STATUSES)))


async def send_invite_for(db: AsyncSession, person_id: uuid.UUID, initiative_id: uuid.UUID,
                          actor_id: uuid.UUID | None) -> bool:
    """Issue the person a new code for the initiative (revoking the last one)
    and email it. False, with no code issued, when they have no email: the
    code sheet is how they get one."""
    person = await db.get(Person, person_id)
    if person is None or not await emails.address_for(db, person_id):
        return False
    initiative = await db.get(Initiative, initiative_id)
    row, code, token = await codes.issue(db, person_id, initiative_id, actor_id=actor_id)
    mail = await emails.send_invite(db, person, row, code, token, initiative,
                                    await due_on(db, person_id, initiative_id))
    return mail is not None


async def invited_people(db: AsyncSession, initiative_id: uuid.UUID) -> set[uuid.UUID]:
    """People holding a working code for the initiative (not revoked, not
    expired) that an invite email went out for."""
    now = _now()
    return set(await db.scalars(
        select(LearningCode.person_id)
        .where(LearningCode.initiative_id == initiative_id, LearningCode.revoked_at.is_(None),
               (LearningCode.expires_at.is_(None)) | (LearningCode.expires_at > now),
               select(LearningEmailLog.id)
               .where(LearningEmailLog.kind == "invite",
                      LearningEmailLog.code_id == LearningCode.id)
               .exists())))


async def lock_schedule(db: AsyncSession, initiative_id: uuid.UUID) -> LearningInviteSchedule:
    """The schedule row (created if missing), locked FOR UPDATE until the
    transaction ends: a manual Send now and the scheduled send serialize."""
    await schedule_for(db, initiative_id, create=True)
    return await db.scalar(
        select(LearningInviteSchedule)
        .where(LearningInviteSchedule.initiative_id == initiative_id)
        .with_for_update()
        .execution_options(populate_existing=True))


async def send_initiative(db: AsyncSession, initiative_id: uuid.UUID,
                          actor_id: uuid.UUID | None, *,
                          person_ids: list[uuid.UUID] | None = None) -> dict:
    """Send invites now. The full send (Send now, and the scheduled send)
    covers everyone with open assignments who hasn't been invited yet:
    someone already holding a working, emailed code keeps it (and their learn
    session) and counts as `already_invited`. It locks the schedule row and
    stamps its `sent_at` the first time (from then on, late adds are invited
    as they join).

    `person_ids` is Resend: those people get a fresh code whatever they
    hold, and `sent_at` isn't touched. A listed person with nothing open is
    `skipped_complete`."""
    counts = {"sent": 0, "no_email": 0, "skipped_complete": 0, "already_invited": 0}
    schedule = await lock_schedule(db, initiative_id) if person_ids is None else None
    open_ids = await open_people(db, initiative_id)
    if person_ids is None:
        invited = await invited_people(db, initiative_id)
        targets = [p for p in open_ids if p not in invited]
        counts["already_invited"] = len(open_ids) - len(targets)
    else:
        targets = list(dict.fromkeys(person_ids))
    open_set = set(open_ids)
    for person_id in targets:
        if person_id not in open_set:
            counts["skipped_complete"] += 1
        elif await send_invite_for(db, person_id, initiative_id, actor_id):
            counts["sent"] += 1
        else:
            counts["no_email"] += 1
    if schedule is not None and schedule.sent_at is None:
        schedule.sent_at = _now()
        schedule.sent_by = actor_id
    audit(db, actor_id=actor_id, entity_type="learning_invite", entity_id=str(initiative_id),
          action="learning_invites_send",
          changes={**counts, "resend": person_ids is not None})
    await db.flush()
    return counts


async def revoke_person(db: AsyncSession, initiative_id: uuid.UUID, person_id: uuid.UUID, *,
                        actor_id: uuid.UUID | None) -> int:
    """Revoke the person's codes (and their links and learn sessions) for the
    initiative. Returns how many were active."""
    ids = list(await db.scalars(select(LearningCode.id).where(
        LearningCode.person_id == person_id, LearningCode.initiative_id == initiative_id,
        LearningCode.revoked_at.is_(None))))
    for code_id in ids:
        await codes.revoke(db, code_id, actor_id=actor_id)
    return len(ids)


async def on_initiative(db: AsyncSession, initiative_id: uuid.UUID,
                        person_id: uuid.UUID) -> bool:
    return await db.scalar(select(InitiativePerson.id).where(
        InitiativePerson.initiative_id == initiative_id,
        InitiativePerson.person_id == person_id).limit(1)) is not None


# ── the code sheet ───────────────────────────────────────────────────


async def issue_sheet_codes(db: AsyncSession, initiative_id: uuid.UUID, *,
                            everyone: bool, actor_id: uuid.UUID | None
                            ) -> list[tuple[str, str]]:
    """(name, code) for each person with open assignments and no email (or
    everyone with open assignments), each a fresh code — which revokes the
    one before it."""
    rows = []
    for person_id in await open_people(db, initiative_id):
        if not everyone and await emails.address_for(db, person_id):
            continue
        person = await db.get(Person, person_id)
        _, code, _ = await codes.issue(db, person_id, initiative_id, actor_id=actor_id)
        rows.append((person.display_name, code))
    return rows


def code_sheet_html(initiative_name: str, rows: list[tuple[str, str]], *,
                    learn_origin: str, generated_at: datetime | None = None) -> str:
    generated_at = generated_at or _now()
    return _ENV.get_template("code_sheet.html").render(
        initiative_name=initiative_name, learn_origin=learn_origin,
        rows=[{"name": name, "code": emails.spaced(code)} for name, code in rows],
        generated=f"{emails.day_text(generated_at.date())} {generated_at:%H:%M} UTC")
