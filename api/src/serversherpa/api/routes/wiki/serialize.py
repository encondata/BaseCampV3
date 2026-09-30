"""Turning DB rows into the API contract's shapes: `space_out`,
`nodes_out`/`node_out`, and the `person_ref(s)` helpers they lean on.

`nodes_out` is the one path every node listing goes through (tree,
favorites, recent, drafts, ...): it serializes any number of nodes with
a fixed number of statements — one each for the spaces, the page rows
(+ published version time and pending review), the file rows (+ current version), the
people referenced, the caller's favorites, and a grouped child count —
so a listing never costs a query per node. `node_out` is the
one-element wrapper for single-node reads."""
from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping, Sequence

from sqlalchemy import and_, func, or_, select

from serversherpa.api.routes.wiki.deps import WikiCtx
from serversherpa.api.routes.wiki.schemas import (
    FileVersionOut,
    Level,
    NodeFileOut,
    NodeOut,
    NodePageOut,
    NodeReviewOut,
    PersonRef,
    PrintingSourceOut,
    SpaceOut,
)
from serversherpa.db.models import (
    Person,
    WikiFavorite,
    WikiFile,
    WikiFileVersion,
    WikiNode,
    WikiPage,
    WikiPageVersion,
    WikiReview,
    WikiSpace,
)
from serversherpa.wiki import reviews
from serversherpa.wiki.permissions import can_set_private, level_rank

ELLIPSIS = "…"


async def person_ref(db, person_id: uuid.UUID | None) -> PersonRef | None:
    if person_id is None:
        return None
    person = await db.get(Person, person_id)
    if person is None:
        return None
    return PersonRef(id=person.id, name=person.display_name)


async def person_refs(db, person_ids: Iterable[uuid.UUID | None],
                      ) -> dict[uuid.UUID, PersonRef]:
    """PersonRefs for every (non-None) id, in one query; ids with no
    person row are simply absent from the result."""
    ids = {pid for pid in person_ids if pid is not None}
    if not ids:
        return {}
    people = (await db.scalars(select(Person).where(Person.id.in_(ids)))).all()
    return {p.id: PersonRef(id=p.id, name=p.display_name) for p in people}


def space_out(space: WikiSpace, level: str | None) -> SpaceOut:
    return SpaceOut(
        id=space.id, key=str(space.key), name=space.name,
        description=space.description, icon=space.icon, color=space.color,
        home_node_id=space.home_node_id, archived_at=space.archived_at,
        my_level=level, settings=space.settings or {},
        created_at=space.created_at, updated_at=space.updated_at,
    )


def file_version_out(version: WikiFileVersion,
                     people: Mapping[uuid.UUID, PersonRef]) -> FileVersionOut:
    return FileVersionOut(
        id=version.id, version_no=version.version_no,
        filename=version.filename, content_type=version.content_type,
        size_bytes=version.size_bytes, preview_kind=version.preview_kind,
        preview_status=version.preview_status,
        extract_status=version.extract_status, note=version.note,
        uploaded_by=people.get(version.uploaded_by) if version.uploaded_by else None,
        created_at=version.created_at,
    )


async def nodes_out(ctx: WikiCtx, nodes: Sequence[WikiNode],
                    levels: Mapping[uuid.UUID, Level | str | None]) -> list[NodeOut]:
    """Serialize `nodes` (in order) with `my_level` from `levels`.

    `has_children` counts live children; for a caller who only has view
    on the node, unpublished child pages (which they can't see) don't
    count."""
    if not nodes:
        return []
    db = ctx.db
    ids = [n.id for n in nodes]

    spaces = {row.id: row for row in (await db.execute(
        select(WikiSpace.id, WikiSpace.key, WikiSpace.home_node_id, WikiSpace.settings)
        .where(WikiSpace.id.in_({n.space_id for n in nodes}))
    )).all()}

    pages: dict[uuid.UUID, tuple] = {}
    page_ids = [n.id for n in nodes if n.kind == "page"]
    if page_ids:
        for node_id, published_id, unpublished, published_at, pending_id in (await db.execute(
            select(WikiPage.node_id, WikiPage.published_version_id,
                   WikiPage.has_unpublished_changes, WikiPageVersion.created_at,
                   WikiReview.id)
            .outerjoin(WikiPageVersion,
                       WikiPageVersion.id == WikiPage.published_version_id)
            # at most one pending review per page (a partial unique index)
            .outerjoin(WikiReview, and_(WikiReview.node_id == WikiPage.node_id,
                                        WikiReview.status == "pending"))
            .where(WikiPage.node_id.in_(page_ids))
        )).all():
            pages[node_id] = (published_id, unpublished, published_at, pending_id)

    files: dict[uuid.UUID, tuple[WikiFile, WikiFileVersion | None]] = {}
    file_ids = [n.id for n in nodes if n.kind == "file"]
    if file_ids:
        for file_row, version in (await db.execute(
            select(WikiFile, WikiFileVersion)
            .outerjoin(WikiFileVersion,
                       WikiFileVersion.id == WikiFile.current_version_id)
            .where(WikiFile.node_id.in_(file_ids))
        )).all():
            files[file_row.node_id] = (file_row, version)

    people = await person_refs(db, [
        *(n.owner_id for n in nodes), *(n.updated_by for n in nodes),
        *(v.uploaded_by for _, v in files.values() if v is not None)])

    favorites = set((await db.scalars(
        select(WikiFavorite.node_id)
        .where(WikiFavorite.person_id == ctx.principal.person_id,
               WikiFavorite.node_id.in_(ids))
    )).all())

    child = WikiNode.__table__.alias("child")
    children: dict[uuid.UUID, tuple[int, int]] = {
        parent_id: (total, readable)
        for parent_id, total, readable in (await db.execute(
            select(child.c.parent_id, func.count(),
                   func.count().filter(or_(
                       child.c.kind != "page",
                       WikiPage.published_version_id.is_not(None))))
            .select_from(child)
            .outerjoin(WikiPage, WikiPage.node_id == child.c.id)
            .where(child.c.parent_id.in_(ids), child.c.deleted_at.is_(None))
            .group_by(child.c.parent_id)
        )).all()}

    # where each inheriting node's printing value comes from — warm the
    # index once for every space so a multi-space listing batches its loads;
    # only source nodes outside this batch cost a query (for their title
    # and the caller's level on them)
    await ctx.ix._load_spaces({n.space_id for n in nodes})
    printing = {n.id: await ctx.ix.printing_source(n) for n in nodes}
    in_batch = {n.id: n for n in nodes}
    outside = {src for _, src in printing.values()
               if src is not None} - in_batch.keys()
    source_nodes = dict(in_batch)
    if outside:
        source_nodes.update({row.id: row for row in (await db.scalars(
            select(WikiNode).where(WikiNode.id.in_(outside)))).all()})
    # a source the caller can't view (an ancestor behind broken inheritance
    # or a private folder) is named "…" with no id — as get_node masks a
    # hidden breadcrumb — so its title and id don't leak
    source_visible: dict[uuid.UUID, bool] = {}
    for src_id, src in source_nodes.items():
        source_visible[src_id] = (
            levels.get(src_id) is not None if src_id in in_batch
            else await ctx.ix.level_for_node(src) is not None)

    now = reviews.utcnow()
    out: list[NodeOut] = []
    for n in nodes:
        level = levels.get(n.id)
        space_row = spaces.get(n.space_id)
        space_key = str(space_row.key) if space_row else ""
        home_id = space_row.home_node_id if space_row else None
        total, readable = children.get(n.id, (0, 0))
        has_children = (total if level_rank(level) >= level_rank("edit")
                        else readable) > 0

        page = review = None
        if n.kind == "page" and n.id in pages:
            published_id, unpublished, published_at, pending_id = pages[n.id]
            page = NodePageOut(
                is_home=(home_id == n.id), published_version_id=published_id,
                published_at=published_at if published_id else None,
                has_unpublished_changes=unpublished)
            interval = reviews.interval_for(n, space_row)
            review = NodeReviewOut(
                interval_months=interval, own_interval_months=n.review_interval_months,
                next_review_at=n.next_review_at,
                last_reviewed_at=n.last_reviewed_at,
                state=reviews.review_state(interval, n.next_review_at, now),
                pending_review_id=(pending_id if level_rank(level) >= level_rank("edit")
                                   else None))

        file = None
        if n.kind == "file" and n.id in files:
            file_row, version = files[n.id]
            file = NodeFileOut(
                description=file_row.description,
                current_version=file_version_out(version, people) if version else None)

        can_print, source_id = printing[n.id]
        printing_from = None
        if n.allow_printing is None:
            if source_id is None:
                printing_from = PrintingSourceOut(node_id=None, title="Library")
            elif source_visible.get(source_id):
                printing_from = PrintingSourceOut(
                    node_id=source_id, title=source_nodes[source_id].title)
            else:
                printing_from = PrintingSourceOut(node_id=None, title=ELLIPSIS)

        out.append(NodeOut(
            id=n.id, space_id=n.space_id, space_key=space_key,
            parent_id=n.parent_id, kind=n.kind, title=n.title,
            position=n.position, inherit_permissions=n.inherit_permissions,
            owner=people.get(n.owner_id) if n.owner_id else None,
            created_at=n.created_at, updated_at=n.updated_at,
            updated_by=people.get(n.updated_by) if n.updated_by else None,
            my_level=level, has_children=has_children,
            is_favorite=n.id in favorites, page=page, file=file, review=review,
            is_private=n.is_private, allow_printing=n.allow_printing,
            can_print=can_print, printing_from=printing_from,
            can_set_private=can_set_private(ctx.principal, n),
        ))
    return out


async def node_out(ctx: WikiCtx, node: WikiNode, level: Level | str | None) -> NodeOut:
    return (await nodes_out(ctx, [node], {node.id: level}))[0]
