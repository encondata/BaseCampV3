"""Public share links, signed-in side (spec §8): create a link to a page
or file (manage on it, and the space's `allow_public_links`), list a
node's links (manage), revoke one (manage on its node, the person who
created it, or a wiki admin), and the wiki-admin list of every link.

Only the create response carries the token (in `url`); lists never show
it or its hash. The unauthenticated read lives in `public.py`; the rules
both share are in `serversherpa.wiki.share_links`."""
from __future__ import annotations

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Response
from sqlalchemy import and_, func, or_, select

from serversherpa.api.routes.wiki.deps import WikiContext
from serversherpa.api.routes.wiki.errors import err, not_found
from serversherpa.api.routes.wiki.schemas import (
    ShareLinkCreatedOut,
    ShareLinkCreateIn,
    ShareLinkOut,
    ShareNodeRef,
)
from serversherpa.api.routes.wiki.serialize import person_refs
from serversherpa.db.models import WikiNode, WikiShareLink, WikiSpace
from serversherpa.services.audit import audit
from serversherpa.wiki.pages import utcnow
from serversherpa.wiki.permissions import require_node_level
from serversherpa.wiki.share_links import (
    expires_at_for,
    hash_token,
    link_status,
    new_token,
    share_url,
)
from serversherpa.wiki.space_settings import space_setting

router = APIRouter()

# the admin list's cap — live links first, then newest first
ADMIN_LIST_LIMIT = 500

SHAREABLE_KINDS = ("page", "file")


async def _links_out(ctx: WikiContext,
                     rows: Sequence[tuple[WikiShareLink, WikiNode, WikiSpace]],
                     ) -> list[ShareLinkOut]:
    people = await person_refs(ctx.db, [link.created_by for link, _, _ in rows])
    now = utcnow()
    return [
        ShareLinkOut(
            id=link.id,
            node=ShareNodeRef(id=node.id, title=node.title, kind=node.kind,
                              space_key=space.key, space_name=space.name),
            status=link_status(link, now),
            created_by=people.get(link.created_by) if link.created_by else None,
            created_at=link.created_at, expires_at=link.expires_at,
            revoked_at=link.revoked_at, view_count=link.view_count,
            last_viewed_at=link.last_viewed_at)
        for link, node, space in rows
    ]


def _links_query():
    return (select(WikiShareLink, WikiNode, WikiSpace)
            .join(WikiNode, WikiNode.id == WikiShareLink.node_id)
            .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
            .order_by(WikiShareLink.created_at.desc(), WikiShareLink.id))


@router.post("/nodes/{node_id}/share-links", response_model=ShareLinkCreatedOut,
             status_code=201)
async def create_share_link(node_id: uuid.UUID, body: ShareLinkCreateIn,
                            ctx: WikiContext) -> ShareLinkCreatedOut:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "manage")
    if node.kind not in SHAREABLE_KINDS:
        raise err(422, "bad_kind", "Only pages and files can be shared publicly.")
    space = await ctx.db.get(WikiSpace, node.space_id)
    if not space_setting(space, "allow_public_links"):
        raise err(422, "links_disabled", "Public links are turned off for this library.")

    token = new_token()
    now = utcnow()
    actor_id = ctx.user.person.id
    link = WikiShareLink(node_id=node.id, token_hash=hash_token(token), created_by=actor_id,
                         created_at=now, expires_at=expires_at_for(body.expires_in_days, now))
    ctx.db.add(link)
    await ctx.db.flush()
    # never the token or its hash
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_share_link", entity_id=str(link.id),
          action="create", changes={
              "node_id": str(node.id),
              "expires_at": link.expires_at.isoformat() if link.expires_at else None})
    await ctx.db.commit()
    return ShareLinkCreatedOut(id=link.id, url=share_url(token), expires_at=link.expires_at)


@router.get("/nodes/{node_id}/share-links", response_model=list[ShareLinkOut])
async def list_node_share_links(node_id: uuid.UUID, ctx: WikiContext) -> list[ShareLinkOut]:
    """Every link to the node — active, expired and revoked — newest first."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "manage")
    rows = (await ctx.db.execute(_links_query().where(WikiShareLink.node_id == node.id))).all()
    return await _links_out(ctx, rows)


@router.get("/share-links", response_model=list[ShareLinkOut])
async def list_all_share_links(ctx: WikiContext) -> list[ShareLinkOut]:
    """Wiki administrators: every link in the wiki — the live ones first
    (this is the only wiki-wide place to revoke one, so the cap must never
    push a live link out for newer revoked or expired ones), each group
    newest first."""
    if not ctx.principal.is_admin:
        raise err(403, "forbidden", "Only wiki administrators can see every public link.")
    live = and_(WikiShareLink.revoked_at.is_(None),
                or_(WikiShareLink.expires_at.is_(None), WikiShareLink.expires_at > func.now()))
    query = _links_query().order_by(None).order_by(
        live.desc(), WikiShareLink.created_at.desc(), WikiShareLink.id)
    rows = (await ctx.db.execute(query.limit(ADMIN_LIST_LIMIT))).all()
    return await _links_out(ctx, rows)


@router.delete("/share-links/{link_id}", status_code=204)
async def revoke_share_link(link_id: uuid.UUID, ctx: WikiContext) -> Response:
    """Idempotent: revoking a revoked link changes nothing."""
    link = await ctx.db.get(WikiShareLink, link_id)
    if link is None:
        raise not_found()
    actor_id = ctx.user.person.id
    if link.created_by != actor_id and not ctx.principal.is_admin:
        await require_node_level(ctx.ix, await ctx.db.get(WikiNode, link.node_id), "manage")
    if link.revoked_at is None:
        link.revoked_at = utcnow()
        audit(ctx.db, actor_id=actor_id, entity_type="wiki_share_link",
              entity_id=str(link.id), action="revoke",
              changes={"node_id": str(link.node_id)})
        await ctx.db.commit()
    return Response(status_code=204)
