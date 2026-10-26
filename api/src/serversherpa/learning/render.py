"""Learning versions as HTML.

A version's HTML is rendered once, at publish, by the wiki render server
(the PDF export's path: `prepare_doc` → `render_fragment` →
`finish_fragment`) and stored with the version, so reading never needs
the render server or the wiki page. The content is first made safe for
readers outside the wiki (`public_doc`, the share-link rule): links to and
embeds of other wiki nodes become plain text, and mentions lose their ids.

`finish_fragment` opens every `<details>` section. That is kept on
purpose: a worker signs off on the whole text, so nothing they sign may
sit folded away.

Images are stored without a source — the document only holds asset ids —
and `html_with_images` gives each one a presigned URL when someone reads
the version, the same way `POST /wiki/assets/urls` does. Only the ids the
version recorded at publish are served: assets of the snapshotted page
itself (the share-link rule, `library.publish_version`)."""
import html
import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.routes.wiki.files import presign_view
from serversherpa.db.models import WikiPageAsset
from serversherpa.learning.models import LearningDocumentVersion
from serversherpa.wiki import export_html
from serversherpa.wiki.content import (
    EMPTY_DOC,
    PUBLIC_FILE_TEXT,
    PUBLIC_PAGE_TEXT,
    public_doc,
)

# web, mail and phone links are the only ones a reader keeps
_READER_HREF = re.compile(r"^(https?:|mailto:|tel:)", re.IGNORECASE)
# an image as `finish_fragment` leaves it without a source
_STORED_IMAGE = re.compile(
    r'(<figure data-wiki-image="([0-9a-fA-F-]{36})"(?: data-width="\d+")?><img)(?=[ >])')


class LearningRenderUnavailable(Exception):
    """The wiki render server couldn't be reached, failed (5xx) or sent
    bad output — worth another try."""


class LearningRenderRejected(Exception):
    """The wiki render server refused the page's content (a 4xx, e.g.
    422 `bad_doc`) — trying again won't help."""


def image_asset_ids(doc: Any) -> list[uuid.UUID]:
    """The `wikiImage` asset ids in `doc`, in document order, once each."""
    found: list[uuid.UUID] = []
    stack = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(reversed(node))
            continue
        if not isinstance(node, dict):
            continue
        attrs = node.get("attrs")
        if node.get("type") == "wikiImage" and isinstance(attrs, dict):
            try:
                asset_id = uuid.UUID(str(attrs.get("assetId")))
            except ValueError:
                asset_id = None
            if asset_id is not None and asset_id not in found:
                found.append(asset_id)
        content = node.get("content")
        if isinstance(content, list):
            stack.extend(reversed(content))
    return found


def _link_href(href: str) -> str | None:
    return href if _READER_HREF.match(href or "") else None


async def render_version_html(content_json: dict) -> tuple[str, list[uuid.UUID]]:
    """The page content as stored HTML (details sections open, see the
    module docstring), and the image asset ids in it. Raises
    LearningRenderRejected when the render server refuses the content,
    LearningRenderUnavailable when it can't help otherwise."""
    # no self id: a link to the page itself reads as any other linked page
    safe = public_doc(content_json or EMPTY_DOC, node_id="", title="")
    doc, hrefs = export_html.prepare_doc(
        safe, page_link=lambda _id: (PUBLIC_PAGE_TEXT, None),
        file_link=lambda _id: (PUBLIC_FILE_TEXT, None), link_href=_link_href)
    try:
        async with export_html.render_client() as client:
            fragment = await export_html.render_fragment(client, doc)
    except export_html.RenderError as exc:
        if exc.status is not None and 400 <= exc.status < 500:
            raise LearningRenderRejected(str(exc)) from exc
        raise LearningRenderUnavailable(str(exc)) from exc
    return (export_html.finish_fragment(fragment, hrefs=hrefs, images={}),
            image_asset_ids(doc))


async def html_with_images(db: AsyncSession, version: LearningDocumentVersion) -> str:
    """The version's stored HTML with a presigned source on each image
    whose id the version recorded at publish. Any other image, and one
    whose asset is deleted or gone (a purged page's), keeps only its alt
    text."""
    ids = list(version.image_asset_ids or [])
    if not ids:
        return version.content_html
    assets = (await db.scalars(
        select(WikiPageAsset).where(WikiPageAsset.id.in_(ids),
                                    WikiPageAsset.deleted_at.is_(None)))).all()
    urls: dict[str, str] = {}
    for asset in assets:
        url = presign_view(asset.storage_key, asset.filename, asset.content_type)
        if url is not None:
            urls[str(asset.id)] = url

    def image(match: re.Match) -> str:
        url = urls.get(match.group(2).lower())
        if url is None:
            return match.group(0)
        return f'{match.group(1)} src="{html.escape(url, quote=True)}"'

    return _STORED_IMAGE.sub(image, version.content_html)
