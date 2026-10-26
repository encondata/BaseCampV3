"""The learning library: documents linked to pages in the `learning` wiki
space, and their versions.

Publishing snapshots the wiki page's current published version — its
content and its HTML, rendered once (`render.py`) — as the document's next
version. Readers only ever see snapshots, so a wiki edit after publish, a
trashed page or a purged one (whose wiki history goes with it) never
changes or breaks what a worker reads and signs. `wiki_node_id` is set to
null by the database when the wiki purges the page.

Services never commit; each mutation adds a `learning_document_*` audit
row to the session."""
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import WikiNode, WikiPage, WikiPageVersion, WikiSpace
from serversherpa.db.ordering import natural
from serversherpa.learning import LEARNING_SPACE_KEY
from serversherpa.learning.models import (
    LearningDocument,
    LearningDocumentVersion,
    LearningPacket,
    LearningPacketItem,
    LearningSignoff,
    LearningTranslation,
)
from serversherpa.learning.render import render_version_html
from serversherpa.learning.settings import load_settings
from serversherpa.services.audit import audit, diff
from serversherpa.wiki.content import EMPTY_DOC

ENTITY = "learning_document"


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _now() -> datetime:
    return datetime.now(UTC)


# ── the wiki side ────────────────────────────────────────────────────


async def learning_page(db: AsyncSession, node_id: uuid.UUID | None) -> WikiNode:
    """The live page node `node_id` in the learning space, else 422
    `not_learning_page`."""
    node = None
    if node_id is not None:
        node = await db.scalar(
            select(WikiNode).join(WikiSpace, WikiSpace.id == WikiNode.space_id)
            .where(WikiNode.id == node_id, WikiNode.kind == "page",
                   WikiNode.deleted_at.is_(None), WikiSpace.key == LEARNING_SPACE_KEY))
    if node is None:
        raise _err(422, "not_learning_page",
                   "Pick a page in the Learning library of the wiki.")
    return node


async def published_wiki_version(db: AsyncSession, node_id: uuid.UUID) -> WikiPageVersion | None:
    """The page's current published version (the only one readers see)."""
    page = await db.get(WikiPage, node_id)
    if page is None or page.published_version_id is None:
        return None
    return await db.get(WikiPageVersion, page.published_version_id)


async def linked_page(db: AsyncSession, document: LearningDocument,
                      ) -> tuple[WikiNode, WikiPageVersion | None] | None:
    """The document's wiki page and its published version, or None once
    the page is purged, trashed or no longer in the learning space."""
    if document.wiki_node_id is None:
        return None
    try:
        node = await learning_page(db, document.wiki_node_id)
    except HTTPException:
        return None
    return node, await published_wiki_version(db, node.id)


async def wiki_pages(db: AsyncSession) -> list[dict]:
    """Every live page in the learning space with its ancestors' titles
    and its published version number, for the "link a page" picker."""
    rows = (await db.execute(
        select(WikiNode, WikiPageVersion.version_no)
        .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .join(WikiPage, WikiPage.node_id == WikiNode.id)
        .outerjoin(WikiPageVersion, WikiPageVersion.id == WikiPage.published_version_id)
        .where(WikiSpace.key == LEARNING_SPACE_KEY, WikiNode.kind == "page",
               WikiNode.deleted_at.is_(None))
        .order_by(natural(WikiNode.title)))).all()
    ancestor_ids = {a for node, _ in rows for a in node.path or []}
    titles = dict((await db.execute(
        select(WikiNode.id, WikiNode.title).where(WikiNode.id.in_(ancestor_ids)))).all()
    ) if ancestor_ids else {}
    return [{"id": node.id, "title": node.title,
             "path": [titles[a] for a in node.path or [] if a in titles],
             "published_version_no": version_no} for node, version_no in rows]


# ── documents ────────────────────────────────────────────────────────


async def create_document(db: AsyncSession, *, actor_id: uuid.UUID | None, title: str,
                          wiki_node_id: uuid.UUID, **settings: Any) -> LearningDocument:
    """A new document linked to a learning-space page (422
    `not_learning_page` otherwise). It has no version until published.
    Validity defaults to the learning settings' default_validity_days."""
    await learning_page(db, wiki_node_id)
    if "validity_days" not in settings:
        settings["validity_days"] = (await load_settings(db)).default_validity_days
    document = LearningDocument(title=title, wiki_node_id=wiki_node_id,
                                created_by=actor_id, **settings)
    db.add(document)
    await db.flush()
    audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(document.id),
          action="learning_document_create",
          changes={"title": title, "wiki_node_id": str(wiki_node_id), **{
              k: v for k, v in settings.items() if v is not None}})
    return document


async def update_document(db: AsyncSession, document: LearningDocument, *,
                          actor_id: uuid.UUID | None, changes: dict[str, Any]) -> None:
    """Apply already-validated setting `changes` (a re-link is checked
    against the learning space too)."""
    if changes.get("wiki_node_id") not in (None, document.wiki_node_id):
        await learning_page(db, changes["wiki_node_id"])
    before = {key: getattr(document, key) for key in changes}
    for key, value in changes.items():
        setattr(document, key, value)
    delta = diff(before, changes)
    if delta:
        document.updated_at = _now()
        audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(document.id),
              action="learning_document_update", changes=delta)


async def archive_document(db: AsyncSession, document: LearningDocument, *,
                           actor_id: uuid.UUID | None) -> None:
    if document.archived_at is not None:
        return
    document.archived_at = document.updated_at = _now()
    audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(document.id),
          action="learning_document_archive")


async def publish_version(db: AsyncSession, document: LearningDocument, *,
                          actor_id: uuid.UUID | None,
                          change_note: str | None) -> LearningDocumentVersion:
    """Snapshot the wiki page's current published version as the
    document's next version and make it current.

    404 `wiki_page_missing` once the page is purged, 422
    `not_learning_page` when it's trashed or moved out of the learning
    space, 404 `wiki_not_published` when it has never been published, 409
    `no_changes` when that version is already the current snapshot, and
    LearningRenderUnavailable when it can't be rendered. Rendering happens
    before the document row is locked, so a slow render server holds no
    lock; the checks are repeated under the lock. An archived document
    can't be published (409 `archived`)."""
    if document.archived_at is not None:
        raise _err(409, "archived", "This document is archived.")
    if document.wiki_node_id is None:
        raise _err(404, "wiki_page_missing",
                   "The linked wiki page no longer exists. Link another page first.")
    node = await learning_page(db, document.wiki_node_id)
    wiki_version = await published_wiki_version(db, node.id)
    if wiki_version is None:
        raise _err(404, "wiki_not_published",
                   "Publish the wiki page first, then publish it here.")

    async def unchanged() -> bool:
        if document.current_version_id is None:
            return False
        current = await db.get(LearningDocumentVersion, document.current_version_id)
        return current is not None and current.wiki_version_id == wiki_version.id

    if await unchanged():
        raise _err(409, "no_changes", "The wiki page hasn't changed since the last version.")
    content = wiki_version.content_json or EMPTY_DOC
    content_html, image_ids = await render_version_html(content)

    document = await db.scalar(
        select(LearningDocument).where(LearningDocument.id == document.id)
        .with_for_update().execution_options(populate_existing=True))
    if await unchanged():
        raise _err(409, "no_changes", "The wiki page hasn't changed since the last version.")
    last = await db.scalar(select(func.max(LearningDocumentVersion.version_no))
                           .where(LearningDocumentVersion.document_id == document.id))
    version = LearningDocumentVersion(
        document_id=document.id, version_no=(last or 0) + 1,
        wiki_version_id=wiki_version.id, wiki_version_no=wiki_version.version_no,
        title=wiki_version.title, content_json=content, content_html=content_html,
        image_asset_ids=image_ids, change_note=change_note or None, published_by=actor_id)
    db.add(version)
    await db.flush()
    document.current_version_id = version.id
    document.updated_at = _now()
    audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(document.id),
          action="learning_document_publish",
          changes={"version_no": version.version_no, "version_id": str(version.id),
                   "wiki_version_no": wiki_version.version_no,
                   "change_note": version.change_note})
    return version


async def list_documents(db: AsyncSession, *, include_archived: bool = False) -> list[dict]:
    """The library list: each document with its current version, the
    packets it's in, its sign-off count and per-language translation
    status (`out_of_date` when the newest translation is of an older
    version)."""
    query = (select(LearningDocument, LearningDocumentVersion)
             .outerjoin(LearningDocumentVersion,
                        LearningDocumentVersion.id == LearningDocument.current_version_id)
             .order_by(natural(LearningDocument.title)))
    if not include_archived:
        query = query.where(LearningDocument.archived_at.is_(None))
    rows = (await db.execute(query)).all()
    ids = [doc.id for doc, _ in rows]
    if not ids:
        return []

    packets: dict[uuid.UUID, list[str]] = {}
    for doc_id, name in (await db.execute(
            select(LearningPacketItem.document_id, LearningPacket.name)
            .join(LearningPacket, LearningPacket.id == LearningPacketItem.packet_id)
            .where(LearningPacketItem.document_id.in_(ids),
                   LearningPacket.archived_at.is_(None))
            .order_by(natural(LearningPacket.name)))).all():
        packets.setdefault(doc_id, []).append(name)

    signoffs = dict((await db.execute(
        select(LearningSignoff.document_id, func.count())
        .where(LearningSignoff.document_id.in_(ids))
        .group_by(LearningSignoff.document_id))).all())

    # newest translation per (document, language): highest version number
    languages: dict[uuid.UUID, dict[str, str]] = {}
    current = {doc.id: doc.current_version_id for doc, _ in rows}
    for doc_id, language, status, version_id in (await db.execute(
            select(LearningDocumentVersion.document_id, LearningTranslation.language,
                   LearningTranslation.status, LearningTranslation.version_id)
            .join(LearningDocumentVersion,
                  LearningDocumentVersion.id == LearningTranslation.version_id)
            .where(LearningDocumentVersion.document_id.in_(ids))
            .order_by(LearningDocumentVersion.version_no))).all():
        languages.setdefault(doc_id, {})[language] = (
            status if version_id == current[doc_id] else "out_of_date")

    return [{"id": doc.id, "title": doc.title,
             "current_version_no": version.version_no if version else None,
             "published_at": version.published_at if version else None,
             "packets": packets.get(doc.id, []),
             "signoff_count": signoffs.get(doc.id, 0),
             "languages": languages.get(doc.id, {}),
             "archived_at": doc.archived_at} for doc, version in rows]
