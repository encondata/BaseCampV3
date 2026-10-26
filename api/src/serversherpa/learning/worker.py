"""The worker's side of learning: my training, reading an assignment and
signing it. Every function takes the caller's person id and only touches
that person's rows; anyone else's assignment (or a cancelled one) is a
404, the same answer as one that doesn't exist.

An open assignment is read and signed at its document's current published
version (`assignment.version_id` is only the minimum it was assigned at);
the sign-off records the version actually shown. A signed assignment
re-reads the version it was signed at. Reading in another language uses
that version's published translation, else English (`fallback`).

`locked` is the packet's order (`enforce_order`: an earlier document in
the same packet and scope is still open) or a quiz lock. A locked
assignment can't be opened, quizzed or signed (409 `locked`).

Nothing here commits; the routes do."""
import base64
import binascii
import math
import re
import uuid
from collections import defaultdict
from datetime import UTC, date, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.routes.attachments import MAX_IMAGE_BYTES
from serversherpa.db.models import Initiative, Person
from serversherpa.learning import completion, quiz
from serversherpa.learning.assign import OPEN_STATUSES, _end_day
from serversherpa.learning.models import (
    LearningAssignment,
    LearningDocument,
    LearningDocumentVersion,
    LearningPacket,
    LearningPacketItem,
    LearningRule,
    LearningSignoff,
    LearningTranslation,
)
from serversherpa.learning.render import html_with_images
from serversherpa.services.timezone import stored_day

ENGLISH = "en"
# a display estimate for the training list's "N min" (a common silent
# reading speed); the document's own minimum reading time wins when longer
WORDS_PER_MINUTE = 200
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
DATA_URL_PREFIX = "data:image/png;base64,"
# a drawn signature is capped like any other image upload
SIGNATURE_B64_MAX = len(DATA_URL_PREFIX) + 4 * math.ceil(MAX_IMAGE_BYTES / 3)
_TAG = re.compile(r"<[^>]+>")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _now() -> datetime:
    return datetime.now(UTC)


# ── finding and locking ──────────────────────────────────────────────


async def own_assignment(db: AsyncSession, person_id: uuid.UUID, assignment_id: uuid.UUID,
                         *, for_update: bool = False) -> LearningAssignment:
    stmt = (select(LearningAssignment)
            .where(LearningAssignment.id == assignment_id,
                   LearningAssignment.person_id == person_id,
                   LearningAssignment.status != "cancelled")
            .execution_options(populate_existing=True))
    if for_update:
        stmt = stmt.with_for_update()
    row = await db.scalar(stmt)
    if row is None:
        raise _err(404, "not_found")
    return row


def _order_locks(items: list[LearningAssignment], ordered: dict[uuid.UUID, dict]) -> set:
    """The ids among `items` (one scope's assignments) held back by their
    packet's order: an earlier document of the same packet is open.
    `ordered` maps each enforce-order packet to {document_id: position}."""
    locked = set()
    for a in items:
        positions = ordered.get(a.packet_id)
        if positions is None or a.document_id not in positions:
            continue
        mine = positions[a.document_id]
        if any(b.packet_id == a.packet_id and b.status in OPEN_STATUSES
               and positions.get(b.document_id, mine) < mine for b in items):
            locked.add(a.id)
    return locked


async def _ordered_packets(db: AsyncSession, packet_ids: set) -> dict[uuid.UUID, dict]:
    packet_ids = {p for p in packet_ids if p is not None}
    if not packet_ids:
        return {}
    ordered: dict[uuid.UUID, dict] = defaultdict(dict)
    for packet_id, document_id, position in (await db.execute(
        select(LearningPacketItem.packet_id, LearningPacketItem.document_id,
               LearningPacketItem.position)
        .join(LearningPacket, LearningPacket.id == LearningPacketItem.packet_id)
        .where(LearningPacketItem.packet_id.in_(packet_ids),
               LearningPacket.enforce_order.is_(True)))).all():
        ordered[packet_id][document_id] = position
    return dict(ordered)


async def is_locked(db: AsyncSession, assignment: LearningAssignment) -> bool:
    if assignment.status not in OPEN_STATUSES:
        return False
    if assignment.quiz_locked_at is not None:
        return True
    if assignment.packet_id is None:
        return False
    ordered = await _ordered_packets(db, {assignment.packet_id})
    if not ordered:
        return False
    siblings = list(await db.scalars(
        select(LearningAssignment)
        .where(LearningAssignment.person_id == assignment.person_id,
               completion.in_scope(LearningAssignment.initiative_id, assignment.initiative_id),
               LearningAssignment.packet_id == assignment.packet_id,
               LearningAssignment.status.in_(OPEN_STATUSES))))
    if assignment not in siblings:
        siblings.append(assignment)
    return assignment.id in _order_locks(siblings, ordered)


async def require_unlocked(db: AsyncSession, assignment: LearningAssignment) -> None:
    if await is_locked(db, assignment):
        raise _err(409, "locked")


# ── versions and languages ───────────────────────────────────────────


async def _shown_version(db: AsyncSession, assignment: LearningAssignment,
                         document: LearningDocument) -> LearningDocumentVersion:
    version_id = None
    if assignment.status == "signed" and assignment.signoff_id is not None:
        version_id = await db.scalar(select(LearningSignoff.version_id).where(
            LearningSignoff.id == assignment.signoff_id))
    version_id = version_id or document.current_version_id or assignment.version_id
    return await db.get(LearningDocumentVersion, version_id)


async def published_translation(db: AsyncSession, version_id: uuid.UUID,
                                lang: str | None) -> LearningTranslation | None:
    if not lang or lang == ENGLISH:
        return None
    return await db.scalar(select(LearningTranslation).where(
        LearningTranslation.version_id == version_id, LearningTranslation.language == lang,
        LearningTranslation.status == "published"))


def _minutes(document: LearningDocument, version: LearningDocumentVersion | None) -> int:
    words = len(_TAG.sub(" ", version.content_html).split()) if version else 0
    estimate = math.ceil(words / WORDS_PER_MINUTE)
    floor = math.ceil((document.min_read_seconds or 0) / 60)
    return max(estimate, floor, 1)


# ── my training ──────────────────────────────────────────────────────


def _latest_per_document(rows: list[LearningAssignment]) -> list[LearningAssignment]:
    """One row per (scope, document): the open one, else the latest signed
    (an older version's sign-off is history once a new one is assigned)."""
    best: dict[tuple, LearningAssignment] = {}
    for a in rows:
        key = (a.initiative_id, a.document_id)
        have = best.get(key)
        if have is None or (a.status in OPEN_STATUSES) > (have.status in OPEN_STATUSES) or (
                (a.status in OPEN_STATUSES) == (have.status in OPEN_STATUSES)
                and a.created_at > have.created_at):
            best[key] = a
    return list(best.values())


def _shown(initiative: Initiative | None, items: list[LearningAssignment], today: date) -> bool:
    """A scope with something open always shows; a finished one stays while
    its initiative runs (the general set only while something is open)."""
    if any(a.status in OPEN_STATUSES for a in items):
        return True
    if initiative is None:
        return False
    last = _end_day(initiative) or (
        stored_day(initiative.scheduled_start) if initiative.scheduled_start else None)
    return last is None or last >= today


async def training(db: AsyncSession, person_id: uuid.UUID) -> dict:
    rows = _latest_per_document(list(await db.scalars(
        select(LearningAssignment)
        .where(LearningAssignment.person_id == person_id,
               LearningAssignment.status != "cancelled"))))
    documents = {d.id: d for d in await db.scalars(select(LearningDocument).where(
        LearningDocument.id.in_({a.document_id for a in rows})))} if rows else {}
    version_ids = {d.current_version_id for d in documents.values() if d.current_version_id}
    versions = {v.id: v for v in await db.scalars(select(LearningDocumentVersion).where(
        LearningDocumentVersion.id.in_(version_ids)))} if version_ids else {}
    initiative_ids = {a.initiative_id for a in rows if a.initiative_id}
    initiatives = {i.id: i for i in await db.scalars(select(Initiative).where(
        Initiative.id.in_(initiative_ids)))} if initiative_ids else {}
    ordered = await _ordered_packets(db, {a.packet_id for a in rows})
    packet_ids = {a.packet_id for a in rows if a.packet_id}
    positions = {(p, d): pos for p, d, pos in (await db.execute(
        select(LearningPacketItem.packet_id, LearningPacketItem.document_id,
               LearningPacketItem.position)
        .where(LearningPacketItem.packet_id.in_(packet_ids)))).all()} if packet_ids else {}
    rule_ids = {a.rule_id for a in rows if a.rule_id}
    rule_positions = dict((await db.execute(select(LearningRule.id, LearningRule.position).where(
        LearningRule.id.in_(rule_ids)))).all()) if rule_ids else {}
    quizzes = await quiz.with_quiz(db, set(documents))

    by_scope: dict[uuid.UUID | None, list[LearningAssignment]] = defaultdict(list)
    for a in rows:
        by_scope[a.initiative_id].append(a)
    today = _now().date()
    inf = float("inf")
    groups = []
    for scope, items in by_scope.items():
        initiative = initiatives.get(scope) if scope else None
        if not _shown(initiative, items, today):
            continue
        items.sort(key=lambda a: (
            a.packet_id is None, rule_positions.get(a.rule_id, inf),
            positions.get((a.packet_id, a.document_id), inf), a.created_at,
            documents[a.document_id].title.casefold()))
        locked = _order_locks(items, ordered)
        open_due = [a.due_on for a in items if a.status in OPEN_STATUSES and a.due_on]
        all_due = [a.due_on for a in items if a.due_on]
        groups.append({
            "initiative": {"id": initiative.id, "name": initiative.name,
                           "start": stored_day(initiative.scheduled_start)
                           if initiative.scheduled_start else None} if initiative else None,
            "due_on": min(open_due or all_due) if (open_due or all_due) else None,
            "items": [{
                "assignment_id": a.id, "title": documents[a.document_id].title,
                "status": a.status,
                "minutes": _minutes(documents[a.document_id],
                                    versions.get(documents[a.document_id].current_version_id)),
                "has_quiz": a.document_id in quizzes,
                "locked": a.status in OPEN_STATUSES and (
                    a.id in locked or a.quiz_locked_at is not None),
                "signed_at": a.signed_at,
            } for a in items],
        })
    # initiatives by start, then the general set
    groups.sort(key=lambda g: (g["initiative"] is None,
                               (g["initiative"] or {}).get("start") or date.max,
                               (g["initiative"] or {}).get("name") or ""))
    complete = bool(rows) and not any(a.status in OPEN_STATUSES for a in rows)
    badge_uid = None
    if complete:
        person = await db.get(Person, person_id)
        badge_uid = str(person.badge_uid)
    return {"groups": groups, "complete": complete, "badge_uid": badge_uid}


# ── reading ──────────────────────────────────────────────────────────


async def read(db: AsyncSession, assignment: LearningAssignment, lang: str | None) -> dict:
    """The assignment as the worker reads it; the first read starts the
    reading clock (`opened_at`)."""
    await require_unlocked(db, assignment)
    document = await db.get(LearningDocument, assignment.document_id)
    version = await _shown_version(db, assignment, document)
    translation = await published_translation(db, version.id, lang)
    if assignment.opened_at is None:
        assignment.opened_at = _now()
    if assignment.status == "assigned":
        assignment.status = "opened"
    has_quiz = await quiz.has_quiz(db, document)
    return {
        "title": translation.title if translation else version.title,
        "html": await html_with_images(
            db, version, translation.content_html if translation else None),
        "language": lang if translation else ENGLISH,
        "fallback": bool(lang) and lang != ENGLISH and translation is None,
        "version_no": version.version_no, "change_note": version.change_note,
        "sign_style": document.sign_style, "require_scroll": document.require_scroll,
        "min_read_seconds": document.min_read_seconds, "has_quiz": has_quiz,
        "quiz_passed": has_quiz and await quiz.passed(db, assignment.id) is not None,
    }


# ── signing ──────────────────────────────────────────────────────────


def _signature(raw: str | None) -> bytes:
    raw = (raw or "").strip()
    if not raw:
        raise _err(422, "signature_required")
    raw = raw.removeprefix(DATA_URL_PREFIX)
    if len(raw) > SIGNATURE_B64_MAX:
        raise _err(422, "signature_invalid")
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise _err(422, "signature_invalid") from None
    if not data.startswith(PNG_MAGIC) or len(data) > MAX_IMAGE_BYTES:
        raise _err(422, "signature_invalid")
    return data


async def sign(db: AsyncSession, person_id: uuid.UUID, assignment_id: uuid.UUID, *,
               agreed: bool, typed_name: str | None, signature_png_b64: str | None,
               language: str, scrolled_to_end: bool, ip: str | None,
               user_agent: str | None) -> dict:
    """Sign the assignment at the version shown, then run the completion
    check. Refusals, in order: 404, 409 `already_signed` / `locked`, then
    422 `must_agree`, `name_required`, `signature_required` /
    `signature_invalid`, `scroll_required`, `quiz_required`, `read_time`."""
    found = await own_assignment(db, person_id, assignment_id)
    # one sign-off at a time per person and scope (see completion.lock)
    await completion.lock(db, person_id, found.initiative_id)
    assignment = await own_assignment(db, person_id, assignment_id, for_update=True)
    if assignment.status == "signed":
        raise _err(409, "already_signed")
    await require_unlocked(db, assignment)
    document = await db.get(LearningDocument, assignment.document_id)

    if not agreed:
        raise _err(422, "must_agree")
    name = " ".join((typed_name or "").split()) or None
    signature = None
    if document.sign_style == "typed_name" and name is None:
        raise _err(422, "name_required")
    if document.sign_style == "drawn_signature":
        signature = _signature(signature_png_b64)
    if document.require_scroll and not scrolled_to_end:
        raise _err(422, "scroll_required")
    quiz_score = None
    if await quiz.has_quiz(db, document):
        quiz_score = await quiz.passed(db, assignment.id)
        if quiz_score is None:
            raise _err(422, "quiz_required")
    now = _now()
    elapsed = (now - assignment.opened_at).total_seconds() if assignment.opened_at else 0
    if document.min_read_seconds and elapsed < document.min_read_seconds:
        raise _err(422, "read_time",
                   seconds_left=math.ceil(document.min_read_seconds - elapsed))

    version = await _shown_version(db, assignment, document)
    # the language read: English unless that translation is published
    if await published_translation(db, version.id, language) is None:
        language = ENGLISH
    signoff = LearningSignoff(
        assignment_id=assignment.id, person_id=person_id, document_id=document.id,
        version_id=version.id, initiative_id=assignment.initiative_id, language=language,
        typed_name=name if document.sign_style == "typed_name" else None,
        signature_png=signature, read_seconds=int(elapsed), scrolled_to_end=scrolled_to_end,
        quiz_score=quiz_score, ip=ip, user_agent=(user_agent or "")[:500] or None,
        signed_at=now)
    db.add(signoff)
    await db.flush()
    assignment.status = "signed"
    assignment.signed_at = now
    assignment.signoff_id = signoff.id
    await db.flush()
    complete = await completion.check(db, person_id, assignment.initiative_id, actor=None)
    return {"signoff_id": signoff.id, "signed_at": now, "complete": complete}
