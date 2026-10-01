"""The trash: a space's deleted batches (`GET /spaces/{key}/trash`),
restoring one (`POST /trash/{batch_id}/restore`) and deleting one
forever (`DELETE /trash/{batch_id}`). All three need manage on the
space. A batch id the caller can't manage — or that doesn't exist — is
a 404 either way, so the trash never confirms a batch to an outsider.

An archived space is read-only: restoring into one is a 422
`read_only` (for anyone who can see the space — a non-admin manager is
clamped to view there, so without this they'd get a bare 404). Wiki
administrators may still delete an archived space's batches forever.
The rules themselves (roots, re-parenting, reference-counted purge)
live in `wiki/trash.py`, shared with the worker's expiry sweep."""
from __future__ import annotations

import uuid
from datetime import timedelta

from fastapi import APIRouter, Response
from sqlalchemy import select

from serversherpa.api.routes.wiki.deps import WikiContext, space_by_key
from serversherpa.api.routes.wiki.errors import conflict, err, not_found
from serversherpa.api.routes.wiki.schemas import NodeOut, TrashBatch, TrashRoot
from serversherpa.api.routes.wiki.serialize import node_out, person_refs
from serversherpa.config import get_settings
from serversherpa.db.models import WikiNode, WikiSpace
from serversherpa.services.audit import audit
from serversherpa.wiki import trash, tree
from serversherpa.wiki.permissions import AccessIndex, require_space_level

router = APIRouter()


async def _visible_counts(
        ctx: WikiContext, space_id: uuid.UUID, batch_ids: list[uuid.UUID],
) -> tuple[dict[uuid.UUID, int], set[uuid.UUID]]:
    """How many members of each batch the caller can see, and the batches
    holding at least one member they can't (a private item that was
    trashed, or made private in the trash, along with others)."""
    if not batch_ids:
        return {}, set()
    members = (await ctx.db.scalars(
        select(WikiNode).where(WikiNode.space_id == space_id,
                               WikiNode.deleted_batch.in_(batch_ids)))).all()
    levels = await ctx.ix.levels_for_nodes(members)
    counts = dict.fromkeys(batch_ids, 0)
    hidden: set[uuid.UUID] = set()
    for node in members:
        if levels[node.id]:
            counts[node.deleted_batch] += 1
        else:
            hidden.add(node.deleted_batch)
    return counts, hidden


@router.get("/spaces/{key}/trash", response_model=list[TrashBatch])
async def list_trash(key: str, ctx: WikiContext) -> list[TrashBatch]:
    space = await require_space_level(ctx.ix, await space_by_key(ctx.db, key), "manage")
    batches = await trash.list_batches(ctx.db, space.id)
    # a private item stays private in the trash
    levels = await ctx.ix.levels_for_nodes([b.root for b in batches])
    batches = [b for b in batches if levels[b.root.id]]
    counts, _ = await _visible_counts(ctx, space.id, [b.batch_id for b in batches])
    people = await person_refs(ctx.db, [b.deleted_by for b in batches])
    keep_for = timedelta(days=get_settings().wiki_trash_days)
    return [
        TrashBatch(
            batch_id=b.batch_id,
            root=TrashRoot(id=b.root.id, title=b.root.title, kind=b.root.kind),
            count=counts[b.batch_id],
            deleted_by=people.get(b.deleted_by) if b.deleted_by else None,
            deleted_at=b.deleted_at,
            purge_at=b.deleted_at + keep_for,
        )
        for b in batches
    ]


async def _managed_batch(ctx: WikiContext, batch_id: uuid.UUID, *,
                         restoring: bool) -> tuple[WikiNode, WikiSpace]:
    """The batch's (locked) root and its space, when the caller manages
    that space; otherwise 404 — or 422 `read_only` for a restore into an
    archived space the caller can see."""
    try:
        root = await trash.batch_root(ctx.db, batch_id)
    except tree.TreeError:
        raise conflict() from None
    space = await ctx.db.get(WikiSpace, root.space_id) if root is not None else None
    if space is None:
        raise not_found()
    level = await ctx.ix.level_for_space(space.id)
    if level is None or await ctx.ix.level_for_node(root) is None:
        raise not_found()
    if restoring and space.archived_at is not None:
        raise err(422, "read_only", "This library is archived, so nothing can be restored into it.")
    if level != "manage":
        raise not_found()
    return root, space


@router.post("/trash/{batch_id}/restore", response_model=NodeOut)
async def restore(batch_id: uuid.UUID, ctx: WikiContext) -> NodeOut:
    root, _ = await _managed_batch(ctx, batch_id, restoring=True)
    try:
        count = await trash.restore_batch(ctx.db, root)
    except tree.TreeError as exc:
        raise err(409, exc.code, exc.message) from exc
    audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_node",
          entity_id=str(root.id), action="restore",
          changes={"batch_id": str(batch_id), "count": count,
                   "parent_id": str(root.parent_id) if root.parent_id else None})
    await ctx.db.commit()

    # the root may have landed somewhere new (the space root) — the
    # request's AccessIndex never saw its chain as it is now
    fresh_ix = AccessIndex(ctx.db, ctx.principal)
    return await node_out(ctx, root, await fresh_ix.level_for_node(root))


@router.delete("/trash/{batch_id}", status_code=204)
async def delete_forever(batch_id: uuid.UUID, ctx: WikiContext) -> Response:
    root, space = await _managed_batch(ctx, batch_id, restoring=False)
    _, hidden = await _visible_counts(ctx, space.id, [batch_id])
    if hidden:
        # live delete refuses the same way (`_refuse_hidden_descendants`)
        raise err(409, "hidden_items",
                  "This contains items you can't see, so you can't delete it forever. "
                  "Ask a library manager.")
    await trash.delete_batch_forever(ctx.db, root, actor_id=ctx.user.person.id)
    await ctx.db.commit()
    return Response(status_code=204)
