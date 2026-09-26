"""Shared per-request context for every `/wiki` route: the DB session,
the caller's `AuthContext`, their wiki `Principal`, and a fresh
`AccessIndex`. Every wiki route handler takes `ctx: WikiContext` instead
of assembling these four itself — and picks up the `wiki:view` gate for
free, since building a `Principal` at all requires it.

It also holds the lookups more than one route module needs:
`destination` (where a new node — a folder/page, or an uploaded file —
is going, and the caller's level there), `lock_and_reread` (a tree
mutation's lock-then-re-check of the node it acts on) and
`visible_nodes` (the live nodes a caller may see, dropping
never-published pages for view-only).

`AccessIndex` never invalidates its cache, so `ctx.ix` is only good for
levels computed against the grants that existed when it was built. A
route that changes grants mid-request must build a NEW `AccessIndex`
(see `spaces.py`) before re-checking or serializing `my_level`."""
from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.routes.wiki.errors import conflict, not_found
from serversherpa.db.models import WikiNode, WikiPage, WikiSpace
from serversherpa.wiki import tree
from serversherpa.wiki.permissions import (
    AccessIndex,
    Principal,
    principal_for,
    require_node_level,
    require_space_level,
)


@dataclass
class WikiCtx:
    db: AsyncSession
    user: AuthContext
    principal: Principal
    ix: AccessIndex


async def _build_wiki_ctx(
    db: DbSession,
    user: AuthContext = require_permission("wiki", "view"),
) -> WikiCtx:
    principal = await principal_for(db, user)
    return WikiCtx(db=db, user=user, principal=principal, ix=AccessIndex(db, principal))


WikiContext = Annotated[WikiCtx, Depends(_build_wiki_ctx)]


async def space_by_key(db: AsyncSession, key: str) -> WikiSpace | None:
    # wiki_spaces.key is CITEXT — case-insensitive equality already, this
    # just normalizes stray whitespace from the path.
    return await db.scalar(select(WikiSpace).where(WikiSpace.key == key.strip()))


async def destination(ctx: WikiCtx, space_id: uuid.UUID, parent_id: uuid.UUID | None,
                      ) -> tuple[WikiSpace, WikiNode | None, str | None]:
    """Resolve where a new node is going: (space, parent, the caller's
    level there). 404 when the space, or the parent, isn't one they can
    view. Whether the parent can actually hold the node is
    `tree.check_parent`'s call (a 422), made after the caller's level has
    been checked."""
    space = await ctx.db.get(WikiSpace, space_id)
    if parent_id is None:
        space = await require_space_level(ctx.ix, space, "view")
        return space, None, await ctx.ix.level_for_space(space.id)
    # populate_existing: after a tree lock, the parent as committed now,
    # not an earlier copy this session may hold
    parent = await ctx.db.get(WikiNode, parent_id, populate_existing=True)
    level = await ctx.ix.level_for_node(parent) if parent is not None else None
    if level is None or space is None:
        raise not_found()
    return space, parent, level


async def lock_and_reread(ctx: WikiCtx, node: WikiNode, needed: str,
                          *also_lock: uuid.UUID) -> WikiNode:
    """Take the tree lock of `node`'s space (and of `also_lock`, e.g. a
    move's destination space), then re-read `node` as committed now and
    re-check the caller still has `needed` on it (404/403 as usual). 409
    `conflict` when it left the locked space while we waited — a
    concurrent cross-space move."""
    space_id = node.space_id
    await tree.lock_space_trees(ctx.db, space_id, *also_lock)
    fresh = await ctx.db.get(WikiNode, node.id, populate_existing=True)
    fresh = await require_node_level(ctx.ix, fresh, needed)
    if fresh.space_id != space_id:
        raise conflict()
    return fresh


async def visible_nodes(ctx: WikiCtx, nodes: Sequence[WikiNode],
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
