"""Wiki analytics (spec §8): the telemetry the wiki records — page and
file views (one `wiki_page_views` row per node, person and UTC day) and
the search log — and the aggregates `GET /wiki/analytics` shows wiki
admins and space managers.

None of it is audited: it's telemetry, not a change to anything. The
aggregates return node ids only; the route turns those into node refs
and drops any node the caller can't see. Pass `viewer` and the counts
themselves leave out private items that person can't see. Nothing here commits — callers
do. The worker's daily `retention` job deletes views after
VIEW_RETENTION_DAYS and search log rows after SEARCH_RETENTION_DAYS.
"""
from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import distinct, func, select, true
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    WikiNode,
    WikiPage,
    WikiPageView,
    WikiSearchLog,
    WikiSpace,
)
from serversherpa.wiki import reviews
from serversherpa.wiki.permissions import Principal, private_filter

# the windows the analytics page offers, in days
VALID_DAYS = (7, 30, 90, 365)

VIEW_RETENTION_DAYS = 365
SEARCH_RETENTION_DAYS = 90
# a published page untouched this long is stale
STALE_MONTHS = 12
# what the search log keeps of a query (search itself refuses longer ones)
QUERY_MAX = 200

TOP_PAGES_LIMIT = 20
FAILED_SEARCHES_LIMIT = 50
STALE_LIMIT = 100
OVERDUE_LIMIT = 100


def utcnow() -> datetime:
    """Now, as an aware UTC datetime (a seam tests patch)."""
    return datetime.now(UTC)


# ── recording ────────────────────────────────────────────────────────


async def record_view(db: AsyncSession, node_id: uuid.UUID, person_id: uuid.UUID) -> None:
    """Count one view of `node_id` by `person_id` today (UTC): insert the
    day's row, or add one to it."""
    stmt = pg_insert(WikiPageView).values(
        node_id=node_id, person_id=person_id, viewed_on=utcnow().date(), count=1)
    await db.execute(stmt.on_conflict_do_update(
        index_elements=[WikiPageView.node_id, WikiPageView.person_id, WikiPageView.viewed_on],
        set_={"count": WikiPageView.count + 1}))


def log_search(db: AsyncSession, person_id: uuid.UUID, query: str, result_count: int) -> None:
    """Add a search log row (an empty query is never logged)."""
    query = query.strip()[:QUERY_MAX]
    if query:
        db.add(WikiSearchLog(person_id=person_id, query=query, result_count=result_count))


# ── aggregates ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Window:
    """The days an analytics request covers: `first_day` through today
    (UTC), `days` of them; `since` is the first day's midnight."""
    days: int
    first_day: date
    today: date
    since: datetime

    @classmethod
    def ending_now(cls, days: int, now: datetime | None = None) -> Window:
        today = (now or utcnow()).date()
        first = today - timedelta(days=days - 1)
        return cls(days=days, first_day=first, today=today,
                   since=datetime.combine(first, time.min, tzinfo=UTC))


def _in_scope(space_ids: Sequence[uuid.UUID] | None):
    """WHERE clause over WikiNode: in these spaces (None = every space)."""
    return WikiNode.space_id.in_(space_ids) if space_ids is not None else true()


def _visible_to(viewer: Principal | None):
    """WHERE clause over WikiNode: nothing private `viewer` may not see —
    so an aggregate never counts an item its reader can't open (a wiki
    administrator included). No viewer, no filter."""
    return private_filter(viewer) if viewer is not None else true()


@dataclass(frozen=True)
class TopPage:
    node_id: uuid.UUID
    views: int
    viewers: int


async def top_pages(db: AsyncSession, space_ids: Sequence[uuid.UUID] | None,
                    window: Window, *, viewer: Principal | None = None) -> list[TopPage]:
    """The most viewed live pages and files in the window: total views and
    distinct viewers, most viewed first."""
    views = func.sum(WikiPageView.count).label("views")
    rows = (await db.execute(
        select(WikiPageView.node_id, views,
               func.count(distinct(WikiPageView.person_id)).label("viewers"))
        .join(WikiNode, WikiNode.id == WikiPageView.node_id)
        .where(WikiNode.deleted_at.is_(None), _in_scope(space_ids), _visible_to(viewer),
               WikiPageView.viewed_on >= window.first_day)
        .group_by(WikiPageView.node_id)
        .order_by(views.desc(), WikiPageView.node_id)
        .limit(TOP_PAGES_LIMIT))).all()
    return [TopPage(node_id=r.node_id, views=int(r.views), viewers=r.viewers) for r in rows]


async def views_by_day(db: AsyncSession, space_ids: Sequence[uuid.UUID] | None,
                       window: Window, *, viewer: Principal | None = None,
                       ) -> list[tuple[date, int]]:
    """Views of live nodes on each day of the window, oldest first, days
    without any as 0."""
    rows = dict((await db.execute(
        select(WikiPageView.viewed_on, func.sum(WikiPageView.count))
        .join(WikiNode, WikiNode.id == WikiPageView.node_id)
        .where(WikiNode.deleted_at.is_(None), _in_scope(space_ids), _visible_to(viewer),
               WikiPageView.viewed_on >= window.first_day)
        .group_by(WikiPageView.viewed_on))).all())
    return [(day, int(rows.get(day, 0)))
            for day in (window.first_day + timedelta(days=i) for i in range(window.days))]


@dataclass(frozen=True)
class FailedSearch:
    query: str
    count: int
    last_at: datetime


async def failed_searches(db: AsyncSession, window: Window) -> list[FailedSearch]:
    """Searches in the window that found nothing, grouped case-
    insensitively, the most repeated first. Across the whole wiki: a
    search isn't tied to a space."""
    query = func.lower(WikiSearchLog.query).label("query")
    count = func.count().label("count")
    last_at = func.max(WikiSearchLog.at).label("last_at")
    rows = (await db.execute(
        select(query, count, last_at)
        .where(WikiSearchLog.result_count == 0, WikiSearchLog.at >= window.since)
        .group_by(query)
        .order_by(count.desc(), last_at.desc(), query)
        .limit(FAILED_SEARCHES_LIMIT))).all()
    return [FailedSearch(query=r.query, count=r.count, last_at=r.last_at) for r in rows]


async def stale_pages(db: AsyncSession, space_ids: Sequence[uuid.UUID] | None, *,
                      now: datetime | None = None, viewer: Principal | None = None) -> list[tuple[uuid.UUID, datetime]]:
    """Published live pages in a live space not updated in STALE_MONTHS,
    the longest untouched first: (node id, updated_at)."""
    cutoff = reviews.add_months(now or utcnow(), -STALE_MONTHS)
    rows = (await db.execute(
        select(WikiNode.id, WikiNode.updated_at)
        .join(WikiPage, WikiPage.node_id == WikiNode.id)
        .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .where(WikiNode.kind == "page", WikiNode.deleted_at.is_(None), _in_scope(space_ids),
               _visible_to(viewer), WikiSpace.archived_at.is_(None),
               WikiPage.published_version_id.is_not(None), WikiNode.updated_at < cutoff)
        .order_by(WikiNode.updated_at, WikiNode.id)
        .limit(STALE_LIMIT))).all()
    return [(r.id, r.updated_at) for r in rows]


async def overdue_reviews(db: AsyncSession, space_ids: Sequence[uuid.UUID] | None, *,
                          now: datetime | None = None, viewer: Principal | None = None) -> list[tuple[uuid.UUID, datetime]]:
    """Pages whose periodic review is overdue (Phase 2's review state:
    due by now, in a live space), the longest overdue first: (node id,
    next_review_at)."""
    rows = (await db.execute(
        select(WikiNode.id, WikiNode.next_review_at)
        .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .where(reviews.due_filter(now or reviews.utcnow()), _in_scope(space_ids),
               _visible_to(viewer))
        .order_by(WikiNode.next_review_at, WikiNode.id)
        .limit(OVERDUE_LIMIT))).all()
    return [(r.id, r.next_review_at) for r in rows]


# ── retention ────────────────────────────────────────────────────────


async def purge_old_views(db: AsyncSession, now: datetime) -> int:
    """Delete view rows older than VIEW_RETENTION_DAYS; returns how many."""
    cutoff = now.date() - timedelta(days=VIEW_RETENTION_DAYS)
    result = await db.execute(
        WikiPageView.__table__.delete().where(WikiPageView.viewed_on < cutoff))
    return result.rowcount


async def purge_old_searches(db: AsyncSession, now: datetime) -> int:
    """Delete search log rows older than SEARCH_RETENTION_DAYS; returns how many."""
    cutoff = now - timedelta(days=SEARCH_RETENTION_DAYS)
    result = await db.execute(
        WikiSearchLog.__table__.delete().where(WikiSearchLog.at < cutoff))
    return result.rowcount
