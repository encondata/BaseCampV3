"""Analytics: recording a view (`POST /nodes/{id}/view`), a reader's
"Was this page helpful?" answer (`PUT /pages/{id}/feedback`, `GET
.../feedback/mine`), and the aggregates (`GET /analytics`) for wiki
admins (any space, or all of them) and space managers (one space they
manage, which they must name).

Views and feedback are telemetry: never audited. A view in read-only
maintenance mode is answered 204 but not counted (the path is exempt
from the freeze in `api.deps`); feedback is a write like any other and
is frozen. The rules and queries live in `serversherpa.wiki.analytics`.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable

from fastapi import APIRouter, Response
from sqlalchemy import select

from serversherpa.api.routes.wiki.deps import (
    WikiContext,
    read_only_mode,
    space_by_key,
    visible_nodes,
)
from serversherpa.api.routes.wiki.errors import err, not_found
from serversherpa.api.routes.wiki.pages import page_for
from serversherpa.api.routes.wiki.schemas import (
    AnalyticsNodeRef,
    AnalyticsOut,
    DayViewsOut,
    FailedSearchOut,
    FeedbackIn,
    FeedbackOut,
    HelpfulnessOut,
    NoCommentOut,
    OverdueReviewOut,
    StalePageOut,
    TopPageOut,
)
from serversherpa.db.models import WikiFeedback, WikiNode, WikiSpace
from serversherpa.wiki import analytics
from serversherpa.wiki.permissions import require_node_level

router = APIRouter()


# ── views ────────────────────────────────────────────────────────────


@router.post("/nodes/{node_id}/view", status_code=204)
async def record_view(node_id: uuid.UUID, ctx: WikiContext) -> Response:
    """Count a view of a page or file the caller can see (a page must be
    published for a view-only reader: 404 `not_published`). 422
    `bad_kind` for a folder."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    if node.kind == "page":
        await page_for(ctx, node.id, "view")
    elif node.kind != "file":
        raise err(422, "bad_kind", "Only pages and files have views.")
    if not await read_only_mode(ctx):
        await analytics.record_view(ctx.db, node.id, ctx.user.person.id)
        await ctx.db.commit()
    return Response(status_code=204)


# ── feedback ─────────────────────────────────────────────────────────


async def _published_page(ctx: WikiContext, node_id: uuid.UUID) -> WikiNode:
    """A published page the caller can view (404 `not_published` even for
    an editor: only published content is rated)."""
    node, page, _ = await page_for(ctx, node_id, "view")
    if page.published_version_id is None:
        raise err(404, "not_published", "This page hasn't been published yet.")
    return node


def _feedback_out(row: WikiFeedback) -> FeedbackOut:
    return FeedbackOut(helpful=row.helpful, comment=row.comment, updated_at=row.updated_at)


@router.put("/pages/{node_id}/feedback", response_model=FeedbackOut)
async def put_feedback(node_id: uuid.UUID, body: FeedbackIn, ctx: WikiContext) -> FeedbackOut:
    node = await _published_page(ctx, node_id)
    row = await analytics.save_feedback(
        ctx.db, node.id, ctx.user.person.id, helpful=body.helpful,
        comment=analytics.clean_comment(body.comment))
    out = _feedback_out(row)
    await ctx.db.commit()
    return out


@router.get("/pages/{node_id}/feedback/mine", response_model=FeedbackOut)
async def my_feedback(node_id: uuid.UUID, ctx: WikiContext) -> FeedbackOut:
    """The caller's answer for the page; 404 `not_found` when they haven't given one."""
    node = await _published_page(ctx, node_id)
    row = await ctx.db.get(WikiFeedback, (node.id, ctx.user.person.id))
    if row is None:
        raise not_found()
    return _feedback_out(row)


# ── aggregates ───────────────────────────────────────────────────────


async def _scope(ctx: WikiContext, space_key: str | None) -> WikiSpace | None:
    """The space asked about (None = every space). A wiki admin may ask
    about any space (404 for an unknown key) or none; anyone else must
    name a space they manage — every other case is a 403, an unknown key
    included, so it can't be used to probe for spaces."""
    space = await space_by_key(ctx.db, space_key) if space_key else None
    if ctx.principal.is_admin:
        if space_key and space is None:
            raise not_found()
        return space
    if space is None or await ctx.ix.level_for_space(space.id) != "manage":
        raise err(403, "forbidden", "Analytics are for wiki admins and library managers.")
    return space


async def _node_refs(ctx: WikiContext,
                     node_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, AnalyticsNodeRef]:
    """Refs for the nodes the caller can see — any other id is left out,
    and so is every row about it."""
    ids = set(node_ids)
    if not ids:
        return {}
    nodes = (await ctx.db.scalars(select(WikiNode).where(WikiNode.id.in_(ids)))).all()
    shown, _ = await visible_nodes(ctx, nodes)
    keys = dict((await ctx.db.execute(
        select(WikiSpace.id, WikiSpace.key)
        .where(WikiSpace.id.in_({n.space_id for n in shown})))).all()) if shown else {}
    return {n.id: AnalyticsNodeRef(id=n.id, title=n.title, kind=n.kind,
                                   space_key=str(keys[n.space_id]))
            for n in shown}


@router.get("/analytics", response_model=AnalyticsOut)
async def get_analytics(ctx: WikiContext, space: str | None = None,
                        days: int = 30) -> AnalyticsOut:
    """`days`: 7, 30, 90 or 365 (else 422 `bad_days`)."""
    scope = await _scope(ctx, space)
    if days not in analytics.VALID_DAYS:
        raise err(422, "bad_days", "days must be 7, 30, 90 or 365.")
    space_ids = [scope.id] if scope is not None else None
    window = analytics.Window.ending_now(days)
    db = ctx.db

    top = await analytics.top_pages(db, space_ids, window)
    by_day = await analytics.views_by_day(db, space_ids, window)
    helpful = await analytics.helpfulness(db, space_ids, window)
    no_comments = await analytics.recent_no_comments(db, space_ids, window)
    failed = await analytics.failed_searches(db, window) if ctx.principal.is_admin else []
    stale = await analytics.stale_pages(db, space_ids)
    overdue = await analytics.overdue_reviews(db, space_ids)

    refs = await _node_refs(ctx, [
        *(t.node_id for t in top), *(h.node_id for h in helpful),
        *(c.node_id for c in no_comments), *(nid for nid, _ in stale),
        *(nid for nid, _ in overdue)])
    return AnalyticsOut(
        space_key=str(scope.key) if scope is not None else None,
        days=days,
        top_pages=[TopPageOut(node=refs[t.node_id], views=t.views, viewers=t.viewers)
                   for t in top if t.node_id in refs],
        views_by_day=[DayViewsOut(day=day, views=views) for day, views in by_day],
        helpfulness=[HelpfulnessOut(node=refs[h.node_id], yes=h.yes, no=h.no, pct=h.pct)
                     for h in helpful if h.node_id in refs],
        recent_no_comments=[NoCommentOut(node=refs[c.node_id], comment=c.comment, at=c.at)
                            for c in no_comments if c.node_id in refs],
        failed_searches=[FailedSearchOut(query=f.query, count=f.count, last_at=f.last_at)
                         for f in failed],
        stale_pages=[StalePageOut(node=refs[nid], updated_at=at)
                     for nid, at in stale if nid in refs],
        overdue_reviews=[OverdueReviewOut(node=refs[nid], next_review_at=at)
                         for nid, at in overdue if nid in refs],
    )
