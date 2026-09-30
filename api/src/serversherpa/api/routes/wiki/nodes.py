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

from serversherpa.api.routes.wiki.deps import (
    WikiContext,
    destination,
    lock_and_reread,
    space_by_key,
    visible_nodes,
)
from serversherpa.api.routes.wiki.errors import conflict, err, forbidden, is_edit, not_found
from serversherpa.api.routes.wiki.schemas import (
    Breadcrumb,
    NodeCopyIn,
    NodeCreateIn,
    NodeDeleteOut,
    NodeDetailOut,
    NodeMoveIn,
    NodeOut,
    NodePatchIn,
    PrintingIn,
    PrivacyIn,
)
from serversherpa.api.routes.wiki.serialize import node_out, nodes_out, space_out
from serversherpa.api.routes.wiki.templates import template_visible
from serversherpa.db.models import Person, WikiFavorite, WikiNode, WikiPage, WikiSpace, WikiTemplate
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.wiki import notify, reviews, tree
from serversherpa.wiki.content import strip_comment_marks
from serversherpa.wiki.pages import check_doc
from serversherpa.wiki.permissions import (
    AccessIndex,
    can_set_private,
    require_node_level,
    require_space_level,
)
from serversherpa.wiki.search import refresh_search

router = APIRouter()

ELLIPSIS = "…"
RECENT_KINDS = ("page", "file")
DRAFTS_LIMIT = 50
NODE_FIELDS = ["title", "owner_id"]
REVIEW_FIELDS = ["review_interval_months", "next_review_at"]
PRIVACY_FIELDS = ["is_private"]
PRINTING_FIELDS = ["allow_printing"]


def _tree_error(exc: tree.TreeError) -> HTTPException:
    if exc.code == "conflict":
        return conflict()
    return err(422, exc.code, exc.message)


async def _nodes_out_for(ctx: WikiContext, nodes: Sequence[WikiNode],
                         limit: int | None = None) -> list[NodeOut]:
    shown, levels = await visible_nodes(ctx, nodes)
    if limit is not None:
        shown = shown[:limit]
    return await nodes_out(ctx, shown, levels)


# ── create ───────────────────────────────────────────────────────────


@router.post("/nodes", response_model=NodeOut, status_code=201)
async def create(body: NodeCreateIn, ctx: WikiContext) -> NodeOut:
    # locked first, so the parent is read (and checked) as committed now
    await tree.lock_space_trees(ctx.db, body.space_id)
    space, parent, level = await destination(ctx, body.space_id, body.parent_id)
    if not is_edit(level):
        raise forbidden("edit")
    try:
        tree.check_parent(parent, space.id)
    except tree.TreeError as exc:
        raise _tree_error(exc) from exc

    title = body.title
    initial_content = (check_doc(body.initial_content)
                       if body.initial_content is not None else None)
    template: WikiTemplate | None = None
    if body.template_id is not None:
        template = await ctx.db.get(WikiTemplate, body.template_id)
        if template is None or not await template_visible(ctx, template):
            raise not_found()
        title = title or template.name
        # a template stores none, but one saved before that rule might
        initial_content = strip_comment_marks(check_doc(template.content_json))

    actor_id = ctx.user.person.id
    node = await tree.create_node(
        ctx.db, space=space, parent=parent, kind=body.kind, title=title,
        actor_id=actor_id, after_id=body.after_id,
        initial_content=initial_content)
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
          entity_id=str(node.id), action="create",
          changes=diff({}, {"kind": node.kind, "title": node.title,
                            "space_id": str(space.id),
                            "parent_id": str(parent.id) if parent else None,
                            "template_id": str(template.id) if template else None}))
    await notify.auto_watch(ctx.db, actor_id, node.id)
    await notify.on_created(ctx.db, node, actor_id=actor_id)
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
            raise not_found()
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
        shown, _ = await visible_nodes(ctx, list(ancestors.values()))
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
    """Rename or re-own (edit); set a page's review interval (manage)."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "edit")
    if body.owner_id is not None and await ctx.db.get(Person, body.owner_id) is None:
        raise err(422, "bad_owner", "That owner doesn't exist.")
    set_interval = "review_interval_months" in body.model_fields_set
    if set_interval:
        if node.kind != "page":
            raise err(422, "not_a_page", "Only pages have a review interval.")
        if await ctx.ix.level_for_node(node) != "manage":
            raise forbidden("manage")

    actor_id = ctx.user.person.id
    before = snapshot(node, NODE_FIELDS)
    if body.title is not None:
        node.title = body.title
    if body.owner_id is not None:
        node.owner_id = body.owner_id
    changes = diff(before, snapshot(node, NODE_FIELDS))
    if changes:
        node.updated_by = actor_id
        node.updated_at = datetime.now(UTC)
        audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
              entity_id=str(node.id), action="update", changes=changes)
        if "title" in changes:
            await refresh_search(ctx.db, node.id)
    review_changes = {}
    if set_interval:
        before = snapshot(node, REVIEW_FIELDS)
        await reviews.set_interval(ctx.db, node, await ctx.db.get(WikiPage, node.id),
                                   body.review_interval_months)
        review_changes = diff(before, snapshot(node, REVIEW_FIELDS))
        if review_changes:
            audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
                  entity_id=str(node.id), action="review_interval", changes=review_changes)
    if changes or review_changes:
        await ctx.db.commit()
    return await node_out(ctx, node, await ctx.ix.level_for_node(node))


# ── privacy / printing ───────────────────────────────────────────────


@router.patch("/nodes/{node_id}/privacy", response_model=NodeOut)
async def set_privacy(node_id: uuid.UUID, body: PrivacyIn, ctx: WikiContext) -> NodeOut:
    """Mark an item private, or clear it. Only its author or a developer
    may — not a manager, not a wiki administrator — and never the library's
    home page (which everyone who can see the library opens). An archived
    library is read-only, so only a wiki administrator may change it there."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    if not can_set_private(ctx.principal, node):
        raise err(403, "forbidden", "Only the author or a developer can change this.")
    space = await ctx.db.get(WikiSpace, node.space_id)
    # an archived library is read-only for everyone but a wiki administrator
    if space.archived_at is not None and not ctx.principal.is_admin:
        raise forbidden("edit")
    if space.home_node_id == node.id:
        raise err(422, "home_page", "The library's home page can't be private.")

    if node.is_private != body.is_private:
        before = snapshot(node, PRIVACY_FIELDS)
        node.is_private = body.is_private
        audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_node",
              entity_id=str(node.id), action="privacy",
              changes=diff(before, snapshot(node, PRIVACY_FIELDS)))
        await ctx.db.commit()
    # the collab server's re-check (it goes through `level_for_node`)
    # disconnects anyone who lost access to a live page
    return await node_out(ctx, node, await ctx.ix.level_for_node(node))


@router.patch("/nodes/{node_id}/printing", response_model=NodeOut)
async def set_printing(node_id: uuid.UUID, body: PrintingIn, ctx: WikiContext) -> NodeOut:
    """Set whether an item (and, unless they set their own, everything
    under it) can be printed; null goes back to inheriting. Manage."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "manage")

    if node.allow_printing != body.allow_printing:
        before = snapshot(node, PRINTING_FIELDS)
        node.allow_printing = body.allow_printing
        audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_node",
              entity_id=str(node.id), action="printing",
              changes=diff(before, snapshot(node, PRINTING_FIELDS)))
        await ctx.db.commit()
    return await node_out(ctx, node, await ctx.ix.level_for_node(node))


# ── move / copy ──────────────────────────────────────────────────────


async def _refuse_hidden_descendants(ctx: WikiContext, node: WikiNode) -> None:
    """409 `hidden_items` when `node`'s live subtree holds anything the
    caller can't see — a descendant behind broken inheritance, or a
    never-published page they only have view on (`visible_nodes`, the
    tree's own rule): a delete or cross-space move would act on content
    its owner never shared with them — and a cross-space move would hand
    it to the destination space's managers. Private items are hidden
    from wiki administrators too, so they hit this like anyone."""
    subtree = (await ctx.db.scalars(
        select(WikiNode).where(WikiNode.path.contains([node.id]),
                               WikiNode.deleted_at.is_(None))
    )).all()
    shown, _ = await visible_nodes(ctx, subtree)
    if len(shown) < len(subtree):
        raise err(409, "hidden_items",
                  "This contains items you can't see, so you can't move it to another "
                  "library or delete it. Ask a library manager.")


@router.post("/nodes/{node_id}/move", response_model=NodeOut)
async def move(node_id: uuid.UUID, body: NodeMoveIn, ctx: WikiContext) -> NodeOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "edit")
    node = await lock_and_reread(ctx, node, "edit", body.space_id or node.space_id)
    space, parent, dest_level = await destination(
        ctx, body.space_id or node.space_id, body.parent_id)
    if space.id != node.space_id and await ctx.ix.level_for_node(node) != "manage":
        raise forbidden("manage")
    if not is_edit(dest_level):
        raise forbidden("edit")
    if space.id != node.space_id:
        # within its space a hidden descendant keeps its own grants; moved
        # out, the destination's managers would gain it
        await _refuse_hidden_descendants(ctx, node)

    fields = ["space_id", "parent_id", "position", "allow_printing"]
    before = snapshot(node, fields)
    # inheriting "off" from where it is: moving out must never turn printing on
    pin_printing_off = node.allow_printing is None and not await ctx.ix.can_print(node)
    try:
        await tree.move_node(ctx.db, node, new_parent=parent, new_space=space,
                             before_id=body.before_id, after_id=body.after_id)
    except tree.TreeError as exc:
        raise _tree_error(exc) from exc
    if pin_printing_off:
        node.allow_printing = False
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
    node = await lock_and_reread(ctx, node, "view", body.space_id or node.space_id)
    shown, _ = await visible_nodes(ctx, [node])
    if not shown:
        raise not_found()
    space, parent, dest_level = await destination(
        ctx, body.space_id or node.space_id, body.parent_id)
    if not is_edit(dest_level):
        raise forbidden("edit")

    subtree = (await ctx.db.scalars(
        select(WikiNode).where(WikiNode.path.contains([node.id]),
                               WikiNode.deleted_at.is_(None))
    )).all()
    levels = await ctx.ix.levels_for_nodes([node, *subtree])

    actor_id = ctx.user.person.id
    try:
        new_root = await tree.copy_subtree(ctx.db, node, dest_parent=parent,
                                           dest_space=space, actor_id=actor_id,
                                           levels=levels,
                                           printing_off=not await ctx.ix.can_print(node))
    except tree.TreeError as exc:
        raise _tree_error(exc) from exc
    new_ids = await tree.subtree_ids(ctx.db, new_root)
    for new_id in new_ids:
        await refresh_search(ctx.db, new_id)
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
          entity_id=str(new_root.id), action="copy",
          changes={"from": str(node.id), "count": len(new_ids)})
    if new_root.kind != "file":
        await notify.auto_watch(ctx.db, actor_id, new_root.id)
    await notify.on_created(ctx.db, new_root, actor_id=actor_id)
    await ctx.db.commit()
    return await node_out(ctx, new_root, await ctx.ix.level_for_node(new_root))


# ── delete (to the trash) ────────────────────────────────────────────


@router.delete("/nodes/{node_id}", response_model=NodeDeleteOut)
async def delete_node(node_id: uuid.UUID, ctx: WikiContext) -> NodeDeleteOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "edit")
    node = await lock_and_reread(ctx, node, "edit")
    home_id = await ctx.db.scalar(
        select(WikiSpace.home_node_id).where(WikiSpace.id == node.space_id))
    if home_id == node.id:
        raise err(422, "is_home", "The library's home page can't be deleted.")
    await _refuse_hidden_descendants(ctx, node)

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
        visible, chunk_levels = await visible_nodes(ctx, rows)
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
    editable = [n for n in nodes if is_edit(levels[n.id])]
    return await nodes_out(ctx, editable, levels)
