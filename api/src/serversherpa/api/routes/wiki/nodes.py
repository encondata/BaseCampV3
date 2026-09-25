"""The node tree: create, list a level of the tree, read a node with its
breadcrumbs, rename, move, copy, delete (to the trash), favorites, and
the recent/drafts lists.

What a caller sees: live (not deleted) nodes they have a level on — and,
where they only have view, never a page that has no published version.
Every list serializes through `nodes_out`, so a listing costs a fixed
number of statements however long it is. A node the caller can't view
is a 404, a viewable one they lack the level on is a 403, and a tree
operation that can't be done (`tree.TreeError`) is a 422 with its code.
"""
from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import insert

from serversherpa.api.routes.wiki.deps import WikiContext, space_by_key
from serversherpa.api.routes.wiki.schemas import (
    Breadcrumb,
    NodeCopyIn,
    NodeCreateIn,
    NodeDeleteOut,
    NodeDetailOut,
    NodeMoveIn,
    NodeOut,
    NodePatchIn,
)
from serversherpa.api.routes.wiki.serialize import node_out, nodes_out, space_out
from serversherpa.db.models import Person, WikiFavorite, WikiNode, WikiPage, WikiSpace
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.wiki import tree
from serversherpa.wiki.permissions import (
    AccessIndex,
    level_rank,
    require_node_level,
    require_space_level,
)

router = APIRouter()

ELLIPSIS = "…"
RECENT_KINDS = ("page", "file")
DRAFTS_LIMIT = 50
NODE_FIELDS = ["title", "owner_id"]


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _not_found() -> HTTPException:
    return _err(404, "not_found", "Not found.")


def _forbidden(needed: str) -> HTTPException:
    return _err(403, "forbidden", f"You need {needed} access to do that.")


def _tree_error(exc: tree.TreeError) -> HTTPException:
    return _err(422, exc.code, exc.message)


def _is_edit(level: str | None) -> bool:
    return level_rank(level) >= level_rank("edit")


async def _visible(ctx: WikiContext, nodes: Sequence[WikiNode],
                   ) -> tuple[list[WikiNode], dict[uuid.UUID, str | None]]:
    """The live nodes the caller can see, in order, with their levels: a
    level of at least view, and — for view-only — not a never-published
    page. One extra query at most (the published check)."""
    live = [n for n in nodes if n.deleted_at is None]
    levels = await ctx.ix.levels_for_nodes(live)
    view_only_pages = [n.id for n in live
                       if n.kind == "page" and levels[n.id] == "view"]
    unpublished: set[uuid.UUID] = set()
    if view_only_pages:
        unpublished = set((await ctx.db.scalars(
            select(WikiPage.node_id).where(
                WikiPage.node_id.in_(view_only_pages),
                WikiPage.published_version_id.is_(None))
        )).all())
    return [n for n in live if levels[n.id] and n.id not in unpublished], levels


async def _destination(ctx: WikiContext, space_id: uuid.UUID,
                       parent_id: uuid.UUID | None,
                       ) -> tuple[WikiSpace, WikiNode | None, str | None]:
    """Resolve where a node is going: (space, parent, the caller's level
    there). 404 when the space, or the parent, isn't one they can view.
    Whether the parent can actually hold the node is `tree.check_parent`'s
    call (a 422), made after the caller's level has been checked."""
    space = await ctx.db.get(WikiSpace, space_id)
    if parent_id is None:
        space = await require_space_level(ctx.ix, space, "view")
        return space, None, await ctx.ix.level_for_space(space.id)
    parent = await ctx.db.get(WikiNode, parent_id)
    level = await ctx.ix.level_for_node(parent) if parent is not None else None
    if level is None or space is None:
        raise _not_found()
    return space, parent, level


async def _nodes_out_for(ctx: WikiContext, nodes: Sequence[WikiNode],
                         limit: int | None = None) -> list[NodeOut]:
    shown, levels = await _visible(ctx, nodes)
    if limit is not None:
        shown = shown[:limit]
    return await nodes_out(ctx, shown, levels)


# ── create ───────────────────────────────────────────────────────────


@router.post("/nodes", response_model=NodeOut, status_code=201)
async def create(body: NodeCreateIn, ctx: WikiContext) -> NodeOut:
    space, parent, level = await _destination(ctx, body.space_id, body.parent_id)
    try:
        tree.check_parent(parent, space.id)
    except tree.TreeError as exc:
        raise _tree_error(exc) from exc
    if not _is_edit(level):
        raise _forbidden("edit")

    actor_id = ctx.user.person.id
    node = await tree.create_node(
        ctx.db, space=space, parent=parent, kind=body.kind, title=body.title,
        actor_id=actor_id, after_id=body.after_id,
        initial_content=body.initial_content)
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
          entity_id=str(node.id), action="create",
          changes=diff({}, {"kind": node.kind, "title": node.title,
                            "space_id": str(space.id),
                            "parent_id": str(parent.id) if parent else None}))
    await ctx.db.commit()
    return await node_out(ctx, node, await ctx.ix.level_for_node(node))


# ── read ─────────────────────────────────────────────────────────────


@router.get("/spaces/{key}/tree", response_model=list[NodeOut])
async def list_tree(key: str, ctx: WikiContext,
                    parent_id: uuid.UUID | None = None) -> list[NodeOut]:
    space = await require_space_level(ctx.ix, await space_by_key(ctx.db, key), "view")
    if parent_id is not None:
        parent = await require_node_level(
            ctx.ix, await ctx.db.get(WikiNode, parent_id), "view")
        if parent.space_id != space.id:
            raise _not_found()
    children = (await ctx.db.scalars(
        select(WikiNode)
        .where(WikiNode.space_id == space.id,
               WikiNode.parent_id == parent_id if parent_id is not None
               else WikiNode.parent_id.is_(None),
               WikiNode.deleted_at.is_(None))
        .order_by(WikiNode.position, WikiNode.id)
    )).all()
    return await _nodes_out_for(ctx, children)


@router.get("/nodes/{node_id}", response_model=NodeDetailOut)
async def get_node(node_id: uuid.UUID, ctx: WikiContext) -> NodeDetailOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    level = await ctx.ix.level_for_node(node)

    breadcrumbs: list[Breadcrumb] = []
    if node.path:
        ancestors = {n.id: n for n in (await ctx.db.scalars(
            select(WikiNode).where(WikiNode.id.in_(node.path))
        )).all()}
        shown, _ = await _visible(ctx, list(ancestors.values()))
        shown_ids = {n.id for n in shown}
        for ancestor_id in node.path:
            ancestor = ancestors.get(ancestor_id)
            if ancestor is not None and ancestor_id in shown_ids:
                breadcrumbs.append(Breadcrumb(id=ancestor.id, title=ancestor.title,
                                              kind=ancestor.kind))
            else:
                breadcrumbs.append(Breadcrumb(id=None, title=ELLIPSIS, kind="folder"))

    space = await ctx.db.get(WikiSpace, node.space_id)
    out = await node_out(ctx, node, level)
    return NodeDetailOut(
        **out.model_dump(), breadcrumbs=breadcrumbs,
        space=space_out(space, await ctx.ix.level_for_space(space.id)))


# ── rename / owner ───────────────────────────────────────────────────


@router.patch("/nodes/{node_id}", response_model=NodeOut)
async def patch_node(node_id: uuid.UUID, body: NodePatchIn, ctx: WikiContext) -> NodeOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "edit")
    if body.owner_id is not None and await ctx.db.get(Person, body.owner_id) is None:
        raise _err(422, "bad_owner", "That owner doesn't exist.")

    before = snapshot(node, NODE_FIELDS)
    if body.title is not None:
        node.title = body.title
    if body.owner_id is not None:
        node.owner_id = body.owner_id
    changes = diff(before, snapshot(node, NODE_FIELDS))
    if changes:
        actor_id = ctx.user.person.id
        node.updated_by = actor_id
        node.updated_at = datetime.now(UTC)
        audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
              entity_id=str(node.id), action="update", changes=changes)
        await ctx.db.commit()
    return await node_out(ctx, node, await ctx.ix.level_for_node(node))


# ── move / copy ──────────────────────────────────────────────────────


@router.post("/nodes/{node_id}/move", response_model=NodeOut)
async def move(node_id: uuid.UUID, body: NodeMoveIn, ctx: WikiContext) -> NodeOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "edit")
    space, parent, dest_level = await _destination(
        ctx, body.space_id or node.space_id, body.parent_id)
    if space.id != node.space_id and await ctx.ix.level_for_node(node) != "manage":
        raise _forbidden("manage")
    if not _is_edit(dest_level):
        raise _forbidden("edit")

    fields = ["space_id", "parent_id", "position"]
    before = snapshot(node, fields)
    try:
        await tree.move_node(ctx.db, node, new_parent=parent, new_space=space,
                             before_id=body.before_id, after_id=body.after_id)
    except tree.TreeError as exc:
        raise _tree_error(exc) from exc
    audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_node",
          entity_id=str(node.id), action="move",
          changes=diff(before, snapshot(node, fields)))
    await ctx.db.commit()

    # the node's chain (and, across spaces, its grants' space) changed —
    # the request's AccessIndex has the old picture cached
    fresh_ix = AccessIndex(ctx.db, ctx.principal)
    return await node_out(ctx, node, await fresh_ix.level_for_node(node))


@router.post("/nodes/{node_id}/copy", response_model=NodeOut, status_code=201)
async def copy(node_id: uuid.UUID, body: NodeCopyIn, ctx: WikiContext) -> NodeOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    shown, _ = await _visible(ctx, [node])
    if not shown:
        raise _not_found()
    space, parent, dest_level = await _destination(
        ctx, body.space_id or node.space_id, body.parent_id)
    if not _is_edit(dest_level):
        raise _forbidden("edit")

    subtree = (await ctx.db.scalars(
        select(WikiNode).where(WikiNode.path.contains([node.id]),
                               WikiNode.deleted_at.is_(None))
    )).all()
    levels = await ctx.ix.levels_for_nodes([node, *subtree])

    actor_id = ctx.user.person.id
    try:
        new_root = await tree.copy_subtree(ctx.db, node, dest_parent=parent,
                                           dest_space=space, actor_id=actor_id,
                                           levels=levels)
    except tree.TreeError as exc:
        raise _tree_error(exc) from exc
    count = len(await tree.subtree_ids(ctx.db, new_root))
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
          entity_id=str(new_root.id), action="copy",
          changes={"from": str(node.id), "count": count})
    await ctx.db.commit()
    return await node_out(ctx, new_root, await ctx.ix.level_for_node(new_root))


# ── delete (to the trash) ────────────────────────────────────────────


@router.delete("/nodes/{node_id}", response_model=NodeDeleteOut)
async def delete_node(node_id: uuid.UUID, ctx: WikiContext) -> NodeDeleteOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "edit")
    home_id = await ctx.db.scalar(
        select(WikiSpace.home_node_id).where(WikiSpace.id == node.space_id))
    if home_id == node.id:
        raise _err(422, "is_home", "The space home page can't be deleted.")

    actor_id = ctx.user.person.id
    batch_id = uuid.uuid4()
    result = await ctx.db.execute(
        update(WikiNode)
        .where(or_(WikiNode.id == node.id, WikiNode.path.contains([node.id])),
               WikiNode.deleted_at.is_(None))
        .values(deleted_at=datetime.now(UTC), deleted_by=actor_id,
                deleted_batch=batch_id)
        .execution_options(synchronize_session=False))
    count = result.rowcount
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
          entity_id=str(node.id), action="delete",
          changes={"batch_id": str(batch_id), "count": count})
    await ctx.db.commit()
    return NodeDeleteOut(batch_id=batch_id, count=count)


# ── favorites ────────────────────────────────────────────────────────


@router.put("/nodes/{node_id}/favorite", status_code=204)
async def add_favorite(node_id: uuid.UUID, ctx: WikiContext) -> Response:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    await ctx.db.execute(
        insert(WikiFavorite)
        .values(person_id=ctx.principal.person_id, node_id=node.id)
        .on_conflict_do_nothing())
    await ctx.db.commit()
    return Response(status_code=204)


@router.delete("/nodes/{node_id}/favorite", status_code=204)
async def remove_favorite(node_id: uuid.UUID, ctx: WikiContext) -> Response:
    # only ever removes the caller's own row, so it needs no level on the
    # node (and says nothing about whether it exists)
    fav = await ctx.db.get(WikiFavorite, (ctx.principal.person_id, node_id))
    if fav is not None:
        await ctx.db.delete(fav)
        await ctx.db.commit()
    return Response(status_code=204)


@router.get("/favorites", response_model=list[NodeOut])
async def list_favorites(ctx: WikiContext) -> list[NodeOut]:
    nodes = (await ctx.db.scalars(
        select(WikiNode)
        .join(WikiFavorite, WikiFavorite.node_id == WikiNode.id)
        .where(WikiFavorite.person_id == ctx.principal.person_id,
               WikiNode.deleted_at.is_(None))
        .order_by(WikiFavorite.created_at.desc(), WikiNode.id)
    )).all()
    return await _nodes_out_for(ctx, nodes)


# ── recent / drafts ──────────────────────────────────────────────────

# /recent reads newest-first in chunks, keeping what the caller can see,
# until it has `limit` — at most this many chunks, so a caller who can
# see little of a big wiki doesn't scan all of it
RECENT_MAX_CHUNKS = 10


@router.get("/recent", response_model=list[NodeOut])
async def list_recent(ctx: WikiContext, space: str | None = None,
                      limit: int = Query(20, ge=1, le=50)) -> list[NodeOut]:
    q = select(WikiNode).where(WikiNode.deleted_at.is_(None),
                               WikiNode.kind.in_(RECENT_KINDS))
    if space is not None:
        space_row = await require_space_level(
            ctx.ix, await space_by_key(ctx.db, space), "view")
        q = q.where(WikiNode.space_id == space_row.id)
    else:
        q = (q.join(WikiSpace, WikiSpace.id == WikiNode.space_id)
             .where(WikiSpace.archived_at.is_(None)))
    q = q.order_by(WikiNode.updated_at.desc(), WikiNode.id)

    chunk = max(limit * 3, 50)
    shown: list[WikiNode] = []
    levels: dict[uuid.UUID, str | None] = {}
    for i in range(RECENT_MAX_CHUNKS):
        rows = (await ctx.db.scalars(q.offset(i * chunk).limit(chunk))).all()
        visible, chunk_levels = await _visible(ctx, rows)
        shown.extend(visible)
        levels.update(chunk_levels)
        if len(shown) >= limit or len(rows) < chunk:
            break
    return await nodes_out(ctx, shown[:limit], levels)


@router.get("/drafts", response_model=list[NodeOut])
async def list_drafts(ctx: WikiContext) -> list[NodeOut]:
    nodes = (await ctx.db.scalars(
        select(WikiNode)
        .join(WikiPage, WikiPage.node_id == WikiNode.id)
        .where(WikiNode.deleted_at.is_(None),
               WikiPage.has_unpublished_changes.is_(True),
               WikiPage.draft_updated_by == ctx.principal.person_id)
        .order_by(WikiPage.draft_updated_at.desc().nulls_last(), WikiNode.id)
        .limit(DRAFTS_LIMIT)
    )).all()
    levels = await ctx.ix.levels_for_nodes(nodes)
    editable = [n for n in nodes if _is_edit(levels[n.id])]
    return await nodes_out(ctx, editable, levels)
