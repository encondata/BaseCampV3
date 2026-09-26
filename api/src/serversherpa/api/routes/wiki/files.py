"""Uploads, file versions, and page assets.

An upload never passes bytes through this process: `POST /uploads`
checks the caller can write to the destination and hands back a
presigned PUT URL (`storage.presign_put`) plus a signed upload token
(`wiki.files.make_upload_token`) carrying everything needed to finish
the job; the browser PUTs the bytes straight to storage; `POST
/uploads/complete` re-checks the token and the caller's level, confirms
the object landed (`storage.head_object`), and only then creates the
file node + version 1 (target `node`), a new version on an existing
file (target `version`), or a page-asset row (target `asset`).

`GET /files/{id}/url` and `POST /assets/urls` hand out presigned reads
for the object itself or its converted preview — inline only for what
`wiki.files.inline_content_type` allows, as an octet-stream attachment
otherwise, so nothing stored can run script from the bucket's origin.
Nothing here does the conversion or text extraction —
`wiki.files.enqueue` only queues the `file_preview`/`file_extract` jobs
Task 8's worker will pick up.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from serversherpa.api.routes.wiki.deps import WikiContext, destination, visible_nodes
from serversherpa.api.routes.wiki.errors import err, forbidden, is_edit, not_found
from serversherpa.api.routes.wiki.schemas import (
    AssetOut,
    AssetUrlsIn,
    AssetUrlsOut,
    FilePatchIn,
    FileUrlOut,
    FileVersionOut,
    NodeOut,
    UploadCompleteIn,
    UploadStartIn,
    UploadStartOut,
)
from serversherpa.api.routes.wiki.serialize import file_version_out, node_out, person_refs
from serversherpa.config import get_settings
from serversherpa.db.models import (
    WikiFile,
    WikiFileVersion,
    WikiNode,
    WikiPageAsset,
    WikiSpace,
)
from serversherpa.services import storage
from serversherpa.services.audit import audit, diff
from serversherpa.wiki import notify, tree
from serversherpa.wiki.files import (
    DEFAULT_CONTENT_TYPE,
    UploadTokenError,
    display_filename,
    enqueue,
    extract_status_for,
    inline_content_type,
    make_upload_token,
    normalize_content_type,
    preview_kind_for,
    preview_status_for,
    read_upload_token,
    sanitize_filename,
)
from serversherpa.wiki.pages import utcnow
from serversherpa.wiki.permissions import require_node_level
from serversherpa.wiki.search import refresh_search

router = APIRouter()


# ── uploads: start ───────────────────────────────────────────────────


async def _node_destination(ctx: WikiContext, space_id: uuid.UUID | None,
                            parent_id: uuid.UUID | None,
                            ) -> tuple[WikiSpace, WikiNode | None]:
    """(space, parent) for a new file node, once the caller is known to
    have edit there and the parent can hold a file — checked at upload
    start and again at complete, since the parent may have been trashed,
    moved, or had its grants changed while the bytes were uploading."""
    if space_id is None:
        raise err(422, "bad_target", "space_id is required to upload a new file.")
    space, parent, level = await destination(ctx, space_id, parent_id)
    if not is_edit(level):
        raise forbidden("edit")
    try:
        tree.check_parent(parent, space.id)
    except tree.TreeError as exc:
        raise err(422, exc.code, exc.message) from exc
    return space, parent


async def _resolve_start(ctx: WikiContext, body: UploadStartIn) -> tuple[uuid.UUID, dict]:
    """Check the caller can write to `body`'s destination and return
    (space_id for the storage key, the claims to carry in the upload
    token — `key` filled in by the caller once the space id is known)."""
    claims: dict = {
        "target": body.target, "space_id": None, "parent_id": None,
        "node_id": None, "page_id": None,
    }
    if body.target == "node":
        space, parent = await _node_destination(ctx, body.space_id, body.parent_id)
        claims["space_id"] = str(space.id)
        claims["parent_id"] = str(parent.id) if parent is not None else None
        return space.id, claims

    if body.target == "version":
        if body.node_id is None:
            raise err(422, "bad_target", "node_id is required to upload a new version.")
        node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, body.node_id),
                                        "edit")
        if node.kind != "file":
            raise not_found()
        claims["node_id"] = str(node.id)
        return node.space_id, claims

    if body.target == "asset":
        if body.page_id is None:
            raise err(422, "bad_target", "page_id is required to upload a page asset.")
        node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, body.page_id),
                                        "edit")
        if node.kind != "page":
            raise not_found()
        claims["page_id"] = str(node.id)
        return node.space_id, claims

    raise err(422, "bad_target", "target must be node, version, or asset.")  # pragma: no cover


@router.post("/uploads", response_model=UploadStartOut, status_code=200)
async def start_upload(body: UploadStartIn, ctx: WikiContext) -> UploadStartOut:
    settings = get_settings()
    if body.size <= 0:
        raise err(422, "bad_size", "size must be positive.")
    if body.size > settings.wiki_max_upload_bytes:
        raise err(413, "too_large",
                  f"Files are limited to {settings.wiki_max_upload_bytes} bytes.")

    content_type = normalize_content_type(body.content_type)
    filename = display_filename(body.filename)
    safe_name = sanitize_filename(body.filename)

    space_id, claims = await _resolve_start(ctx, body)
    key = f"wiki/{space_id}/{uuid.uuid4()}/{safe_name}"
    claims.update(key=key, filename=filename, content_type=content_type,
                 size=body.size, person=str(ctx.user.person.id))

    url = storage.presign_put(key, content_type, body.size)
    return UploadStartOut(upload_id=make_upload_token(claims), url=url,
                          headers={"Content-Type": content_type})


# ── uploads: complete ────────────────────────────────────────────────


async def _verify_object(key: str, size: int) -> None:
    head = await storage.head_object(key)
    if head is None or head["size"] != size:
        raise err(422, "upload_mismatch",
                  "The uploaded object wasn't found or its size didn't match.")


async def _new_file_version(ctx: WikiContext, node: WikiNode, *, storage_key: str,
                            filename: str, content_type: str, size: int,
                            version_no: int) -> WikiFileVersion:
    preview_kind = preview_kind_for(filename, content_type)
    version = WikiFileVersion(
        node_id=node.id, version_no=version_no, storage_key=storage_key,
        filename=filename, content_type=content_type, size_bytes=size,
        preview_kind=preview_kind, preview_status=preview_status_for(preview_kind),
        extract_status=extract_status_for(filename, content_type),
        uploaded_by=ctx.user.person.id)
    ctx.db.add(version)
    await ctx.db.flush()
    await _enqueue_pending_work(ctx, version)
    return version


async def _enqueue_pending_work(ctx: WikiContext, version: WikiFileVersion) -> None:
    """Queue the extract/preview jobs a version is still waiting on — for
    a fresh upload, or a restored copy of a version whose own jobs (keyed
    to the old version id) would never update the new row."""
    if version.extract_status == "pending":
        await enqueue(ctx.db, "file_extract", node_id=version.node_id,
                      file_version_id=version.id)
    if version.preview_status == "pending":
        await enqueue(ctx.db, "file_preview", node_id=version.node_id,
                      file_version_id=version.id)


async def _lock_file(ctx: WikiContext, node_id: uuid.UUID) -> WikiFile:
    """The file row, locked FOR UPDATE — taken before numbering a new
    version so two concurrent uploads/restores can't both claim n+1."""
    file_row = await ctx.db.scalar(
        select(WikiFile).where(WikiFile.node_id == node_id).with_for_update()
        .execution_options(populate_existing=True))
    if file_row is None:
        raise not_found()
    return file_row


async def _next_version_no(ctx: WikiContext, node_id: uuid.UUID) -> int:
    last_no = await ctx.db.scalar(
        select(func.max(WikiFileVersion.version_no))
        .where(WikiFileVersion.node_id == node_id))
    return (last_no or 0) + 1


@router.post("/uploads/complete", response_model=NodeOut | AssetOut, status_code=201)
async def complete_upload(body: UploadCompleteIn, ctx: WikiContext) -> NodeOut | AssetOut:
    try:
        claims = read_upload_token(body.upload_id)
    except UploadTokenError:
        raise err(422, "stale_upload", "This upload link has expired.") from None
    if claims.get("person") != str(ctx.user.person.id):
        raise err(403, "forbidden", "This upload belongs to someone else.")

    target = claims["target"]
    key = claims["key"]
    filename = claims["filename"]
    content_type = claims["content_type"]
    size = claims["size"]
    actor_id = ctx.user.person.id

    if target == "node":
        space_id = uuid.UUID(claims["space_id"])
        parent_id = uuid.UUID(claims["parent_id"]) if claims["parent_id"] else None
        # locked first, so the parent is re-checked as committed now
        await tree.lock_space_trees(ctx.db, space_id)
        space, parent = await _node_destination(ctx, space_id, parent_id)
        await _verify_object(key, size)

        node = await tree.create_node(ctx.db, space=space, parent=parent, kind="file",
                                      title=filename, actor_id=actor_id)
        ctx.db.add(WikiFile(node_id=node.id, description=""))
        version = await _new_file_version(
            ctx, node, storage_key=key, filename=filename, content_type=content_type,
            size=size, version_no=1)
        file_row = await ctx.db.get(WikiFile, node.id)
        file_row.current_version_id = version.id
        audit(ctx.db, actor_id=actor_id, entity_type="wiki_node", entity_id=str(node.id),
              action="upload", changes=diff({}, {
                  "kind": "file", "filename": filename, "content_type": content_type,
                  "size_bytes": size}))
        await refresh_search(ctx.db, node.id)
        # announced, but not auto-watched: watching every upload is noise
        await notify.on_created(ctx.db, node, actor_id=actor_id)
        await ctx.db.commit()
        return await node_out(ctx, node, await ctx.ix.level_for_node(node))

    if target == "version":
        node = await require_node_level(ctx.ix, await ctx.db.get(
            WikiNode, uuid.UUID(claims["node_id"])), "edit")
        if node.kind != "file":
            raise not_found()
        await _verify_object(key, size)

        file_row = await _lock_file(ctx, node.id)
        version = await _new_file_version(
            ctx, node, storage_key=key, filename=filename, content_type=content_type,
            size=size, version_no=await _next_version_no(ctx, node.id))
        file_row.current_version_id = version.id
        node.updated_at = utcnow()
        node.updated_by = actor_id
        audit(ctx.db, actor_id=actor_id, entity_type="wiki_node", entity_id=str(node.id),
              action="upload_version", changes={
                  "version_no": version.version_no, "filename": filename,
                  "content_type": content_type, "size_bytes": size})
        await refresh_search(ctx.db, node.id)
        await ctx.db.commit()
        return await node_out(ctx, node, await ctx.ix.level_for_node(node))

    # target == "asset"
    node = await require_node_level(ctx.ix, await ctx.db.get(
        WikiNode, uuid.UUID(claims["page_id"])), "edit")
    if node.kind != "page":
        raise not_found()
    await _verify_object(key, size)

    asset = WikiPageAsset(node_id=node.id, storage_key=key, filename=filename,
                          content_type=content_type, size_bytes=size,
                          uploaded_by=actor_id)
    ctx.db.add(asset)
    await ctx.db.flush()
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node", entity_id=str(node.id),
          action="asset_upload", changes={"asset_id": str(asset.id), "filename": filename})
    await ctx.db.commit()
    return AssetOut(id=asset.id, filename=asset.filename,
                    content_type=asset.content_type, size_bytes=asset.size_bytes)


# ── files: read, describe, versions, restore ─────────────────────────


async def _file_node(ctx: WikiContext, node_id: uuid.UUID, needed: str) -> WikiNode:
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), needed)
    if node.kind != "file":
        raise not_found()
    return node


@router.get("/files/{node_id}/versions", response_model=list[FileVersionOut])
async def list_file_versions(node_id: uuid.UUID, ctx: WikiContext) -> list[FileVersionOut]:
    node = await _file_node(ctx, node_id, "view")
    versions = (await ctx.db.scalars(
        select(WikiFileVersion).where(WikiFileVersion.node_id == node.id)
        .order_by(WikiFileVersion.version_no.desc()))).all()
    people = await person_refs(ctx.db, [v.uploaded_by for v in versions])
    return [file_version_out(v, people) for v in versions]


def _presign_view(key: str, filename: str, content_type: str, *,
                    preview_kind: str | None = None) -> str | None:
    """A presigned read meant for in-browser display: inline with the
    type `inline_content_type` allows, or — for anything that could run
    as active content, or simply has no native preview — an attachment
    served as application/octet-stream."""
    inline_type = inline_content_type(filename, content_type, preview_kind)
    if inline_type is None:
        return storage.presign_get(key, download_filename=filename,
                                   content_type=DEFAULT_CONTENT_TYPE)
    return storage.presign_get(key, download_filename=filename, inline=True,
                               content_type=inline_type)


@router.get("/files/{node_id}/url", response_model=FileUrlOut)
async def file_url(node_id: uuid.UUID, ctx: WikiContext,
                   version_id: uuid.UUID | None = None,
                   disposition: str = Query("attachment", pattern="^(inline|attachment)$"),
                   preview: bool = False) -> FileUrlOut:
    node = await _file_node(ctx, node_id, "view")
    file_row = await ctx.db.get(WikiFile, node.id)

    if version_id is not None:
        version = await ctx.db.get(WikiFileVersion, version_id)
        if version is None or version.node_id != node.id:
            raise not_found()
    else:
        if file_row is None or file_row.current_version_id is None:
            raise not_found()
        version = await ctx.db.get(WikiFileVersion, file_row.current_version_id)

    if preview and version.preview_kind == "pdf":
        if version.preview_status != "ready" or not version.preview_key:
            return FileUrlOut(url=None, content_type="application/pdf",
                              preview_status=version.preview_status)
        url = storage.presign_get(
            version.preview_key, download_filename=f"{version.filename}.pdf",
            inline=True, content_type="application/pdf")
        return FileUrlOut(url=url, content_type="application/pdf", preview_status="ready")

    if disposition == "inline":
        url = _presign_view(version.storage_key, version.filename, version.content_type,
                              preview_kind=version.preview_kind)
    else:
        url = storage.presign_get(version.storage_key, download_filename=version.filename)
    return FileUrlOut(url=url, content_type=version.content_type,
                      preview_status=version.preview_status)


@router.patch("/files/{node_id}", response_model=NodeOut)
async def patch_file(node_id: uuid.UUID, body: FilePatchIn, ctx: WikiContext) -> NodeOut:
    node = await _file_node(ctx, node_id, "edit")
    file_row = await ctx.db.get(WikiFile, node.id)
    before = {"description": file_row.description}
    file_row.description = body.description
    changes = diff(before, {"description": body.description})
    if changes:
        audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_node",
              entity_id=str(node.id), action="update", changes=changes)
        await refresh_search(ctx.db, node.id)
        await ctx.db.commit()
    return await node_out(ctx, node, await ctx.ix.level_for_node(node))


@router.post("/files/{node_id}/versions/{version_id}/restore",
            response_model=FileVersionOut, status_code=201)
async def restore_file_version(node_id: uuid.UUID, version_id: uuid.UUID,
                               ctx: WikiContext) -> FileVersionOut:
    node = await _file_node(ctx, node_id, "edit")
    source = await ctx.db.get(WikiFileVersion, version_id)
    if source is None or source.node_id != node.id:
        raise not_found()

    file_row = await _lock_file(ctx, node.id)
    actor_id = ctx.user.person.id
    version = WikiFileVersion(
        node_id=node.id, version_no=await _next_version_no(ctx, node.id),
        storage_key=source.storage_key, filename=source.filename,
        content_type=source.content_type, size_bytes=source.size_bytes, sha256=source.sha256,
        preview_kind=source.preview_kind, preview_key=source.preview_key,
        preview_status=source.preview_status, text_extract=source.text_extract,
        extract_status=source.extract_status,
        note=f"Restored from version {source.version_no}", uploaded_by=actor_id)
    ctx.db.add(version)
    await ctx.db.flush()
    await _enqueue_pending_work(ctx, version)

    file_row.current_version_id = version.id
    node.updated_at = utcnow()
    node.updated_by = actor_id
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node", entity_id=str(node.id),
          action="restore", changes={
              "from_version_id": str(source.id), "from_version_no": source.version_no,
              "version_no": version.version_no})
    await refresh_search(ctx.db, node.id)
    await ctx.db.commit()

    people = await person_refs(ctx.db, [version.uploaded_by])
    return file_version_out(version, people)


# ── page assets ──────────────────────────────────────────────────────


@router.post("/assets/urls", response_model=AssetUrlsOut)
async def asset_urls(body: AssetUrlsIn, ctx: WikiContext) -> AssetUrlsOut:
    """Presigned URLs for embedded page assets (inline where
    `inline_content_type` allows, an attachment otherwise). Unknown ids,
    and ids on a page the caller can't see — including a never-published
    page when they only have view, as in the tree — are simply omitted."""
    if not body.ids:
        return AssetUrlsOut(urls={})
    assets = (await ctx.db.scalars(
        select(WikiPageAsset).where(WikiPageAsset.id.in_(body.ids),
                                    WikiPageAsset.deleted_at.is_(None)))).all()
    if not assets:
        return AssetUrlsOut(urls={})

    pages = (await ctx.db.scalars(
        select(WikiNode).where(WikiNode.id.in_({a.node_id for a in assets})))).all()
    shown, _ = await visible_nodes(ctx, pages)
    shown_ids = {n.id for n in shown}

    urls: dict[uuid.UUID, str] = {}
    for asset in assets:
        if asset.node_id not in shown_ids:
            continue
        url = _presign_view(asset.storage_key, asset.filename, asset.content_type)
        if url is not None:
            urls[asset.id] = url
    return AssetUrlsOut(urls=urls)
