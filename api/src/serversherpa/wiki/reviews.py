"""Page reviews/approvals and the periodic review cycle (spec §7).

Reviews: an editor submits the page's current draft for review — a
`submitted` version snapshot plus a pending `wiki_reviews` row (one per
page: a new submit withdraws the old one). The page's approvers — the
manage-level holders of its effective grants (`approver_ids`) — are
asked; one of them approves (the snapshot is published, whatever the
draft holds by now) or rejects (with a note), and the requester or a
manager may withdraw it. When the space sets `require_approval`, only
managers publish directly (the route enforces that).

Periodic review: a page's review interval is its own
`review_interval_months`, else its space's setting of that name. Each
publish (or approval) and each "mark as reviewed" sets `next_review_at`
to that many months on; changing the interval re-bases it on the last
review or publish. `review_state` turns that into the NodeOut chip, and
the worker's daily `reminders` job notifies the owner once per due date.

Like `pages`, nothing here commits — callers commit and audit.
"""
from __future__ import annotations

import calendar
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import Integer, and_, cast, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    AccessGroupMember,
    PersonRole,
    Role,
    WikiNode,
    WikiPage,
    WikiPageVersion,
    WikiReview,
    WikiSpace,
)
from serversherpa.wiki import pages
from serversherpa.wiki.content import EMPTY_DOC, docs_equal
from serversherpa.wiki.permissions import AccessIndex, Principal
from serversherpa.wiki.space_settings import space_setting

log = logging.getLogger(__name__)

# the most people one review request is sent to
MAX_APPROVERS = 200

# how far ahead a review counts as "due soon" (and shows in due-reviews)
DUE_SOON = timedelta(days=14)

ReviewState = Literal["ok", "due_soon", "overdue"]


def utcnow() -> datetime:
    """Now, as an aware UTC datetime (a seam tests patch)."""
    return datetime.now(UTC)


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


# ── the review cycle ─────────────────────────────────────────────────


def add_months(when: datetime, months: int) -> datetime:
    """`when` plus `months` calendar months, the day clamped to the end of
    a shorter month (Jan 31 + 1 → Feb 28)."""
    total = when.month - 1 + months
    year, month = when.year + total // 12, total % 12 + 1
    day = min(when.day, calendar.monthrange(year, month)[1])
    return when.replace(year=year, month=month, day=day)


def interval_for(node: WikiNode, space: WikiSpace | None) -> int | None:
    """The page's review interval in months: its own, else its space's."""
    if node.review_interval_months is not None:
        return node.review_interval_months
    return space_setting(space, "review_interval_months") if space is not None else None


def interval_sql():
    """`interval_for` as a SQL expression over WikiNode joined to WikiSpace."""
    return func.coalesce(
        WikiNode.review_interval_months,
        cast(WikiSpace.settings["review_interval_months"].astext, Integer))


def review_state(interval: int | None, next_review_at: datetime | None,
                 now: datetime) -> ReviewState | None:
    """`overdue` once due, `due_soon` within DUE_SOON, else `ok` — or None
    when the page has no interval or no review scheduled yet."""
    if interval is None or next_review_at is None:
        return None
    if next_review_at <= now:
        return "overdue"
    if next_review_at <= now + DUE_SOON:
        return "due_soon"
    return "ok"


async def _interval(db: AsyncSession, node: WikiNode) -> int | None:
    return interval_for(node, await db.get(WikiSpace, node.space_id))


async def schedule_from(db: AsyncSession, node: WikiNode, base: datetime | None) -> None:
    """Set `next_review_at` to `base` + the page's interval (None when
    either is missing)."""
    interval = await _interval(db, node)
    node.next_review_at = (add_months(base, interval)
                           if interval is not None and base is not None else None)


async def after_publish(db: AsyncSession, node: WikiNode) -> None:
    """A publish (or an approval) starts the next review period now."""
    await schedule_from(db, node, utcnow())


async def mark_reviewed(db: AsyncSession, node: WikiNode, *,
                        actor_id: uuid.UUID | None) -> None:
    """Someone confirmed the page is still right: the next review is one
    interval from now."""
    now = utcnow()
    node.last_reviewed_at = now
    node.last_reviewed_by = actor_id
    await schedule_from(db, node, now)


async def set_interval(db: AsyncSession, node: WikiNode, page: WikiPage,
                       months: int | None) -> None:
    """Change the page's own interval (None: back to the space's) and
    re-base `next_review_at` on the latest of its last review and its
    last publish — nothing is scheduled for a page never published."""
    node.review_interval_months = months
    base = None
    if page.published_version_id is not None:
        published_at = await db.scalar(select(WikiPageVersion.created_at)
                                       .where(WikiPageVersion.id == page.published_version_id))
        base = max(d for d in (published_at, node.last_reviewed_at) if d is not None)
    await schedule_from(db, node, base)


# ── approvers ────────────────────────────────────────────────────────

# a Principal that matches nothing: `effective_grants` lists the grants,
# not anyone's access, so whose index it is doesn't matter
_NOBODY = Principal(person_id=uuid.UUID(int=0), roles=frozenset(), group_ids=frozenset(),
                    client_ids=frozenset(), partner_ids=frozenset(), is_internal=False,
                    is_admin=False, can_view_wiki=False)


async def approver_ids(db: AsyncSession, node: WikiNode, *,
                       exclude: uuid.UUID | None = None) -> list[uuid.UUID]:
    """The people holding manage on `node` through its effective grants:
    person grants directly, role/access-group/client/partner grants
    expanded to their current members. `internal`/`everyone` manage
    grants are too broad to page anyone and are skipped (logged); wiki
    administrators can act on any review but aren't asked. `exclude` (the
    requester) is left out, and at most MAX_APPROVERS come back (logged
    when capped). Whether each can still view the page is the notifier's
    check (`notify.on_review_requested`)."""
    grants = [g for g in await AccessIndex(db, _NOBODY).effective_grants(node, node.space_id)
              if g.level == "manage"]
    ids: list[uuid.UUID] = []
    by_type: dict[str, set[str]] = {}
    for g in grants:
        if g.principal_type in ("internal", "everyone"):
            log.info("review approvers for node %s skip the %s manage grant (too broad)",
                     node.id, g.principal_type)
        elif g.principal_id is not None:
            by_type.setdefault(g.principal_type, set()).add(g.principal_id)

    def _uuids(values: set[str]) -> set[uuid.UUID]:
        out = set()
        for value in values:
            try:
                out.add(uuid.UUID(value))
            except ValueError:
                continue
        return out

    ids.extend(sorted(_uuids(by_type.get("person", set()))))
    member_queries = []
    if roles := by_type.get("role"):
        member_queries.append(select(PersonRole.person_id).where(
            PersonRole.role.in_(roles), PersonRole.revoked_at.is_(None)))
    if groups := _uuids(by_type.get("access_group", set())):
        member_queries.append(select(AccessGroupMember.person_id)
                              .where(AccessGroupMember.group_id.in_(groups)))
    for anchor, column in (("client", PersonRole.client_id), ("partner", PersonRole.partner_id)):
        if anchored := _uuids(by_type.get(anchor, set())):
            member_queries.append(
                select(PersonRole.person_id)
                .join(Role, Role.name == PersonRole.role)
                .where(column.in_(anchored), Role.scope_anchor == anchor,
                       PersonRole.revoked_at.is_(None)))
    for q in member_queries:
        ids.extend(sorted(set((await db.scalars(q)).all())))

    unique = [pid for pid in dict.fromkeys(ids) if pid != exclude]
    if len(unique) > MAX_APPROVERS:
        log.warning("review approvers for node %s capped at %d of %d",
                    node.id, MAX_APPROVERS, len(unique))
        unique = unique[:MAX_APPROVERS]
    return unique


# ── reviews ──────────────────────────────────────────────────────────


async def pending_for(db: AsyncSession, node_id: uuid.UUID) -> WikiReview | None:
    """The page's pending review, row-locked (lock the page first)."""
    return await db.scalar(select(WikiReview)
                           .where(WikiReview.node_id == node_id,
                                  WikiReview.status == "pending")
                           .with_for_update())


async def lock_review(db: AsyncSession, review: WikiReview) -> WikiReview:
    """Lock the review's page, then the review itself, and return it as
    committed now — the same order `submit` takes them in."""
    await pages.lock_page(db, review.node_id)
    return await db.scalar(select(WikiReview).where(WikiReview.id == review.id)
                           .with_for_update()
                           .execution_options(populate_existing=True))


def require_pending(review: WikiReview) -> None:
    if review.status != "pending":
        raise _err(409, "not_pending", f"This review was already {review.status}.")


async def submit(db: AsyncSession, node: WikiNode, page: WikiPage, *,
                 actor_id: uuid.UUID | None, note: str | None,
                 ) -> tuple[WikiReview, WikiReview | None]:
    """Snapshot the draft (the empty doc when there's none) as a
    `submitted` version under a new pending review, withdrawing the
    page's pending one if any. 409 `nothing_to_review` when the draft
    adds nothing to the published content. Returns (the new review, the
    one it replaced)."""
    await pages.lock_page(db, node.id)
    await db.refresh(page)
    if not await pages.has_changes(db, page):
        raise _err(409, "nothing_to_review", "There are no changes to review.")
    replaced = await pending_for(db, node.id)
    now = utcnow()
    if replaced is not None:
        replaced.status = "withdrawn"
        replaced.decided_by = actor_id
        replaced.decided_at = now
        await db.flush()     # before the new row: one pending review per page
    version = await pages.add_version(
        db, node, kind="submitted", title=node.title,
        content_json=page.draft_json if page.draft_json is not None else EMPTY_DOC,
        actor_id=actor_id, note=note)
    review = WikiReview(node_id=node.id, version_id=version.id, requested_by=actor_id,
                        note=note or "", status="pending", created_at=now)
    db.add(review)
    await db.flush()
    return review, replaced


def decide(review: WikiReview, status: str, *, actor_id: uuid.UUID | None,
           note: str | None) -> None:
    """Close a (locked, pending) review as approved, rejected or withdrawn."""
    review.status = status
    review.decided_by = actor_id
    review.decided_at = utcnow()
    review.decision_note = note or ""


async def approve(db: AsyncSession, node: WikiNode, page: WikiPage, review: WikiReview, *,
                  actor_id: uuid.UUID | None, note: str | None,
                  ) -> tuple[WikiPageVersion | None, set[uuid.UUID]]:
    """Publish the review's snapshot (the submitter's note is its change
    note), close it as approved with `note` as the decision note, and
    start the next review period. Returns the published version and who
    got a mention for it (see `pages.publish_snapshot`) — or (None, ∅)
    when the snapshot is exactly the published content already: the
    review is approved without publishing a duplicate version."""
    snapshot = await db.get(WikiPageVersion, review.version_id)
    content = snapshot.content_json if snapshot.content_json is not None else EMPTY_DOC
    decide(review, "approved", actor_id=actor_id, note=note)
    if docs_equal(content, await pages.published_content(db, page)):
        # already what readers see (published directly meanwhile): no
        # duplicate version, no new review period
        await db.flush()
        return None, set()
    version, mentioned = await pages.publish_snapshot(
        db, node, page, snapshot, actor_id=actor_id, note=review.note or None)
    await after_publish(db, node)
    await db.flush()
    return version, mentioned


def due_filter(now: datetime):
    """WHERE clause (WikiNode joined to WikiSpace): a live page in a live
    space with an interval and a review falling due by `now`."""
    return and_(WikiNode.kind == "page", WikiNode.deleted_at.is_(None),
                WikiSpace.archived_at.is_(None), interval_sql().is_not(None),
                WikiNode.next_review_at.is_not(None), WikiNode.next_review_at <= now)


def not_yet_notified():
    """WHERE clause: the reminders job hasn't notified for this due date."""
    return WikiNode.review_notified_for.is_distinct_from(WikiNode.next_review_at)


async def backfill_due_dates(db: AsyncSession) -> tuple[int, int]:
    """Bring `next_review_at` in line with intervals that changed at the
    space level (the space's setting isn't copied onto its pages):
    schedule each live published page that now has an interval but no
    due date at its current version's publish time + the interval, and
    clear the due date of pages no interval applies to any more. Pages
    another transaction holds are left for the next run. Returns
    (scheduled, cleared); the caller commits."""
    rows = (await db.execute(
        select(WikiNode, WikiPageVersion.created_at, interval_sql())
        .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .join(WikiPage, WikiPage.node_id == WikiNode.id)
        .join(WikiPageVersion, WikiPageVersion.id == WikiPage.published_version_id)
        .where(WikiNode.kind == "page", WikiNode.deleted_at.is_(None),
               WikiNode.next_review_at.is_(None), interval_sql().is_not(None))
        .with_for_update(of=WikiNode, skip_locked=True)
    )).all()
    for node, published_at, interval in rows:
        node.next_review_at = add_months(published_at, interval)
    no_space_interval = select(WikiSpace.id).where(
        cast(WikiSpace.settings["review_interval_months"].astext, Integer).is_(None))
    cleared = await db.execute(
        update(WikiNode)
        .where(WikiNode.kind == "page", WikiNode.next_review_at.is_not(None),
               WikiNode.review_interval_months.is_(None),
               WikiNode.space_id.in_(no_space_interval))
        .values(next_review_at=None)
        .execution_options(synchronize_session=False))
    await db.flush()
    return len(rows), cleared.rowcount
