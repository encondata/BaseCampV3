"""`GET /wiki/public/{token}` — the unauthenticated read behind a public
share link (spec §8). No session, no wiki:view gate: the token is the
only credential.

- Rate-limited per client address first (`share_links.public_limiter`,
  keyed by `deps.rate_limit_ip`): 429 `rate_limited` past the cap.
- Every other failure is the same 404 `not_found` — an unknown, revoked
  or expired token, a space whose public links were turned off, a node
  that was trashed or purged, a page that was never published — so a
  response never says which.
- A page answers its PUBLISHED content only, through
  `content.public_doc` (no comment anchors, no links into the rest of the
  wiki, no person ids), with presigned URLs for exactly the page's own
  assets that content embeds. A file answers its current version. Every
  presigned URL follows the uploads' inline rules
  (`files.presign_view`) and lives at most PUBLIC_URL_TTL_SECONDS.
- A successful read counts a view with one UPDATE (no read-modify-write).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Request, Response
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import DbSession, rate_limit_ip
from serversherpa.api.routes.wiki.errors import err, not_found
from serversherpa.api.routes.wiki.files import presign_view
from serversherpa.api.routes.wiki.schemas import PublicFileOut, PublicPageOut
from serversherpa.db.models import (
    WikiFile,
    WikiFileVersion,
    WikiNode,
    WikiPage,
    WikiPageAsset,
    WikiPageVersion,
    WikiShareLink,
    WikiSpace,
)
from serversherpa.services import storage
from serversherpa.wiki.content import EMPTY_DOC, public_doc, referenced_asset_ids
from serversherpa.wiki.files import inline_content_type
from serversherpa.wiki.pages import utcnow
from serversherpa.wiki.share_links import (
    MAX_TOKEN_LENGTH,
    PUBLIC_URL_TTL_SECONDS,
    hash_token,
    public_limiter,
)
from serversherpa.wiki.space_settings import space_setting

router = APIRouter()


async def _page_out(db: AsyncSession, node: WikiNode) -> PublicPageOut:
    page = await db.get(WikiPage, node.id)
    version = (await db.get(WikiPageVersion, page.published_version_id)
               if page is not None and page.published_version_id is not None else None)
    if version is None:
        raise not_found()
    content = public_doc(version.content_json or EMPTY_DOC, node_id=node.id, title=node.title)

    # the ids as the document spells them — the SPA looks URLs up by that
    wanted: dict[uuid.UUID, list[str]] = {}
    for raw in referenced_asset_ids(content):
        try:
            wanted.setdefault(uuid.UUID(raw), []).append(raw)
        except ValueError:
            continue
    urls: dict[str, str] = {}
    if wanted:
        assets = (await db.scalars(select(WikiPageAsset).where(
            WikiPageAsset.id.in_(wanted), WikiPageAsset.node_id == node.id,
            WikiPageAsset.deleted_at.is_(None)))).all()
        for asset in assets:
            url = presign_view(asset.storage_key, asset.filename, asset.content_type,
                               max_ttl_seconds=PUBLIC_URL_TTL_SECONDS)
            for raw in wanted[asset.id]:
                urls[raw] = url
    return PublicPageOut(title=node.title, content_json=content,
                         published_at=version.created_at, asset_urls=urls)


async def _file_out(db: AsyncSession, node: WikiNode) -> PublicFileOut:
    file_row = await db.get(WikiFile, node.id)
    version = (await db.get(WikiFileVersion, file_row.current_version_id)
               if file_row is not None and file_row.current_version_id is not None else None)
    if version is None:
        raise not_found()
    return PublicFileOut(
        title=node.title, filename=version.filename, content_type=version.content_type,
        size_bytes=version.size_bytes,
        inline=inline_content_type(version.filename, version.content_type,
                                   version.preview_kind) is not None,
        url=presign_view(version.storage_key, version.filename, version.content_type,
                         preview_kind=version.preview_kind,
                         max_ttl_seconds=PUBLIC_URL_TTL_SECONDS),
        download_url=storage.presign_get(version.storage_key,
                                         download_filename=version.filename,
                                         max_ttl_seconds=PUBLIC_URL_TTL_SECONDS))


@router.get("/public/{token}", response_model=PublicPageOut | PublicFileOut)
async def public_share(token: str, request: Request, response: Response,
                       db: DbSession) -> PublicPageOut | PublicFileOut:
    if not public_limiter.hit(rate_limit_ip(request)):
        raise err(429, "rate_limited", "Too many requests. Try again in a minute.")
    if not token or len(token) > MAX_TOKEN_LENGTH:
        raise not_found()

    link = await db.scalar(select(WikiShareLink).where(
        WikiShareLink.token_hash == hash_token(token),
        WikiShareLink.revoked_at.is_(None),
        or_(WikiShareLink.expires_at.is_(None), WikiShareLink.expires_at > utcnow())))
    node = await db.get(WikiNode, link.node_id) if link is not None else None
    if node is None or node.deleted_at is not None:
        raise not_found()
    space = await db.get(WikiSpace, node.space_id)
    if space is None or not space_setting(space, "allow_public_links"):
        raise not_found()

    if node.kind == "page":
        out: PublicPageOut | PublicFileOut = await _page_out(db, node)
    elif node.kind == "file":
        out = await _file_out(db, node)
    else:
        raise not_found()

    await db.execute(update(WikiShareLink).where(WikiShareLink.id == link.id).values(
        view_count=WikiShareLink.view_count + 1, last_viewed_at=func.now()))
    await db.commit()
    # the URLs inside expire within minutes: never serve this from a cache
    response.headers["Cache-Control"] = "no-store"
    return out
