"""Learning at a glance for managers: the dashboard (funnel, overrides,
initiatives at risk, expiring sign-offs, translation issues, hard quiz
questions), the per-initiative compliance grid and a person's learning
history. `evaluate` is the one place that decides, for an initiative (or
the general set), who must hold which document and whether they do; the
grid and the compliance report both read it. Read-only.

Dashboard windows: the funnel and the override count look at the last
`days` days (assignments created and overrides issued in it); the rest
are about right now."""
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from statistics import median

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from serversherpa.db.models import Initiative, InitiativePerson, Person, UserAccount
from serversherpa.db.ordering import natural
from serversherpa.learning import assign, translate
from serversherpa.learning.assign import NEVER, OPEN_STATUSES
from serversherpa.learning.emails import day_text
from serversherpa.learning.models import (
    LearningAssignment,
    LearningDocument,
    LearningDocumentVersion,
    LearningEmailLog,
    LearningOverride,
    LearningQuizAttempt,
    LearningQuizQuestion,
    LearningSignoff,
    LearningTranslation,
)
from serversherpa.services.timezone import stored_day

AT_RISK_DAYS = 30
EXPIRING_DAYS = 30
# a question is "hard" once enough attempts have seen it and most-enough miss it
HARD_MIN_ATTEMPTS = 10
HARD_MISS_PERCENT = 40
# initiatives that are over don't need chasing
INACTIVE_STATUSES = ("completed", "cancelled")

STATUS_TEXT = {
    "never_signed": "Not signed",
    "expired": "Expired",
    "new_version": "New version",
    "every_initiative": "Sign again for this initiative",
}


def _percent(part: int, whole: int) -> int:
    return round(100 * part / whole) if whole else 0


def _median(values: list[float]) -> float | None:
    return round(median(values), 1) if values else None


# ── the compliance core ──────────────────────────────────────────────


@dataclass
class Cell:
    """One person's standing on one required document. `state` is
    valid | expires_during | missing; `status` the report's wording."""
    person_id: uuid.UUID
    person: str
    document_id: uuid.UUID
    document: str
    state: str
    status: str
    label: str
    version: int | None            # of the sign-off considered, even a superseded one
    language: str | None
    signed_at: datetime | None
    expires_on: date | None
    overrides: int


@dataclass
class Evaluation:
    documents: list[LearningDocument]
    people: list[Person]
    cells: dict[tuple[uuid.UUID, uuid.UUID], Cell]      # (person_id, document_id), required only


def _until(reason: str) -> date | None:
    """The day a `valid_until:<day|never>` reason names."""
    value = reason.partition(":")[2]
    return None if value == NEVER else date.fromisoformat(value)


def _state(document: LearningDocument, signoffs: list[LearningSignoff],
           initiative: Initiative | None, on: date) -> tuple[str, str, str, LearningSignoff | None,
                                                            date | None]:
    """(state, status, label, the sign-off considered, expires_on)."""
    initiative_id = initiative.id if initiative else None
    valid, reason = assign._judge(document, signoffs, initiative_id=initiative_id,
                                  initiative=initiative, on=on)
    here = next((s for s in signoffs if initiative_id and s.initiative_id == initiative_id), None)
    signoff = here or (signoffs[0] if signoffs else None)
    if not valid:
        expires = None
        if reason == "expired" and signoff is not None and document.validity_days is not None:
            expires = stored_day(signoff.signed_at) + timedelta(days=document.validity_days)
        return "missing", STATUS_TEXT[reason], STATUS_TEXT[reason], signoff, expires
    expires = _until(reason)
    end = assign._end_day(initiative)
    if (here is None and document.resign_rule == "expired_or_new_version"
            and document.validity_days is not None and expires is not None
            and end is not None and expires < end):
        return ("expires_during", "Expires during initiative",
                f"Expires {day_text(expires)}", signoff, expires)
    label = "Valid" if expires is None else f"Valid until {day_text(expires)}"
    return "valid", "Valid", label, signoff, expires


async def _members(db: AsyncSession, initiative: Initiative | None) -> list[Person]:
    """The people on the initiative; for the general set, whoever has a
    general assignment."""
    if initiative is not None:
        ids = select(InitiativePerson.person_id).where(
            InitiativePerson.initiative_id == initiative.id)
    else:
        ids = select(LearningAssignment.person_id).where(
            LearningAssignment.initiative_id.is_(None), LearningAssignment.status != "cancelled")
    return list(await db.scalars(
        select(Person).where(Person.id.in_(ids))
        .order_by(natural(Person.last_name), natural(Person.first_name), Person.id)))


async def evaluate(db: AsyncSession, initiative: Initiative | None) -> Evaluation:
    """Who must hold which document for `initiative` (None = the general
    set) and whether they do, judged on `check_day` like the assignment
    engine. Required = what the rules would hand the person (including
    what they already hold, so a valid sign-off still shows) plus every
    document with a non-cancelled assignment in scope. The general set has
    no rules: its assignments are the requirement."""
    initiative_id = initiative.id if initiative else None
    people = await _members(db, initiative)
    ids = [p.id for p in people]
    required: dict[uuid.UUID, set[uuid.UUID]] = {pid: set() for pid in ids}
    if ids:
        scope = (LearningAssignment.initiative_id.is_(None) if initiative_id is None
                 else LearningAssignment.initiative_id == initiative_id)
        for person_id, document_id in (await db.execute(
            select(LearningAssignment.person_id, LearningAssignment.document_id)
            .where(LearningAssignment.person_id.in_(ids), scope,
                   LearningAssignment.status != "cancelled"))).all():
            required[person_id].add(document_id)
    if initiative is not None:
        for pid, items in (await assign.plan_many(db, ids, initiative_id)).items():
            required[pid].update(i.document_id for i in items
                                 if i.reason not in ("archived", "not_published"))

    document_ids = set().union(*required.values()) if required else set()
    documents = sorted(
        (await db.scalars(select(LearningDocument).where(
            LearningDocument.id.in_(document_ids)))).all() if document_ids else [],
        key=lambda d: (d.title.casefold(), d.id))
    by_doc = {d.id: d for d in documents}

    signoffs = await assign.signoffs_many(db, ids, document_ids)
    version_ids = {s.version_id for rows in signoffs.values() for s in rows}
    version_no = dict((await db.execute(
        select(LearningDocumentVersion.id, LearningDocumentVersion.version_no)
        .where(LearningDocumentVersion.id.in_(version_ids)))).all()) if version_ids else {}
    scope = (LearningOverride.initiative_id.is_(None) if initiative_id is None
             else LearningOverride.initiative_id == initiative_id)
    overrides = dict((await db.execute(
        select(LearningOverride.person_id, func.count())
        .where(LearningOverride.person_id.in_(ids), scope)
        .group_by(LearningOverride.person_id))).all()) if ids else {}

    on = assign.check_day(initiative)
    cells: dict[tuple[uuid.UUID, uuid.UUID], Cell] = {}
    for person in people:
        for document_id in required[person.id]:
            document = by_doc[document_id]
            state, status, label, signoff, expires = _state(
                document, signoffs.get((person.id, document_id), []), initiative, on)
            cells[(person.id, document_id)] = Cell(
                person_id=person.id, person=person.display_name, document_id=document_id,
                document=document.title, state=state, status=status, label=label,
                version=version_no.get(signoff.version_id) if signoff else None,
                language=signoff.language if signoff else None,
                signed_at=signoff.signed_at if signoff else None, expires_on=expires,
                overrides=overrides.get(person.id, 0))
    return Evaluation(documents=documents, people=people, cells=cells)


async def grid(db: AsyncSession, initiative: Initiative) -> dict:
    """The initiative's compliance grid: one row per person, one cell per
    document that anyone on the initiative needs."""
    ev = await evaluate(db, initiative)
    rows = []
    for person in ev.people:
        cells = {}
        for document in ev.documents:
            cell = ev.cells.get((person.id, document.id))
            cells[document.id] = ({"state": cell.state, "label": cell.label} if cell
                                  else {"state": "not_required", "label": "Not required"})
        rows.append({"person_id": person.id, "name": person.display_name, "cells": cells})
    return {"documents": [{"id": d.id, "title": d.title} for d in ev.documents], "rows": rows}


# ── dashboard ────────────────────────────────────────────────────────


async def _funnel(db: AsyncSession, since: datetime) -> dict:
    """Workers with assignments created since `since`: how many were
    assigned, opened anything, and finished everything; the median hours
    from their last invite to their first open, and the median minutes from
    first open to last sign-off among those who finished."""
    per_person: dict[uuid.UUID, list] = defaultdict(list)
    for person_id, status, opened_at, signed_at in (await db.execute(
        select(LearningAssignment.person_id, LearningAssignment.status,
               LearningAssignment.opened_at, LearningAssignment.signed_at)
        .where(LearningAssignment.created_at >= since,
               LearningAssignment.status != "cancelled"))).all():
        per_person[person_id].append((status, opened_at, signed_at))

    first_open: dict[uuid.UUID, datetime] = {}
    finish_minutes: list[float] = []
    complete = 0
    for person_id, items in per_person.items():
        stamps = [t for _, opened, signed in items for t in (opened, signed) if t is not None]
        opens = [o for _, o, _ in items if o is not None] or stamps
        if stamps:
            first_open[person_id] = min(opens)
        if all(status == "signed" for status, _, _ in items):
            complete += 1
            signed = [s for _, _, s in items if s is not None]
            if signed and stamps:
                finish_minutes.append((max(signed) - min(opens)).total_seconds() / 60)

    open_hours: list[float] = []
    if first_open:
        invites: dict[uuid.UUID, list[datetime]] = defaultdict(list)
        for person_id, at in (await db.execute(
            select(LearningEmailLog.person_id, LearningEmailLog.created_at)
            .where(LearningEmailLog.kind == "invite",
                   LearningEmailLog.person_id.in_(first_open)))).all():
            invites[person_id].append(at)
        for person_id, opened in first_open.items():
            sent = max((at for at in invites.get(person_id, []) if at <= opened), default=None)
            if sent is not None:
                open_hours.append((opened - sent).total_seconds() / 3600)
    return {"assigned": len(per_person), "opened": len(first_open), "complete": complete,
            "median_open_hours": _median(open_hours),
            "median_finish_minutes": _median(finish_minutes)}


async def _overrides(db: AsyncSession, since: datetime) -> dict:
    count, admins = (await db.execute(
        select(func.count(), func.count(func.distinct(LearningOverride.admin_person_id)))
        .where(LearningOverride.created_at >= since))).one()
    return {"count": count, "admins": admins}


async def _at_risk(db: AsyncSession, today: date) -> list[dict]:
    """Active initiatives starting within 30 days that still have open
    assignments, least complete first."""
    first = datetime(today.year, today.month, today.day, tzinfo=UTC)
    # a day of slack either side for the SQL cut; the exact 0..30 window is
    # read below with stored_day, as everywhere else
    candidates = list(await db.scalars(
        select(Initiative).where(
            Initiative.archived_at.is_(None), Initiative.status.not_in(INACTIVE_STATUSES),
            Initiative.scheduled_start >= first - timedelta(days=1),
            Initiative.scheduled_start < first + timedelta(days=AT_RISK_DAYS + 2),
            Initiative.id.in_(select(LearningAssignment.initiative_id).where(
                LearningAssignment.status.in_(OPEN_STATUSES))))))
    initiatives = [i for i in candidates
                   if 0 <= (stored_day(i.scheduled_start) - today).days <= AT_RISK_DAYS]
    if not initiatives:
        return []
    total: dict[uuid.UUID, int] = defaultdict(int)
    signed: dict[uuid.UUID, int] = defaultdict(int)
    unfinished: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    for initiative_id, person_id, status in (await db.execute(
        select(LearningAssignment.initiative_id, LearningAssignment.person_id,
               LearningAssignment.status)
        .where(LearningAssignment.initiative_id.in_([i.id for i in initiatives]),
               LearningAssignment.status != "cancelled"))).all():
        total[initiative_id] += 1
        if status == "signed":
            signed[initiative_id] += 1
        else:
            unfinished[initiative_id].add(person_id)
    everyone = set().union(*unfinished.values())
    with_email = {pid for pid, email, account in (await db.execute(
        select(Person.id, Person.email, UserAccount.email)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.id.in_(everyone)))).all() if email or account}
    rows = [{"initiative_id": i.id, "name": i.name,
             "starts_in_days": (stored_day(i.scheduled_start) - today).days,
             "percent": _percent(signed[i.id], total[i.id]),
             "not_finished": len(unfinished[i.id]),
             "no_email": len(unfinished[i.id] - with_email)}
            for i in initiatives if unfinished[i.id]]
    rows.sort(key=lambda r: (r["percent"], r["starts_in_days"], r["name"].casefold()))
    return rows


async def _expiring(db: AsyncSession, today: date) -> list[dict]:
    """Documents with sign-offs (the current version's, each person's
    latest) that run out within 30 days: who, and the first day."""
    latest = (select(LearningSignoff, LearningDocument)
              .options(defer(LearningSignoff.signature_png))
              .join(LearningDocument, LearningDocument.id == LearningSignoff.document_id)
              .join(Person, Person.id == LearningSignoff.person_id)
              .where(LearningDocument.archived_at.is_(None),
                     LearningDocument.validity_days.is_not(None),
                     Person.archived_at.is_(None))
              .order_by(LearningSignoff.person_id, LearningSignoff.document_id,
                        LearningSignoff.signed_at.desc(), LearningSignoff.created_at.desc())
              .distinct(LearningSignoff.person_id, LearningSignoff.document_id))
    by_doc: dict[uuid.UUID, dict] = {}
    horizon = today + timedelta(days=EXPIRING_DAYS)
    for signoff, document in (await db.execute(latest)).all():
        if signoff.version_id != document.current_version_id:
            continue                        # a new version is due anyway
        until = stored_day(signoff.signed_at) + timedelta(days=document.validity_days)
        if not today <= until <= horizon:
            continue
        row = by_doc.setdefault(document.id, {
            "document_id": document.id, "title": document.title, "people": 0,
            "first_date": until})
        row["people"] += 1
        row["first_date"] = min(row["first_date"], until)
    return sorted(by_doc.values(), key=lambda r: (r["first_date"], r["title"].casefold()))


async def _translation_issues(db: AsyncSession) -> list[dict]:
    """Languages whose newest translation of a published document is of an
    older version than the current one (`out_of_date`)."""
    targets = await translate.target_languages(db)
    if not targets:
        return []
    newest: dict[tuple[uuid.UUID, str], tuple[int, uuid.UUID]] = {}
    titles: dict[uuid.UUID, tuple[str, uuid.UUID]] = {}
    for document, translation, number in (await db.execute(
        select(LearningDocument, LearningTranslation, LearningDocumentVersion.version_no)
        .join(LearningDocumentVersion,
              LearningDocumentVersion.document_id == LearningDocument.id)
        .join(LearningTranslation, LearningTranslation.version_id == LearningDocumentVersion.id)
        .where(LearningDocument.archived_at.is_(None),
               LearningDocument.current_version_id.is_not(None),
               LearningTranslation.language.in_(targets)))).all():
        key = (document.id, translation.language)
        if key not in newest or number > newest[key][0]:
            newest[key] = (number, translation.version_id)
        titles[document.id] = (document.title, document.current_version_id)
    issues = [{"document_id": doc_id, "title": titles[doc_id][0], "language": language}
              for (doc_id, language), (_, version_id) in newest.items()
              if version_id != titles[doc_id][1]]
    issues.sort(key=lambda r: (r["title"].casefold(), targets.index(r["language"])))
    return issues


async def _hard_questions(db: AsyncSession, since: datetime) -> list[dict]:
    """Active questions that at least 10 attempts since `since` saw and more
    than 40 % of them got wrong, worst first. A miss is judged against the
    question's current correct answers."""
    questions = {q.id: (q, title) for q, title in (await db.execute(
        select(LearningQuizQuestion, LearningDocument.title)
        .join(LearningDocument, LearningDocument.id == LearningQuizQuestion.document_id)
        .where(LearningQuizQuestion.archived_at.is_(None),
               LearningDocument.archived_at.is_(None)))).all()}
    if not questions:
        return []
    by_doc: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for q, _ in questions.values():
        by_doc[q.document_id].append(q.id)
    seen: dict[uuid.UUID, int] = defaultdict(int)
    missed: dict[uuid.UUID, int] = defaultdict(int)
    for document_id, answers in (await db.execute(
        select(LearningAssignment.document_id, LearningQuizAttempt.answers)
        .join(LearningAssignment, LearningAssignment.id == LearningQuizAttempt.assignment_id)
        .where(LearningAssignment.document_id.in_(by_doc),
               LearningQuizAttempt.created_at >= since))).all():
        for question_id in by_doc[document_id]:
            key = str(question_id)
            if key not in answers:
                continue                    # not in the pool when this was taken
            seen[question_id] += 1
            if set(answers[key] or []) != set(questions[question_id][0].correct_choice_ids or []):
                missed[question_id] += 1
    rows = [{"question_id": qid, "document_title": questions[qid][1],
             "miss_percent": _percent(missed[qid], seen[qid])}
            for qid in seen
            if seen[qid] >= HARD_MIN_ATTEMPTS
            and missed[qid] * 100 > HARD_MISS_PERCENT * seen[qid]]
    rows.sort(key=lambda r: (-r["miss_percent"], r["document_title"].casefold(),
                             str(r["question_id"])))
    return rows


async def dashboard(db: AsyncSession, days: int, *, now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    since = now - timedelta(days=days)
    return {"funnel": await _funnel(db, since),
            "overrides": await _overrides(db, since),
            "at_risk": await _at_risk(db, now.astimezone(UTC).date()),
            "expiring": await _expiring(db, now.astimezone(UTC).date()),
            "translation_issues": await _translation_issues(db),
            "hard_questions": await _hard_questions(db, since)}


# ── a person's history ───────────────────────────────────────────────


async def history(db: AsyncSession, person: Person, *, initiative_names: bool = True) -> dict:
    """Every sign-off (never the signature image), quiz attempt and
    override of one person, newest first, and what is still open.
    `initiative_names=False` leaves the initiative ids but not their names
    (for readers who can't see initiatives)."""
    signoffs = [{
        "id": s.id, "document_id": s.document_id, "document": title, "version": number,
        "language": s.language, "signed_at": s.signed_at, "read_seconds": s.read_seconds,
        "quiz_score": s.quiz_score, "initiative_id": s.initiative_id}
        for s, title, number in (await db.execute(
            select(LearningSignoff, LearningDocument.title, LearningDocumentVersion.version_no)
            .options(defer(LearningSignoff.signature_png))
            .join(LearningDocument, LearningDocument.id == LearningSignoff.document_id)
            .join(LearningDocumentVersion,
                  LearningDocumentVersion.id == LearningSignoff.version_id)
            .where(LearningSignoff.person_id == person.id)
            .order_by(LearningSignoff.signed_at.desc(), LearningSignoff.created_at.desc(),
                      LearningSignoff.id))).all()]
    attempts = [{
        "id": a.id, "document_id": document_id, "document": title,
        "score_percent": a.score_percent, "passed": a.passed, "created_at": a.created_at,
        "initiative_id": initiative_id}
        for a, document_id, title, initiative_id in (await db.execute(
            select(LearningQuizAttempt, LearningAssignment.document_id, LearningDocument.title,
                   LearningAssignment.initiative_id)
            .join(LearningAssignment, LearningAssignment.id == LearningQuizAttempt.assignment_id)
            .join(LearningDocument, LearningDocument.id == LearningAssignment.document_id)
            .where(LearningAssignment.person_id == person.id)
            .order_by(LearningQuizAttempt.created_at.desc(), LearningQuizAttempt.id))).all()]
    override_rows = list(await db.scalars(
        select(LearningOverride).where(LearningOverride.person_id == person.id)
        .order_by(LearningOverride.created_at.desc(), LearningOverride.id)))
    admins = {p.id: p.display_name for p in await db.scalars(select(Person).where(
        Person.id.in_({o.admin_person_id for o in override_rows})))}
    overrides = [{
        "id": o.id, "created_at": o.created_at, "reason": o.reason,
        "reason_text": o.reason_text, "scope": o.scope, "local_day": o.local_day,
        "admin": admins.get(o.admin_person_id), "initiative_id": o.initiative_id}
        for o in override_rows]
    open_assignments = [{
        "id": a.id, "document_id": a.document_id, "document": title, "status": a.status,
        "source": a.source, "due_on": a.due_on, "initiative_id": a.initiative_id}
        for a, title in (await db.execute(
            select(LearningAssignment, LearningDocument.title)
            .join(LearningDocument, LearningDocument.id == LearningAssignment.document_id)
            .where(LearningAssignment.person_id == person.id,
                   LearningAssignment.status.in_(OPEN_STATUSES))
            .order_by(LearningAssignment.due_on.asc().nulls_last(), LearningDocument.title,
                      LearningAssignment.id))).all()]
    out = {"person": {"id": person.id, "name": person.display_name},
           "signoffs": signoffs, "quiz_attempts": attempts, "overrides": overrides,
           "open_assignments": open_assignments}
    wanted = {r["initiative_id"] for key in ("signoffs", "quiz_attempts", "overrides",
                                             "open_assignments") for r in out[key]} - {None}
    names = dict((await db.execute(select(Initiative.id, Initiative.name).where(
        Initiative.id.in_(wanted)))).all()) if wanted and initiative_names else {}
    for key in ("signoffs", "quiz_attempts", "overrides", "open_assignments"):
        for row in out[key]:
            row["initiative"] = names.get(row["initiative_id"])
    return out
