"""Node-tree helpers: sibling positions (`next_position`), creating
nodes (`create_node`; files arrive via Task 6's uploads flow), moving a
subtree within or across spaces (`move_node`; `repath_subtree` is the
path rewrite it shares with trash restore), copying one
(`copy_subtree`), listing one (`subtree_ids`), and
`publish_empty_home`, used once by space creation to publish a
brand-new home page's first version.

These helpers know nothing about the caller's access — routes check
levels first (and hand `copy_subtree` the caller's levels so it copies
only what they can see). A request that can't be carried out raises
`TreeError(code, message)`, which routes turn into a 422.

Callers are expected to `db.commit()` themselves once their whole
request (space + home page + grants, or a single node) is ready — these
helpers only `flush()`, so they compose inside a larger transaction.
"""
from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    WikiFile,
    WikiFileVersion,
    WikiGrant,
    WikiNode,
    WikiPage,
    WikiPageAsset,
    WikiPageVersion,
    WikiSpace,
)
from serversherpa.wiki.content import (
    EMPTY_DOC,
    doc_text,
    referenced_asset_ids,
    rewrite_asset_ids,
)
from serversherpa.wiki.files import enqueue
from serversherpa.wiki.pages import add_version, utcnow
from serversherpa.wiki.permissions import level_rank
from serversherpa.wiki.search import refresh_search

# sibling positions step by POSITION_STEP; a sibling set is renumbered
# in those steps when an insert's two neighbors are closer than MIN_GAP
POSITION_STEP = 1024.0
MIN_GAP = 1e-6
# the most nodes one copy may create (a larger copy is a 422 `too_many`)
COPY_LIMIT = 500


# one transaction-scoped advisory lock per space, keyed by the space id
# (namespaced so it can't collide with any other advisory lock user)
_LOCK_SPACE_SQL = text(
    "SELECT pg_advisory_xact_lock(hashtextextended('wiki_tree:' || :space_id, 0))")


async def lock_space_trees(db: AsyncSession, *space_ids: uuid.UUID) -> None:
    """Serialize tree mutations per space: wait for, then hold until the
    transaction ends, each space's tree lock — in a fixed (sorted) order,
    so two callers locking the same spaces can't deadlock. Every
    operation that changes the tree's shape (create, a new file, move,
    copy, delete, restore, delete forever) takes it BEFORE re-reading the
    nodes it validates, so it checks what the previous writer committed:
    two opposite moves can't both pass the cycle check, and nothing lands
    under a folder another transaction just trashed."""
    for space_id in sorted({str(sid) for sid in space_ids}):
        await db.execute(_LOCK_SPACE_SQL, {"space_id": space_id})


class TreeError(Exception):
    """A tree operation the caller asked for that can't be done — the
    route turns it into a 422 with `code`."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _siblings_where(space_id: uuid.UUID, parent_id: uuid.UUID | None,
                    exclude_id: uuid.UUID | None):
    conds = [WikiNode.space_id == space_id,
             WikiNode.parent_id == parent_id if parent_id is not None
             else WikiNode.parent_id.is_(None),
             WikiNode.deleted_at.is_(None)]
    if exclude_id is not None:
        conds.append(WikiNode.id != exclude_id)
    return conds


def _slot(rows: list[tuple[uuid.UUID, float]], *, before_id: uuid.UUID | None,
          after_id: uuid.UUID | None) -> tuple[float | None, float | None]:
    """The (lower, upper) neighbor positions the new sibling goes between;
    None on a side means open-ended."""
    ids = [r[0] for r in rows]
    if after_id is not None and after_id in ids:
        idx = ids.index(after_id)
        upper = rows[idx + 1][1] if idx + 1 < len(rows) else None
        return rows[idx][1], upper
    if after_id is None and before_id is not None and before_id in ids:
        idx = ids.index(before_id)
        lower = rows[idx - 1][1] if idx > 0 else None
        return lower, rows[idx][1]
    return (rows[-1][1] if rows else None), None


def _between(lower: float | None, upper: float | None) -> float:
    if lower is None and upper is None:
        return POSITION_STEP
    if upper is None:
        return lower + POSITION_STEP
    if lower is None:
        return upper - POSITION_STEP
    return (lower + upper) / 2.0


async def next_position(db: AsyncSession, space_id: uuid.UUID,
                        parent_id: uuid.UUID | None, *,
                        before_id: uuid.UUID | None = None,
                        after_id: uuid.UUID | None = None,
                        exclude_id: uuid.UUID | None = None) -> float:
    """Where a node lands among the live children of `parent_id` (None =
    the space root). Appended (last + POSITION_STEP) by default or when
    the anchor isn't a sibling; right after `after_id` or right before
    `before_id` (the midpoint with the neighbor on the other side) when
    given — `after_id` wins if both are. `exclude_id` (the node being
    moved) isn't counted as a sibling. When the two neighbors are closer
    than MIN_GAP, the sibling set is first renumbered in POSITION_STEP
    steps — in the caller's transaction (the siblings are loaded as ORM
    rows, so the session's copies stay current)."""
    where = _siblings_where(space_id, parent_id, exclude_id)
    rows = [tuple(r) for r in (await db.execute(
        select(WikiNode.id, WikiNode.position).where(*where)
        .order_by(WikiNode.position, WikiNode.id)
    )).all()]
    lower, upper = _slot(rows, before_id=before_id, after_id=after_id)
    if lower is None or upper is None or upper - lower >= MIN_GAP:
        return _between(lower, upper)

    siblings = (await db.scalars(
        select(WikiNode).where(*where).order_by(WikiNode.position, WikiNode.id)
    )).all()
    for i, sibling in enumerate(siblings, start=1):
        sibling.position = i * POSITION_STEP
    rows = [(n.id, n.position) for n in siblings]
    lower, upper = _slot(rows, before_id=before_id, after_id=after_id)
    return _between(lower, upper)


async def create_node(
    db: AsyncSession, *, space: WikiSpace, parent: WikiNode | None,
    kind: str, title: str, actor_id: uuid.UUID | None,
    after_id: uuid.UUID | None = None,
    initial_content: dict[str, Any] | None = None,
) -> WikiNode:
    """Create a node under `parent` (None = space root): sets `path` and
    `position`, and for a page also creates the 1:1 `wiki_pages` row. When
    `initial_content` is given (an import), the page starts with that
    content as the actor's unpublished draft — `draft_json`/`draft_text`/
    `draft_updated_*` are set, `has_unpublished_changes` is True, and an `imported` version is
    recorded — the caller still has to publish it separately."""
    path = [*(parent.path or []), parent.id] if parent is not None else []
    position = await next_position(
        db, space.id, parent.id if parent is not None else None,
        after_id=after_id)

    node = WikiNode(
        space_id=space.id,
        parent_id=parent.id if parent is not None else None,
        path=path, kind=kind, title=title, position=position,
        owner_id=actor_id, created_by=actor_id, updated_by=actor_id,
    )
    db.add(node)
    await db.flush()

    if kind == "page":
        page = WikiPage(node_id=node.id)
        if initial_content is not None:
            page.draft_json = initial_content
            page.draft_text = doc_text(initial_content)
            page.draft_updated_by = actor_id
            page.draft_updated_at = utcnow()
            page.has_unpublished_changes = True
        db.add(page)
        await db.flush()
        if initial_content is not None:
            await add_version(db, node, kind="imported", title=title,
                              content_json=initial_content, actor_id=actor_id)

    # findable by title from the start: a folder is never published, and
    # an editor finds a never-published page by its title
    await refresh_search(db, node.id)
    return node


async def publish_empty_home(db: AsyncSession, page_node: WikiNode,
                             actor_id: uuid.UUID | None) -> WikiPageVersion:
    """Publish version 1 of a freshly created home page with the empty
    doc. Only meant to run once, right after `create_node` makes the
    home page (with no `initial_content`) — it doesn't touch the draft,
    since a brand-new page has none."""
    version = await add_version(db, page_node, kind="published",
                                title=page_node.title, content_json=EMPTY_DOC,
                                actor_id=actor_id)
    page = await db.get(WikiPage, page_node.id)
    assert page is not None
    page.published_version_id = version.id
    page.has_unpublished_changes = False
    await refresh_search(db, page_node.id)
    return version


# ── parents, subtrees, move ─────────────────────────────────────────


def check_parent(parent: WikiNode | None, space_id: uuid.UUID, *,
                 moving: WikiNode | None = None) -> None:
    """Can `parent` (None = the space root) hold a node in `space_id` —
    and, for a move or copy, `moving` itself? Raises `bad_parent` for a
    file, a deleted parent, a parent in another space, or `moving` or
    one of its own descendants."""
    if parent is None:
        return
    if parent.kind == "file":
        raise TreeError("bad_parent", "A file can't contain other items.")
    if parent.deleted_at is not None or parent.space_id != space_id:
        raise TreeError("bad_parent", "That parent isn't in this space.")
    if moving is not None and (parent.id == moving.id
                               or moving.id in (parent.path or [])):
        raise TreeError("bad_parent", "An item can't go inside itself.")


def _subtree_where(node: WikiNode):
    return WikiNode.path.contains([node.id])


async def subtree_ids(db: AsyncSession, node: WikiNode) -> list[uuid.UUID]:
    """`node`'s id and every descendant's — deleted ones included —
    shallowest first."""
    rows = (await db.scalars(
        select(WikiNode.id).where(_subtree_where(node))
        .order_by(func.cardinality(WikiNode.path), WikiNode.position)
    )).all()
    return [node.id, *rows]


# descendants keep their path below the moved node; everything above it
# (the old prefix, ending with the node) is swapped for the new prefix.
# The slice colon is backslash-escaped so text() doesn't read it as a
# bind parameter.
_REPATH_SQL = text(
    "UPDATE wiki_nodes SET "
    "path = CAST(:prefix AS uuid[]) || path[CAST(:start AS int)\\:cardinality(path)], "
    "space_id = :space_id "
    "WHERE path @> ARRAY[CAST(:node_id AS uuid)]")


async def repath_subtree(db: AsyncSession, node: WikiNode, new_prefix: list[uuid.UUID],
                         *, space_id: uuid.UUID) -> None:
    """Rewrite the path (and space) of every descendant of `node` —
    deleted ones included — for `node` now sitting under `new_prefix` in
    `space_id`. Reads `node.path` as the OLD path, so call it before
    setting the node's own new path (which is the caller's job)."""
    await db.execute(_REPATH_SQL, {
        "prefix": [*new_prefix, node.id],
        "start": len(node.path or []) + 2,
        "space_id": space_id,
        "node_id": node.id,
    })


async def move_node(db: AsyncSession, node: WikiNode, *,
                    new_parent: WikiNode | None, new_space: WikiSpace,
                    before_id: uuid.UUID | None = None,
                    after_id: uuid.UUID | None = None) -> WikiNode:
    """Move `node` (and its whole subtree, deleted descendants included)
    under `new_parent` (None = root of `new_space`), placed before/after
    a sibling or appended. Descendant paths are rewritten in one UPDATE;
    on a cross-space move the subtree's `space_id` and its node-level
    grants follow. Raises `bad_parent` (see `check_parent`) or `is_home`
    when the space's home page would leave the root of its space."""
    check_parent(new_parent, new_space.id, moving=node)
    new_parent_id = new_parent.id if new_parent is not None else None
    relocating = new_parent_id != node.parent_id or new_space.id != node.space_id
    if relocating:
        home_id = await db.scalar(
            select(WikiSpace.home_node_id).where(WikiSpace.id == node.space_id))
        if home_id == node.id:
            raise TreeError("is_home", "The space home page can't be moved.")

    position = await next_position(db, new_space.id, new_parent_id,
                                   before_id=before_id, after_id=after_id,
                                   exclude_id=node.id)
    new_prefix = [*(new_parent.path or []), new_parent.id] if new_parent else []
    cross_space = new_space.id != node.space_id

    if relocating:
        if cross_space:
            ids = await subtree_ids(db, node)
            await db.execute(
                update(WikiGrant).where(WikiGrant.node_id.in_(ids))
                .values(space_id=new_space.id)
                .execution_options(synchronize_session=False))
        await repath_subtree(db, node, new_prefix, space_id=new_space.id)
    node.parent_id = new_parent_id
    node.space_id = new_space.id
    node.path = new_prefix
    node.position = position
    await db.flush()
    return node


# ── copy ────────────────────────────────────────────────────────────


def _as_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def _copy_title(title: str) -> str:
    return f"Copy of {title}"[:200]


async def copy_subtree(db: AsyncSession, node: WikiNode, *,
                       dest_parent: WikiNode | None, dest_space: WikiSpace,
                       actor_id: uuid.UUID | None,
                       levels: Mapping[uuid.UUID, str | None] | None = None,
                       ) -> WikiNode:
    """Copy `node` and its live descendants under `dest_parent` (None =
    root of `dest_space`); returns the new root.

    Copies inherit (no grants copied) and are owned by `actor_id`. A page
    copy is a new unpublished page — no versions — whose draft is the
    source's current draft (`ydoc` left NULL so the collab server seeds
    from `draft_json`); the asset rows that content embeds are copied
    with the same storage keys, and the copied content points at them. A file copy gets one version: a copy of the source's current
    version row, same object keys (objects are never copied) — with its
    own extract/preview jobs queued when the source's were still pending.

    `levels`, when given, is the caller's level per node: a descendant
    with no level is skipped along with its subtree, and where the
    caller only has view, a page copies its published content instead of
    the draft (and a never-published page is skipped). Raises
    `bad_parent`, or `too_many` above COPY_LIMIT nodes."""
    check_parent(dest_parent, dest_space.id, moving=node)

    descendants = (await db.scalars(
        select(WikiNode)
        .where(_subtree_where(node), WikiNode.deleted_at.is_(None))
        .order_by(func.cardinality(WikiNode.path), WikiNode.position, WikiNode.id)
    )).all()
    candidates = [node, *descendants]
    page_ids = [n.id for n in candidates if n.kind == "page"]
    pages = {p.node_id: p for p in (await db.scalars(
        select(WikiPage).where(WikiPage.node_id.in_(page_ids))
    )).all()} if page_ids else {}

    def _drafts_visible(n: WikiNode) -> bool:
        return levels is None or level_rank(levels.get(n.id)) >= level_rank("edit")

    included: list[WikiNode] = []
    kept: set[uuid.UUID] = set()
    for n in candidates:
        if n is not node:
            if n.parent_id not in kept:
                continue
            if levels is not None and levels.get(n.id) is None:
                continue
            page = pages.get(n.id)
            if (n.kind == "page" and not _drafts_visible(n)
                    and (page is None or page.published_version_id is None)):
                continue
        included.append(n)
        kept.add(n.id)
    if len(included) > COPY_LIMIT:
        raise TreeError("too_many",
                        f"That's {len(included)} items; a copy is limited to {COPY_LIMIT}.")

    published_ids = [p.published_version_id for nid, p in pages.items()
                     if nid in kept and p.published_version_id is not None]
    published = {v.id: v for v in (await db.scalars(
        select(WikiPageVersion).where(WikiPageVersion.id.in_(published_ids))
    )).all()} if published_ids else {}

    dest_parent_id = dest_parent.id if dest_parent is not None else None
    same_place = dest_parent_id == node.parent_id and dest_space.id == node.space_id
    root_position = await next_position(
        db, dest_space.id, dest_parent_id,
        after_id=node.id if same_place else None)
    root_prefix = [*(dest_parent.path or []), dest_parent.id] if dest_parent else []

    new_ids: dict[uuid.UUID, uuid.UUID] = {}
    new_paths: dict[uuid.UUID, list[uuid.UUID]] = {}
    new_nodes: list[WikiNode] = []
    for n in included:
        is_root = n is node
        new_id = uuid.uuid4()
        parent_new_id = dest_parent_id if is_root else new_ids[n.parent_id]
        path = root_prefix if is_root else [*new_paths[n.parent_id], parent_new_id]
        new_ids[n.id] = new_id
        new_paths[n.id] = path
        new_nodes.append(WikiNode(
            id=new_id, space_id=dest_space.id, parent_id=parent_new_id, path=path,
            kind=n.kind, title=_copy_title(n.title) if is_root and same_place else n.title,
            position=root_position if is_root else n.position,
            inherit_permissions=True,
            owner_id=actor_id, created_by=actor_id, updated_by=actor_id))
    db.add_all(new_nodes)
    await db.flush()

    # the content each copied page starts from: the draft, or — where the
    # caller only has view — the published version
    contents: dict[uuid.UUID, tuple[dict | None, str | None]] = {}
    for n in included:
        if n.kind != "page":
            continue
        source = pages.get(n.id)
        draft_json = draft_text = None
        if source is not None:
            version = published.get(source.published_version_id)
            if _drafts_visible(n) and source.draft_json is not None:
                draft_json, draft_text = source.draft_json, source.draft_text
            elif version is not None:
                draft_json, draft_text = version.content_json, version.content_text
        contents[n.id] = (draft_json, draft_text)

    # only the assets that content embeds are copied (a draft-only image
    # never leaks through a copy of the published version), each as a new
    # row sharing the storage key, and the copy's content is rewritten to
    # point at the new rows
    referenced = {nid: referenced_asset_ids(doc)
                  for nid, (doc, _) in contents.items()}
    asset_ids = {u for ids in referenced.values() for a in ids
                 if (u := _as_uuid(a)) is not None}
    new_asset_ids: dict[uuid.UUID, dict[str, str]] = {nid: {} for nid in contents}
    if asset_ids:
        for asset in (await db.scalars(
            select(WikiPageAsset).where(
                WikiPageAsset.id.in_(asset_ids),
                WikiPageAsset.node_id.in_(list(contents)),
                WikiPageAsset.deleted_at.is_(None))
        )).all():
            if str(asset.id) not in referenced[asset.node_id]:
                continue
            new_asset_id = uuid.uuid4()
            new_asset_ids[asset.node_id][str(asset.id)] = str(new_asset_id)
            db.add(WikiPageAsset(
                id=new_asset_id, node_id=new_ids[asset.node_id],
                storage_key=asset.storage_key, filename=asset.filename,
                content_type=asset.content_type, size_bytes=asset.size_bytes,
                uploaded_by=asset.uploaded_by))

    for source_id, (draft_json, draft_text) in contents.items():
        if draft_json is not None and new_asset_ids[source_id]:
            draft_json = rewrite_asset_ids(draft_json, new_asset_ids[source_id])
        db.add(WikiPage(node_id=new_ids[source_id], draft_json=draft_json,
                        # only NULL before first live load: collab.ts seeds a fixed Yjs client id
                        draft_text=draft_text, ydoc=None,
                        # the copier's draft: it shows in their "My drafts"
                        draft_updated_by=actor_id, draft_updated_at=utcnow(),
                        has_unpublished_changes=True))

    file_ids = [n.id for n in included if n.kind == "file"]
    new_files: list[tuple[WikiFile, WikiFileVersion]] = []
    if file_ids:
        for file_row, version in (await db.execute(
            select(WikiFile, WikiFileVersion)
            .outerjoin(WikiFileVersion,
                       WikiFileVersion.id == WikiFile.current_version_id)
            .where(WikiFile.node_id.in_(file_ids))
        )).all():
            new_file = WikiFile(node_id=new_ids[file_row.node_id],
                                description=file_row.description)
            db.add(new_file)
            if version is not None:
                new_version = WikiFileVersion(
                    id=uuid.uuid4(), node_id=new_file.node_id, version_no=1,
                    storage_key=version.storage_key, filename=version.filename,
                    content_type=version.content_type, size_bytes=version.size_bytes,
                    sha256=version.sha256, preview_kind=version.preview_kind,
                    preview_key=version.preview_key,
                    preview_status=version.preview_status,
                    text_extract=version.text_extract,
                    extract_status=version.extract_status, note=version.note,
                    uploaded_by=version.uploaded_by)
                db.add(new_version)
                new_files.append((new_file, new_version))
    await db.flush()
    for new_file, new_version in new_files:
        new_file.current_version_id = new_version.id
        # the source's own jobs only ever update the source's version row
        if new_version.extract_status == "pending":
            await enqueue(db, "file_extract", node_id=new_version.node_id,
                          file_version_id=new_version.id)
        if new_version.preview_status == "pending":
            await enqueue(db, "file_preview", node_id=new_version.node_id,
                          file_version_id=new_version.id)
    await db.flush()

    return new_nodes[0]
