"""Page drafts, versions and publishing — the rules behind the page routes
and the collab server's internal store.

- `store_draft` saves what the live editor holds (the Yjs update plus its
  ProseMirror JSON), keeps `has_unpublished_changes` honest, and takes an
  `autosave` version at most every AUTOSAVE_EVERY while content changes.
- `publish` snapshots the draft as a `published` version readers see.
- `add_version` is the one place a version row is numbered and written
  (autosave, published, restored, imported).

Like `tree`, these helpers only `flush()`; callers commit, and audit
the user-facing actions (publish, restore) themselves — autosaves are
too chatty to audit.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import WikiNode, WikiPage, WikiPageVersion
from serversherpa.wiki.content import (
    EMPTY_DOC,
    MAX_DOC_BYTES,
    doc_bytes,
    doc_text,
    docs_equal,
)

# the least time between two autosave versions of a page
AUTOSAVE_EVERY = timedelta(minutes=10)

# cursor/presence colors for live editing: 12 distinct hues dark enough
# to read as text (and carry white text) on a white page
PERSON_COLORS = (
    "#1f6feb", "#c2410c", "#15803d", "#9333ea", "#be123c", "#0e7490",
    "#a16207", "#4d7c0f", "#7c3aed", "#b91c1c", "#0369a1", "#9d174d",
)


def utcnow() -> datetime:
    """Now, as an aware UTC datetime (a seam tests patch)."""
    return datetime.now(UTC)


def person_color(person_id: uuid.UUID) -> str:
    """A person's stable color from PERSON_COLORS."""
    return PERSON_COLORS[int(person_id.hex, 16) % len(PERSON_COLORS)]


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def check_doc(content_json: object) -> dict:
    """`content_json` if it's a storable document: a `{"type": "doc", …}`
    object (else 422 `bad_doc`) of at most MAX_DOC_BYTES (else 413
    `too_large`)."""
    if not isinstance(content_json, dict) or content_json.get("type") != "doc":
        raise _err(422, "bad_doc", "The page content isn't a document.")
    if doc_bytes(content_json) > MAX_DOC_BYTES:
        raise _err(413, "too_large", "The page content is larger than 5 MB.")
    return content_json


async def _lock_page(db: AsyncSession, node_id: uuid.UUID) -> None:
    """Row-lock the page for the rest of the transaction, so two writers
    can't number versions (or publish) concurrently."""
    await db.execute(select(WikiPage.node_id)
                     .where(WikiPage.node_id == node_id).with_for_update())


async def add_version(db: AsyncSession, node: WikiNode, *, kind: str, title: str,
                      content_json: dict, actor_id: uuid.UUID | None,
                      note: str | None = None) -> WikiPageVersion:
    """Record the next version (1..n per page) of `node`'s content."""
    await _lock_page(db, node.id)
    last = await db.scalar(select(func.max(WikiPageVersion.version_no))
                           .where(WikiPageVersion.node_id == node.id))
    version = WikiPageVersion(
        node_id=node.id, version_no=(last or 0) + 1, title=title,
        content_json=content_json, content_text=doc_text(content_json),
        kind=kind, note=note, created_by=actor_id)
    db.add(version)
    await db.flush()
    return version


async def published_content(db: AsyncSession, page: WikiPage) -> dict | None:
    """The content readers see, or None for a never-published page."""
    if page.published_version_id is None:
        return None
    return await db.scalar(select(WikiPageVersion.content_json)
                           .where(WikiPageVersion.id == page.published_version_id))


async def store_draft(db: AsyncSession, page: WikiPage, node: WikiNode, *,
                      ydoc: bytes, content_json: dict,
                      editor_ids: list[uuid.UUID]) -> None:
    """Save the live editor's state as the page's draft.

    `editor_ids` are the people who edited since the last store, oldest
    first; the last one becomes `draft_updated_by` (and the node's
    `updated_by` when the content changed). An empty list leaves both
    as they were. When the content changed and the last autosave is
    AUTOSAVE_EVERY old (or there's none yet), an `autosave` version is
    taken too. Raises 422 `bad_doc` / 413 `too_large` (see `check_doc`)."""
    check_doc(content_json)
    now = utcnow()
    editor_id = editor_ids[-1] if editor_ids else None
    changed = not docs_equal(page.draft_json, content_json)

    page.ydoc = ydoc
    page.draft_json = content_json
    page.draft_text = doc_text(content_json)
    page.draft_updated_at = now
    if editor_id is not None:
        page.draft_updated_by = editor_id
    published = await published_content(db, page)
    page.has_unpublished_changes = (published is None
                                    or not docs_equal(content_json, published))

    if not changed:
        await db.flush()
        return
    node.updated_at = now
    if editor_id is not None:
        node.updated_by = editor_id
    last = page.last_autosave_version_at
    if last is None or now - last >= AUTOSAVE_EVERY:
        await add_version(db, node, kind="autosave", title=node.title,
                          content_json=content_json, actor_id=editor_id)
        page.last_autosave_version_at = now
    await db.flush()


async def publish(db: AsyncSession, node: WikiNode, page: WikiPage, *,
                  actor_id: uuid.UUID | None, note: str | None) -> WikiPageVersion:
    """Publish the current draft (the empty doc when there's none) as a
    `published` version. 409 `nothing_to_publish` when the page is
    already published and its draft adds nothing to that."""
    await _lock_page(db, node.id)
    await db.refresh(page)     # the draft as of the lock, not the request start
    published = await published_content(db, page)
    if page.published_version_id is not None and (
            page.draft_json is None or docs_equal(page.draft_json, published)):
        raise _err(409, "nothing_to_publish", "There are no changes to publish.")

    version = await add_version(
        db, node, kind="published", title=node.title,
        content_json=page.draft_json if page.draft_json is not None else EMPTY_DOC,
        actor_id=actor_id, note=note)
    page.published_version_id = version.id
    page.has_unpublished_changes = False
    node.updated_at = utcnow()
    node.updated_by = actor_id
    await db.flush()
    await refresh_search(db, node.id)
    return version


# Task 7 moves this into the search module and extends it (weights, file
# text); for now a page's index is its title plus its published text.
_REFRESH_SEARCH_SQL = text("""
    UPDATE wiki_nodes n SET search_tsv = to_tsvector('english',
        n.title || ' ' || coalesce((
            SELECT v.content_text FROM wiki_pages p
            JOIN wiki_page_versions v ON v.id = p.published_version_id
            WHERE p.node_id = n.id), ''))
    WHERE n.id = :node_id
""")


async def refresh_search(db: AsyncSession, node_id: uuid.UUID) -> None:
    """Recompute a node's `search_tsv` from its title and published text."""
    await db.execute(_REFRESH_SEARCH_SQL, {"node_id": node_id})
