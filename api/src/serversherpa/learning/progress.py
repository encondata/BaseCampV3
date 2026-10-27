"""An initiative's learning at a glance, for its Learning tab: the worker
roster (progress and status per person), the stat tiles, what the move
requires (packets from rules, extras), and the schedule's mini timeline.

Roster status, first match wins: `complete` (nothing open), `overdue` (an
open item's due date is before the initiative's local today), `in_progress`
(something opened or signed), `no_email`, `not_opened`. Cancelled
assignments (the person left and came back) are ignored. Read-only."""
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Initiative,
    InitiativePerson,
    Partner,
    Person,
    UserAccount,
    WorkerProfile,
)
from serversherpa.db.ordering import natural
from serversherpa.learning import codes, emails
from serversherpa.learning.assign import OPEN_STATUSES, _end_day
from serversherpa.learning.invites import schedule_for, send_at
from serversherpa.learning.models import (
    LearningAssignment,
    LearningDocument,
    LearningEmailLog,
    LearningInviteSchedule,
    LearningPacket,
    LearningPacketItem,
    LearningRule,
    LearningSignoff,
)
from serversherpa.services.timezone import stored_day

STATUSES = ("complete", "in_progress", "overdue", "not_opened", "no_email")


@dataclass
class RosterRow:
    person_id: uuid.UUID
    name: str
    email: str | None
    partner: str | None
    language: str
    done: int = 0
    total: int = 0
    status: str = "not_opened"
    last_activity: datetime | None = None
    opened: bool = False
    assignments: list = field(default_factory=list, repr=False)

    def out(self) -> dict:
        return {k: getattr(self, k) for k in (
            "person_id", "name", "email", "partner", "language", "done", "total", "status",
            "last_activity")}


async def local_today(db: AsyncSession, initiative: Initiative, now: datetime) -> date:
    return now.astimezone(await codes.initiative_zone(db, initiative)).date()


async def roster(db: AsyncSession, initiative: Initiative, *, now: datetime) -> list[RosterRow]:
    """One row per person on the initiative, by name."""
    people = (await db.execute(
        select(Person, Partner.name, *emails.ADDRESS_COLUMNS)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .outerjoin(WorkerProfile, WorkerProfile.person_id == Person.id)
        .outerjoin(Partner, Partner.id == WorkerProfile.partner_id)
        .where(Person.id.in_(select(InitiativePerson.person_id).where(
            InitiativePerson.initiative_id == initiative.id)))
        .order_by(natural(Person.last_name), natural(Person.first_name), Person.id))).all()
    ids = [p.id for p, *_ in people]
    if not ids:
        return []
    languages: dict[uuid.UUID, str] = {}
    for person_id, lang in (await db.execute(
        select(LearningSignoff.person_id, LearningSignoff.language)
        .where(LearningSignoff.person_id.in_(ids))
        .order_by(LearningSignoff.person_id, LearningSignoff.signed_at.desc(),
                  LearningSignoff.created_at.desc())
        .distinct(LearningSignoff.person_id))).all():
        languages[person_id] = lang
    # the address a send would use (none for a disabled account), so the
    # roster's "no email" matches the send counts
    rows = {p.id: RosterRow(person_id=p.id, name=p.display_name,
                            email=emails.listed_address(*address), partner=partner,
                            language=languages.get(p.id, "en"))
            for p, partner, *address in people}
    for a in await db.scalars(
        select(LearningAssignment).where(LearningAssignment.initiative_id == initiative.id,
                                         LearningAssignment.person_id.in_(ids),
                                         LearningAssignment.status != "cancelled")):
        rows[a.person_id].assignments.append(a)

    today = await local_today(db, initiative, now)
    for row in rows.values():
        items = row.assignments
        row.total = len(items)
        row.done = sum(1 for a in items if a.status == "signed")
        stamps = [t for a in items for t in (a.opened_at, a.signed_at) if t is not None]
        row.last_activity = max(stamps) if stamps else None
        row.opened = bool(stamps)
        open_items = [a for a in items if a.status in OPEN_STATUSES]
        if not open_items:
            row.status = "complete"
        elif any(a.due_on is not None and a.due_on < today for a in open_items):
            row.status = "overdue"
        elif row.opened:
            row.status = "in_progress"
        elif not row.email:
            row.status = "no_email"
        else:
            row.status = "not_opened"
    return list(rows.values())


async def stats(db: AsyncSession, initiative: Initiative, rows: list[RosterRow]) -> dict:
    invited = set(await db.scalars(
        select(LearningEmailLog.person_id).where(LearningEmailLog.kind == "invite",
                                                 LearningEmailLog.initiative_id == initiative.id)))
    out = {"invited": sum(1 for r in rows if r.person_id in invited),
           "opened": sum(1 for r in rows if r.opened)}
    for status in ("in_progress", "complete", "overdue"):
        out[status] = sum(1 for r in rows if r.status == status)
    return out


async def requirements(db: AsyncSession, initiative_id: uuid.UUID) -> tuple[list, list]:
    """(packets, extras): the packets rules assigned on this initiative, with
    the first rule that did and whether any of their documents is re-signed
    every initiative; and the manually assigned documents with how many
    people have them."""
    live = (LearningAssignment.initiative_id == initiative_id,
            LearningAssignment.status != "cancelled")
    packet_rules: dict[uuid.UUID, uuid.UUID | None] = {}
    for packet_id, rule_id in (await db.execute(
        select(LearningAssignment.packet_id, LearningAssignment.rule_id)
        .where(*live, LearningAssignment.source == "rule",
               LearningAssignment.packet_id.is_not(None))
        .order_by(LearningAssignment.created_at))).all():
        if packet_rules.get(packet_id) is None:
            packet_rules[packet_id] = rule_id
    packets = []
    if packet_rules:
        found = {p.id: p for p in await db.scalars(
            select(LearningPacket).where(LearningPacket.id.in_(packet_rules)))}
        rule_names = dict((await db.execute(select(LearningRule.id, LearningRule.name).where(
            LearningRule.id.in_({r for r in packet_rules.values() if r})))).all())
        docs: dict[uuid.UUID, list[LearningDocument]] = defaultdict(list)
        for packet_id, doc in (await db.execute(
            select(LearningPacketItem.packet_id, LearningDocument)
            .join(LearningDocument, LearningDocument.id == LearningPacketItem.document_id)
            .where(LearningPacketItem.packet_id.in_(packet_rules))
            .order_by(LearningPacketItem.position, LearningPacketItem.created_at))).all():
            docs[packet_id].append(doc)
        for packet_id, rule_id in packet_rules.items():
            packet = found.get(packet_id)
            if packet is None:
                continue
            packets.append({
                "packet": {"id": packet.id, "name": packet.name,
                           "documents": [d.title for d in docs[packet_id]]},
                "rule_name": rule_names.get(rule_id),
                "every_initiative": any(d.resign_rule == "every_initiative"
                                        for d in docs[packet_id])})
    extras = [{"title": title, "people": people} for title, people in (await db.execute(
        select(LearningDocument.title,
               func.count(distinct(LearningAssignment.person_id)))
        .join(LearningAssignment, LearningAssignment.document_id == LearningDocument.id)
        .where(*live, LearningAssignment.source == "manual")
        .group_by(LearningDocument.id, LearningDocument.title)
        .order_by(natural(LearningDocument.title)))).all()]
    return packets, extras


async def timeline(db: AsyncSession, initiative: Initiative,
                   schedule: LearningInviteSchedule) -> list[dict]:
    """The mini timeline: invite, each reminder, due, start, by date."""
    if initiative.scheduled_start is None:
        if schedule.sent_at is None:
            return []
        zone = await codes.initiative_zone(db, initiative)
        return [{"date": schedule.sent_at.astimezone(zone).date(), "kind": "invite"}]
    start = stored_day(initiative.scheduled_start)
    if schedule.sent_at is not None:
        zone = await codes.initiative_zone(db, initiative)
        invite_day = schedule.sent_at.astimezone(zone).date()
    else:
        invite_day = start - timedelta(days=schedule.send_offset_days)
    events = [(invite_day, 0, "invite")]
    events += [(start - timedelta(days=o), 1, "reminder")
               for o in sorted(schedule.reminder_offsets or [], reverse=True)]
    events.append((start - timedelta(days=schedule.due_offset_days), 2, "due"))
    events.append((start, 3, "start"))
    return [{"date": day, "kind": kind} for day, _, kind in sorted(events)]


async def schedule_out(db: AsyncSession, initiative: Initiative,
                       schedule: LearningInviteSchedule | None = None) -> dict:
    schedule = schedule or await schedule_for(db, initiative.id)
    end = _end_day(initiative)
    return {
        "mode": schedule.mode, "send_offset_days": schedule.send_offset_days,
        "send_time": schedule.send_time.strftime("%H:%M"),
        "reminder_offsets": list(schedule.reminder_offsets or []),
        "due_offset_days": schedule.due_offset_days, "late_adds": schedule.late_adds,
        "sent_at": schedule.sent_at,
        "send_at": await send_at(db, initiative, schedule),
        "codes_expire_on": end,
        "is_default": await db.get(LearningInviteSchedule, initiative.id) is None,
    }


async def summary(db: AsyncSession, initiative: Initiative, *, now: datetime) -> dict:
    rows = await roster(db, initiative, now=now)
    schedule = await schedule_for(db, initiative.id)
    packets, extras = await requirements(db, initiative.id)
    return {"stats": await stats(db, initiative, rows),
            "schedule": await schedule_out(db, initiative, schedule),
            "packets": packets, "extras": extras,
            "timeline": await timeline(db, initiative, schedule)}
