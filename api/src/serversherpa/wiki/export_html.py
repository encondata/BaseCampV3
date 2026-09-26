"""A page as a printable HTML document, for PDF and Word exports (spec §8).

1. `prepare_doc` rewrites what a page says about the rest of the wiki
   before rendering: a page link becomes its target's title (linked, when
   the export resolves a path for it), a file-node embed a line with the
   file's title, and an internal `/n/<id>` link keeps its href only where
   the export resolves one. Resolved targets are left as `/n/<id>` hrefs
   (the only internal form the schema's renderer lets through) and
   swapped for their relative paths afterwards.
2. `render_fragment` asks the wiki server to render the JSON with the
   shared editor schema (`POST {wiki_render_url}/internal/render`, the
   service token), so the export looks like the page.
3. `finish_fragment` swaps in those relative paths, gives each image its
   data URI (the schema renders images without a source — the document
   only holds an asset id), and opens every collapsible section.
4. `page_document` wraps it in the print template: title, breadcrumbs,
   published date, and CSS with the portal's type and colors (the
   renderer drops `style` attributes — alignment arrives as
   `data-text-align`).

`html_to_pdf` is WeasyPrint (blocking — callers run it in a thread)."""
from __future__ import annotations

import copy
import html
import re
from collections.abc import Callable
from datetime import datetime
from typing import Any
from urllib.parse import quote

import httpx

from serversherpa.config import get_settings

RENDER_TIMEOUT_SECONDS = 30
RENDER_PATH = "/internal/render"
SERVICE_TOKEN_HEADER = "X-Wiki-Service-Token"

# tests stand in for the wiki server here (an httpx transport)
_transport: httpx.AsyncBaseTransport | None = None

_NODE_HREF = re.compile(r"^/n/([0-9a-fA-F-]{36})(?:[/?#].*)?$")
_RENDERED_NODE_HREF = re.compile(r'href="/n/([0-9a-fA-F-]{36})"')
_RENDERED_IMAGE = re.compile(
    r'<figure data-wiki-image="([^"]*)"((?: data-width="(\d+)")?)><img ')
_RENDERED_DETAILS = re.compile(r"<details(?=[ >])")


class RenderError(Exception):
    """The wiki server couldn't render a page (down, refused, or bad
    output) — worth another try."""


def render_client() -> httpx.AsyncClient:
    """One client per export job (connections reused across its pages)."""
    return httpx.AsyncClient(timeout=RENDER_TIMEOUT_SECONDS, transport=_transport)


async def render_fragment(client: httpx.AsyncClient, doc: dict) -> str:
    """The document rendered by the wiki server: an HTML fragment."""
    s = get_settings()
    url = f"{s.wiki_render_url.rstrip('/')}{RENDER_PATH}"
    try:
        resp = await client.post(url, json={"doc": doc}, headers={
            SERVICE_TOKEN_HEADER: s.wiki_service_token.get_secret_value()})
    except httpx.HTTPError as exc:
        raise RenderError(f"the wiki server could not be reached: {exc}") from exc
    if resp.status_code != 200:
        raise RenderError(f"the wiki server answered {resp.status_code}: {resp.text[:300]}")
    try:
        fragment = resp.json()["html"]
    except (ValueError, KeyError, TypeError) as exc:
        raise RenderError("the wiki server sent no HTML") from exc
    if not isinstance(fragment, str):
        raise RenderError("the wiki server sent no HTML")
    return fragment


# ── before rendering ─────────────────────────────────────────────────


def node_href_id(href: str) -> str | None:
    """The node id of an internal `/n/<id>…` href, lowercased, else None."""
    match = _NODE_HREF.match(href or "")
    return match.group(1).lower() if match else None


def _text(value: str, marks: list | None) -> dict:
    node: dict[str, Any] = {"type": "text", "text": value}
    if marks:
        node["marks"] = marks
    return node


def _link_mark(node_id: str) -> dict:
    return {"type": "link", "attrs": {"href": f"/n/{node_id}"}}


def prepare_doc(doc: dict, *,
                page_link: Callable[[str | None], tuple[str, str | None]],
                file_link: Callable[[str], tuple[str, str | None]],
                link_href: Callable[[str], str | None],
                ) -> tuple[dict, dict[str, str]]:
    """A deep copy of `doc` ready to render, and the relative path each
    remaining `/n/<id>` href stands for.

    `page_link(node_id)` and `file_link(node_id)` give a target's
    (text, relative path or None); `link_href(href)` a `link` mark's
    relative path, or None to keep only its text (a web link passes
    through `link_href` untouched when it returns it unchanged)."""
    hrefs: dict[str, str] = {}
    out = copy.deepcopy(doc)
    stack: list[Any] = [out]

    def internal_link(node_id: str, path: str | None) -> list[dict]:
        if not path:
            return []
        hrefs[node_id] = path
        return [_link_mark(node_id)]

    def rewrite_marks(marks: Any) -> list | None:
        if not isinstance(marks, list):
            return None
        kept = []
        for mark in marks:
            if isinstance(mark, dict) and mark.get("type") == "link":
                attrs = mark.get("attrs") if isinstance(mark.get("attrs"), dict) else {}
                href = attrs.get("href") if isinstance(attrs.get("href"), str) else ""
                target_id = node_href_id(href)
                if target_id is None:
                    if link_href(href):
                        kept.append(mark)
                    continue
                kept.extend(internal_link(target_id, link_href(href)))
                continue
            kept.append(mark)
        return kept

    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        content = node.get("content")
        if not isinstance(content, list):
            continue
        rebuilt: list[Any] = []
        for child in content:
            if not isinstance(child, dict):
                continue
            kind = child.get("type")
            attrs = child.get("attrs") if isinstance(child.get("attrs"), dict) else {}
            if kind == "pageLink":
                raw = attrs.get("nodeId")
                node_id = raw.lower() if isinstance(raw, str) and raw else None
                label, path = page_link(node_id)
                marks = [m for m in (rewrite_marks(child.get("marks")) or [])
                         if m.get("type") != "link"]
                links = internal_link(node_id, path) if node_id else []
                rebuilt.append(_text(label, links + marks))
                continue
            if kind == "fileEmbed" and isinstance(attrs.get("nodeId"), str) and attrs["nodeId"]:
                node_id = attrs["nodeId"].lower()
                label, path = file_link(node_id)
                rebuilt.append({"type": "paragraph", "content": [
                    _text(label, internal_link(node_id, path))]})
                continue
            if "marks" in child:
                marks = rewrite_marks(child["marks"])
                if marks:
                    child["marks"] = marks
                else:
                    del child["marks"]
            rebuilt.append(child)
            stack.append(child)
        node["content"] = rebuilt
    return out, hrefs


# ── after rendering ──────────────────────────────────────────────────


def href_for_path(path: str) -> str:
    """A relative file path as an href (percent-encoded, HTML-escaped)."""
    return html.escape(quote(path, safe="/"), quote=True)


def finish_fragment(fragment: str, *, hrefs: dict[str, str],
                    images: dict[str, str]) -> str:
    """Swap `/n/<id>` hrefs for their relative paths (dropping any the
    export didn't resolve), give each image its source from `images`
    (asset id → data URI or path; an image without one keeps only its
    alt text), and open every details section for print."""
    def link(match: re.Match) -> str:
        path = hrefs.get(match.group(1).lower())
        return f'href="{href_for_path(path)}"' if path else ""

    def image(match: re.Match) -> str:
        asset_id, width_attr, width = match.group(1), match.group(2), match.group(3)
        src = images.get(asset_id)
        style = f' style="width: {int(width)}px; max-width: 100%"' if width else ""
        source = f' src="{html.escape(src, quote=True)}"' if src else ""
        return f'<figure data-wiki-image="{asset_id}"{width_attr}><img{source}{style} '

    out = _RENDERED_NODE_HREF.sub(link, fragment)
    out = _RENDERED_IMAGE.sub(image, out)
    return _RENDERED_DETAILS.sub("<details open", out)


# ── the print template ───────────────────────────────────────────────

PRINT_CSS = """
@page {
  size: Letter; margin: 18mm 16mm 20mm;
  @bottom-right { content: counter(page) " / " counter(pages);
                  font: 8pt 'Geologica', 'Helvetica Neue', Helvetica, Arial, sans-serif;
                  color: #667085; }
}
body { font: 10.5pt/1.5 'Geologica', 'Helvetica Neue', Helvetica, Arial, sans-serif;
       color: #1b2129; margin: 0; }
.ss-head { border-bottom: 1px solid #e4e8ee; margin-bottom: 6mm; padding-bottom: 3mm; }
.ss-crumbs { font-size: 8.5pt; color: #667085; }
.ss-title { font-size: 22pt; line-height: 1.2; margin: 1mm 0 1.5mm; }
.ss-meta { font-size: 8.5pt; color: #667085; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 5mm 0 2mm; page-break-after: avoid; }
p { margin: 0 0 2.5mm; }
[data-text-align="left"] { text-align: left; }
[data-text-align="center"] { text-align: center; }
[data-text-align="right"] { text-align: right; }
[data-text-align="justify"] { text-align: justify; }
a { color: #b45f06; }
mark { background: #fff3bf; }
code, pre { font-family: 'Fragment Mono', Menlo, Consolas, 'Courier New', monospace; }
code { background: #f1f4f7; border-radius: 3px; padding: 0 1mm; font-size: 0.9em; }
pre { background: #f1f4f7; border: 1px solid #e4e8ee; border-radius: 4px; padding: 3mm;
      white-space: pre-wrap; font-size: 9pt; }
pre code { background: none; padding: 0; font-size: inherit; }
blockquote { border-left: 3px solid #d0d5dd; margin: 3mm 0; padding: 0 0 0 4mm; color: #475467; }
hr { border: 0; border-top: 1px solid #e4e8ee; margin: 5mm 0; }
table { border-collapse: collapse; width: 100%; margin: 3mm 0; }
th, td { border: 0.5pt solid #d0d5dd; padding: 1.5mm 2mm; text-align: left; vertical-align: top; }
th { background: #f1f4f7; font-weight: 600; }
th > p, td > p { margin: 0; }
tr { page-break-inside: avoid; }
div[data-callout] { border-left: 4px solid #2563eb; background: #eff6ff; border-radius: 4px;
                    padding: 2mm 4mm; margin: 3mm 0; }
div[data-callout]::before { display: block; font-size: 8pt; font-weight: 700;
                            letter-spacing: 0.04em; text-transform: uppercase;
                            margin-bottom: 1mm; content: "Info"; color: #2563eb; }
div[data-callout] > p:last-child { margin-bottom: 0; }
div[data-callout="tip"] { border-color: #16a34a; background: #f0fdf4; }
div[data-callout="tip"]::before { content: "Tip"; color: #16a34a; }
div[data-callout="warning"] { border-color: #d97706; background: #fffbeb; }
div[data-callout="warning"]::before { content: "Warning"; color: #b45309; }
div[data-callout="danger"] { border-color: #dc2626; background: #fef2f2; }
div[data-callout="danger"]::before { content: "Danger"; color: #dc2626; }
figure[data-wiki-image] { margin: 4mm 0; text-align: center; page-break-inside: avoid; }
figure[data-wiki-image] img { max-width: 100%; }
figcaption { font-size: 8.5pt; color: #667085; margin-top: 1mm; }
div[data-file-embed] { border: 1px solid #e4e8ee; border-radius: 4px; padding: 2mm 3mm;
                       margin: 3mm 0; font-size: 9pt; }
ul[data-type="taskList"] { list-style: none; padding-left: 0; }
li[data-type="taskItem"] { position: relative; padding-left: 6mm; margin-bottom: 1mm; }
li[data-type="taskItem"] > label { position: absolute; left: 0; top: 0; }
li[data-type="taskItem"] > div > p { margin: 0; }
details { border: 1px solid #e4e8ee; border-radius: 4px; padding: 2mm 3mm; margin: 3mm 0; }
summary { font-weight: 600; }
.wiki-mention { color: #b45f06; font-weight: 500; }
"""


def _published_label(published_at: datetime | None) -> str:
    if published_at is None:
        return ""
    return f"Published {published_at.strftime('%B')} {published_at.day}, {published_at.year}"


def page_document(*, title: str, breadcrumbs: list[str], published_at: datetime | None,
                  body: str) -> str:
    """The full printable HTML page around a finished fragment."""
    esc = html.escape
    crumbs = " › ".join(esc(c) for c in breadcrumbs)
    published = _published_label(published_at)
    return (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        f"<title>{esc(title)}</title>\n<style>{PRINT_CSS}</style>\n</head>\n<body>\n"
        "<header class=\"ss-head\">\n"
        + (f"<div class=\"ss-crumbs\">{crumbs}</div>\n" if crumbs else "")
        + f"<h1 class=\"ss-title\">{esc(title)}</h1>\n"
        + (f"<div class=\"ss-meta\">{esc(published)}</div>\n" if published else "")
        + "</header>\n<main>\n" + body + "\n</main>\n</body>\n</html>\n")


def _data_only_fetcher():
    """A WeasyPrint URL fetcher that loads `data:` URIs and nothing else:
    an export's images are all inlined, so any other fetch would be the
    document reaching out somewhere it shouldn't."""
    try:
        # WeasyPrint 68+
        from weasyprint.urls import URLFetcher
    except ImportError:  # pragma: no cover - older WeasyPrint
        from weasyprint import default_url_fetcher

        def fetch(url, *args, **kwargs):
            if not url.lower().startswith("data:"):
                raise ValueError(f"export documents load data: URIs only, not {url[:40]}")
            return default_url_fetcher(url, *args, **kwargs)
        return fetch
    return URLFetcher(allowed_protocols={"data"})


def html_to_pdf(document: str) -> bytes:
    """WeasyPrint. Blocking — run it in a thread. No base URL: a document
    only refers to data URIs and relative paths inside its export, and
    loads nothing but data URIs (`_data_only_fetcher`)."""
    # a slow import: keep it off module load
    from weasyprint import HTML
    return HTML(string=document, url_fetcher=_data_only_fetcher()).write_pdf()
