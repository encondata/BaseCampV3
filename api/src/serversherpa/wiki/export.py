"""Exports (spec §8): a page as a PDF, Word document or Markdown file, or
a folder, a page with its subpages, or a whole space as a .zip.

`POST /wiki/exports` (routes/wiki/exports.py) queues an `export` job;
the wiki worker runs it through `run`, as the person who asked:

- Their access is rebuilt when the job runs (`principal_for_person`):
  only what they can view goes in. A node they can't view leaves out
  its whole subtree (its folder name would name it); so does a
  never-published page they only have view on (they can't see it at all).
- Pages export their PUBLISHED content only, without comment anchors. A
  never-published page an editor can see is left out and named in
  `_skipped.txt` at the top of the zip; its subpages still go in, under
  its name.
- A zip mirrors the tree with safe, unique names (`safe_name`), and
  holds each viewable file at its current version. Links between pages
  (and to files) in the same zip become relative links; anything else
  becomes its title — or "(linked page)" / "(linked file)" for what the
  requester can't view.
- PDF and Word pages go through the wiki server's renderer and the
  print template (`export_html`), with images inlined as data URIs;
  Markdown goes through `markdown.to_markdown`, with images written into
  `assets/` in a zip (a single Markdown page gets a placeholder for each).

Session discipline, as for the worker's other jobs: every DB read is
done and committed before any rendering, download or conversion starts;
`run` only bumps the job's `progress_at` now and then (so a long export
isn't taken for an abandoned one). The worker records the result and
notifies the requester."""
from __future__ import annotations

import asyncio
import base64
import posixpath
import re
import tempfile
import time
import unicodedata
import uuid
import zipfile
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Person,
    UserAccount,
    WikiFile,
    WikiFileVersion,
    WikiJob,
    WikiNode,
    WikiPage,
    WikiPageAsset,
    WikiPageVersion,
    WikiSpace,
)
from serversherpa.services import storage
from serversherpa.wiki import convert, export_html
from serversherpa.wiki.content import (
    EMPTY_DOC,
    PUBLIC_FILE_TEXT,
    PUBLIC_PAGE_TEXT,
    referenced_asset_ids,
    strip_comment_marks,
)
from serversherpa.wiki.files import normalize_content_type, sanitize_filename
from serversherpa.wiki.markdown import MarkdownRefs, to_markdown
from serversherpa.wiki.permissions import AccessIndex, principal_for_person, viewable_nodes

PAGE_FORMATS = ("pdf", "docx", "md")
FORMATS = (*PAGE_FORMATS, "zip")
EXTENSIONS = {"pdf": ".pdf", "docx": ".docx", "md": ".md", "zip": ".zip"}
CONTENT_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "md": "text/markdown; charset=utf-8",
    "zip": "application/zip",
}
EXPORT_KEY = "wiki/exports/{job_id}/{name}"
# every object an export job could ever have written, its own attempts
# included — the retention sweep purges the whole prefix, not just the
# one key the winning attempt's result recorded
EXPORT_PREFIX = "wiki/exports/{job_id}/"
# how long an export's file (and its job row) is kept
EXPORT_RETENTION = timedelta(days=7)
# queued + running exports one person may have at once
MAX_ACTIVE_EXPORTS = 3
# the download URL `GET /wiki/exports/{id}` hands out (fresh on every read)
DOWNLOAD_URL_TTL_SECONDS = 600

SKIPPED_FILE = "_skipped.txt"
ASSETS_DIR = "assets"
HIDDEN_CRUMB = "…"
# images a PDF/Word page inlines (never SVG: it's active markup)
INLINE_IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})
MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024
# the most image data one PDF/Word page inlines; past it, alt text only
MAX_INLINE_PAGE_IMAGE_BYTES = 50 * 1024 * 1024
# how often a running export bumps its job's progress_at
TOUCH_SECONDS = 60

# what the requester reads when a job failed for a reason they can't act on
FAILED_MESSAGE = ("The export couldn't be finished. Try again, or ask a wiki "
                  "administrator if it keeps failing.")


class ExportError(Exception):
    """The export can't be made, and trying again won't change that (the
    item was deleted, the requester lost access, the page was never
    published). The message is for the requester."""


class ExportSuperseded(Exception):
    """This attempt no longer owns its job — the stale sweep re-queued it,
    or another worker re-claimed it, while this attempt was still
    working. Raised by `run`'s progress heartbeat (`touch`) the moment
    it notices, so the attempt stops before uploading anything or
    notifying the requester; the worker's ownership check (already
    needed for the no-touch path, where an attempt can finish and
    upload before ever noticing) takes it from there and records
    nothing for this attempt."""


# ── names ────────────────────────────────────────────────────────────

_UNSAFE_CHARS = re.compile(r'[\x00-\x1f\x7f/\\:*?"<>|]')
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
             *(f"lpt{i}" for i in range(1, 10))}
MAX_NAME_CHARS = 100


def safe_name(title: str) -> str:
    """A file or folder name every OS accepts, from a node title: no path
    separators, control characters or characters Windows refuses,
    whitespace collapsed, no leading/trailing dots or spaces, at most
    MAX_NAME_CHARS, never a Windows device name, never empty."""
    name = unicodedata.normalize("NFC", title or "")
    name = re.sub(r"\s+", " ", name)
    name = _UNSAFE_CHARS.sub("-", name).strip(" .")
    name = name[:MAX_NAME_CHARS].rstrip(" .")
    if name.split(".")[0].lower() in _RESERVED:
        name = f"{name}_"
    return name or "Untitled"


def export_filename(title: str, fmt: str) -> str:
    """What the download is called: the page/folder/space name plus the
    format's extension."""
    return f"{safe_name(title)}{EXTENSIONS[fmt]}"


class _Dir:
    """The names already taken in one zip directory (case-insensitively:
    the zip will be unpacked on case-insensitive disks too)."""

    def __init__(self, reserved: tuple[str, ...] = ()):
        self.used = {r.lower() for r in reserved}

    def claim(self, base: str, suffixes: tuple[str, ...]) -> str:
        """The first of `base`, `base (2)`, … for which every
        `name + suffix` is free — and takes them all."""
        n = 1
        while True:
            name = base if n == 1 else f"{base} ({n})"
            wanted = [f"{name}{s}".lower() for s in suffixes]
            if not any(w in self.used for w in wanted):
                self.used.update(wanted)
                return name
            n += 1


# ── the plan: everything read from the database ──────────────────────


@dataclass
class _File:
    storage_key: str
    filename: str
    size_bytes: int


@dataclass
class _Asset:
    storage_key: str
    filename: str
    content_type: str
    size_bytes: int


@dataclass
class _Node:
    id: uuid.UUID
    kind: str
    title: str
    parent_id: uuid.UUID | None
    path: list[uuid.UUID]
    position: float
    children: list[_Node] = field(default_factory=list)
    content: dict | None = None            # a page's published content
    published_at: datetime | None = None
    published: bool = False
    file: _File | None = None
    assets: dict[str, _Asset] = field(default_factory=dict)   # by the id the doc spells
    crumbs: list[str] = field(default_factory=list)
    zip_path: str | None = None            # page/file: its entry; folder: its directory
    dir_path: str | None = None            # a page's subpages directory


@dataclass
class _Target:
    """Something a page links to: its title for this requester (None when
    they can't view it) and, when it's in this export, its node."""
    title: str | None
    node: _Node | None = None


@dataclass
class _Plan:
    format: str                            # pdf | docx | md | zip
    page_format: str                       # the pages' format (zip_format for a zip)
    filename: str
    roots: list[_Node]
    pages: list[_Node] = field(default_factory=list)      # exported, in tree order
    files: list[_Node] = field(default_factory=list)
    folders: list[_Node] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)      # zip paths of unpublished pages
    targets: dict[str, _Target] = field(default_factory=dict)   # by lowercase node id

    @property
    def is_zip(self) -> bool:
        return self.format == "zip"


def _walk_doc(doc: Any) -> Iterator[dict]:
    stack = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(reversed(node))
            continue
        if not isinstance(node, dict):
            continue
        yield node
        content = node.get("content")
        if isinstance(content, list):
            stack.extend(reversed(content))


def _referenced_nodes(doc: dict | None) -> set[str]:
    """Lowercase node ids a document points at: page links, file-node
    embeds and internal `/n/<id>` links."""
    found: set[str] = set()
    for node in _walk_doc(doc):
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        node_id = attrs.get("nodeId")
        if node.get("type") in ("pageLink", "fileEmbed") and isinstance(node_id, str) and node_id:
            found.add(node_id.lower())
        for mark in node.get("marks") or []:
            if isinstance(mark, dict) and mark.get("type") == "link":
                href = (mark.get("attrs") or {}).get("href")
                target = export_html.node_href_id(href) if isinstance(href, str) else None
                if target:
                    found.add(target)
    return found


def _image_asset_ids(doc: dict | None) -> set[str]:
    return {n["attrs"]["assetId"] for n in _walk_doc(doc)
            if n.get("type") == "wikiImage" and isinstance(n.get("attrs"), dict)
            and isinstance(n["attrs"].get("assetId"), str) and n["attrs"]["assetId"]}


def _as_uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


async def _is_active(db: AsyncSession, person_id: uuid.UUID) -> bool:
    return await db.scalar(
        select(UserAccount.person_id)
        .join(Person, Person.id == UserAccount.person_id)
        .where(UserAccount.person_id == person_id, UserAccount.disabled_at.is_(None),
               Person.archived_at.is_(None))) is not None


async def _published(db: AsyncSession, page_ids: list[uuid.UUID],
                     ) -> dict[uuid.UUID, tuple[dict | None, datetime]]:
    if not page_ids:
        return {}
    rows = (await db.execute(
        select(WikiPage.node_id, WikiPageVersion.content_json, WikiPageVersion.created_at)
        .join(WikiPageVersion, WikiPageVersion.id == WikiPage.published_version_id)
        .where(WikiPage.node_id.in_(page_ids)))).all()
    return {node_id: (content, at) for node_id, content, at in rows}


async def _visible_titles(db: AsyncSession, ix: AccessIndex,
                          ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Titles of the live nodes among `ids` the requester can view (a
    never-published page counts only for an editor)."""
    if not ids:
        return {}
    nodes = (await db.scalars(select(WikiNode).where(
        WikiNode.id.in_(ids), WikiNode.deleted_at.is_(None)))).all()
    shown, _ = await viewable_nodes(db, ix, nodes)
    return {n.id: n.title for n in shown}


async def _gather(db: AsyncSession, payload: dict) -> _Plan:
    requester_id = _as_uuid(payload.get("requester"))
    fmt = payload.get("format")
    title = payload.get("title") or "this item"
    if requester_id is None or fmt not in FORMATS:
        raise ExportError("This export request is incomplete.")
    if not await _is_active(db, requester_id):
        raise ExportError("Your account can't export from the wiki any more.")
    ix = AccessIndex(db, await principal_for_person(db, requester_id))
    gone = ExportError(f"“{title}” was deleted, or you can no longer view it.")

    if payload.get("node_id"):
        root = await db.get(WikiNode, _as_uuid(payload["node_id"]))
        if root is None or root.deleted_at is not None:
            raise gone
        space = await db.get(WikiSpace, root.space_id)
        rows = [root, *(await db.scalars(select(WikiNode).where(
            WikiNode.path.contains([root.id]), WikiNode.deleted_at.is_(None)))).all()]
    else:
        space = await db.get(WikiSpace, _as_uuid(payload.get("space_id")))
        if space is None or await ix.level_for_space(space.id) is None:
            raise gone
        root = None
        rows = list((await db.scalars(select(WikiNode).where(
            WikiNode.space_id == space.id, WikiNode.deleted_at.is_(None)))).all())

    shown, _ = await viewable_nodes(db, ix, rows)
    shown_ids = {n.id for n in shown}
    published = await _published(db, [n.id for n in rows if n.kind == "page"])
    nodes = {n.id: _Node(id=n.id, kind=n.kind, title=n.title, parent_id=n.parent_id,
                         path=list(n.path or []), position=n.position) for n in rows}
    for node in nodes.values():
        if node.id in published:
            node.published = True
            node.content, node.published_at = published[node.id]

    def visible(node: _Node) -> bool:
        return node.id in shown_ids

    for node in sorted(nodes.values(), key=lambda n: (n.position, n.title.lower(), str(n.id))):
        parent = nodes.get(node.parent_id) if node.parent_id else None
        if parent is not None and visible(node):
            parent.children.append(node)

    if root is not None:
        roots = [nodes[root.id]]
        if not visible(roots[0]):
            raise gone
    else:
        roots = [n for n in sorted(nodes.values(),
                                   key=lambda n: (n.position, n.title.lower(), str(n.id)))
                 if n.parent_id is None and visible(n)]

    page_format = (payload.get("zip_format") or "pdf") if fmt == "zip" else fmt
    if page_format not in PAGE_FORMATS:
        raise ExportError("This export request is incomplete.")
    plan = _Plan(format=fmt, page_format=page_format,
                 filename=payload.get("filename") or export_filename(title, fmt), roots=roots)

    if fmt != "zip":
        page = roots[0]
        if page.kind != "page":
            raise ExportError(f"“{page.title}” can only be exported as a .zip.")
        if not page.published:
            raise ExportError(f"“{page.title}” has never been published — only "
                              "published pages can be exported.")
        page.children = []
        plan.pages.append(page)
    else:
        # the files' current versions (a file without one is left out)
        tree_nodes = list(_iter_tree(roots))
        file_ids = [n.id for n in tree_nodes if n.kind == "file"]
        if file_ids:
            by_id = {n.id: n for n in tree_nodes if n.kind == "file"}
            for node_id, key, filename, size in (await db.execute(
                    select(WikiFile.node_id, WikiFileVersion.storage_key,
                           WikiFileVersion.filename, WikiFileVersion.size_bytes)
                    .join(WikiFileVersion, WikiFileVersion.id == WikiFile.current_version_id)
                    .where(WikiFile.node_id.in_(file_ids)))).all():
                by_id[node_id].file = _File(storage_key=key, filename=filename, size_bytes=size)
        for node in tree_nodes:
            node.children = [c for c in node.children if c.kind != "file" or c.file]
        roots = plan.roots = [r for r in roots if r.kind != "file" or r.file]
        _collect(plan, roots)

    # each page's own assets its content embeds
    wanted: dict[uuid.UUID, list[tuple[_Node, str]]] = {}
    for page in plan.pages:
        for raw in referenced_asset_ids(page.content):
            asset_id = _as_uuid(raw)
            if asset_id is not None:
                wanted.setdefault(asset_id, []).append((page, raw))
    if wanted:
        for asset in (await db.scalars(select(WikiPageAsset).where(
                WikiPageAsset.id.in_(list(wanted)), WikiPageAsset.deleted_at.is_(None)))).all():
            for page, raw in wanted[asset.id]:
                if asset.node_id == page.id:
                    page.assets[raw] = _Asset(
                        storage_key=asset.storage_key, filename=asset.filename,
                        content_type=normalize_content_type(asset.content_type),
                        size_bytes=asset.size_bytes)

    _check_limits(plan, title)

    # what the pages link to: in this export, or elsewhere and viewable
    exported = {str(n.id): n for n in _iter_tree(roots)}
    referenced: set[str] = set()
    for page in plan.pages:
        referenced |= _referenced_nodes(page.content)
    outside = {u for r in referenced if r not in exported and (u := _as_uuid(r))}
    titles = await _visible_titles(db, ix, outside)
    for ref in referenced:
        if ref in exported:
            plan.targets[ref] = _Target(title=exported[ref].title, node=exported[ref])
        else:
            found = titles.get(_as_uuid(ref))
            plan.targets[ref] = _Target(title=found)

    # breadcrumbs: the space, then each ancestor (… for one they can't see)
    ancestor_ids = {a for page in plan.pages for a in page.path}
    known = {nid: n.title for nid, n in nodes.items() if visible(n)}
    known |= await _visible_titles(db, ix, ancestor_ids - set(nodes))
    for page in plan.pages:
        page.crumbs = [space.name if space else "",
                       *(known.get(a, HIDDEN_CRUMB) for a in page.path)]
    return plan


def _human_size(size: int) -> str:
    value = float(size)
    for unit in ("bytes", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{int(value)} {unit}" if unit == "bytes" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} bytes"                  # pragma: no cover - the loop always returns


def _check_limits(plan: _Plan, title: str) -> None:
    """Refuse an export past `wiki_export_max_pages` pages, or whose files
    and page images add up to more than `wiki_export_max_bytes`."""
    s = get_settings()
    pages = len(plan.pages)
    if pages > s.wiki_export_max_pages:
        most = s.wiki_export_max_pages
        raise ExportError(
            f"“{title}” has {pages:,} pages — more than the {most:,} "
            f"{'page' if most == 1 else 'pages'} one export can hold. "
            "Export a smaller folder instead.")
    sizes = {n.file.storage_key: n.file.size_bytes for n in plan.files if n.file}
    for page in plan.pages:
        sizes.update({a.storage_key: a.size_bytes for a in page.assets.values()})
    total = sum(sizes.values())
    if total > s.wiki_export_max_bytes:
        raise ExportError(
            f"“{title}” is too large to export: its files and images add up to "
            f"{_human_size(total)}, more than the {_human_size(s.wiki_export_max_bytes)} "
            "one export can hold. Export a smaller folder instead.")


def _iter_tree(nodes: list[_Node]) -> Iterator[_Node]:
    stack = list(reversed(nodes))
    while stack:
        node = stack.pop()
        yield node
        stack.extend(reversed(node.children))


def _join(parent: str, name: str) -> str:
    return f"{parent}/{name}" if parent else name


def _file_parts(title: str, filename: str) -> tuple[str, str]:
    """(stem, extension) for a file in the zip: its title, with the
    uploaded file's extension added when the title doesn't carry it."""
    name = safe_name(title)
    ext = posixpath.splitext(filename or "")[1].lower()
    ext = ext if re.fullmatch(r"\.[a-z0-9]{1,10}", ext) else ""
    if ext and name.lower().endswith(ext):
        name = name[:-len(ext)].rstrip(" .") or "Untitled"
    return name, ext


def _collect(plan: _Plan, roots: list[_Node]) -> None:
    """Give every node in the tree its path in the zip (unique per
    directory, depth-first in tree order) and sort them into pages,
    files, folders and skipped pages. A page with subpages also gets a
    directory of the same name for them. Iterative, however deep."""
    ext = EXTENSIONS[plan.page_format]
    reserved = (SKIPPED_FILE, *((ASSETS_DIR,) if plan.page_format == "md" else ()))
    dirs = {"": _Dir(reserved)}
    work = [(n, "") for n in reversed(roots)]
    while work:
        node, parent = work.pop()
        directory = dirs[parent]
        child_dir = None
        if node.kind == "folder":
            node.zip_path = child_dir = _join(parent, directory.claim(safe_name(node.title),
                                                                     ("",)))
            plan.folders.append(node)
        elif node.kind == "page":
            suffixes = ((ext,) if node.published else ()) + (("",) if node.children else ())
            base = directory.claim(safe_name(node.title), suffixes or ("",))
            if node.published:
                node.zip_path = _join(parent, base + ext)
                plan.pages.append(node)
            else:
                plan.skipped.append(_join(parent, base))
            if node.children:
                node.dir_path = child_dir = _join(parent, base)
        elif node.file is not None:
            stem, fext = _file_parts(node.title, node.file.filename)
            node.zip_path = _join(parent, directory.claim(stem, (fext,)) + fext)
            plan.files.append(node)
        if child_dir is not None:
            dirs[child_dir] = _Dir()
            work.extend((c, child_dir) for c in reversed(node.children))


# ── building the export ──────────────────────────────────────────────


class _Refs(MarkdownRefs):
    """How one page's references read in this export."""

    def __init__(self, plan: _Plan, page: _Node, *, asset_paths: dict[str, str] | None = None):
        self.plan = plan
        self.base = posixpath.dirname(page.zip_path) if plan.is_zip and page.zip_path else ""
        self.asset_paths = asset_paths or {}

    def _rel(self, path: str | None) -> str | None:
        if not path or not self.plan.is_zip:
            return None
        return posixpath.relpath(path, self.base or ".")

    def _target(self, node_id: str | None, hidden: str) -> tuple[str, str | None]:
        target = self.plan.targets.get((node_id or "").lower())
        if target is None or target.title is None:
            return hidden, None
        path = target.node.zip_path if target.node is not None else None
        if target.node is not None and target.node.kind == "page" and not target.node.published:
            path = target.node.dir_path
        return target.title, self._rel(path)

    def page_link(self, node_id: str | None) -> tuple[str, str | None]:
        return self._target(node_id, PUBLIC_PAGE_TEXT)

    def file_link(self, node_id: str) -> tuple[str, str | None]:
        return self._target(node_id, PUBLIC_FILE_TEXT)

    def link_href(self, href: str) -> str | None:
        node_id = export_html.node_href_id(href)
        if node_id is None:
            return super().link_href(href)
        return self._target(node_id, PUBLIC_PAGE_TEXT)[1]

    def image(self, asset_id: str | None) -> str | None:
        return self._rel(self.asset_paths.get(asset_id or ""))

    def file_embed(self, *, node_id: str | None, asset_id: str | None,
                   filename: str) -> tuple[str, str | None]:
        if node_id:
            return self.file_link(node_id)
        return filename or PUBLIC_FILE_TEXT, self._rel(self.asset_paths.get(asset_id or ""))


Touch = Callable[[], Awaitable[None]]


async def _download(key: str, dest: Path) -> Path:
    await storage.download_to(key, dest)
    return dest


async def _image_data(page: _Node, workdir: Path) -> dict[str, str]:
    """The page's embedded images as data URIs (PNG, JPEG, GIF and WebP
    up to MAX_INLINE_IMAGE_BYTES each and MAX_INLINE_PAGE_IMAGE_BYTES in
    all; anything else keeps only its alt text)."""
    out: dict[str, str] = {}
    budget = MAX_INLINE_PAGE_IMAGE_BYTES
    for raw in _image_asset_ids(page.content):
        asset = page.assets.get(raw)
        if asset is None or asset.content_type not in INLINE_IMAGE_TYPES \
                or asset.size_bytes > MAX_INLINE_IMAGE_BYTES or asset.size_bytes > budget:
            continue
        budget -= asset.size_bytes
        dest = await _download(asset.storage_key, workdir / "image")
        data = await asyncio.to_thread(dest.read_bytes)
        dest.unlink(missing_ok=True)
        out[raw] = f"data:{asset.content_type};base64,{base64.b64encode(data).decode()}"
    return out


async def _page_html(client, plan: _Plan, page: _Node, workdir: Path) -> str:
    refs = _Refs(plan, page)
    doc, hrefs = export_html.prepare_doc(
        strip_comment_marks(page.content or EMPTY_DOC),
        page_link=refs.page_link, file_link=refs.file_link, link_href=refs.link_href)
    fragment = await export_html.render_fragment(client, doc)
    body = export_html.finish_fragment(fragment, hrefs=hrefs,
                                       images=await _image_data(page, workdir))
    return export_html.page_document(title=page.title, breadcrumbs=page.crumbs,
                                     published_at=page.published_at, body=body)


async def _pdf(client, plan: _Plan, page: _Node, workdir: Path) -> bytes:
    document = await _page_html(client, plan, page, workdir)
    return await export_html.html_to_pdf(document, workdir)


async def _docx_all(client, plan: _Plan, workdir: Path, touch: Touch) -> list[Path]:
    """Every page as a .docx, in plan order (one LibreOffice run per batch)."""
    html_dir = workdir / "html"
    html_dir.mkdir()
    sources = []
    for i, page in enumerate(plan.pages, 1):
        src = html_dir / f"p{i:05d}.html"
        src.write_text(await _page_html(client, plan, page, workdir), encoding="utf-8")
        sources.append(src)
        await touch()
    return await convert.html_to_docx(sources, touch=touch)


async def _single(client, plan: _Plan, workdir: Path, touch: Touch) -> Path:
    page = plan.pages[0]
    out = workdir / f"export{EXTENSIONS[plan.format]}"
    if plan.format == "pdf":
        out.write_bytes(await _pdf(client, plan, page, workdir))
    elif plan.format == "docx":
        out = (await _docx_all(client, plan, workdir, touch))[0]
    else:
        text = to_markdown(strip_comment_marks(page.content or EMPTY_DOC),
                           refs=_Refs(plan, page), title=page.title)
        out.write_text(text, encoding="utf-8")
    return out


def _skipped_text(paths: list[str]) -> str:
    lines = ["These pages were left out because they have never been published:", ""]
    return "\n".join(lines + paths) + "\n"


async def _zip(client, plan: _Plan, workdir: Path, touch: Touch) -> Path:
    out = workdir / "export.zip"
    scratch = workdir / "file"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder in plan.folders:
            zf.writestr(f"{folder.zip_path}/", b"")
        if plan.page_format == "pdf":
            for page in plan.pages:
                zf.writestr(page.zip_path, await _pdf(client, plan, page, workdir))
                await touch()
        elif plan.page_format == "docx":
            docs = await _docx_all(client, plan, workdir, touch)
            for page, docx in zip(plan.pages, docs, strict=True):
                await asyncio.to_thread(zf.write, docx, page.zip_path)
        else:
            assets_dir = _Dir()
            written: dict[str, str] = {}               # asset storage key → zip path
            for page in plan.pages:
                asset_paths: dict[str, str] = {}
                for raw, asset in page.assets.items():
                    if asset.storage_key not in written:
                        stem, ext = posixpath.splitext(safe_name(asset.filename))
                        name = assets_dir.claim(stem or "asset", (ext.lower(),)) + ext.lower()
                        path = f"{ASSETS_DIR}/{name}"
                        await _download(asset.storage_key, scratch)
                        await asyncio.to_thread(zf.write, scratch, path)
                        scratch.unlink(missing_ok=True)
                        written[asset.storage_key] = path
                    asset_paths[raw] = written[asset.storage_key]
                text = to_markdown(strip_comment_marks(page.content or EMPTY_DOC),
                                   refs=_Refs(plan, page, asset_paths=asset_paths),
                                   title=page.title)
                zf.writestr(page.zip_path, text.encode("utf-8"))
                await touch()
        for node in plan.files:
            await _download(node.file.storage_key, scratch)
            await asyncio.to_thread(zf.write, scratch, node.zip_path)
            scratch.unlink(missing_ok=True)
            await touch()
        if plan.skipped:
            zf.writestr(SKIPPED_FILE, _skipped_text(plan.skipped).encode("utf-8"))
    return out


async def run(db: AsyncSession, job: WikiJob) -> dict:
    """Make the export `job` describes and upload it; returns the job's
    result (`key`, `filename`, and counts). Raises ExportError when it
    can't be made (see its docstring); anything else is worth a retry."""
    plan = await _gather(db, job.payload or {})
    await db.commit()                        # no transaction held across the work

    last = time.monotonic()

    async def touch() -> None:
        nonlocal last
        if time.monotonic() - last < TOUCH_SECONDS:
            return
        last = time.monotonic()
        result = await db.execute(
            update(WikiJob)
            .where(WikiJob.id == job.id, WikiJob.status == "running",
                   WikiJob.attempts == job.attempts)
            .values(progress_at=func.now()))
        await db.commit()
        if result.rowcount == 0:
            raise ExportSuperseded(
                f"export {job.id}: attempt {job.attempts} no longer owns this job")

    key = EXPORT_KEY.format(job_id=job.id, name=sanitize_filename(plan.filename))
    with tempfile.TemporaryDirectory(prefix="wiki-export-",
                                     ignore_cleanup_errors=True) as tmp:
        async with export_html.render_client() as client:
            workdir = Path(tmp)
            if plan.is_zip:
                path = await _zip(client, plan, workdir, touch)
            else:
                path = await _single(client, plan, workdir, touch)
        await storage.upload_from(path, key, CONTENT_TYPES[plan.format])
    return {"key": key, "filename": plan.filename, "pages": len(plan.pages),
            "files": len(plan.files), "skipped": len(plan.skipped)}


# ── retention ────────────────────────────────────────────────────────


async def purge_old_exports(db: AsyncSession, now: datetime) -> int:
    """Delete finished exports older than EXPORT_RETENTION: every object
    under each job's `wiki/exports/<job_id>/` prefix — not just the one
    key its result recorded, so a superseded attempt's orphan upload
    (made under the same job id, but never linked from any row — see
    `worker._run_export`) is swept up too — then the job rows.
    Idempotent, so a re-run after a failed commit is safe. Returns how
    many job rows went."""
    rows = (await db.execute(
        select(WikiJob.id).where(
            WikiJob.kind == "export", WikiJob.status.in_(("done", "failed")),
            func.coalesce(WikiJob.finished_at, WikiJob.created_at) < now - EXPORT_RETENTION))
            ).all()
    for (job_id,) in rows:
        for key in await storage.list_keys(EXPORT_PREFIX.format(job_id=job_id)):
            await storage.delete_object(key)
    if rows:
        await db.execute(delete(WikiJob).where(WikiJob.id.in_([r[0] for r in rows])))
    return len(rows)
