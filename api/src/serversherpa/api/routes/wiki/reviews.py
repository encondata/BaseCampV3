"""Page reviews/approvals and the periodic review cycle: submit a page
for review, the reviews queue and one review's detail (with both sides
of its diff), approve / reject / withdraw, mark a page reviewed, and a
space's due-for-review list. The rules live in `serversherpa.wiki.reviews`.

Who sees what: submitting needs edit on the page; approving and
rejecting need manage; withdrawing is for the requester or a manager.
A review is readable by editors of its page and by its requester (while
they can still see the page). A page the caller can't see is a 404.
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter
from sqlalchemy import select

from serversherpa.api.routes.wiki.deps import WikiContext, space_by_key, visible_nodes
from serversherpa.api.routes.wiki.errors import err, forbidden, is_edit, not_found
from serversherpa.api.routes.wiki.pages import page_for
from serversherpa.api.routes.wiki.schemas import (
    NodeOut,
    ReviewDetail,
    ReviewIn,
    ReviewNodeRef,
    ReviewOut,
    ReviewRejectIn,
    ReviewStatus,
)
from serversherpa.api.routes.wiki.serialize import node_out, nodes_out, person_refs
from serversherpa.db.models import WikiNode, WikiPage, WikiPageVersion, WikiReview, WikiSpace
from serversherpa.services.audit import audit
from serversherpa.wiki import notify, reviews
from serversherpa.wiki.content import EMPTY_DOC
from serversherpa.wiki.permissions import require_node_level, require_space_level

router = APIRouter()

# the most reviews one queue listing returns; a decided-review listing
# reads at most 4x this many rows before the visibility filter
LIST_LIMIT = 200
# the most pages the due-for-review list returns
DUE_LIMIT = 200


async def _reviews_out(ctx: WikiContext, rows: list[WikiReview]) -> list[ReviewOut]:
    if not rows:
        return []
    nodes = {n.id: (n, key, name) for n, key, name in (await ctx.db.execute(
        select(WikiNode, WikiSpace.key, WikiSpace.name)
        .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .where(WikiNode.id.in_({r.node_id for r in rows}))
    )).all()}
    people = await person_refs(ctx.db, [pid for r in rows
                                        for pid in (r.requested_by, r.decided_by)])
    out = []
    for r in rows:
        node, key, name = nodes[r.node_id]
        out.append(ReviewOut(
            id=r.id, node=ReviewNodeRef(id=node.id, title=node.title, space_key=str(key),
                                        space_name=name),
            version_id=r.version_id, status=r.status, note=r.note,
            requested_by=people.get(r.requested_by) if r.requested_by else None,
            created_at=r.created_at,
            decided_by=people.get(r.decided_by) if r.decided_by else None,
            decided_at=r.decided_at, decision_note=r.decision_note))
    return out


async def _review_out(ctx: WikiContext, review: WikiReview) -> ReviewOut:
    return (await _reviews_out(ctx, [review]))[0]


async def _review_for(ctx: WikiContext, review_id: uuid.UUID,
                      ) -> tuple[WikiReview, WikiNode, WikiPage, str | None]:
    """(review, node, page, the caller's level on it): 404 when there's no
    such review or the caller can't see its page."""
    review = await ctx.db.get(WikiReview, review_id)
    if review is None:
        raise not_found()
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, review.node_id),
                                    "view")
    shown, levels = await visible_nodes(ctx, [node])
    if not shown:
        raise not_found()
    return review, node, await ctx.db.get(WikiPage, node.id), levels[node.id]


def _audit(ctx: WikiContext, review: WikiReview, action: str, **changes) -> None:
    audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_review",
          entity_id=str(review.id), action=action,
          changes={"node_id": str(review.node_id), **changes})


# ── submit ───────────────────────────────────────────────────────────


@router.post("/pages/{node_id}/reviews", response_model=ReviewOut, status_code=201)
async def submit(node_id: uuid.UUID, body: ReviewIn, ctx: WikiContext) -> ReviewOut:
    """Submit the page's current draft for review (the client stores the
    live document first, as it does before a publish). A pending review
    of the page is withdrawn in favor of this one."""
    node, page, _ = await page_for(ctx, node_id, "edit")
    actor_id = ctx.user.person.id
    review, replaced = await reviews.submit(ctx.db, node, page, actor_id=actor_id,
                                            note=body.note or None)
    if replaced is not None:
        _audit(ctx, replaced, "withdraw", replaced_by=str(review.id))
    _audit(ctx, review, "submit", version_id=str(review.version_id), note=review.note)
    approvers = await reviews.approver_ids(ctx.db, node, exclude=actor_id)
    await notify.on_review_requested(ctx.db, node, review, approvers, actor_id=actor_id)
    await ctx.db.commit()
    return await _review_out(ctx, review)


# ── the queue / one review ───────────────────────────────────────────


@router.get("/reviews", response_model=list[ReviewOut])
async def list_reviews(ctx: WikiContext, status: ReviewStatus = "pending",
                       mine: Literal["approver", "requester"] | None = None,
                       ) -> list[ReviewOut]:
    """Newest first. `mine=approver`: reviews of pages the caller manages;
    `mine=requester`: the caller's own requests (on pages they can still
    see); neither: reviews of pages the caller can edit."""
    q = (select(WikiReview, WikiNode)
         .join(WikiNode, WikiNode.id == WikiReview.node_id)
         .where(WikiReview.status == status, WikiNode.deleted_at.is_(None))
         .order_by(WikiReview.created_at.desc(), WikiReview.id))
    if mine == "requester":
        q = q.where(WikiReview.requested_by == ctx.principal.person_id)
    if status != "pending":           # decided reviews pile up; pending stay few
        q = q.limit(4 * LIST_LIMIT)
    rows = (await ctx.db.execute(q)).all()
    shown, levels = await visible_nodes(ctx, list(dict.fromkeys(n for _, n in rows)))
    shown_ids = {n.id for n in shown}

    def wanted(node: WikiNode) -> bool:
        if node.id not in shown_ids:
            return False
        if mine == "approver":
            return levels[node.id] == "manage"
        return mine == "requester" or is_edit(levels[node.id])

    picked = [r for r, n in rows if wanted(n)][:LIST_LIMIT]
    return await _reviews_out(ctx, picked)


@router.get("/reviews/{review_id}", response_model=ReviewDetail)
async def get_review(review_id: uuid.UUID, ctx: WikiContext) -> ReviewDetail:
    """For editors of the page and the requester: the review, its
    submitted snapshot and the page's published content now."""
    review, _, page, level = await _review_for(ctx, review_id)
    if not is_edit(level) and review.requested_by != ctx.principal.person_id:
        raise forbidden("edit")
    submitted = await ctx.db.get(WikiPageVersion, review.version_id)
    published = (await ctx.db.get(WikiPageVersion, page.published_version_id)
                 if page.published_version_id else None)
    out = await _review_out(ctx, review)
    submitted_content = (submitted.content_json if submitted.content_json is not None
                         else EMPTY_DOC)
    return ReviewDetail(
        **out.model_dump(), submitted_version_no=submitted.version_no,
        submitted_content=submitted_content,
        published_version_id=page.published_version_id,
        published_content=published.content_json if published else None,
        stale=(review.status == "pending" and published is not None
               and published.created_at > review.created_at))


# ── decisions ────────────────────────────────────────────────────────


@router.post("/reviews/{review_id}/approve", response_model=ReviewOut)
async def approve(review_id: uuid.UUID, body: ReviewIn, ctx: WikiContext) -> ReviewOut:
    """Publish exactly the submitted snapshot (manage) — unless it already
    is the published content, when the review is approved without a new
    version. 409 `not_pending` for a review already decided or withdrawn."""
    review, node, page, level = await _review_for(ctx, review_id)
    if level != "manage":
        raise forbidden("manage")
    review = await reviews.lock_review(ctx.db, review)
    reviews.require_pending(review)
    actor_id = ctx.user.person.id
    version, mentioned = await reviews.approve(ctx.db, node, page, review,
                                               actor_id=actor_id, note=body.note or None)
    _audit(ctx, review, "approve", version_id=str(version.id) if version else None,
           version_no=version.version_no if version else None,
           submitted_version_id=str(review.version_id), note=review.decision_note)
    await notify.auto_watch(ctx.db, actor_id, node.id)
    # the decision announces the publish too (no on_published)
    await notify.on_review_decided(ctx.db, node, review, actor_id=actor_id, skip=mentioned)
    await ctx.db.commit()
    return await _review_out(ctx, review)


@router.post("/reviews/{review_id}/reject", response_model=ReviewOut)
async def reject(review_id: uuid.UUID, body: ReviewRejectIn, ctx: WikiContext) -> ReviewOut:
    """Request changes (manage; the note is required). Nothing is published."""
    review, node, _, level = await _review_for(ctx, review_id)
    if level != "manage":
        raise forbidden("manage")
    review = await reviews.lock_review(ctx.db, review)
    reviews.require_pending(review)
    actor_id = ctx.user.person.id
    reviews.decide(review, "rejected", actor_id=actor_id, note=body.note)
    _audit(ctx, review, "reject", note=review.decision_note)
    await notify.on_review_decided(ctx.db, node, review, actor_id=actor_id)
    await ctx.db.commit()
    return await _review_out(ctx, review)


@router.post("/reviews/{review_id}/withdraw", response_model=ReviewOut)
async def withdraw(review_id: uuid.UUID, ctx: WikiContext) -> ReviewOut:
    """The requester, or a manager of the page, takes the request back."""
    review, _, _, level = await _review_for(ctx, review_id)
    actor_id = ctx.user.person.id
    if review.requested_by != actor_id and level != "manage":
        raise forbidden("manage")
    review = await reviews.lock_review(ctx.db, review)
    reviews.require_pending(review)
    reviews.decide(review, "withdrawn", actor_id=actor_id, note=None)
    _audit(ctx, review, "withdraw")
    await ctx.db.commit()
    return await _review_out(ctx, review)


# ── periodic review ──────────────────────────────────────────────────


@router.post("/pages/{node_id}/mark-reviewed", response_model=NodeOut)
async def mark_reviewed(node_id: uuid.UUID, ctx: WikiContext) -> NodeOut:
    """Confirm the page is still right (edit): the next review is one
    interval from now. 409 `not_published` for a page never published
    (it has nothing reviewed to confirm)."""
    node, page, level = await page_for(ctx, node_id, "edit")
    if page.published_version_id is None:
        raise err(409, "not_published", "Publish the page before marking it reviewed.")
    actor_id = ctx.user.person.id
    await reviews.mark_reviewed(ctx.db, node, actor_id=actor_id)
    audit(ctx.db, actor_id=actor_id, entity_type="wiki_node", entity_id=str(node.id),
          action="mark_reviewed",
          changes={"next_review_at": node.next_review_at.isoformat()
                   if node.next_review_at else None})
    await ctx.db.commit()
    return await node_out(ctx, node, level)


@router.get("/spaces/{key}/due-reviews", response_model=list[NodeOut])
async def due_reviews(key: str, ctx: WikiContext) -> list[NodeOut]:
    """The space's pages whose review falls due within two weeks (or is
    overdue), soonest first — those the caller can see, of the first
    DUE_LIMIT."""
    space = await require_space_level(ctx.ix, await space_by_key(ctx.db, key), "view")
    nodes = (await ctx.db.scalars(
        select(WikiNode)
        .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .where(WikiNode.space_id == space.id,
               reviews.due_filter(reviews.utcnow() + reviews.DUE_SOON))
        .order_by(WikiNode.next_review_at, WikiNode.id)
        .limit(DUE_LIMIT)
    )).all()
    shown, levels = await visible_nodes(ctx, nodes)
    return await nodes_out(ctx, shown, levels)
