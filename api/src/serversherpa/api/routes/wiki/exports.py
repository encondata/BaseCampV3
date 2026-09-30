"""Exports (spec §8), the request side: `POST /wiki/exports` queues an
`export` job for the wiki worker (`serversherpa.wiki.export` does the
work); `GET /wiki/exports/{job_id}` reports it to the person who asked —
and only to them — with a fresh download URL once it's done.

- A node needs view (404 when the caller can't see it — including a
  never-published page they only have view on). A file is downloaded,
  not exported (422 `use_download`); a folder is a .zip only, a page
  a .pdf/.md, or a .zip when it has subpages the caller can see
  (the tree's visibility rule; 422 `bad_format`
  otherwise); a single page must have been published (422
  `not_published`).
- Printing turned off for the node: 403 `printing_disabled`, for anyone.
  A zip of a folder or library leaves out what can't be printed and lists
  it in `_skipped.txt` (`wiki/export.py`).
- A space (view on it) exports as a .zip.
- Each person may have MAX_ACTIVE_EXPORTS exports queued or running at
  once (429 `too_many_exports`), counted under a per-person lock so two
  requests at once can't both slip under it."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter
from sqlalchemy import func, select

from serversherpa.api.routes.wiki.deps import WikiContext, space_by_key, visible_nodes
from serversherpa.api.routes.wiki.errors import err, not_found
from serversherpa.api.routes.wiki.schemas import (
    ExportCreatedOut,
    ExportIn,
    ExportOut,
    ExportSettingsIn,
    ExportSettingsOut,
)
from serversherpa.db.models import SystemConfig, WikiJob, WikiNode, WikiPage
from serversherpa.services import storage
from serversherpa.services.audit import audit
from serversherpa.system.config_store import read_section
from serversherpa.wiki.export import (
    DOWNLOAD_URL_TTL_SECONDS,
    FAILED_MESSAGE,
    MAX_ACTIVE_EXPORTS,
    export_filename,
)
from serversherpa.wiki.permissions import require_node_level, require_space_level
from serversherpa.wiki.statement import (
    MAX_STATEMENT_LENGTH,
    SECTION,
    standard_statement,
    statement_ok,
)

router = APIRouter()

# pg_advisory_xact_lock(key, hashtext(person)) — one person's requests in turn
EXPORT_LOCK_KEY = 0x5715_0007


async def _has_viewable_children(ctx: WikiContext, node: WikiNode) -> bool:
    """Does the page have a subpage (or file) the caller can see?"""
    children = (await ctx.db.scalars(select(WikiNode).where(
        WikiNode.parent_id == node.id, WikiNode.deleted_at.is_(None)))).all()
    return bool((await visible_nodes(ctx, children))[0])


async def _node_target(ctx: WikiContext, body: ExportIn) -> tuple[WikiNode, dict]:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, body.node_id), "view")
    if node.kind == "file":
        raise err(422, "use_download", "Files aren't exported — download the file instead.")
    published = False
    if node.kind == "page":
        page = await ctx.db.get(WikiPage, node.id)
        published = page is not None and page.published_version_id is not None
        if not published and await ctx.ix.level_for_node(node) == "view":
            raise not_found()
    # after every "can't see it" refusal: a hidden item never answers 403
    if not await ctx.ix.can_print(node):
        raise err(403, "printing_disabled", "Printing is turned off for this item.")
    if body.format == "zip":
        if node.kind == "page" and not await _has_viewable_children(ctx, node):
            raise err(422, "bad_format",
                      "Only a folder, or a page with subpages, exports as a .zip.")
    elif node.kind == "folder":
        raise err(422, "bad_format", "A folder exports as a .zip.")
    elif not published:
        raise err(422, "not_published",
                  "Only published pages can be exported. Publish this page first.")
    return node, {"node_id": str(node.id)}


async def _check_active_limit(ctx: WikiContext, person_id: uuid.UUID) -> None:
    await ctx.db.execute(select(func.pg_advisory_xact_lock(
        EXPORT_LOCK_KEY, func.hashtext(str(person_id)))))
    active = await ctx.db.scalar(select(func.count()).select_from(WikiJob).where(
        WikiJob.kind == "export", WikiJob.created_by == person_id,
        WikiJob.status.in_(("queued", "running"))))
    if active >= MAX_ACTIVE_EXPORTS:
        raise err(429, "too_many_exports",
                  f"You already have {MAX_ACTIVE_EXPORTS} exports in progress. "
                  "Wait for one to finish, then try again.")


@router.post("/exports", response_model=ExportCreatedOut, status_code=202)
async def create_export(body: ExportIn, ctx: WikiContext) -> ExportCreatedOut:
    person_id = ctx.user.person.id
    node: WikiNode | None = None
    if body.space_key is not None:
        space = await require_space_level(
            ctx.ix, await space_by_key(ctx.db, body.space_key), "view")
        if body.format != "zip":
            raise err(422, "bad_format", "A library exports as a .zip.")
        title = space.name
        target = {"space_id": str(space.id), "space_key": space.key}
    else:
        node, target = await _node_target(ctx, body)
        title = node.title

    await _check_active_limit(ctx, person_id)
    job = WikiJob(kind="export", node_id=node.id if node else None, created_by=person_id,
                  payload={
                      "requester": str(person_id), **target, "format": body.format,
                      "zip_format": (body.zip_format or "pdf") if body.format == "zip" else None,
                      "title": title, "filename": export_filename(title, body.format)})
    ctx.db.add(job)
    await ctx.db.flush()
    job_id = job.id
    await ctx.db.commit()
    return ExportCreatedOut(job_id=job_id)


@router.get("/exports/{job_id}", response_model=ExportOut)
async def get_export(job_id: uuid.UUID, ctx: WikiContext) -> ExportOut:
    """The requester's own export (anyone else: 404 — as is one of an item
    the requester can no longer see)."""
    job = await ctx.db.get(WikiJob, job_id)
    if job is None or job.kind != "export" or job.created_by != ctx.user.person.id:
        raise not_found()
    payload = job.payload or {}
    result = job.result or {}
    node = await ctx.db.get(WikiNode, job.node_id) if job.node_id is not None else None
    # an item the requester can no longer see (made private by someone
    # else since) is missing, like its export
    if node is not None and await ctx.ix.level_for_node(node) is None:
        raise not_found()
    # a finished file isn't handed out once printing was turned off since
    if job.status == "done" and node is not None and not await ctx.ix.can_print(node):
        raise err(403, "printing_disabled", "Printing is turned off for this item.")
    filename = result.get("filename") or payload.get("filename") or "export"
    url = None
    if job.status == "done" and result.get("key"):
        url = storage.presign_get(result["key"], download_filename=filename,
                                  max_ttl_seconds=DOWNLOAD_URL_TTL_SECONDS)
    error = (result.get("message") or FAILED_MESSAGE) if job.status == "failed" else None
    return ExportOut(id=job.id, status=job.status, filename=filename, url=url, error=error)


def _require_admin(ctx: WikiContext) -> None:
    if not ctx.principal.is_admin:
        raise err(403, "forbidden", "Only wiki administrators can change export settings.")


@router.get("/admin/export-settings", response_model=ExportSettingsOut)
async def get_export_settings(ctx: WikiContext) -> ExportSettingsOut:
    _require_admin(ctx)
    return ExportSettingsOut(confidentiality_statement=await standard_statement(ctx.db))


@router.put("/admin/export-settings", response_model=ExportSettingsOut)
async def put_export_settings(body: ExportSettingsIn, ctx: WikiContext) -> ExportSettingsOut:
    _require_admin(ctx)
    statement = body.confidentiality_statement.strip()
    if not statement_ok(statement):
        raise err(422, "bad_setting",
                  f"The statement can be up to {MAX_STATEMENT_LENGTH} characters, "
                  "with no control characters.",
                  keys=["confidentiality_statement"])
    stored = await read_section(ctx.db, SECTION)
    before = str(stored.get("confidentiality_statement") or "")
    row = await ctx.db.get(SystemConfig, SECTION)
    if row is None:
        row = SystemConfig(section=SECTION)
        ctx.db.add(row)
    row.data = {**stored, "confidentiality_statement": statement}
    row.updated_at = datetime.now(UTC)
    row.updated_by = ctx.user.person.id
    if before != statement:
        audit(ctx.db, actor_id=ctx.user.person.id, entity_type="system",
              entity_id=SECTION, action="wiki_config_update",
              changes={"confidentiality_statement": {"from": before, "to": statement}})
    await ctx.db.commit()
    return ExportSettingsOut(confidentiality_statement=statement)
