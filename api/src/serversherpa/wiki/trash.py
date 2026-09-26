"""The wiki trash: batches of soft-deleted nodes, and the two ways out of
it — restore (`restore_batch`) and delete forever
(`delete_batch_forever`, used by both `DELETE /wiki/trash/{batch_id}`
and the worker's expiry sweep).

`DELETE /wiki/nodes/{id}` (routes/wiki/nodes.py) stamps the node and its
live subtree with one `deleted_batch` id, so a batch is always one
subtree: its root is the member whose parent isn't in the batch.
Descendants deleted earlier keep their own, older batch.

Like tree.py, nothing here checks the caller's access or commits —
routes check levels first and commit once the request is done.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, exists, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from serversherpa.db.models import WikiFileVersion, WikiNode, WikiPageAsset
from serversherpa.services.audit import audit
from serversherpa.wiki import tree
from serversherpa.wiki.files import enqueue


@dataclass(frozen=True)
class TrashedBatch:
    batch_id: uuid.UUID
    root: WikiNode
    count: int
    deleted_by: uuid.UUID | None
    deleted_at: datetime


def _is_batch_root():
    """WHERE clause: this deleted node's parent isn't in its own batch."""
    parent = aliased(WikiNode)
    return ~exists().where(parent.id == WikiNode.parent_id,
                           parent.deleted_batch == WikiNode.deleted_batch)


async def batch_root(db: AsyncSession, batch_id: uuid.UUID) -> WikiNode | None:
    """The batch's root node, locked FOR UPDATE, or None when no such
    batch exists. The lock serializes restore / delete-forever / the
    expiry sweep on one batch: whoever waits re-reads the row after the
    first commits, finds it restored or gone, and gets None."""
    return await db.scalar(
        select(WikiNode)
        .where(WikiNode.deleted_batch == batch_id, _is_batch_root())
        .order_by(func.cardinality(WikiNode.path), WikiNode.id)
        .limit(1)
        .with_for_update(of=WikiNode)
        .execution_options(populate_existing=True))


async def list_batches(db: AsyncSession, space_id: uuid.UUID) -> list[TrashedBatch]:
    """Every batch in the space's trash, newest first — two queries."""
    roots = (await db.scalars(
        select(WikiNode)
        .where(WikiNode.space_id == space_id, WikiNode.deleted_batch.is_not(None),
               _is_batch_root())
        .order_by(WikiNode.deleted_batch, func.cardinality(WikiNode.path), WikiNode.id)
        .distinct(WikiNode.deleted_batch)
    )).all()
    counts = dict((await db.execute(
        select(WikiNode.deleted_batch, func.count())
        .where(WikiNode.space_id == space_id, WikiNode.deleted_batch.is_not(None))
        .group_by(WikiNode.deleted_batch)
    )).all())
    batches = [TrashedBatch(batch_id=r.deleted_batch, root=r, count=counts[r.deleted_batch],
                            deleted_by=r.deleted_by, deleted_at=r.deleted_at)
               for r in roots]
    batches.sort(key=lambda b: (b.deleted_at, b.batch_id), reverse=True)
    return batches


async def restore_batch(db: AsyncSession, root: WikiNode) -> int:
    """Bring `root`'s batch back; returns how many nodes came back.

    The root goes back under its old parent, keeping its old position —
    unless that parent is in the trash itself, or gone, in which case it
    lands at the end of the space root. Either way the subtree's paths
    are rewritten from the root's current place (an ancestor may have
    been moved, or deleted forever, while it sat in the trash)."""
    batch_id = root.deleted_batch
    parent = await db.get(WikiNode, root.parent_id) if root.parent_id else None
    if parent is not None and (parent.deleted_at is not None
                               or parent.space_id != root.space_id):
        parent = None
    new_parent_id = parent.id if parent is not None else None
    new_prefix = [*(parent.path or []), parent.id] if parent is not None else []

    if new_parent_id != root.parent_id:
        root.position = await tree.next_position(db, root.space_id, new_parent_id)
    if list(root.path or []) != new_prefix:
        await tree.repath_subtree(db, root, new_prefix, space_id=root.space_id)
    root.parent_id = new_parent_id
    root.path = new_prefix
    await db.flush()

    result = await db.execute(
        update(WikiNode).where(WikiNode.deleted_batch == batch_id)
        .values(deleted_at=None, deleted_by=None, deleted_batch=None)
        .execution_options(synchronize_session=False))
    await db.refresh(root)
    return result.rowcount


async def storage_keys(db: AsyncSession, node_ids: list[uuid.UUID]) -> list[str]:
    """Every object key the nodes' rows point at: file versions (the
    upload and its converted preview) and page assets (soft-deleted ones
    included), de-duplicated and sorted."""
    keys: set[str] = set()
    for storage_key, preview_key in (await db.execute(
            select(WikiFileVersion.storage_key, WikiFileVersion.preview_key)
            .where(WikiFileVersion.node_id.in_(node_ids)))).all():
        keys.add(storage_key)
        if preview_key:
            keys.add(preview_key)
    keys.update((await db.scalars(
        select(WikiPageAsset.storage_key).where(WikiPageAsset.node_id.in_(node_ids))
    )).all())
    return sorted(keys)


async def delete_batch_forever(db: AsyncSession, root: WikiNode, *,
                               actor_id: uuid.UUID | None,
                               reason: str | None = None) -> int:
    """Hard-delete `root`'s batch; returns how many nodes went.

    A `purge` job for the batch's storage keys is queued first, in the
    same transaction, so the objects are only ever removed once the rows
    are gone (the job reference-counts each key before deleting it —
    copies and restored versions share objects). A trashed descendant
    from an OLDER batch would otherwise be cascade-deleted with its
    parent — and its objects leaked — so it is detached to the space
    root first and stays in the trash, restorable on its own."""
    batch_id = root.deleted_batch
    root_id, title = root.id, root.title
    ids = list((await db.scalars(
        select(WikiNode.id).where(WikiNode.deleted_batch == batch_id))).all())
    keys = await storage_keys(db, ids)

    await db.execute(
        update(WikiNode)
        .where(WikiNode.parent_id.in_(ids),
               WikiNode.deleted_batch.is_distinct_from(batch_id))
        .values(parent_id=None)
        .execution_options(synchronize_session=False))
    if keys:
        await enqueue(db, "purge", payload={"keys": keys})
    await db.execute(delete(WikiNode).where(WikiNode.id.in_(ids))
                     .execution_options(synchronize_session=False))
    db.expunge(root)

    changes = {"batch_id": str(batch_id), "count": len(ids), "title": title}
    if reason:
        changes["reason"] = reason
    audit(db, actor_id=actor_id, entity_type="wiki_node", entity_id=str(root_id),
          action="purge", changes=changes)
    return len(ids)
