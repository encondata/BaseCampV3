"""Library routes: learning documents, publishing versions (wiki
snapshots), reading a version's HTML, and the learning-space page picker.
Reads need `learning:view`; create `add`; settings and publish `change`;
archive `delete` (`require_manager`, so wiki administrators too). Linking
and publishing a page also need the actor's view access on it in the wiki
(`library.learning_page`)."""
import uuid

from fastapi import APIRouter, HTTPException, Response
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession
from serversherpa.db.models import Person
from serversherpa.learning import library
from serversherpa.learning.access import require_manager
from serversherpa.learning.models import LearningDocument, LearningDocumentVersion
from serversherpa.learning.render import (
    LearningRenderRejected,
    LearningRenderUnavailable,
    html_with_images,
)
from serversherpa.learning.schemas import (
    SETTING_FIELDS,
    DocumentCreateIn,
    DocumentListItem,
    DocumentOut,
    DocumentPatchIn,
    DocumentSettings,
    PersonRef,
    PublishIn,
    VersionOut,
    VersionSummary,
    WikiPageOption,
    WikiPageRef,
)

router = APIRouter()


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail={"code": "not_found", "message": "Not found."})


async def _document(db, document_id: uuid.UUID) -> LearningDocument:
    document = await db.get(LearningDocument, document_id)
    if document is None:
        raise _not_found()
    return document


async def _people(db, ids) -> dict[uuid.UUID, PersonRef]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    people = (await db.scalars(select(Person).where(Person.id.in_(ids)))).all()
    return {p.id: PersonRef(id=p.id, name=p.display_name) for p in people}


def _summary(version: LearningDocumentVersion, people: dict) -> dict:
    return {"id": version.id, "version_no": version.version_no,
            "wiki_version_no": version.wiki_version_no, "title": version.title,
            "change_note": version.change_note, "published_at": version.published_at,
            "published_by": people.get(version.published_by)}


async def _version_out(db, version: LearningDocumentVersion) -> VersionOut:
    people = await _people(db, [version.published_by])
    return VersionOut(**_summary(version, people), html=await html_with_images(db, version))


async def _document_out(db, document: LearningDocument) -> DocumentOut:
    versions = list(await db.scalars(
        select(LearningDocumentVersion)
        .where(LearningDocumentVersion.document_id == document.id)
        .order_by(LearningDocumentVersion.version_no.desc())))
    current = next((v for v in versions if v.id == document.current_version_id), None)
    people = await _people(db, [v.published_by for v in versions])
    linked = await library.linked_page(db, document)
    wiki_page, has_changes = None, False
    if linked is not None:
        node, wiki_version = linked
        wiki_page = WikiPageRef(id=node.id, title=node.title,
                                published_version_no=wiki_version.version_no
                                if wiki_version else None)
        has_changes = wiki_version is not None and (
            current is None or current.wiki_version_id != wiki_version.id)
    return DocumentOut(
        id=document.id, title=document.title,
        **{key: getattr(document, key) for key in SETTING_FIELDS},
        wiki_node_id=document.wiki_node_id, wiki_page=wiki_page,
        has_wiki_changes=has_changes,
        current_version_id=document.current_version_id,
        current_version_no=current.version_no if current else None,
        current_html=await html_with_images(db, current) if current else None,
        versions=[VersionSummary(**_summary(v, people)) for v in versions],
        archived_at=document.archived_at, created_at=document.created_at,
        updated_at=document.updated_at)


@router.get("/documents", response_model=list[DocumentListItem])
async def list_documents(
    db: DbSession,
    include_archived: bool = False,
    actor: AuthContext = require_manager("view"),
) -> list[DocumentListItem]:
    return [DocumentListItem(**row)
            for row in await library.list_documents(db, include_archived=include_archived)]


@router.post("/documents", response_model=DocumentOut, status_code=201)
async def create_document(
    body: DocumentCreateIn,
    db: DbSession,
    actor: AuthContext = require_manager("add"),
) -> DocumentOut:
    settings = body.model_dump(include=set(SETTING_FIELDS), exclude_unset=True)
    document = await library.create_document(
        db, actor_id=actor.person.id, title=body.title, wiki_node_id=body.wiki_node_id,
        actor=actor, **settings)
    await db.commit()
    await db.refresh(document)
    return await _document_out(db, document)


@router.get("/documents/{document_id}", response_model=DocumentOut)
async def get_document(
    document_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> DocumentOut:
    return await _document_out(db, await _document(db, document_id))


@router.patch("/documents/{document_id}", response_model=DocumentOut)
async def patch_document(
    document_id: uuid.UUID,
    body: DocumentPatchIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> DocumentOut:
    document = await _document(db, document_id)
    changes = body.model_dump(exclude_unset=True)
    # the settings are checked as a whole once merged (a quiz needs a pass mark…)
    merged = {key: getattr(document, key) for key in SETTING_FIELDS}
    merged.update({k: v for k, v in changes.items() if k in SETTING_FIELDS})
    try:
        DocumentSettings.model_validate(merged)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors(include_url=False, include_context=False))
    await library.update_document(db, document, actor_id=actor.person.id, changes=changes,
                                  actor=actor)
    await db.commit()
    await db.refresh(document)
    return await _document_out(db, document)


@router.post("/documents/{document_id}/publish", response_model=VersionOut, status_code=201)
async def publish_document(
    document_id: uuid.UUID,
    body: PublishIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> VersionOut:
    document = await _document(db, document_id)
    try:
        version = await library.publish_version(
            db, document, actor_id=actor.person.id, change_note=body.change_note,
            actor=actor)
    except LearningRenderRejected:
        raise HTTPException(status_code=422, detail={
            "code": "render_rejected",
            "message": "The wiki couldn't render this page's content. Check the page in the wiki."})
    except LearningRenderUnavailable:
        raise HTTPException(status_code=503, detail={
            "code": "render_unavailable",
            "message": "The wiki couldn't render the page right now. Try again shortly."})
    await db.commit()
    await db.refresh(version)
    return await _version_out(db, version)


@router.get("/documents/{document_id}/versions/{version_id}", response_model=VersionOut)
async def get_version(
    document_id: uuid.UUID,
    version_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> VersionOut:
    version = await db.get(LearningDocumentVersion, version_id)
    if version is None or version.document_id != document_id:
        raise _not_found()
    return await _version_out(db, version)


@router.delete("/documents/{document_id}", status_code=204)
async def archive_document(
    document_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("delete"),
) -> Response:
    document = await _document(db, document_id)
    await library.archive_document(db, document, actor_id=actor.person.id)
    await db.commit()
    return Response(status_code=204)


@router.get("/wiki-pages", response_model=list[WikiPageOption])
async def wiki_pages(
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> list[WikiPageOption]:
    return [WikiPageOption(**row) for row in await library.wiki_pages(db, actor=actor)]
