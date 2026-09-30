"""Help links (spec §8): `GET /wiki/help?context=` — the guide for a
portal or kiosk screen, for anyone who can view it — and the wiki-admin
list/create/edit/delete at `/wiki/help-links`.

Contexts are normalized on the way in, both when stored and when looked
up; the matching rules live in `serversherpa.wiki.help`."""
from __future__ import annotations

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from serversherpa.api.routes.wiki.deps import WikiContext, visible_nodes
from serversherpa.api.routes.wiki.errors import err, not_found
from serversherpa.api.routes.wiki.schemas import (
    HelpContextIn,
    HelpLinkIn,
    HelpLinkOut,
    HelpLinkPatchIn,
    HelpOut,
    ShareNodeRef,
)
from serversherpa.api.routes.wiki.serialize import person_refs
from serversherpa.db.models import WikiHelpLink, WikiNode, WikiSpace
from serversherpa.services.audit import audit
from serversherpa.wiki.help import (
    context_prefixes,
    guide_url,
    is_valid_context,
    normalize_context,
)
from serversherpa.wiki.permissions import require_node_level

router = APIRouter()

GUIDE_KINDS = ("page", "file")


def _require_admin(ctx: WikiContext) -> None:
    if not ctx.principal.is_admin:
        raise err(403, "forbidden", "Only wiki administrators can manage help links.")


def _context(raw: str) -> str:
    context = normalize_context(raw)
    if not is_valid_context(context):
        raise err(422, "bad_context",
                  "A context looks like portal:/bulk/time or kiosk:/enroll — the app, "
                  "a colon, then the page's path (letters, digits, / _ : and -).")
    return context


async def _guide(ctx: WikiContext, node_id: uuid.UUID) -> WikiNode:
    """A live page or file the admin can see (404 otherwise; 422
    `bad_kind` for a folder, 422 `private` for a private item)."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    if node.kind not in GUIDE_KINDS:
        raise err(422, "bad_kind", "A help link points to a page or a file.")
    if await ctx.ix.is_private(node):
        raise err(422, "private", "A private item can't be a help guide.")
    return node


async def _context_taken(ctx: WikiContext, context: str,
                         except_id: uuid.UUID | None = None) -> bool:
    query = select(WikiHelpLink.id).where(WikiHelpLink.context == context)
    if except_id is not None:
        query = query.where(WikiHelpLink.id != except_id)
    return await ctx.db.scalar(query) is not None


def _taken() -> HTTPException:
    return err(409, "context_taken", "Another help link already uses that context.")


async def _flush_unique(ctx: WikiContext) -> None:
    """Flush in a savepoint: a context taken by a concurrent request (the
    unique index) is a 409, not a 500."""
    try:
        async with ctx.db.begin_nested():
            await ctx.db.flush()
    except IntegrityError:
        raise _taken() from None


def _links_query():
    return (select(WikiHelpLink, WikiNode, WikiSpace)
            .join(WikiNode, WikiNode.id == WikiHelpLink.node_id)
            .join(WikiSpace, WikiSpace.id == WikiNode.space_id))


async def _links_out(ctx: WikiContext,
                     rows: Sequence[tuple[WikiHelpLink, WikiNode, WikiSpace]],
                     ) -> list[HelpLinkOut]:
    people = await person_refs(ctx.db, [link.created_by for link, _, _ in rows])
    return [
        HelpLinkOut(
            id=link.id, context=link.context,
            node=ShareNodeRef(id=node.id, title=node.title, kind=node.kind,
                              space_key=space.key, space_name=space.name),
            trashed=node.deleted_at is not None,
            created_by=people.get(link.created_by) if link.created_by else None,
            created_at=link.created_at)
        for link, node, space in rows
    ]


async def _link_out(ctx: WikiContext, link_id: uuid.UUID) -> HelpLinkOut:
    row = (await ctx.db.execute(
        _links_query().where(WikiHelpLink.id == link_id))).one()
    return (await _links_out(ctx, [row]))[0]


@router.get("/help", response_model=HelpOut)
async def get_help(ctx: WikiContext, context: HelpContextIn) -> HelpOut:
    """The nearest guide the caller can view: the stored contexts the
    requested one falls under, longest first, skipping any whose guide
    they can't view (trashed, not theirs to see, or a never-published page
    for view-only). 404 when none qualifies."""
    candidates = context_prefixes(normalize_context(context))
    if not candidates:
        raise not_found()
    # at most one row per prefix, so this is never more than a handful
    rows = (await ctx.db.execute(
        select(WikiHelpLink, WikiNode)
        .join(WikiNode, WikiNode.id == WikiHelpLink.node_id)
        .where(WikiHelpLink.context.in_(candidates))
        .order_by(func.char_length(WikiHelpLink.context).desc()))).all()
    visible, _ = await visible_nodes(ctx, [node for _, node in rows])
    viewable = {node.id for node in visible}
    for link, node in rows:
        if node.id in viewable:
            return HelpOut(node_id=node.id, title=node.title, url=guide_url(node.id),
                           context=link.context)
    raise not_found()


@router.get("/help-links", response_model=list[HelpLinkOut])
async def list_help_links(ctx: WikiContext) -> list[HelpLinkOut]:
    """Wiki administrators: every help link, by context."""
    _require_admin(ctx)
    rows = (await ctx.db.execute(_links_query().order_by(WikiHelpLink.context))).all()
    return await _links_out(ctx, rows)


@router.post("/help-links", response_model=HelpLinkOut, status_code=201)
async def create_help_link(body: HelpLinkIn, ctx: WikiContext) -> HelpLinkOut:
    _require_admin(ctx)
    context = _context(body.context)
    node = await _guide(ctx, body.node_id)
    if await _context_taken(ctx, context):
        raise _taken()

    actor_id = ctx.user.person.id
    link = WikiHelpLink(context=context, node_id=node.id, created_by=actor_id)
    ctx.db.add(link)
    await _flush_unique(ctx)
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_help_link", entity_id=str(link.id),
          action="create", changes={"context": context, "node_id": str(node.id)})
    await ctx.db.commit()
    return await _link_out(ctx, link.id)


@router.patch("/help-links/{link_id}", response_model=HelpLinkOut)
async def update_help_link(link_id: uuid.UUID, body: HelpLinkPatchIn,
                           ctx: WikiContext) -> HelpLinkOut:
    _require_admin(ctx)
    link = await ctx.db.get(WikiHelpLink, link_id)
    if link is None:
        raise not_found()

    context = _context(body.context) if body.context is not None else link.context
    node_id = link.node_id
    if body.node_id is not None and body.node_id != link.node_id:
        node_id = (await _guide(ctx, body.node_id)).id
    if context != link.context and await _context_taken(ctx, context, except_id=link.id):
        raise _taken()

    changes: dict[str, dict[str, str]] = {}
    if context != link.context:
        changes["context"] = {"from": link.context, "to": context}
        link.context = context
    if node_id != link.node_id:
        changes["node_id"] = {"from": str(link.node_id), "to": str(node_id)}
        link.node_id = node_id

    if changes:
        await _flush_unique(ctx)
        audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_help_link",
              entity_id=str(link.id), action="update", changes=changes)
        await ctx.db.commit()
    return await _link_out(ctx, link.id)


@router.delete("/help-links/{link_id}", status_code=204)
async def delete_help_link(link_id: uuid.UUID, ctx: WikiContext) -> Response:
    _require_admin(ctx)
    link = await ctx.db.get(WikiHelpLink, link_id)
    if link is None:
        raise not_found()
    audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_help_link",
          entity_id=str(link.id), action="delete",
          changes={"context": link.context, "node_id": str(link.node_id)})
    await ctx.db.delete(link)
    await ctx.db.commit()
    return Response(status_code=204)
