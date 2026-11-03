"""Watching (spec §7): a person watches a page, a folder (its subtree) or
a space, and hears about what happens there through
`serversherpa.wiki.notify`. A watch is the person's own row of
`notification_watches` (migration 0116) on a library (`wiki_space_id`) or a
folder or page (`wiki_node_id`); it names no events, so it hears every update
and comment. The table also holds watches on other things and groups'
watches, and none of those is the wiki's to list, answer for or remove.

- `GET /watches` — my watches, newest first, leaving out any whose
  target I can no longer see (the rows stay: access may come back).
- `PUT /watches {node_id | space_id}` — watch something I can view;
  idempotent (the existing watch comes back).
- `DELETE /watches/{id}` — unwatch; only my own (anyone else's is a 404).
- `GET /nodes/{id}/watch` — whether I watch a node, and through what.

Watching and unwatching are audited (`wiki_watch`, `watch` / `unwatch`),
and so is either done from /me (api/routes/me.py), with the same helpers.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Response
from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.routes.wiki.deps import WikiContext, visible_nodes
from serversherpa.api.routes.wiki.errors import not_found
from serversherpa.api.routes.wiki.schemas import (
    WatchIn,
    WatchNodeRef,
    WatchOut,
    WatchSpaceRef,
    WatchStateOut,
)
from serversherpa.db.models import NotificationWatch, WikiNode, WikiSpace
from serversherpa.services.audit import audit
from serversherpa.wiki.permissions import require_node_level, require_space_level

router = APIRouter()

# A watch on a library, a folder or a page, not on anything else: the one
# test the list and unwatch share.
ON_THE_WIKI = or_(NotificationWatch.wiki_space_id.is_not(None),
                  NotificationWatch.wiki_node_id.is_not(None))


def audit_watch(db: AsyncSession, *, actor_id: uuid.UUID, watch: NotificationWatch) -> None:
    """The wiki's record of a watch started, as `PUT /watches` writes it:
    the folder or page it is on, or the library."""
    audit(db, actor_id=actor_id, entity_type="wiki_watch", entity_id=str(watch.id),
          action="watch",
          changes=({"node_id": str(watch.wiki_node_id)} if watch.wiki_node_id is not None
                   else {"space_id": str(watch.wiki_space_id)}))


def audit_unwatch(db: AsyncSession, *, actor_id: uuid.UUID, watch: NotificationWatch) -> None:
    """The wiki's record of a watch stopped, whichever page stopped it."""
    audit(db, actor_id=actor_id, entity_type="wiki_watch", entity_id=str(watch.id),
          action="unwatch", changes={
              "node_id": str(watch.wiki_node_id) if watch.wiki_node_id else None,
              "space_id": str(watch.wiki_space_id) if watch.wiki_space_id else None})


def _out(watch: NotificationWatch, node: WikiNode | None, space: WikiSpace | None) -> WatchOut:
    return WatchOut(
        id=watch.id,
        node=WatchNodeRef(id=node.id, title=node.title, kind=node.kind) if node else None,
        space=WatchSpaceRef(key=space.key, name=space.name) if space else None,
        created_at=watch.created_at)


async def _viewable_node(ctx: WikiContext, node_id: uuid.UUID) -> WikiNode:
    """The node, if the caller can see it (a never-published page is
    hidden from view-only callers, as in the tree); else 404."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    shown, _ = await visible_nodes(ctx, [node])
    if not shown:
        raise not_found()
    return node


@router.get("/watches", response_model=list[WatchOut])
async def list_watches(ctx: WikiContext) -> list[WatchOut]:
    watches = (await ctx.db.scalars(
        select(NotificationWatch)
        .where(NotificationWatch.person_id == ctx.principal.person_id, ON_THE_WIKI)
        .order_by(NotificationWatch.created_at.desc(), NotificationWatch.id)
    )).all()
    node_ids = [w.wiki_node_id for w in watches if w.wiki_node_id is not None]
    nodes = (await ctx.db.scalars(
        select(WikiNode).where(WikiNode.id.in_(node_ids)))).all() if node_ids else []
    shown, _ = await visible_nodes(ctx, nodes)
    shown_by_id = {n.id: n for n in shown}

    watched_spaces = [w.wiki_space_id for w in watches if w.wiki_space_id is not None]
    space_levels = await ctx.ix.levels_for_spaces(watched_spaces)
    space_ids = {*watched_spaces, *(n.space_id for n in shown)}
    spaces = {s.id: s for s in (await ctx.db.scalars(
        select(WikiSpace).where(WikiSpace.id.in_(space_ids)))).all()} if space_ids else {}

    out: list[WatchOut] = []
    for w in watches:
        if w.wiki_node_id is not None:
            node = shown_by_id.get(w.wiki_node_id)
            if node is not None:
                out.append(_out(w, node, spaces.get(node.space_id)))
        elif space_levels.get(w.wiki_space_id):
            out.append(_out(w, None, spaces.get(w.wiki_space_id)))
    return out


@router.put("/watches", response_model=WatchOut)
async def watch(body: WatchIn, ctx: WikiContext) -> WatchOut:
    node: WikiNode | None = None
    if body.node_id is not None:
        node = await _viewable_node(ctx, body.node_id)
        space = await ctx.db.get(WikiSpace, node.space_id)
        target = {"wiki_node_id": node.id}
        match = NotificationWatch.wiki_node_id == node.id
    else:
        space = await require_space_level(
            ctx.ix, await ctx.db.get(WikiSpace, body.space_id), "view")
        target = {"wiki_space_id": space.id}
        match = NotificationWatch.wiki_space_id == space.id

    me = ctx.principal.person_id
    # a person's one watch on the thing (uq_notification_watches_target): a second PUT finds it
    new_id = await ctx.db.scalar(
        insert(NotificationWatch).values(person_id=me, created_by=me, **target)
        .on_conflict_do_nothing().returning(NotificationWatch.id))
    row = await ctx.db.scalar(
        select(NotificationWatch).where(NotificationWatch.person_id == me, match))
    if new_id is not None:
        audit_watch(ctx.db, actor_id=me, watch=row)
        await ctx.db.commit()
    return _out(row, node, space)


@router.delete("/watches/{watch_id}", status_code=204)
async def unwatch(watch_id: uuid.UUID, ctx: WikiContext) -> Response:
    me = ctx.principal.person_id
    row = await ctx.db.scalar(select(NotificationWatch).where(
        NotificationWatch.id == watch_id, NotificationWatch.person_id == me, ON_THE_WIKI))
    if row is None:
        raise not_found()
    audit_unwatch(ctx.db, actor_id=me, watch=row)
    await ctx.db.delete(row)
    await ctx.db.commit()
    return Response(status_code=204)


@router.get("/nodes/{node_id}/watch", response_model=WatchStateOut)
async def watch_state(node_id: uuid.UUID, ctx: WikiContext) -> WatchStateOut:
    node = await _viewable_node(ctx, node_id)
    ancestors = list(node.path or [])
    rows = (await ctx.db.execute(
        select(NotificationWatch.id, NotificationWatch.wiki_node_id)
        .where(NotificationWatch.person_id == ctx.principal.person_id,
               or_(NotificationWatch.wiki_node_id.in_([*ancestors, node.id]),
                   NotificationWatch.wiki_space_id == node.space_id))
    )).all()
    by_node = {watched: wid for wid, watched in rows if watched is not None}
    if node.id in by_node:
        return WatchStateOut(watching=True, via="node", watch_id=by_node[node.id])
    for ancestor_id in reversed(ancestors):     # the closest ancestor first
        if ancestor_id in by_node:
            return WatchStateOut(watching=True, via="ancestor",
                                 watch_id=by_node[ancestor_id])
    space_watch = next((wid for wid, watched in rows if watched is None), None)
    if space_watch is not None:
        return WatchStateOut(watching=True, via="space", watch_id=space_watch)
    return WatchStateOut(watching=False, via=None, watch_id=None)
