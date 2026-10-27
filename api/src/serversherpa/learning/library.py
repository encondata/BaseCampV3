"""The learning library: documents linked to pages in the `learning` wiki
space, and their versions.

Publishing snapshots the wiki page's current published version — its
content and its HTML, rendered once (`render.py`) — as the document's next
version. Readers only ever see snapshots, so a wiki edit after publish, a
trashed page or a purged one (whose wiki history goes with it) never
changes or breaks what a worker reads and signs. `wiki_node_id` is set to
null by the database when the wiki purges the page.

The wiki's own visibility rules hold for the manager linking or
publishing a page: a private page (or one under a private folder) is
never linked or published, and the manager needs at least view on the
page (`AccessIndex.level_for_node`, as the wiki routes check it). The
"link a page" picker lists only pages that pass both. A caller without
an `AuthContext` (the seed CLI) skips the access check, not the private
rule.

Services never commit; each mutation adds a `learning_document_*` audit
row to the session."""
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext
from serversherpa.db.models import (
    Initiative,
    Person,
    WikiNode,
    WikiPage,
    WikiPageAsset,
    WikiPageVersion,
    WikiSpace,
)
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
from serversherpa.wiki.permissions import ANONYMOUS, AccessIndex, principal_for, viewable_nodes

ENTITY = "learning_document"


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _now() -> datetime:
    return datetime.now(UTC)


# ── the wiki side ────────────────────────────────────────────────────


async def _access_index(db: AsyncSession, actor: AuthContext | None) -> AccessIndex:
    principal = await principal_for(db, actor) if actor is not None else ANONYMOUS
    return AccessIndex(db, principal)


async def _learning_node(db: AsyncSession, node_id: uuid.UUID | None) -> WikiNode | None:
    """The live page node `node_id` in the learning space, or None."""
    if node_id is None:
        return None
    return await db.scalar(
        select(WikiNode).join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .where(WikiNode.id == node_id, WikiNode.kind == "page",
               WikiNode.deleted_at.is_(None), WikiSpace.key == LEARNING_SPACE_KEY))


async def learning_page(db: AsyncSession, node_id: uuid.UUID | None, *,
                        actor: AuthContext | None) -> WikiNode:
    """The page `node_id`, if a learning document may link it for `actor`:
    a live page in the learning space (else 422 `not_learning_page`),
    neither it nor an ancestor private (else 422 `private_page`), and —
    with an actor — at least view on it for them (else 403
    `wiki_forbidden`)."""
    node = await _learning_node(db, node_id)
    if node is None:
        raise _err(422, "not_learning_page",
                   "Pick a page in the Learning library of the wiki.")
    ix = await _access_index(db, actor)
    if await ix.is_private(node):
        raise _err(422, "private_page",
                   "This wiki page is private. Private pages can't be learning documents.")
    if actor is not None and await ix.level_for_node(node) is None:
        raise _err(403, "wiki_forbidden", "You don't have access to this wiki page.")
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
    the page is purged, trashed, made private or no longer in the
    learning space."""
    node = await _learning_node(db, document.wiki_node_id)
    if node is None or await AccessIndex(db, ANONYMOUS).is_private(node):
        return None
    return node, await published_wiki_version(db, node.id)


async def wiki_pages(db: AsyncSession, *, actor: AuthContext) -> list[dict]:
    """The live, non-private pages in the learning space that `actor` can
    view (`viewable_nodes`, the wiki listings' rule), with their
    ancestors' titles and published version number, for the "link a
    page" picker."""
    rows = (await db.execute(
        select(WikiNode, WikiPageVersion.version_no)
        .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .join(WikiPage, WikiPage.node_id == WikiNode.id)
        .outerjoin(WikiPageVersion, WikiPageVersion.id == WikiPage.published_version_id)
        .where(WikiSpace.key == LEARNING_SPACE_KEY, WikiNode.kind == "page",
               WikiNode.deleted_at.is_(None))
        .order_by(natural(WikiNode.title)))).all()
    ix = await _access_index(db, actor)
    shown, _ = await viewable_nodes(db, ix, [node for node, _ in rows])
    public = {n.id for n in shown if not await ix.is_private(n)}
    rows = [(node, no) for node, no in rows if node.id in public]
    ancestor_ids = {a for node, _ in rows for a in node.path or []}
    titles = dict((await db.execute(
        select(WikiNode.id, WikiNode.title).where(WikiNode.id.in_(ancestor_ids)))).all()
    ) if ancestor_ids else {}
    return [{"id": node.id, "title": node.title,
             "path": [titles[a] for a in node.path or [] if a in titles],
             "published_version_no": version_no} for node, version_no in rows]


# ── documents ────────────────────────────────────────────────────────


async def create_document(db: AsyncSession, *, actor_id: uuid.UUID | None, title: str,
                          wiki_node_id: uuid.UUID, actor: AuthContext | None = None,
                          **settings: Any) -> LearningDocument:
    """A new document linked to a learning-space page (`learning_page`'s
    checks). It has no version until published. Validity defaults to the
    learning settings' default_validity_days."""
    await learning_page(db, wiki_node_id, actor=actor)
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
                          actor_id: uuid.UUID | None, changes: dict[str, Any],
                          actor: AuthContext | None = None) -> None:
    """Apply already-validated setting `changes` (a re-link gets
    `learning_page`'s checks too)."""
    if changes.get("wiki_node_id") not in (None, document.wiki_node_id):
        await learning_page(db, changes["wiki_node_id"], actor=actor)
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


async def _refuse_unless_newer(db: AsyncSession, document: LearningDocument,
                               wiki_version: WikiPageVersion) -> None:
    """409 when the document can't take `wiki_version` as its next
    snapshot: `archived`; `no_changes` when it is the current snapshot;
    `stale_wiki_version` when the current snapshot is of a later version
    of the same page (two publishes raced and this one read the page
    first)."""
    if document.archived_at is not None:
        raise _err(409, "archived", "This document is archived.")
    if document.current_version_id is None:
        return
    current = await db.get(LearningDocumentVersion, document.current_version_id)
    if current is None or current.wiki_version_id is None:
        return
    if current.wiki_version_id == wiki_version.id:
        raise _err(409, "no_changes", "The wiki page hasn't changed since the last version.")
    # only comparable within one page (a re-link starts a new numbering)
    snapped = await db.get(WikiPageVersion, current.wiki_version_id)
    if (snapped is not None and snapped.node_id == wiki_version.node_id
            and wiki_version.version_no <= snapped.version_no):
        raise _err(409, "stale_wiki_version",
                   "A newer version of the wiki page is already published here.")


async def publish_version(db: AsyncSession, document: LearningDocument, *,
                          actor_id: uuid.UUID | None, change_note: str | None,
                          actor: AuthContext | None = None) -> LearningDocumentVersion:
    """Snapshot the wiki page's current published version as the
    document's next version and make it current.

    404 `wiki_page_missing` once the page is purged; `learning_page`'s
    refusals (trashed or moved out, private, no wiki access for `actor`);
    404 `wiki_not_published` when it has never been published; 409
    `archived` / `no_changes` / `stale_wiki_version`
    (`_refuse_unless_newer`); LearningRenderRejected or
    LearningRenderUnavailable when it can't be rendered.

    Rendering happens before the document row is locked, so a slow render
    server holds no lock; the 409 checks are repeated under the lock.
    Only images that are the snapshotted page's own assets are recorded
    (the share-link rule), so a page can't embed — and expose — another
    page's image."""
    if document.archived_at is not None:
        raise _err(409, "archived", "This document is archived.")
    if document.wiki_node_id is None:
        raise _err(404, "wiki_page_missing",
                   "The linked wiki page no longer exists. Link another page first.")
    node = await learning_page(db, document.wiki_node_id, actor=actor)
    wiki_version = await published_wiki_version(db, node.id)
    if wiki_version is None:
        raise _err(404, "wiki_not_published",
                   "Publish the wiki page first, then publish it here.")
    await _refuse_unless_newer(db, document, wiki_version)

    content = wiki_version.content_json or EMPTY_DOC
    content_html, image_ids = await render_version_html(content)
    if image_ids:
        own = set((await db.scalars(select(WikiPageAsset.id).where(
            WikiPageAsset.id.in_(image_ids), WikiPageAsset.node_id == node.id))).all())
        image_ids = [i for i in image_ids if i in own]

    document = await db.scalar(
        select(LearningDocument).where(LearningDocument.id == document.id)
        .with_for_update().execution_options(populate_existing=True))
    await _refuse_unless_newer(db, document, wiki_version)
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


async def list_signoffs(db: AsyncSession, document_id: uuid.UUID, *,
                        version_id: uuid.UUID | None = None,
                        limit: int = 50, offset: int = 0) -> dict:
    """A document's sign-offs, newest first: one page, the filtered total and
    the count per version. Never reads the signature images."""
    counts = {str(vid): n for vid, n in (await db.execute(
        select(LearningSignoff.version_id, func.count())
        .where(LearningSignoff.document_id == document_id)
        .group_by(LearningSignoff.version_id))).all()}
    total = (counts.get(str(version_id), 0) if version_id is not None
             else sum(counts.values()))
    query = (select(LearningSignoff.id, LearningSignoff.language, LearningSignoff.signed_at,
                    LearningSignoff.read_seconds, LearningSignoff.quiz_score,
                    LearningSignoff.initiative_id,
                    LearningDocumentVersion.version_no, Person.id, Person.preferred_name,
                    Person.first_name, Person.last_name, Initiative.name)
             .join(LearningDocumentVersion,
                   LearningDocumentVersion.id == LearningSignoff.version_id)
             .join(Person, Person.id == LearningSignoff.person_id)
             .outerjoin(Initiative, Initiative.id == LearningSignoff.initiative_id)
             .where(LearningSignoff.document_id == document_id)
             .order_by(LearningSignoff.signed_at.desc(), LearningSignoff.id)
             .limit(limit).offset(offset))
    if version_id is not None:
        query = query.where(LearningSignoff.version_id == version_id)
    items = [{
        "id": sid,
        "person": {"id": pid, "name": f"{preferred or first} {last}"},
        "version_no": version_no, "language": language, "signed_at": signed_at,
        "read_seconds": read_seconds, "quiz_score": quiz_score,
        "initiative_id": initiative_id, "initiative": initiative_name}
        for (sid, language, signed_at, read_seconds, quiz_score, initiative_id,
             version_no, pid, preferred, first, last, initiative_name)
        in (await db.execute(query)).all()]
    return {"total": total, "version_counts": counts, "items": items}
