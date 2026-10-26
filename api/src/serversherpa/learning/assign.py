"""The learning assignment engine: which documents a person must sign, and
the assignments that say so.

A document is due on an initiative when its re-sign rule is
`every_initiative`, when the person has no valid sign-off, or when their
latest sign-off is for an older version. A sign-off is valid while
`signed_at + validity_days` is on or after the day it's checked, or, when
it was signed for the same initiative, through that initiative's end.

`plan_for` decides (rules → packets → documents, deduplicated by document:
the first rule by position keeps it), `apply_plan` writes, and the hooks
run inside the people add/remove transactions of both the single and the
bulk paths. Assignments are never edited away: removal cancels the open
ones, and a re-add plans afresh.

Services never commit."""
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, InitiativePerson, Person
from serversherpa.db.ordering import natural
from serversherpa.learning import rules
from serversherpa.learning.models import (
    LearningAssignment,
    LearningCode,
    LearningDocument,
    LearningInviteSchedule,
    LearningPacket,
    LearningPacketItem,
    LearningSignoff,
)
from serversherpa.learning.settings import load_settings
from serversherpa.services.audit import audit
from serversherpa.services.timezone import stored_day

OPEN_STATUSES = ("assigned", "opened")
# a sign-off (or initiative) with no end date
NEVER = "never"


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _now() -> datetime:
    return datetime.now(UTC)


def today() -> date:
    return _now().date()


@dataclass
class PlannedItem:
    document_id: uuid.UUID
    version_id: uuid.UUID | None          # the document's current version
    packet_id: uuid.UUID | None
    rule_id: uuid.UUID | None
    action: Literal["assign", "skip"]
    reason: str
    title: str = ""


# ── due / valid ──────────────────────────────────────────────────────


def _end_day(initiative: Initiative | None) -> date | None:
    end = (initiative.scheduled_end or initiative.real_end_at) if initiative else None
    return stored_day(end) if end is not None else None


def check_day(initiative: Initiative | None) -> date:
    """The day a sign-off must be valid on: the initiative's start when that's
    still ahead (a worker has to be covered when it begins), else today."""
    on = today()
    if initiative is not None and initiative.scheduled_start is not None:
        on = max(on, stored_day(initiative.scheduled_start))
    return on


async def _signoffs(db: AsyncSession, person_id: uuid.UUID,
                    document_ids: set[uuid.UUID]) -> dict[uuid.UUID, list[LearningSignoff]]:
    """The person's sign-offs on `document_ids` in one query, newest first
    per document."""
    if not document_ids:
        return {}
    by_doc: dict[uuid.UUID, list[LearningSignoff]] = defaultdict(list)
    for signoff in await db.scalars(
        select(LearningSignoff)
        .where(LearningSignoff.person_id == person_id,
               LearningSignoff.document_id.in_(document_ids))
        .order_by(LearningSignoff.signed_at.desc(), LearningSignoff.created_at.desc())):
        by_doc[signoff.document_id].append(signoff)
    return by_doc


def _judge(document: LearningDocument, signoffs: list[LearningSignoff], *,
           initiative_id: uuid.UUID | None, initiative: Initiative | None,
           on: date) -> tuple[bool, str]:
    """`signoff_valid` on preloaded rows: `signoffs` newest first,
    `initiative` the row for `initiative_id` (for its end day)."""
    if initiative_id is not None and any(s.initiative_id == initiative_id for s in signoffs):
        # signed for this initiative: good through its end, whatever the
        # document's own validity or a newer version say
        end = _end_day(initiative)
        if end is None:
            return True, f"valid_until:{NEVER}"
        if on <= end:
            return True, f"valid_until:{end.isoformat()}"
    if initiative_id is not None and document.resign_rule == "every_initiative":
        return False, "every_initiative"
    if not signoffs:
        return False, "never_signed"
    latest = signoffs[0]
    if document.current_version_id is not None and latest.version_id != document.current_version_id:
        return False, "new_version"
    if document.validity_days is None:
        return True, f"valid_until:{NEVER}"
    until = stored_day(latest.signed_at) + timedelta(days=document.validity_days)
    if until >= on:
        return True, f"valid_until:{until.isoformat()}"
    return False, "expired"


async def signoff_valid(db: AsyncSession, person_id: uuid.UUID, document: LearningDocument, *,
                        initiative_id: uuid.UUID | None, on: date) -> tuple[bool, str]:
    """(valid, reason) for `person_id`'s sign-off on `document`, checked on
    day `on` for `initiative_id` (None = outside an initiative). Reasons:
    `valid_until:<iso day or "never">`, `never_signed`, `expired`,
    `new_version`, `every_initiative`."""
    signoffs = (await _signoffs(db, person_id, {document.id})).get(document.id, [])
    initiative = await db.get(Initiative, initiative_id) if initiative_id else None
    return _judge(document, signoffs, initiative_id=initiative_id, initiative=initiative,
                  on=on)


async def _open_documents(db: AsyncSession, person_id: uuid.UUID,
                          initiative_id: uuid.UUID | None) -> set[uuid.UUID]:
    """Documents with an open (assigned/opened) assignment for this key; the
    partial unique index allows only one. Signed and cancelled rows don't
    count, so a new version can be required again."""
    scope = (LearningAssignment.initiative_id.is_(None) if initiative_id is None
             else LearningAssignment.initiative_id == initiative_id)
    return set(await db.scalars(
        select(LearningAssignment.document_id)
        .where(LearningAssignment.person_id == person_id, scope,
               LearningAssignment.status.in_(OPEN_STATUSES))))


def _unassignable(doc: LearningDocument) -> str | None:
    if doc.archived_at is not None:
        return "archived"
    if doc.current_version_id is None:
        return "not_published"
    return None


async def plan_for(db: AsyncSession, person_id: uuid.UUID,
                   initiative_id: uuid.UUID | None) -> list[PlannedItem]:
    """What the rules give `person_id` for `initiative_id` (None = the
    general set), one item per document in rule then packet order. Already
    assigned, archived and unpublished documents are skipped with that
    reason; the rest are judged as `signoff_valid` does, on `check_day`.
    The person's sign-offs are loaded in one query."""
    ctx = await rules.build_context(db, person_id, initiative_id)
    matched = await rules.matching_packets(db, ctx)
    if not matched:
        return []
    docs_by_packet: dict[uuid.UUID, list[LearningDocument]] = defaultdict(list)
    for packet_id, doc in (await db.execute(
        select(LearningPacketItem.packet_id, LearningDocument)
        .join(LearningDocument, LearningDocument.id == LearningPacketItem.document_id)
        .where(LearningPacketItem.packet_id.in_({p.id for _, p in matched}))
        .order_by(LearningPacketItem.position, LearningPacketItem.created_at))).all():
        docs_by_packet[packet_id].append(doc)

    initiative = await db.get(Initiative, initiative_id) if initiative_id else None
    on = check_day(initiative)
    open_docs = await _open_documents(db, person_id, initiative_id)
    signoffs = await _signoffs(db, person_id,
                               {d.id for docs in docs_by_packet.values() for d in docs})
    seen: set[uuid.UUID] = set()
    plan: list[PlannedItem] = []
    for rule, packet in matched:
        for doc in docs_by_packet[packet.id]:
            if doc.id in seen:
                continue
            seen.add(doc.id)
            reason = _unassignable(doc) or ("already_assigned" if doc.id in open_docs else None)
            if reason is None:
                valid, reason = _judge(doc, signoffs.get(doc.id, []),
                                       initiative_id=initiative_id, initiative=initiative,
                                       on=on)
                action = "skip" if valid else "assign"
            else:
                action = "skip"
            plan.append(PlannedItem(document_id=doc.id, version_id=doc.current_version_id,
                                    packet_id=packet.id, rule_id=rule.id, action=action,
                                    reason=reason, title=doc.title))
    return plan


# ── writing ──────────────────────────────────────────────────────────


class DueDates:
    """`packet_id -> due_on`: the packet's `due_offset_days`, or the
    initiative schedule's, or the settings' default, counted back from the
    initiative's start; no initiative or no start = no due date. Built once
    (`load`) per initiative and shared across people; packet offsets are
    fetched as new packets turn up (`prime`)."""

    def __init__(self, start: date | None, default: int) -> None:
        self.start, self.default = start, default
        self.offsets: dict[uuid.UUID, int | None] = {}

    @classmethod
    async def load(cls, db: AsyncSession, initiative_id: uuid.UUID | None) -> "DueDates":
        initiative = await db.get(Initiative, initiative_id) if initiative_id else None
        if initiative is None or initiative.scheduled_start is None:
            return cls(None, 0)
        schedule = await db.get(LearningInviteSchedule, initiative_id)
        default = (schedule.due_offset_days if schedule is not None
                   else (await load_settings(db)).due_offset_days)
        return cls(stored_day(initiative.scheduled_start), default)

    async def prime(self, db: AsyncSession, packet_ids: set[uuid.UUID]) -> None:
        missing = packet_ids - self.offsets.keys()
        if self.start is not None and missing:
            self.offsets.update((await db.execute(
                select(LearningPacket.id, LearningPacket.due_offset_days)
                .where(LearningPacket.id.in_(missing)))).all())

    def __call__(self, packet_id: uuid.UUID | None) -> date | None:
        if self.start is None:
            return None
        offset = self.offsets.get(packet_id) if packet_id else None
        return self.start - timedelta(days=self.default if offset is None else offset)


async def apply_plan(db: AsyncSession, person_id: uuid.UUID, initiative_id: uuid.UUID | None,
                     items: list[PlannedItem], *, actor_id: uuid.UUID | None,
                     source: str = "rule", due: DueDates | None = None,
                     ) -> list[LearningAssignment]:
    """Create an assignment for each "assign" item and return the new rows.
    Idempotent: a document with an open assignment for the same key is
    skipped, and the insert itself does nothing on a unique conflict, so a
    concurrent add can't fail the transaction it runs in. Pass `due` (from
    `DueDates.load`) to share one across many people of the same initiative."""
    todo = [i for i in items if i.action == "assign" and i.version_id is not None]
    if not todo:
        return []
    open_docs = await _open_documents(db, person_id, initiative_id)
    if due is None:
        due = await DueDates.load(db, initiative_id)
    await due.prime(db, {i.packet_id for i in todo if i.packet_id})
    created: list[LearningAssignment] = []
    for item in todo:
        if item.document_id in open_docs:
            continue
        row = (await db.scalars(
            pg_insert(LearningAssignment)
            .values(person_id=person_id, initiative_id=initiative_id,
                    document_id=item.document_id, version_id=item.version_id,
                    packet_id=item.packet_id, rule_id=item.rule_id, source=source,
                    due_on=due(item.packet_id), created_by=actor_id)
            .on_conflict_do_nothing()
            .returning(LearningAssignment))).first()
        open_docs.add(item.document_id)
        if row is not None:
            created.append(row)
    if created:
        audit(db, actor_id=actor_id, entity_type="learning_assignment",
              entity_id=str(person_id), action="learning_assign",
              changes={"initiative_id": str(initiative_id) if initiative_id else None,
                       "source": source,
                       "documents": [str(a.document_id) for a in created]})
    return created


# ── the people add / remove hooks ────────────────────────────────────


async def assign_on_add(db: AsyncSession, initiative_id: uuid.UUID, person_id: uuid.UUID,
                        actor_id: uuid.UUID | None) -> None:
    """Run right after the initiative_people row is added (and flushed, so
    the person's work type is visible to the rules), in the same
    transaction. When the initiative's invites already went out and late
    adds are on, the newcomer is invited too."""
    plan = await plan_for(db, person_id, initiative_id)
    created = await apply_plan(db, person_id, initiative_id, plan, actor_id=actor_id)
    if not created:
        return
    schedule = await db.get(LearningInviteSchedule, initiative_id)
    if schedule is not None and schedule.sent_at is not None and schedule.late_adds:
        from serversherpa.learning.invites import send_invite_for
        await send_invite_for(db, person_id, initiative_id, actor_id)


async def cancel_for_removed(db: AsyncSession, initiative_id: uuid.UUID,
                             person_id: uuid.UUID) -> None:
    """The person left the initiative: cancel their open assignments for it
    (signed ones stay as the record) and revoke its learning code."""
    await db.execute(
        update(LearningAssignment)
        .where(LearningAssignment.person_id == person_id,
               LearningAssignment.initiative_id == initiative_id,
               LearningAssignment.status.in_(OPEN_STATUSES))
        .values(status="cancelled"))
    await db.execute(
        update(LearningCode)
        .where(LearningCode.person_id == person_id,
               LearningCode.initiative_id == initiative_id,
               LearningCode.revoked_at.is_(None))
        .values(revoked_at=_now()))


# ── dry run, manual assignment, pushed versions ──────────────────────


def _summary_row(person: Person, plan: list[PlannedItem]) -> dict:
    assigned = [i for i in plan if i.action == "assign"]
    return {"person_id": person.id, "name": person.display_name,
            "will_get": [i.title for i in assigned], "why": [i.reason for i in assigned],
            "skipped": [{"title": i.title, "reason": i.reason}
                        for i in plan if i.action == "skip"],
            "no_email": not person.email}


def _summary(rows: list[dict]) -> dict:
    return {"rows": rows, "totals": {
        "checked": len(rows),
        "to_assign": sum(len(r["will_get"]) for r in rows),
        "skipped": sum(len(r["skipped"]) for r in rows),
        "no_email": sum(1 for r in rows if r["no_email"])}}


async def dry_run(db: AsyncSession, initiative_id: uuid.UUID, *, apply: bool,
                  actor_id: uuid.UUID | None) -> dict:
    """Per person on the initiative: what the rules would assign, why, and
    what they skip (the Bulk Actions review summary). `apply` writes it."""
    people = list(await db.scalars(
        select(Person)
        .join(InitiativePerson, InitiativePerson.person_id == Person.id)
        .where(InitiativePerson.initiative_id == initiative_id)
        .order_by(natural(Person.last_name), natural(Person.first_name), Person.id)))
    due = await DueDates.load(db, initiative_id) if apply else None
    rows = []
    for person in people:
        plan = await plan_for(db, person.id, initiative_id)
        if apply:
            await apply_plan(db, person.id, initiative_id, plan, actor_id=actor_id, due=due)
        rows.append(_summary_row(person, plan))
    return _summary(rows)


async def _people(db: AsyncSession, person_ids: list[uuid.UUID]) -> list[Person]:
    ids = list(dict.fromkeys(person_ids))
    found = {p.id: p for p in await db.scalars(select(Person).where(Person.id.in_(ids)))}
    if len(found) != len(ids):
        raise _err(422, "bad_person", "A person in the list doesn't exist.")
    return [found[i] for i in ids]


async def assign_manual(db: AsyncSession, *, actor_id: uuid.UUID | None,
                        person_ids: list[uuid.UUID], initiative_id: uuid.UUID | None,
                        packet_id: uuid.UUID | None,
                        document_ids: list[uuid.UUID]) -> dict:
    """Hand documents to people by name ("Assign extras", on-site days):
    a packet's documents in order, then any listed ones, each once. No
    sign-off check — the manager asked for it; an open assignment for the
    same key, or a person not on the initiative, is skipped."""
    people = await _people(db, person_ids)
    if initiative_id is not None and await db.get(Initiative, initiative_id) is None:
        raise _err(422, "bad_initiative", "That initiative doesn't exist.")
    wanted: list[tuple[LearningDocument, uuid.UUID | None]] = []
    if packet_id is not None:
        packet = await db.get(LearningPacket, packet_id)
        if packet is None or packet.archived_at is not None:
            raise _err(422, "bad_packet", "Pick a packet that exists and isn't archived.")
        wanted += [(doc, packet_id) for doc in await db.scalars(
            select(LearningDocument)
            .join(LearningPacketItem, LearningPacketItem.document_id == LearningDocument.id)
            .where(LearningPacketItem.packet_id == packet_id)
            .order_by(LearningPacketItem.position, LearningPacketItem.created_at))]
    if document_ids:
        ids = list(dict.fromkeys(document_ids))
        docs = {d.id: d for d in await db.scalars(
            select(LearningDocument).where(LearningDocument.id.in_(ids)))}
        if len(docs) != len(ids):
            raise _err(422, "bad_document", "A document in the list doesn't exist.")
        wanted += [(docs[i], None) for i in ids]
    # each document once, in first-seen order (a packet's copy comes first)
    unique: dict[uuid.UUID, tuple[LearningDocument, uuid.UUID | None]] = {}
    for doc, from_packet in wanted:
        unique.setdefault(doc.id, (doc, from_packet))
    wanted = list(unique.values())

    members = set(await db.scalars(
        select(InitiativePerson.person_id).where(
            InitiativePerson.initiative_id == initiative_id))) if initiative_id else set()
    due = await DueDates.load(db, initiative_id)
    rows = []
    for person in people:
        outsider = initiative_id is not None and person.id not in members
        open_docs = await _open_documents(db, person.id, initiative_id)
        plan = []
        for doc, from_packet in wanted:
            reason = (("not_on_initiative" if outsider else None) or _unassignable(doc)
                      or ("already_assigned" if doc.id in open_docs else None))
            plan.append(PlannedItem(
                document_id=doc.id, version_id=doc.current_version_id, packet_id=from_packet,
                rule_id=None, action="skip" if reason else "assign",
                reason=reason or "manual", title=doc.title))
        await apply_plan(db, person.id, initiative_id, plan, actor_id=actor_id,
                         source="manual", due=due)
        rows.append(_summary_row(person, plan))
    return _summary(rows)


async def push_version(db: AsyncSession, document: LearningDocument, *,
                       actor_id: uuid.UUID | None, person_ids: list[uuid.UUID]) -> dict:
    """Require the current version of `document` from people on site outside
    an initiative: a `new_version` assignment with no initiative. Someone
    whose latest sign-off is already this version, or who has an open
    general assignment for the document, is skipped."""
    if document.archived_at is not None:
        raise _err(409, "archived", "This document is archived.")
    if document.current_version_id is None:
        raise _err(409, "not_published", "Publish the document first.")
    due = DueDates(None, 0)                 # no initiative, no due date
    rows = []
    for person in await _people(db, person_ids):
        signoffs = (await _signoffs(db, person.id, {document.id})).get(document.id)
        latest = signoffs[0].version_id if signoffs else None
        reason = ("already_signed" if latest == document.current_version_id
                  else "already_assigned" if document.id in await _open_documents(
                      db, person.id, None) else None)
        plan = [PlannedItem(document_id=document.id, version_id=document.current_version_id,
                            packet_id=None, rule_id=None, action="skip" if reason else "assign",
                            reason=reason or "new_version", title=document.title)]
        await apply_plan(db, person.id, None, plan, actor_id=actor_id, source="new_version",
                         due=due)
        rows.append(_summary_row(person, plan))
    return _summary(rows)
