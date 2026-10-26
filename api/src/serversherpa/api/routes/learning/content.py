"""Content routes: a document's translations (draft, Claude draft, review,
publish) and its quiz questions, plus unlocking a worker's locked quiz.

Reads need `learning:view`; writing a translation, sending it to review,
approving it, editing a question and unlocking need `change`; a new
question needs `add`; removing one `delete` (`require_manager`, so wiki
administrators too)."""
import uuid

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession
from serversherpa.db.models import Person
from serversherpa.learning import quiz, translate
from serversherpa.learning.access import require_manager
from serversherpa.learning.models import (
    LearningAssignment,
    LearningDocument,
    LearningDocumentVersion,
    LearningQuizQuestion,
    LearningTranslation,
)
from serversherpa.learning.render import html_with_images
from serversherpa.learning.schemas import (
    PersonRef,
    QuestionIn,
    QuestionOut,
    QuestionPatchIn,
    QuestionReorderIn,
    TranslationOut,
    TranslationSaveIn,
    TranslationStatusOut,
    UnlockQuizOut,
)

router = APIRouter()


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail={"code": "not_found", "message": "Not found."})


async def _document(db, document_id: uuid.UUID) -> LearningDocument:
    document = await db.get(LearningDocument, document_id)
    if document is None:
        raise _not_found()
    return document


async def _question(db, question_id: uuid.UUID) -> LearningQuizQuestion:
    question = await db.get(LearningQuizQuestion, question_id)
    if question is None or question.archived_at is not None:
        raise _not_found()
    return question


# ── translations ─────────────────────────────────────────────────────


async def _translation_out(db, document: LearningDocument, translation: LearningTranslation,
                           version: LearningDocumentVersion) -> TranslationOut:
    ids = {translation.updated_by, translation.reviewed_by} - {None}
    people = {p.id: PersonRef(id=p.id, name=p.display_name) for p in (
        await db.scalars(select(Person).where(Person.id.in_(ids)))).all()} if ids else {}
    current = translation.version_id == document.current_version_id
    current_no = version.version_no
    if not current and document.current_version_id:
        current_no = await db.scalar(select(LearningDocumentVersion.version_no).where(
            LearningDocumentVersion.id == document.current_version_id))
    # presigned image sources for the editor (a save strips them again)
    html = await html_with_images(db, version, translation.content_html)
    return TranslationOut(
        language=translation.language,
        status=translation.status if current else "out_of_date",
        version_no=version.version_no, current_version_no=current_no,
        title=translation.title, content_html=html, source=translation.source,
        updated_at=translation.updated_at, updated_by=people.get(translation.updated_by),
        reviewed_by=people.get(translation.reviewed_by), reviewed_at=translation.reviewed_at)


@router.get("/documents/{document_id}/translations",
            response_model=list[TranslationStatusOut])
async def list_translations(
    document_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> list[dict]:
    return await translate.statuses(db, await _document(db, document_id))


@router.get("/documents/{document_id}/translations/{language}", response_model=TranslationOut)
async def get_translation(
    document_id: uuid.UUID,
    language: str,
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> TranslationOut:
    document = await _document(db, document_id)
    await translate.require_language(db, language)
    found = await translate.newest(db, document, language)
    if found is None:
        raise _not_found()
    return await _translation_out(db, document, *found)


@router.put("/documents/{document_id}/translations/{language}", response_model=TranslationOut)
async def save_translation(
    document_id: uuid.UUID,
    language: str,
    body: TranslationSaveIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> TranslationOut:
    document = await _document(db, document_id)
    await translate.require_language(db, language)
    row = await translate.save(db, document, language, title=body.title,
                               content_html=body.content_html, source="manual",
                               actor_id=actor.person.id)
    await db.commit()
    return await _translation_out(db, document, row, await translate.current_version(db, document))


@router.post("/documents/{document_id}/translations/{language}/draft",
             response_model=TranslationOut)
async def draft_translation(
    document_id: uuid.UUID,
    language: str,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> TranslationOut:
    document = await _document(db, document_id)
    await translate.require_language(db, language)
    actor_id = actor.person.id
    version_id, source_html, source_title = await translate.draft_source(db, document, language)
    # reads are done: end the transaction so the connection isn't held open
    # through the Claude call (nothing was written; loaded objects stay usable)
    await db.commit()
    try:
        title, html = await translate.draft(source_html, source_title, language)
    except translate.TranslationUnavailable:
        raise HTTPException(status_code=503, detail={
            "code": "translation_unavailable",
            "message": "Translating with Claude isn't available right now."})
    except translate.TranslationFailed:
        raise HTTPException(status_code=502, detail={
            "code": "translation_failed",
            "message": "Claude couldn't translate this document. Try again."})
    row = await translate.store_draft(db, document, language, version_id=version_id,
                                      title=title, content_html=html, actor_id=actor_id)
    await db.commit()
    return await _translation_out(db, document, row, await translate.current_version(db, document))


@router.post("/documents/{document_id}/translations/{language}/submit",
             response_model=TranslationOut)
async def submit_translation(
    document_id: uuid.UUID,
    language: str,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> TranslationOut:
    document = await _document(db, document_id)
    await translate.require_language(db, language)
    row = await translate.submit(db, document, language, actor_id=actor.person.id)
    await db.commit()
    return await _translation_out(db, document, row, await translate.current_version(db, document))


@router.post("/documents/{document_id}/translations/{language}/approve",
             response_model=TranslationOut)
async def approve_translation(
    document_id: uuid.UUID,
    language: str,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> TranslationOut:
    document = await _document(db, document_id)
    await translate.require_language(db, language)
    row = await translate.approve(db, document, language, actor_id=actor.person.id,
                                  is_developer="developer" in actor.roles)
    await db.commit()
    return await _translation_out(db, document, row, await translate.current_version(db, document))


# ── quiz questions ───────────────────────────────────────────────────


def _question_out(question: LearningQuizQuestion) -> QuestionOut:
    return QuestionOut.model_validate(question, from_attributes=True)


@router.get("/documents/{document_id}/questions", response_model=list[QuestionOut])
async def list_questions(
    document_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> list[QuestionOut]:
    await _document(db, document_id)
    return [_question_out(q) for q in await quiz.list_questions(db, document_id)]


@router.post("/documents/{document_id}/questions", response_model=QuestionOut,
             status_code=201)
async def create_question(
    document_id: uuid.UUID,
    body: QuestionIn,
    db: DbSession,
    actor: AuthContext = require_manager("add"),
) -> QuestionOut:
    await _document(db, document_id)
    question = await quiz.create_question(
        db, document_id, prompt=body.prompt,
        choices=[c.model_dump() for c in body.choices],
        correct_choice_ids=body.correct_choice_ids,
        translations={k: v.model_dump() for k, v in body.translations.items()},
        languages=await translate.target_languages(db), actor_id=actor.person.id)
    await db.commit()
    await db.refresh(question)
    return _question_out(question)


@router.post("/documents/{document_id}/questions/reorder", response_model=list[QuestionOut])
async def reorder_questions(
    document_id: uuid.UUID,
    body: QuestionReorderIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> list[QuestionOut]:
    await _document(db, document_id)
    await quiz.reorder_questions(db, document_id, body.ids, actor_id=actor.person.id)
    await db.commit()
    return [_question_out(q) for q in await quiz.list_questions(db, document_id)]


@router.patch("/questions/{question_id}", response_model=QuestionOut)
async def patch_question(
    question_id: uuid.UUID,
    body: QuestionPatchIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> QuestionOut:
    question = await _question(db, question_id)
    changes = body.model_dump(exclude_unset=True)
    await quiz.update_question(
        db, question, changes=changes, languages=await translate.target_languages(db),
        actor_id=actor.person.id)
    await db.commit()
    await db.refresh(question)
    return _question_out(question)


@router.delete("/questions/{question_id}", status_code=204)
async def delete_question(
    question_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("delete"),
) -> Response:
    await quiz.archive_question(db, await _question(db, question_id),
                                actor_id=actor.person.id)
    await db.commit()
    return Response(status_code=204)


# ── unlocking a worker's quiz ────────────────────────────────────────


@router.post("/assignments/{assignment_id}/unlock-quiz", response_model=UnlockQuizOut)
async def unlock_quiz(
    assignment_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> UnlockQuizOut:
    # the row lock orders this against the worker's own attempts
    assignment = await db.scalar(select(LearningAssignment)
                                 .where(LearningAssignment.id == assignment_id)
                                 .with_for_update())
    if assignment is None:
        raise _not_found()
    await quiz.unlock(db, assignment, actor_id=actor.person.id)
    await db.commit()
    return UnlockQuizOut(assignment_id=assignment.id,
                         attempts_forgiven=assignment.quiz_attempts_forgiven)
