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

Nothing here commits."""
import random
import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
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
        used = await db.scalar(
            sa.select(sa.func.count()).select_from(LearningQuizAttempt)
            .where(LearningQuizAttempt.assignment_id == assignment.id)) or 0
        attempts_left = max(limit - used, 0)
        if not ok and attempts_left == 0 and await passed(db, assignment.id) is None:
            await _lock(db, assignment, document, limit)
    return {"score_percent": score, "passed": ok, "attempts_left": attempts_left,
            "locked": assignment.quiz_locked_at is not None}


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
