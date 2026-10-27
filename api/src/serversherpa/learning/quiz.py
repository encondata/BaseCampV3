"""Document quizzes on the learn site: the question pool, what a worker is
shown, grading and the lock.

The pool is every non-archived question on the document (`select`). A
worker sees the questions and their choices shuffled on every request,
never which choices are right; `multiple` only says that more than one is.
A question counts as right when the chosen set is exactly the correct set,
and the attempt passes when the share of right questions reaches the
document's pass mark.

With `quiz_fail_action="lock"` an attempt limit applies: the failed
attempt that reaches `quiz_max_attempts` locks the assignment
(`quiz_locked_at`) and tells every learning manager (inbox only). With
"retry" there's no limit. A passed quiz never locks.

A manager can unlock a locked assignment (`unlock`): the lock clears and
`quiz_attempts_forgiven` becomes the number of attempts made so far, and
only the attempts beyond it count toward the limit, so the worker gets a
fresh set of attempts (an exact count, no clocks). Their earlier attempts
stay on record.

The pool is edited here too (`create_question` and friends); a removed
question is archived, never deleted, because past attempts' answers are
keyed by its id.

Nothing here commits."""
import random
import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Person
from serversherpa.learning.access import manager_ids
from serversherpa.learning.models import (
    LearningAssignment,
    LearningDocument,
    LearningQuizAttempt,
    LearningQuizQuestion,
)
from serversherpa.notifications.inbox import notify
from serversherpa.services.audit import audit

# a quiz turned on without a pass mark (the settings schema refuses one,
# so only an edited row) asks for every answer right
FULL_MARKS = 100


async def select(db: AsyncSession, document_id: uuid.UUID) -> list[LearningQuizQuestion]:
    """The document's question pool: every non-archived question."""
    return list(await db.scalars(
        sa.select(LearningQuizQuestion)
        .where(LearningQuizQuestion.document_id == document_id,
               LearningQuizQuestion.archived_at.is_(None))
        .order_by(LearningQuizQuestion.position, LearningQuizQuestion.created_at)))


async def has_quiz(db: AsyncSession, document: LearningDocument) -> bool:
    """The quiz is on and has at least one question to ask."""
    if not document.quiz_enabled:
        return False
    return await db.scalar(
        sa.select(LearningQuizQuestion.id)
        .where(LearningQuizQuestion.document_id == document.id,
               LearningQuizQuestion.archived_at.is_(None)).limit(1)) is not None


async def with_quiz(db: AsyncSession, document_ids: set[uuid.UUID]) -> set[uuid.UUID]:
    """`has_quiz` for many documents in one query."""
    if not document_ids:
        return set()
    return set(await db.scalars(
        sa.select(LearningDocument.id).distinct()
        .join(LearningQuizQuestion, LearningQuizQuestion.document_id == LearningDocument.id)
        .where(LearningDocument.id.in_(document_ids), LearningDocument.quiz_enabled.is_(True),
               LearningQuizQuestion.archived_at.is_(None))))


async def passed(db: AsyncSession, assignment_id: uuid.UUID) -> int | None:
    """The best passing score on this assignment, or None when no attempt
    passed."""
    return await db.scalar(
        sa.select(sa.func.max(LearningQuizAttempt.score_percent))
        .where(LearningQuizAttempt.assignment_id == assignment_id,
               LearningQuizAttempt.passed.is_(True)))


def present(questions: list[LearningQuizQuestion], lang: str | None) -> list[dict]:
    """What the worker sees: shuffled, in `lang` where the question has a
    translation (per text, so a half-translated question still reads), and
    no answers."""
    rng = random.SystemRandom()
    out = []
    for q in questions:
        tr = (q.translations or {}).get(lang) if lang else None
        tr = tr if isinstance(tr, dict) else {}
        texts = tr.get("choices") if isinstance(tr.get("choices"), dict) else {}
        choices = [{"id": str(c["id"]), "text": texts.get(str(c["id"])) or c["text"]}
                   for c in q.choices or []]
        rng.shuffle(choices)
        out.append({"id": q.id, "prompt": tr.get("prompt") or q.prompt, "choices": choices,
                    "multiple": len(q.correct_choice_ids or []) > 1})
    rng.shuffle(out)
    return out


def grade(questions: list[LearningQuizQuestion],
          answers: dict[str, list[str]]) -> tuple[int, dict[str, list[str]]]:
    """(score percent, the answers kept for the record). Answers to
    questions outside the pool are dropped; a choice that isn't on the
    question makes the question wrong."""
    right = 0
    kept: dict[str, list[str]] = {}
    for q in questions:
        chosen = set(answers.get(str(q.id)) or [])
        if chosen == set(q.correct_choice_ids or []):
            right += 1
        known = {str(c["id"]) for c in q.choices or []}
        kept[str(q.id)] = sorted(chosen & known)
    score = round(100 * right / len(questions)) if questions else 0
    return score, kept


def _attempt_limit(document: LearningDocument) -> int | None:
    if document.quiz_fail_action == "lock":
        return document.quiz_max_attempts
    return None


async def attempt(db: AsyncSession, assignment: LearningAssignment, document: LearningDocument,
                  answers: dict[str, list[str]]) -> dict:
    """Grade and record one attempt; lock and notify when it was the last.
    The caller holds the assignment's row lock, so attempts are counted
    one at a time."""
    questions = await select(db, document.id)
    score, kept = grade(questions, answers)
    ok = score >= (document.quiz_pass_percent or FULL_MARKS)
    db.add(LearningQuizAttempt(assignment_id=assignment.id, answers=kept,
                               score_percent=score, passed=ok))
    await db.flush()
    limit = _attempt_limit(document)
    attempts_left = None
    if limit is not None:
        used = (await _attempt_count(db, assignment.id)) - assignment.quiz_attempts_forgiven
        attempts_left = max(limit - used, 0)
        if not ok and attempts_left == 0 and await passed(db, assignment.id) is None:
            await _lock(db, assignment, document, limit)
    return {"score_percent": score, "passed": ok, "attempts_left": attempts_left,
            "locked": assignment.quiz_locked_at is not None}


async def _attempt_count(db: AsyncSession, assignment_id: uuid.UUID) -> int:
    return await db.scalar(
        sa.select(sa.func.count()).select_from(LearningQuizAttempt)
        .where(LearningQuizAttempt.assignment_id == assignment_id)) or 0


async def _lock(db: AsyncSession, assignment: LearningAssignment, document: LearningDocument,
                limit: int) -> None:
    assignment.quiz_locked_at = datetime.now(UTC)
    person = await db.get(Person, assignment.person_id)
    if assignment.initiative_id is not None:
        link = f"/initiatives/{assignment.initiative_id}?tab=learning"
    else:
        link = f"/people/workers/{assignment.person_id}"
    noun = "attempt" if limit == 1 else "attempts"
    for manager_id in await manager_ids(db, action="change"):
        await notify(db, manager_id, "learning_quiz_locked",
                     f"{person.display_name} is locked out of the {document.title} quiz",
                     body=f"They used all {limit} {noun} without passing, so they can't "
                          "sign it yet.",
                     link=link,
                     payload={"person_id": str(assignment.person_id),
                              "assignment_id": str(assignment.id),
                              "document_id": str(document.id),
                              "initiative_id": str(assignment.initiative_id)
                              if assignment.initiative_id else None})


async def unlock(db: AsyncSession, assignment: LearningAssignment, *,
                 actor_id: uuid.UUID | None) -> None:
    """Clear a quiz lock and forgive the attempts so far (409 `not_locked`
    when there's no lock). The caller holds the assignment's row lock."""
    if assignment.quiz_locked_at is None:
        raise _err(409, "not_locked", "This assignment's quiz isn't locked.")
    assignment.quiz_locked_at = None
    forgiven = await _attempt_count(db, assignment.id)     # every attempt so far, cumulative
    assignment.quiz_attempts_forgiven = forgiven
    audit(db, actor_id=actor_id, entity_type="learning_assignment",
          entity_id=str(assignment.id), action="learning_quiz_unlock",
          changes={"person_id": str(assignment.person_id),
                   "document_id": str(assignment.document_id),
                   "attempts_forgiven": forgiven})


# ── editing the question pool ────────────────────────────────────────

ENTITY = "learning_quiz_question"


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def check_question(choices: list[dict], correct: list[str], translations: dict,
                   languages: list[str]) -> None:
    """422 unless the question reads: at least one choice (a lone "Yes"
    acknowledgment is fine) with distinct
    ids, at least one correct id and every correct id a choice, and
    translations only into the configured languages (never English) naming
    only the question's own choice ids."""
    if len(choices) < 1:
        raise _err(422, "too_few_choices", "A question needs at least one choice.")
    ids = [str(c["id"]) for c in choices]
    if len(set(ids)) != len(ids):
        raise _err(422, "duplicate_choice", "Two choices share an id.")
    if not correct:
        raise _err(422, "no_correct_choice", "Mark at least one choice as correct.")
    if len(set(correct)) != len(correct):
        raise _err(422, "duplicate_correct", "A correct choice is listed twice.")
    if any(c not in ids for c in correct):
        raise _err(422, "unknown_correct_choice",
                   "A correct choice isn't one of the question's choices.")
    for lang, tr in translations.items():
        if lang not in languages:
            raise _err(422, "unknown_language",
                       f"{lang} isn't a language the learning portal is translated into.")
        extra = set(tr.get("choices") or {}) - set(ids)
        if extra:
            raise _err(422, "unknown_translated_choice",
                       "A translation names a choice the question doesn't have.")


def _translations(raw: dict) -> dict:
    """What's stored: only the texts that are set, per language."""
    out = {}
    for lang, tr in raw.items():
        entry = {}
        if tr.get("prompt"):
            entry["prompt"] = tr["prompt"]
        texts = {cid: text for cid, text in (tr.get("choices") or {}).items() if text}
        if texts:
            entry["choices"] = texts
        if entry:
            out[lang] = entry
    return out


def _choices(raw: list[dict]) -> list[dict]:
    """Choices with an id each (new ones get one)."""
    return [{"id": c.get("id") or uuid.uuid4().hex[:8], "text": c["text"]} for c in raw]


async def list_questions(db: AsyncSession, document_id: uuid.UUID) -> list[LearningQuizQuestion]:
    return await select(db, document_id)


async def create_question(db: AsyncSession, document_id: uuid.UUID, *, prompt: str,
                          choices: list[dict], correct_choice_ids: list[str],
                          translations: dict, languages: list[str],
                          actor_id: uuid.UUID | None) -> LearningQuizQuestion:
    choices = _choices(choices)
    check_question(choices, correct_choice_ids, translations, languages)
    last = await db.scalar(
        sa.select(sa.func.max(LearningQuizQuestion.position))
        .where(LearningQuizQuestion.document_id == document_id,
               LearningQuizQuestion.archived_at.is_(None)))
    question = LearningQuizQuestion(
        document_id=document_id, prompt=prompt, choices=choices,
        correct_choice_ids=list(correct_choice_ids),
        translations=_translations(translations), position=(last or 0) + 1.0)
    db.add(question)
    await db.flush()
    audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(question.id),
          action="learning_quiz_question_create",
          changes={"document_id": str(document_id), "prompt": prompt})
    return question


async def update_question(db: AsyncSession, question: LearningQuizQuestion, *,
                          changes: dict, languages: list[str],
                          actor_id: uuid.UUID | None) -> None:
    """Apply a partial edit; the merged question is checked as a whole.
    Translated choice texts of a choice that was removed are dropped unless
    the edit sends `translations` itself (then they're checked as sent)."""
    prompt = changes.get("prompt", question.prompt)
    choices = _choices(changes["choices"]) if "choices" in changes else question.choices
    correct = changes.get("correct_choice_ids", list(question.correct_choice_ids or []))
    if "translations" in changes:
        translations = _translations(changes["translations"])
    else:
        ids = {str(c["id"]) for c in choices}
        translations = {}
        for lang, tr in (question.translations or {}).items():
            kept = {cid: t for cid, t in (tr.get("choices") or {}).items() if cid in ids}
            translations[lang] = {**tr, "choices": kept}
        translations = _translations(translations)
    check_question(choices, correct, translations, languages)
    before = {"prompt": question.prompt, "choices": question.choices,
              "correct_choice_ids": list(question.correct_choice_ids or []),
              "translations": _translations(question.translations or {})}
    question.prompt = prompt
    question.choices = choices
    question.correct_choice_ids = list(correct)
    question.translations = translations
    after = {"prompt": prompt, "choices": choices, "correct_choice_ids": list(correct),
             "translations": translations}
    changed = sorted(k for k in after if after[k] != before[k])
    if changed:
        audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(question.id),
              action="learning_quiz_question_update",
              changes={"document_id": str(question.document_id), "fields": changed})
    await db.flush()


async def archive_question(db: AsyncSession, question: LearningQuizQuestion, *,
                           actor_id: uuid.UUID | None) -> None:
    if question.archived_at is None:
        question.archived_at = datetime.now(UTC)
        audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(question.id),
              action="learning_quiz_question_delete",
              changes={"document_id": str(question.document_id), "prompt": question.prompt})
    await db.flush()


async def reorder_questions(db: AsyncSession, document_id: uuid.UUID, ids: list[uuid.UUID], *,
                            actor_id: uuid.UUID | None) -> None:
    """Put the questions in `ids` first, in that order; the rest follow in
    their current order. 422 `bad_order` for a repeated or unknown id."""
    if len(set(ids)) != len(ids):
        raise _err(422, "bad_order", "A question is listed more than once.")
    questions = list(await db.scalars(
        sa.select(LearningQuizQuestion)
        .where(LearningQuizQuestion.document_id == document_id,
               LearningQuizQuestion.archived_at.is_(None))
        .order_by(LearningQuizQuestion.position, LearningQuizQuestion.created_at)
        .with_for_update()))
    by_id = {q.id: q for q in questions}
    if any(i not in by_id for i in ids):
        raise _err(422, "bad_order", "A question in the list isn't on this document.")
    ordered = [by_id[i] for i in ids] + [q for q in questions if q.id not in set(ids)]
    before = [str(q.id) for q in questions]
    for position, question in enumerate(ordered, start=1):
        if question.position != float(position):
            question.position = float(position)
    after = [str(q.id) for q in ordered]
    if before != after:
        audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=None,
              action="learning_quiz_question_reorder",
              changes={"document_id": str(document_id),
                       "order": {"from": before, "to": after}})
    await db.flush()
