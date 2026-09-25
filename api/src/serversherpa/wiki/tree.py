"""Node-tree helpers shared by every route that creates or publishes a
node: `create_node` (folders, pages, and — via Task 6's uploads flow —
files) and `publish_empty_home`, used once by space creation to publish
a brand-new home page's first version.

Callers are expected to `db.commit()` themselves once their whole
request (space + home page + grants, or a single node) is ready — these
helpers only `flush()`, so they compose inside a larger transaction.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    WikiNode, WikiPage, WikiPageVersion, WikiSpace,
)
from serversherpa.wiki.content import EMPTY_DOC, doc_to_text


async def _next_position(db: AsyncSession, *, space_id: uuid.UUID,
                         parent_id: uuid.UUID | None,
                         after_id: uuid.UUID | None) -> float:
    """Where a new sibling lands: appended after the last child when
    `after_id` is None (or unrecognized), otherwise squeezed in right
    after `after_id` (midpoint with its next sibling, or +1 if it's
    last)."""
    rows = (await db.execute(
        select(WikiNode.id, WikiNode.position)
        .where(WikiNode.space_id == space_id,
               WikiNode.parent_id == parent_id
               if parent_id is not None else WikiNode.parent_id.is_(None),
               WikiNode.deleted_at.is_(None))
        .order_by(WikiNode.position)
    )).all()
    if not rows:
        return 0.0
    if after_id is None:
        return rows[-1][1] + 1.0
    ids = [r[0] for r in rows]
    try:
        idx = ids.index(after_id)
    except ValueError:
        return rows[-1][1] + 1.0
    if idx == len(rows) - 1:
        return rows[idx][1] + 1.0
    return (rows[idx][1] + rows[idx + 1][1]) / 2.0


async def create_node(
    db: AsyncSession, *, space: WikiSpace, parent: WikiNode | None,
    kind: str, title: str, actor_id: uuid.UUID | None,
    after_id: uuid.UUID | None = None,
    initial_content: dict[str, Any] | None = None,
) -> WikiNode:
    """Create a node under `parent` (None = space root): sets `path` and
    `position`, and for a page also creates the 1:1 `wiki_pages` row. When
    `initial_content` is given (an import), the page starts with that
    content as an unpublished draft — `draft_json`/`draft_text` are set,
    `has_unpublished_changes` is True, and an `imported` version is
    recorded — the caller still has to publish it separately."""
    path = [*(parent.path or []), parent.id] if parent is not None else []
    position = await _next_position(
        db, space_id=space.id,
        parent_id=parent.id if parent is not None else None,
        after_id=after_id)

    node = WikiNode(
        space_id=space.id,
        parent_id=parent.id if parent is not None else None,
        path=path, kind=kind, title=title, position=position,
        owner_id=actor_id, created_by=actor_id, updated_by=actor_id,
    )
    db.add(node)
    await db.flush()

    if kind == "page":
        page = WikiPage(node_id=node.id)
        if initial_content is not None:
            page.draft_json = initial_content
            page.draft_text = doc_to_text(initial_content)
            page.has_unpublished_changes = True
        db.add(page)
        if initial_content is not None:
            db.add(WikiPageVersion(
                node_id=node.id, version_no=1, title=title,
                content_json=initial_content,
                content_text=doc_to_text(initial_content),
                kind="imported", created_by=actor_id,
            ))
        await db.flush()

    return node


async def publish_empty_home(db: AsyncSession, page_node: WikiNode,
                             actor_id: uuid.UUID | None) -> WikiPageVersion:
    """Publish version 1 of a freshly created home page with the empty
    doc. Only meant to run once, right after `create_node` makes the
    home page (with no `initial_content`) — it doesn't touch the draft,
    since a brand-new page has none."""
    version = WikiPageVersion(
        node_id=page_node.id, version_no=1, title=page_node.title,
        content_json=EMPTY_DOC, content_text=doc_to_text(EMPTY_DOC),
        kind="published", created_by=actor_id,
    )
    db.add(version)
    await db.flush()

    page = await db.get(WikiPage, page_node.id)
    assert page is not None
    page.published_version_id = version.id
    page.has_unpublished_changes = False
    return version
