"""Page content, publishing and history: read a page's published content,
its live draft or any version; seed an imported page's draft; publish the
draft; list and read versions; record a restore.

Readers (view) see published content and `published` versions only;
editors see everything. A page that was never published doesn't exist
for a view-only caller (404 `not_published`), matching the tree, which
hides it from them. The rules themselves live in `serversherpa.wiki.pages`.
"""
from __future__ import annotations

import uuid
from collections.abc import Mapping

from fastapi import APIRouter, Response
from sqlalchemy import select

from serversherpa.api.routes.wiki.deps import WikiContext
from serversherpa.api.routes.wiki.errors import err, forbidden, is_edit, not_found
from serversherpa.api.routes.wiki.schemas import (
    DraftIn,
    PageContentOut,
    PersonRef,
    PublishIn,
    RestoreIn,
    VersionDetail,
    VersionOut,
)
from serversherpa.api.routes.wiki.serialize import person_refs
from serversherpa.db.models import WikiNode, WikiPage, WikiPageVersion
from serversherpa.services.audit import audit
from serversherpa.wiki import notify, pages
from serversherpa.wiki.content import EMPTY_DOC
from serversherpa.wiki.permissions import level_rank, require_node_level

router = APIRouter()


async def _page_for(ctx: WikiContext, node_id: uuid.UUID, needed: str,
                    ) -> tuple[WikiNode, WikiPage, str | None]:
    """(node, page, the caller's level) for a live page they can see: 404
    `not_found` when it isn't a page they can view, 404 `not_published`
    when they only have view and it was never published, then 403 when
    they lack `needed`."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    page = await ctx.db.get(WikiPage, node.id) if node.kind == "page" else None
    if page is None:
        raise not_found()
    level = await ctx.ix.level_for_node(node)
    if not is_edit(level) and page.published_version_id is None:
        raise err(404, "not_published", "This page hasn't been published yet.")
    if level_rank(level) < level_rank(needed):
        raise forbidden(needed)
    return node, page, level


async def _version_for(ctx: WikiContext, node: WikiNode, level: str | None,
                       version_id: uuid.UUID) -> WikiPageVersion:
    """One of the page's versions: 404 when it isn't one, 403 when it
    isn't a published one and the caller only has view."""
    version = await ctx.db.get(WikiPageVersion, version_id)
    if version is None or version.node_id != node.id:
        raise not_found()
    if version.kind != "published" and not is_edit(level):
        raise forbidden("edit")
    return version


def _version_out(version: WikiPageVersion,
                 people: Mapping[uuid.UUID, PersonRef]) -> VersionOut:
    return VersionOut(
        id=version.id, version_no=version.version_no, kind=version.kind,
        title=version.title, note=version.note,
        created_by=people.get(version.created_by) if version.created_by else None,
        created_at=version.created_at)


async def _one_version_out(ctx: WikiContext, version: WikiPageVersion) -> VersionOut:
    return _version_out(version, await person_refs(ctx.db, [version.created_by]))


def _content_of(version: WikiPageVersion) -> dict:
    return version.content_json if version.content_json is not None else EMPTY_DOC


# ── content ──────────────────────────────────────────────────────────


@router.get("/pages/{node_id}/content", response_model=PageContentOut)
async def get_content(node_id: uuid.UUID, ctx: WikiContext,
                      version: str = "published") -> PageContentOut:
    """`version` is `published` (default), `draft` (edit), or a version
    id (edit, unless it's a published version)."""
    node, page, level = await _page_for(ctx, node_id, "view")

    if version == "draft":
        if not is_edit(level):
            raise forbidden("edit")
        content = page.draft_json
        if content is None:
            content = await pages.published_content(ctx.db, page) or EMPTY_DOC
        people = await person_refs(ctx.db, [page.draft_updated_by])
        return PageContentOut(
            version_id=None, version_no=None, kind="draft", title=node.title,
            content_json=content, created_at=page.draft_updated_at,
            created_by=people.get(page.draft_updated_by) if page.draft_updated_by else None)

    if version == "published":
        if page.published_version_id is None:
            raise err(404, "not_published", "This page hasn't been published yet.")
        row = await ctx.db.get(WikiPageVersion, page.published_version_id)
    else:
        try:
            version_id = uuid.UUID(version)
        except ValueError:
            raise err(422, "bad_version",
                       "version must be published, draft, or a version id.") from None
        row = await _version_for(ctx, node, level, version_id)

    people = await person_refs(ctx.db, [row.created_by])
    return PageContentOut(
        version_id=row.id, version_no=row.version_no, kind=row.kind,
        title=row.title, content_json=_content_of(row), created_at=row.created_at,
        created_by=people.get(row.created_by) if row.created_by else None)


# ── import ───────────────────────────────────────────────────────────


@router.put("/nodes/{node_id}/draft", status_code=204)
async def put_draft(node_id: uuid.UUID, body: DraftIn, ctx: WikiContext) -> Response:
    """Seed an imported page's draft — only while it was never opened live
    (409 `already_live` after that). Records an `imported` version."""
    node, page, _ = await _page_for(ctx, node_id, "edit")
    actor_id = ctx.user.person.id
    version = await pages.import_draft(ctx.db, page, node, content_json=body.content_json,
                                       actor_id=actor_id)
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
          entity_id=str(node.id), action="import",
          changes={"version_id": str(version.id), "version_no": version.version_no})
    await ctx.db.commit()
    return Response(status_code=204)


# ── publish ──────────────────────────────────────────────────────────


@router.post("/pages/{node_id}/publish", response_model=VersionOut, status_code=201)
async def publish(node_id: uuid.UUID, body: PublishIn, ctx: WikiContext) -> VersionOut:
    node, page, _ = await _page_for(ctx, node_id, "edit")
    actor_id = ctx.user.person.id
    version, mentioned = await pages.publish(ctx.db, node, page, actor_id=actor_id,
                                             note=body.note or None)
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
          entity_id=str(node.id), action="publish",
          changes={"version_id": str(version.id), "version_no": version.version_no,
                   "note": version.note})
    await notify.auto_watch(ctx.db, actor_id, node.id)
    await notify.on_published(ctx.db, node, actor_id=actor_id, version=version,
                              skip=mentioned)
    await ctx.db.commit()
    return await _one_version_out(ctx, version)


# ── versions ─────────────────────────────────────────────────────────


@router.get("/pages/{node_id}/versions", response_model=list[VersionOut])
async def list_versions(node_id: uuid.UUID, ctx: WikiContext) -> list[VersionOut]:
    """Newest first; view-only callers get the published versions only."""
    node, _, level = await _page_for(ctx, node_id, "view")
    q = select(WikiPageVersion).where(WikiPageVersion.node_id == node.id)
    if not is_edit(level):
        q = q.where(WikiPageVersion.kind == "published")
    versions = (await ctx.db.scalars(
        q.order_by(WikiPageVersion.version_no.desc()))).all()
    people = await person_refs(ctx.db, [v.created_by for v in versions])
    return [_version_out(v, people) for v in versions]


@router.get("/pages/{node_id}/versions/{version_id}", response_model=VersionDetail)
async def get_version(node_id: uuid.UUID, version_id: uuid.UUID,
                      ctx: WikiContext) -> VersionDetail:
    node, _, level = await _page_for(ctx, node_id, "view")
    version = await _version_for(ctx, node, level, version_id)
    out = await _one_version_out(ctx, version)
    return VersionDetail(**out.model_dump(), content_json=_content_of(version))


@router.post("/pages/{node_id}/versions/restored", response_model=VersionOut,
             status_code=201)
async def record_restore(node_id: uuid.UUID, body: RestoreIn,
                         ctx: WikiContext) -> VersionOut:
    """Record that an editor restored an earlier version. The editor loads
    that version's content into the live document itself (which syncs to
    everyone and reaches the draft through the collab store); this only
    snapshots it as a `restored` version."""
    node, _, level = await _page_for(ctx, node_id, "edit")
    source = await _version_for(ctx, node, level, body.from_version_id)
    actor_id = ctx.user.person.id
    version = await pages.add_version(
        ctx.db, node, kind="restored", title=node.title,
        content_json=_content_of(source), actor_id=actor_id,
        note=f"Restored from version {source.version_no}")
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node",
          entity_id=str(node.id), action="restore",
          changes={"from_version_id": str(source.id),
                   "from_version_no": source.version_no,
                   "version_id": str(version.id), "version_no": version.version_no})
    await ctx.db.commit()
    return await _one_version_out(ctx, version)
