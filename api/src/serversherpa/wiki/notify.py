"""Wiki notifications: every inbox item the wiki sends goes through here,
and from here through `notifications.inbox.notify` (spec §7).

Each event picks its candidates (watchers of the node, its ancestors
and its space; thread participants; mentioned people; approvers; the
page owner), then `recipients_who_can_view` narrows them to the people
who can see the node right now:

- never the actor;
- only people with an active account (not disabled, person not archived);
- only people whose level on the node — their own `AccessIndex`, built
  from `principal_for_person` — is at least view, and, for a page they
  only have view on, only once it has been published (the tree's own
  rule: a reader never sees a never-published page);
- each person once per event.

Watches whose owner lost access stay in place (access may come back);
they simply stop producing notifications.

The link is the absolute wiki URL of the node (`<wiki_origin>/n/<id>`,
plus `#comment-<id>` for a comment), so the portal's inbox opens it on
the wiki. `payload` is `{"node_id", "space_key", "event"}`. Like
`inbox.notify`, nothing here commits — the caller's transaction does.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from typing import Literal

from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Person,
    UserAccount,
    WikiComment,
    WikiNode,
    WikiPage,
    WikiPageVersion,
    WikiReview,
    WikiSpace,
    WikiWatch,
)
from serversherpa.notifications.inbox import notify
from serversherpa.wiki.permissions import AccessIndex, principal_for_person

log = logging.getLogger(__name__)

# the most candidates one event evaluates; watch lists are small in
# practice, and each candidate costs its own access resolution
MAX_RECIPIENTS = 500

# how much of a comment's text a notification body carries
COMMENT_PREVIEW_CHARS = 280


def node_link(node_id: uuid.UUID, suffix: str = "") -> str:
    """The absolute wiki URL of a node (`suffix` e.g. `#comment-<id>`)."""
    return f"{get_settings().wiki_origin.rstrip('/')}/n/{node_id}{suffix}"


# ── who can see it ──────────────────────────────────────────────────


async def _is_published(db: AsyncSession, node: WikiNode) -> bool:
    """False only for a page with no published version."""
    if node.kind != "page":
        return True
    return await db.scalar(select(WikiPage.published_version_id)
                           .where(WikiPage.node_id == node.id)) is not None


async def _can_see(ix: AccessIndex, node: WikiNode, published: bool) -> bool:
    level = await ix.level_for_node(node)
    if level is None:
        return False
    return not (level == "view" and not published)


async def _viewers(db: AsyncSession, node: WikiNode,
                   person_ids: Iterable[uuid.UUID | None]) -> dict[uuid.UUID, AccessIndex]:
    """The candidates who can see `node` now, each with the AccessIndex
    that decided it (reusable for their view of other nodes in the same
    space). At most MAX_RECIPIENTS candidates are evaluated."""
    if node.deleted_at is not None:
        return {}
    ids = list(dict.fromkeys(pid for pid in person_ids if pid is not None))
    if len(ids) > MAX_RECIPIENTS:
        log.warning("wiki notification for node %s capped at %d of %d candidates",
                    node.id, MAX_RECIPIENTS, len(ids))
        ids = ids[:MAX_RECIPIENTS]
    if not ids:
        return {}
    active = set((await db.scalars(
        select(UserAccount.person_id)
        .join(Person, Person.id == UserAccount.person_id)
        .where(UserAccount.person_id.in_(ids),
               UserAccount.disabled_at.is_(None),
               Person.archived_at.is_(None))
    )).all())
    published = await _is_published(db, node)
    out: dict[uuid.UUID, AccessIndex] = {}
    for pid in ids:
        if pid not in active:
            continue
        ix = AccessIndex(db, await principal_for_person(db, pid))
        if await _can_see(ix, node, published):
            out[pid] = ix
    return out


async def recipients_who_can_view(db: AsyncSession, node: WikiNode,
                                  person_ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    """The people among `person_ids` with an active account who can see
    `node` right now (see the module docstring)."""
    return set(await _viewers(db, node, person_ids))


# ── watches ─────────────────────────────────────────────────────────


async def _watchers(db: AsyncSession, space_id: uuid.UUID,
                    node_ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    node_ids = list(node_ids)
    targets = [WikiWatch.space_id == space_id]
    if node_ids:
        targets.append(WikiWatch.node_id.in_(node_ids))
    return set((await db.scalars(
        select(WikiWatch.person_id).where(or_(*targets)))).all())


async def watchers_for(db: AsyncSession, node: WikiNode) -> set[uuid.UUID]:
    """Everyone watching the node, one of its ancestors, or its space —
    before any visibility check."""
    return await _watchers(db, node.space_id, [*(node.path or []), node.id])


async def auto_watch(db: AsyncSession, person_id: uuid.UUID, node_id: uuid.UUID) -> None:
    """Watch `node_id` for `person_id` unless they already do."""
    await db.execute(insert(WikiWatch)
                     .values(person_id=person_id, node_id=node_id)
                     .on_conflict_do_nothing())


# ── delivery ────────────────────────────────────────────────────────


async def _actor_name(db: AsyncSession, actor_id: uuid.UUID | None) -> str:
    person = await db.get(Person, actor_id) if actor_id is not None else None
    return person.display_name if person is not None else "Someone"


async def _space_key(db: AsyncSession, node: WikiNode) -> str:
    return await db.scalar(select(WikiSpace.key).where(WikiSpace.id == node.space_id))


async def _deliver(db: AsyncSession, node: WikiNode, person_ids: Iterable[uuid.UUID], *,
                   kind: str, title: str, body: str, event: str,
                   link_suffix: str = "") -> None:
    space_key = await _space_key(db, node)
    for pid in person_ids:
        await notify(db, pid, kind, title, body=body,
                     link=node_link(node.id, link_suffix),
                     payload={"node_id": str(node.id), "space_key": space_key,
                              "event": event})


async def _send(db: AsyncSession, node: WikiNode, candidates: Iterable[uuid.UUID], *,
                actor_id: uuid.UUID | None, kind: str, title: str, body: str = "",
                event: str, link_suffix: str = "") -> set[uuid.UUID]:
    """Notify the candidates who may receive it (not the actor, can view
    the node); returns who was notified."""
    recipients = await recipients_who_can_view(
        db, node, (pid for pid in candidates if pid != actor_id))
    await _deliver(db, node, recipients, kind=kind, title=title, body=body,
                   event=event, link_suffix=link_suffix)
    return recipients


# ── events ──────────────────────────────────────────────────────────


async def on_published(db: AsyncSession, node: WikiNode, *, actor_id: uuid.UUID | None,
                       version: WikiPageVersion, skip: Iterable[uuid.UUID] = ()) -> None:
    """A page was published: `wiki_update` to its watchers (the page, its
    ancestors, its space); the version's note is the body. `skip` is who
    already got a mention for this version (`pages.publish` returns
    them) — a mentioned watcher gets only the mention."""
    actor = await _actor_name(db, actor_id)
    await _send(db, node, await watchers_for(db, node) - set(skip), actor_id=actor_id,
                kind="wiki_update", title=f"{actor} published {node.title}",
                body=version.note or "", event="published")


async def on_created(db: AsyncSession, node: WikiNode, *,
                     actor_id: uuid.UUID | None) -> None:
    """A node was created (or copied, or uploaded) under a watched folder
    or space: `wiki_update` to watchers of its ancestors and its space.
    The title names the parent — or the space, for someone who can't
    see the parent."""
    candidates = await _watchers(db, node.space_id, node.path or [])
    candidates.discard(actor_id)
    viewers = await _viewers(db, node, candidates)
    if not viewers:
        return
    actor = await _actor_name(db, actor_id)
    space_name = await db.scalar(select(WikiSpace.name).where(WikiSpace.id == node.space_id))
    parent = await db.get(WikiNode, node.parent_id) if node.parent_id else None
    parent_published = parent is not None and await _is_published(db, parent)
    for pid, ix in viewers.items():
        where = space_name
        if parent is not None and await _can_see(ix, parent, parent_published):
            where = parent.title
        await _deliver(db, node, [pid], kind="wiki_update",
                       title=f"{actor} added {node.title} to {where}", body="",
                       event="created")


async def on_comment(db: AsyncSession, node: WikiNode, comment: WikiComment, *,
                     actor_id: uuid.UUID | None, skip: Iterable[uuid.UUID] = ()) -> None:
    """A comment was posted: `wiki_comment` to the page's watchers and the
    authors of earlier comments in its thread. `skip` is who already got
    a mention for it (`on_mentions`) — a mentioned watcher gets only the
    mention."""
    participants = set((await db.scalars(
        select(WikiComment.author_id).distinct()
        .where(WikiComment.thread_id == comment.thread_id,
               WikiComment.id != comment.id,
               WikiComment.author_id.is_not(None))
    )).all())
    skipped = set(skip)
    candidates = (await watchers_for(db, node) | participants) - skipped
    actor = await _actor_name(db, actor_id)
    text = str((comment.body or {}).get("text", ""))
    body = text if len(text) <= COMMENT_PREVIEW_CHARS \
        else text[:COMMENT_PREVIEW_CHARS - 1].rstrip() + "…"
    await _send(db, node, candidates, actor_id=actor_id, kind="wiki_comment",
                title=f"{actor} commented on {node.title}", body=body,
                event="comment", link_suffix=f"#comment-{comment.id}")


async def on_mentions(db: AsyncSession, node: WikiNode, person_ids: Iterable[uuid.UUID], *,
                      actor_id: uuid.UUID | None, context: Literal["comment", "page"],
                      link_suffix: str = "") -> set[uuid.UUID]:
    """People were @mentioned — `context` is `comment` (in a comment on
    the page) or `page` (in the page content): `wiki_mention` to each
    who can view the page. Returns who was notified."""
    actor = await _actor_name(db, actor_id)
    where = f"a comment on {node.title}" if context == "comment" else node.title
    return await _send(db, node, person_ids, actor_id=actor_id, kind="wiki_mention",
                title=f"{actor} mentioned you in {where}", event="mention",
                link_suffix=link_suffix)


async def on_review_requested(db: AsyncSession, node: WikiNode, review: WikiReview,
                              approver_ids: Iterable[uuid.UUID], *,
                              actor_id: uuid.UUID | None) -> None:
    """A page was submitted for review: `wiki_review_request` to its
    approvers; the submitter's note is the body."""
    actor = await _actor_name(db, actor_id)
    await _send(db, node, approver_ids, actor_id=actor_id, kind="wiki_review_request",
                title=f"{actor} asked you to review {node.title}", body=review.note or "",
                event="review_requested")


# how a decision reads in a notification title, by review status
_DECISION_VERBS = {"approved": "approved", "rejected": "requested changes to"}


async def on_review_decided(db: AsyncSession, node: WikiNode, review: WikiReview, *,
                            actor_id: uuid.UUID | None,
                            skip: Iterable[uuid.UUID] = ()) -> None:
    """A review was approved or rejected: `wiki_review_decision` to the
    requester and `wiki_update` to the page's watchers (the requester
    only once); the decision note is the body. An approval's publish is
    announced by this — callers don't also call `on_published` for it,
    and pass as `skip` who `pages.publish` already mentioned: they get no
    `wiki_update` (the requester still gets the decision).
    Raises ValueError for a review that isn't approved or rejected."""
    verb = _DECISION_VERBS.get(review.status)
    if verb is None:
        raise ValueError(f"review {review.id} is {review.status!r}, not decided")
    actor = await _actor_name(db, actor_id)
    title = f"{actor} {verb} {node.title}"
    body = review.decision_note or ""
    requester = [review.requested_by] if review.requested_by else []
    told = await _send(db, node, requester, actor_id=actor_id,
                       kind="wiki_review_decision", title=title, body=body,
                       event="review_decided")
    await _send(db, node, await watchers_for(db, node) - told - set(requester) - set(skip),
                actor_id=actor_id, kind="wiki_update", title=title, body=body,
                event="review_decided")


async def on_review_due(db: AsyncSession, node: WikiNode, *,
                        owner_id: uuid.UUID | None) -> set[uuid.UUID]:
    """A page's periodic review is due: `wiki_review_due` to its owner
    (sent by the worker — there is no actor). Returns who was notified."""
    if owner_id is None:
        return set()
    return await _send(db, node, [owner_id], actor_id=None, kind="wiki_review_due",
                       title=f"{node.title} is due for review", event="review_due")
