"""Node-level permission overrides: `GET`/`PUT /nodes/{id}/permissions`.

A node's *own* grants (`wiki_grants.node_id = this node`) are distinct
from its *effective* (resolved) access — see the module docstring on
`AccessIndex` in `wiki/permissions.py` for how the two combine. This
module reuses `spaces.py`'s principal validation (`_principal_exists`)
rather than duplicating it; it does not reuse `spaces._grants_out`,
which hardcodes `node_id=None` for space-level grants — here it's the
node's own id.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter
from sqlalchemy import select

from serversherpa.api.routes.wiki.deps import WikiContext
from serversherpa.api.routes.wiki.errors import err
from serversherpa.api.routes.wiki.schemas import (
    EffectiveGrant,
    EffectiveGrantSource,
    GrantOut,
    NodePermissionsOut,
    NodePermissionsPutIn,
)
from serversherpa.api.routes.wiki.spaces import _principal_exists, reject_duplicate_principals
from serversherpa.db.models import WikiGrant, WikiNode
from serversherpa.services.audit import audit
from serversherpa.wiki.permissions import (
    AccessIndex,
    EffectiveGrantRow,
    level_rank,
    principal_labels,
    require_node_level,
)

router = APIRouter()


async def _own_grants(db, node: WikiNode) -> list[WikiGrant]:
    return (await db.scalars(
        select(WikiGrant)
        .where(WikiGrant.node_id == node.id)
        .order_by(WikiGrant.created_at)
    )).all()


async def _node_grants_out(db, node_id: uuid.UUID, grants: list[WikiGrant]) -> list[GrantOut]:
    labels = await principal_labels(db, grants)
    return [
        GrantOut(
            id=g.id, principal_type=g.principal_type, principal_id=g.principal_id,
            level=g.level, principal_label=labels[(g.principal_type, g.principal_id)],
            node_id=node_id,
        )
        for g in grants
    ]


def _effective_out(rows: list[EffectiveGrantRow]) -> list[EffectiveGrant]:
    return [
        EffectiveGrant(
            principal_type=r.principal_type, principal_id=r.principal_id, level=r.level,
            principal_label=r.principal_label,
            source=EffectiveGrantSource(
                kind=r.source_kind, node_id=r.source_node_id, title=r.source_title),
        )
        for r in rows
    ]


async def _permissions_out(db, ix: AccessIndex, node: WikiNode) -> NodePermissionsOut:
    grants = await _own_grants(db, node)
    effective = await ix.effective_grants(node, node.space_id)
    return NodePermissionsOut(
        inherit=node.inherit_permissions,
        grants=await _node_grants_out(db, node.id, grants),
        effective=_effective_out(effective),
    )


@router.get("/nodes/{node_id}/permissions", response_model=NodePermissionsOut)
async def get_node_permissions(node_id: uuid.UUID, ctx: WikiContext) -> NodePermissionsOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "manage")
    return await _permissions_out(ctx.db, ctx.ix, node)


@router.put("/nodes/{node_id}/permissions", response_model=NodePermissionsOut)
async def put_node_permissions(node_id: uuid.UUID, body: NodePermissionsPutIn,
                               ctx: WikiContext) -> NodePermissionsOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "manage")
    reject_duplicate_principals(body.grants or [])

    for g in (body.grants or []):
        if not await _principal_exists(ctx.db, g.principal_type, g.principal_id):
            raise err(422, "bad_principal",
                       principal_type=g.principal_type, principal_id=g.principal_id)

    before_inherit = node.inherit_permissions
    existing = await _own_grants(ctx.db, node)
    before_grants = [{"principal_type": g.principal_type, "principal_id": g.principal_id,
                      "level": g.level} for g in existing]

    if body.grants is not None:
        # an explicit grant list always replaces the node's own set
        new_grant_specs = [(g.principal_type, g.principal_id, g.level) for g in body.grants]
    elif body.inherit is False and before_inherit is True:
        # breaking inheritance without an explicit list: copy the current
        # EFFECTIVE set (deduped, highest level per principal) so nothing
        # changes for anyone until it's edited — SharePoint behavior
        effective = await ctx.ix.effective_grants(node, node.space_id)
        best: dict[tuple[str, str | None], str] = {}
        for row in effective:
            key = (row.principal_type, row.principal_id)
            if key not in best or level_rank(row.level) > level_rank(best[key]):
                best[key] = row.level
        new_grant_specs = [(ptype, pid, level) for (ptype, pid), level in best.items()]
    else:
        # inherit unchanged, or restored to true: the node's own grants
        # (additive again once inherit is back on) are kept as they are
        new_grant_specs = [(g.principal_type, g.principal_id, g.level) for g in existing]

    for g in existing:
        await ctx.db.delete(g)
    await ctx.db.flush()

    actor_id = ctx.user.person.id
    new_rows = [
        WikiGrant(space_id=node.space_id, node_id=node.id, principal_type=ptype,
                  principal_id=pid, level=level, created_by=actor_id)
        for ptype, pid, level in new_grant_specs
    ]
    ctx.db.add_all(new_rows)
    node.inherit_permissions = body.inherit
    await ctx.db.flush()

    # lock-out guard, evaluated with a FRESH AccessIndex (AccessIndex never
    # invalidates its cache) — a wiki admin or space manager is always
    # reflected as "manage" here, so no separate exemption is needed
    fresh_ix = AccessIndex(ctx.db, ctx.principal)
    level = await fresh_ix.level_for_node(node)
    if level_rank(level) < level_rank("manage"):
        await ctx.db.rollback()
        raise err(422, "would_lock_out",
                  "This change would remove your own manage access to this page.")

    after_grants = [{"principal_type": ptype, "principal_id": pid, "level": level}
                    for ptype, pid, level in new_grant_specs]
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_grant", entity_id=str(node.id),
          action="node_permissions",
          changes={"inherit": [before_inherit, body.inherit],
                   "grants": [before_grants, after_grants]})
    await ctx.db.commit()

    return await _permissions_out(ctx.db, fresh_ix, node)
