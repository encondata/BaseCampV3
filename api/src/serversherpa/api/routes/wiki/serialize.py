"""Turning DB rows into the API contract's shapes: `space_out` and
`node_out` (plus the `person_ref` helper both lean on). This task's own
routes only need `space_out`; `node_out` is built now — full NodeOut
fidelity, including the `page`/`file` sub-shapes — so Task 4 (tree/node
routes) and onward can import it rather than re-deriving the shape.

`node_out` resolves owner/updated_by/page/file/space-key with per-node
lookups on `ctx.db`. That's fine for the single-node reads this task's
routes never even call it from; a route that serializes many nodes at
once (the tree listing, favorites, search) should batch-preload what it
can and is free to extend `WikiCtx` with a cache if that N+1 becomes a
real cost — nothing here assumes a single call shape."""
from __future__ import annotations

import uuid
from collections.abc import Iterable

from serversherpa.api.routes.wiki.deps import WikiCtx
from serversherpa.api.routes.wiki.schemas import (
    FileVersionOut, Level, NodeFileOut, NodeOut, NodePageOut, PersonRef, SpaceOut,
)
from serversherpa.db.models import (
    Person, WikiFile, WikiFileVersion, WikiNode, WikiPage, WikiPageVersion, WikiSpace,
)


async def person_ref(db, person_id: uuid.UUID | None) -> PersonRef | None:
    if person_id is None:
        return None
    person = await db.get(Person, person_id)
    if person is None:
        return None
    return PersonRef(id=person.id, name=person.display_name)


def space_out(space: WikiSpace, level: str | None) -> SpaceOut:
    return SpaceOut(
        id=space.id, key=str(space.key), name=space.name,
        description=space.description, icon=space.icon, color=space.color,
        home_node_id=space.home_node_id, archived_at=space.archived_at,
        my_level=level, settings=space.settings or {},
        created_at=space.created_at, updated_at=space.updated_at,
    )


async def _page_out(ctx: WikiCtx, node: WikiNode, home_node_id: uuid.UUID | None,
                    ) -> NodePageOut | None:
    page = await ctx.db.get(WikiPage, node.id)
    if page is None:
        return None
    published_at = None
    if page.published_version_id is not None:
        version = await ctx.db.get(WikiPageVersion, page.published_version_id)
        published_at = version.created_at if version else None
    return NodePageOut(
        is_home=(home_node_id == node.id),
        published_version_id=page.published_version_id,
        published_at=published_at,
        has_unpublished_changes=page.has_unpublished_changes,
    )


async def _file_out(ctx: WikiCtx, node: WikiNode) -> NodeFileOut | None:
    file_row = await ctx.db.get(WikiFile, node.id)
    if file_row is None:
        return None
    current: FileVersionOut | None = None
    if file_row.current_version_id is not None:
        version = await ctx.db.get(WikiFileVersion, file_row.current_version_id)
        if version is not None:
            current = FileVersionOut(
                id=version.id, version_no=version.version_no,
                filename=version.filename, content_type=version.content_type,
                size_bytes=version.size_bytes, preview_kind=version.preview_kind,
                preview_status=version.preview_status,
                extract_status=version.extract_status, note=version.note,
                uploaded_by=await person_ref(ctx.db, version.uploaded_by),
                created_at=version.created_at,
            )
    return NodeFileOut(description=file_row.description, current_version=current)


async def node_out(
    ctx: WikiCtx, node: WikiNode, level: Level | None, *,
    favorites: Iterable[uuid.UUID], has_children: Iterable[uuid.UUID],
) -> NodeOut:
    space = await ctx.db.get(WikiSpace, node.space_id)
    favorites = favorites if isinstance(favorites, (set, frozenset)) else set(favorites)
    has_children = (has_children if isinstance(has_children, (set, frozenset))
                    else set(has_children))

    page = await _page_out(ctx, node, space.home_node_id if space else None) \
        if node.kind == "page" else None
    file = await _file_out(ctx, node) if node.kind == "file" else None

    return NodeOut(
        id=node.id, space_id=node.space_id,
        space_key=str(space.key) if space else "",
        parent_id=node.parent_id, kind=node.kind, title=node.title,
        position=node.position, inherit_permissions=node.inherit_permissions,
        owner=await person_ref(ctx.db, node.owner_id),
        created_at=node.created_at, updated_at=node.updated_at,
        updated_by=await person_ref(ctx.db, node.updated_by),
        my_level=level, has_children=node.id in has_children,
        is_favorite=node.id in favorites, page=page, file=file,
    )
