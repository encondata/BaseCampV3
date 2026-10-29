"""The worker's training on the learn site: what I have to sign, reading an
assignment, its quiz and signing it (serversherpa.learning.worker, .quiz,
.completion). Every route acts on the caller's own assignments only;
anyone else's is a 404."""
import uuid

from fastapi import APIRouter, HTTPException, Query, Request

from serversherpa.api.deps import DbSession, rate_limit_ip
from serversherpa.api.routes.kiosk import _inet_or_none
from serversherpa.learning import quiz, worker
from serversherpa.learning.models import LearningDocument
from serversherpa.learning.schemas import (
    LANG_PATTERN,
    AssignmentReadOut,
    HistoryItemOut,
    QuizAnswersIn,
    QuizQuestionOut,
    QuizResultOut,
    SignIn,
    SignOut,
    TrainingOut,
)
from serversherpa.learning.sessions import CurrentLearner

router = APIRouter()

LangQuery = Query(default=None, max_length=16, pattern=LANG_PATTERN)


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _quiz_document(db, assignment) -> LearningDocument:
    document = await db.get(LearningDocument, assignment.document_id)
    if not await quiz.has_quiz(db, document):
        raise _err(404, "no_quiz")
    return document


@router.get("/training", response_model=TrainingOut)
async def my_training(actor: CurrentLearner, db: DbSession) -> dict:
    return await worker.training(db, actor.person_id)


@router.get("/history", response_model=list[HistoryItemOut])
async def my_history(actor: CurrentLearner, db: DbSession) -> list[dict]:
    return await worker.history(db, actor.person_id)


@router.get("/assignments/{assignment_id}", response_model=AssignmentReadOut)
async def read_assignment(assignment_id: uuid.UUID, actor: CurrentLearner, db: DbSession,
                          lang: str | None = LangQuery) -> dict:
    assignment = await worker.own_assignment(db, actor.person_id, assignment_id,
                                             for_update=True)
    out = await worker.read(db, assignment, lang)
    await db.commit()
    return out


@router.get("/assignments/{assignment_id}/quiz", response_model=list[QuizQuestionOut])
async def quiz_questions(assignment_id: uuid.UUID, actor: CurrentLearner, db: DbSession,
                         lang: str | None = LangQuery) -> list[dict]:
    assignment = await worker.own_assignment(db, actor.person_id, assignment_id)
    await worker.require_unlocked(db, assignment)
    document = await _quiz_document(db, assignment)
    return quiz.present(await quiz.select(db, document.id), lang)


@router.post("/assignments/{assignment_id}/quiz", response_model=QuizResultOut)
async def quiz_attempt(assignment_id: uuid.UUID, body: QuizAnswersIn, actor: CurrentLearner,
                       db: DbSession) -> dict:
    assignment = await worker.own_assignment(db, actor.person_id, assignment_id,
                                             for_update=True)
    if assignment.status == "signed":
        raise _err(409, "already_signed")
    await worker.require_unlocked(db, assignment)
    document = await _quiz_document(db, assignment)
    out = await quiz.attempt(db, assignment, document, body.answers)
    await db.commit()
    return out


@router.post("/assignments/{assignment_id}/sign", response_model=SignOut)
async def sign_assignment(assignment_id: uuid.UUID, body: SignIn, request: Request,
                          actor: CurrentLearner, db: DbSession) -> dict:
    out = await worker.sign(
        db, actor.person_id, assignment_id, agreed=body.agreed, typed_name=body.typed_name,
        signature_png_b64=body.signature_png_b64, language=body.language,
        scrolled_to_end=body.scrolled_to_end, shown_version_no=body.version_no,
        ip=_inet_or_none(rate_limit_ip(request)),
        user_agent=request.headers.get("user-agent"))
    await db.commit()
    return out
