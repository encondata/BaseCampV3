"""Wiki notifications: every inbox item the wiki sends goes through here,
and from here through `notifications.inbox.notify` (spec §7).

Each event picks its candidates (watchers of the node, its ancestors
and its space, and the members of the Active notification groups that
watch any of them; thread participants; mentioned people; approvers;
the page owner), then `recipients_who_can_view` narrows them to the
people who can see the node right now:

- never the actor;
- only people with an active account (not disabled, person not archived);
- only people whose level on the node — their own `AccessIndex`, built
  from `principals_for_people` — is at least view, and, for a page they
  only have view on, only once it has been published (the tree's own
  rule: a reader never sees a never-published page) — all candidates
  resolved in one batch, with one shared load of the space's grants;
- each person once per event, however many routes reach them.

Someone with an active account who is left out because they can't see
the node (nobody can see one in the trash) is logged in the Delivery
log, `inbox_suppressed` `no_access`, with the routes that brought them,
as the event sweep logs each candidate it drops for access. The actor,
someone told by a mention instead (an event's `skip`), someone without
an active account and anyone past the cap (MAX_RECIPIENTS, a warning in
the process log) are not logged.

Watches whose owner lost access stay in place (access may come back);
they simply stop producing notifications. Access is asked again before
a notice's queued or held email goes out (`access_recheck`, in the
send-time re-check): a person who can't open the node by then isn't
emailed about it.

The link is the absolute wiki URL of the node (`<wiki_origin>/n/<id>`,
plus `#comment-<id>` for a comment), so the portal's inbox opens it on
the wiki. `payload` is `{"node_id", "space_key", "event"}`. A notice a
watch brought logs, on its inbox row in the Delivery log, the routes
that reached its person (`via`: `watch` for their own, `group:<id>` for
a group's) and the groups' names (`names`), as the event sweep's do. An
event about something that isn't a node goes through `to_person`
instead (one recipient, any wiki path). Like `inbox.notify`, nothing
here commits — the caller's transaction does.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable, Mapping
from collections.abc import Set as AbstractSet
from typing import Literal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Notification,
    NotificationGroup,
    NotificationWatch,
    Person,
    UserAccount,
    WikiComment,
    WikiNode,
    WikiPage,
    WikiPageVersion,
    WikiReview,
    WikiSpace,
)
from serversherpa.notifications import access as watch_access
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.events import Thing
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info
from serversherpa.notifications.watches import routes_watching
from serversherpa.wiki.permissions import AccessIndex, level_rank, principals_for_people

log = logging.getLogger(__name__)

# the most candidates one event evaluates; watch lists are small in
# practice (their access is resolved in one batch)
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


async def _viewers(db: AsyncSession, node: WikiNode, person_ids: Iterable[uuid.UUID | None],
                   ) -> tuple[dict[uuid.UUID, AccessIndex], list[uuid.UUID]]:
    """The candidates who can see `node` now, each with the AccessIndex
    that decided it (reusable for their view of other nodes in the same
    space), and those with an active account who can't, in the order they
    came (all of them for a node in the trash). At most MAX_RECIPIENTS
    candidates are evaluated."""
    ids = list(dict.fromkeys(pid for pid in person_ids if pid is not None))
    if len(ids) > MAX_RECIPIENTS:
        log.warning("wiki notification for node %s capped at %d of %d candidates",
                    node.id, MAX_RECIPIENTS, len(ids))
        ids = ids[:MAX_RECIPIENTS]
    if not ids:
        return {}, []
    active = set((await db.scalars(
        select(UserAccount.person_id)
        .join(Person, Person.id == UserAccount.person_id)
        .where(UserAccount.person_id.in_(ids),
               UserAccount.disabled_at.is_(None),
               Person.archived_at.is_(None))
    )).all())
    people = [pid for pid in ids if pid in active]
    out: dict[uuid.UUID, AccessIndex] = {}
    if node.deleted_at is None and people:
        published = await _is_published(db, node)
        # one batch for everyone's access, and the space's grants loaded once
        # for all their indexes: a fixed number of queries per event
        principals = await principals_for_people(db, people)
        spaces: dict = {}
        for pid, principal in principals.items():
            ix = AccessIndex(db, principal, spaces=spaces)
            if await _can_see(ix, node, published):
                out[pid] = ix
    return out, [pid for pid in people if pid not in out]


async def recipients_who_can_view(db: AsyncSession, node: WikiNode,
                                  person_ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    """The people among `person_ids` with an active account who can see
    `node` right now (see the module docstring)."""
    viewers, _ = await _viewers(db, node, person_ids)
    return set(viewers)


# ── watches ─────────────────────────────────────────────────────────
# A watch is a row of `notification_watches` (migration 0116) on a library
# (`wiki_space_id`) or a folder or page (`wiki_node_id`), a person's own
# (`person_id`) or a notification group's (`group_id`), whose members hear
# it while the group is Active. It names no events: it hears every page
# update and comment.

# who a watch brought, and by which routes ("watch", "group:<id>")
Routes = Mapping[uuid.UUID, AbstractSet[str]]


async def _watchers(db: AsyncSession, space_id: uuid.UUID,
                    node_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, set[str]]:
    """The people with a watch on the space or on any of `node_ids`, and the
    members of the Active groups with one, each with the routes that reach
    them: "watch" for a watch of their own, "group:<id>" for each such
    group they belong to. People with a watch of their own come first,
    oldest watch first, then the groups' members, longest-standing first:
    the order the cap keeps (`_viewers`)."""
    return await routes_watching(db, [Thing("wiki_space", space_id),
                                      *(Thing("wiki_node", node_id) for node_id in node_ids)])


async def watchers_for(db: AsyncSession, node: WikiNode) -> dict[uuid.UUID, set[str]]:
    """Everyone watching the node, one of its ancestors, or its space, by
    their own watch or a group's, with their routes (`_watchers`) — before
    any visibility check."""
    return await _watchers(db, node.space_id, [*(node.path or []), node.id])


async def _logged(db: AsyncSession, routes: Routes | None,
                  person_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, dict]:
    """What the Delivery log records with the notice of each of `person_ids`
    that a watch brought: the routes (`via`, sorted) and the names of the
    groups among them (`names`, by route), exactly as the event sweep logs
    them. Nothing for someone no watch brought (a thread participant, say)."""
    via = {pid: sorted(routes[pid]) for pid in person_ids
           if routes is not None and routes.get(pid)}
    group_ids = {uuid.UUID(route.removeprefix("group:"))
                 for found in via.values() for route in found if route.startswith("group:")}
    names: dict[str, str] = {}
    if group_ids:
        names = {f"group:{group_id}": name for group_id, name in await db.execute(
            select(NotificationGroup.id, NotificationGroup.name)
            .where(NotificationGroup.id.in_(group_ids)))}
    return {pid: {"via": found, "names": {route: names[route] for route in found
                                          if route in names}}
            for pid, found in via.items()}


def _kept_out(db: AsyncSession, kind: str, person_ids: Iterable[uuid.UUID],
              logged: Mapping[uuid.UUID, dict]) -> None:
    """Log that the `kind` notice was kept out of the inbox of each of
    `person_ids`, people with an active account who can't see its node:
    `inbox_suppressed` `no_access`, as the event sweep logs each candidate
    it drops for access, with what `logged` (`_logged`) records of the
    routes that brought them, and nothing more for someone no watch brought
    (a thread participant, a mentioned person)."""
    info = kind_info(kind)
    for pid in person_ids:
        record(db, "inbox_suppressed", channel="inbox", person_id=pid, kind=kind,
               category=info.category if info else None, reason="no_access",
               detail=logged.get(pid))


async def auto_watch(db: AsyncSession, person_id: uuid.UUID, node_id: uuid.UUID) -> None:
    """Watch `node_id` for `person_id` unless they already do."""
    await db.execute(insert(NotificationWatch)
                     .values(person_id=person_id, wiki_node_id=node_id, created_by=person_id)
                     .on_conflict_do_nothing())


# ── delivery ────────────────────────────────────────────────────────


async def _actor_name(db: AsyncSession, actor_id: uuid.UUID | None) -> str:
    person = await db.get(Person, actor_id) if actor_id is not None else None
    return person.display_name if person is not None else "Someone"


async def _space_key(db: AsyncSession, node: WikiNode) -> str:
    return await db.scalar(select(WikiSpace.key).where(WikiSpace.id == node.space_id))


async def _deliver(db: AsyncSession, node: WikiNode, person_ids: Iterable[uuid.UUID], *,
                   kind: str, title: str, body: str, event: str,
                   link_suffix: str = "", space_key: str | None = None,
                   logged: Mapping[uuid.UUID, dict] | None = None,
                   ) -> set[uuid.UUID]:
    """Write one notification per person; returns who actually got one
    (`notify()` writes nothing for someone who turned the category off).
    `logged` is what the Delivery log records with each person's inbox
    row, for the people a watch brought (`_logged`)."""
    person_ids = list(person_ids)
    if not person_ids:
        return set()
    if space_key is None:
        space_key = await _space_key(db, node)
    delivered: set[uuid.UUID] = set()
    for pid in person_ids:
        row = await notify(db, pid, kind, title, body=body,
                           link=node_link(node.id, link_suffix),
                           payload={"node_id": str(node.id), "space_key": space_key,
                                    "event": event},
                           log_detail=(logged or {}).get(pid))
        if row is not None:
            delivered.add(pid)
    return delivered


async def _send(db: AsyncSession, node: WikiNode, candidates: Iterable[uuid.UUID], *,
                actor_id: uuid.UUID | None, kind: str, title: str, body: str = "",
                event: str, link_suffix: str = "",
                routes: Routes | None = None) -> set[uuid.UUID]:
    """Notify the candidates who may receive it (not the actor, can view
    the node); returns who actually was (not someone who turned wiki
    notifications off). A candidate with an active account who can't view
    it is logged as kept out (`_kept_out`). `routes` says which of them a
    watch brought, and how (`watchers_for`), for the Delivery log."""
    recipients, blind = await _viewers(
        db, node, (pid for pid in candidates if pid != actor_id))
    logged = await _logged(db, routes, [*recipients, *blind])
    _kept_out(db, kind, blind, logged)
    return await _deliver(db, node, recipients, kind=kind, title=title, body=body,
                          event=event, link_suffix=link_suffix, logged=logged)


# ── events ──────────────────────────────────────────────────────────


async def on_published(db: AsyncSession, node: WikiNode, *, actor_id: uuid.UUID | None,
                       version: WikiPageVersion, skip: Iterable[uuid.UUID] = ()) -> None:
    """A page was published: `wiki_update` to its watchers (the page, its
    ancestors, its space); the version's note is the body. `skip` is who
    already got a mention for this version (`pages.publish` returns
    them) — a mentioned watcher gets only the mention."""
    actor = await _actor_name(db, actor_id)
    routes = await watchers_for(db, node)
    skipped = set(skip)
    await _send(db, node, [pid for pid in routes if pid not in skipped], actor_id=actor_id,
                kind="wiki_update", title=f"{actor} published {node.title}",
                body=version.note or "", event="published", routes=routes)


async def on_created(db: AsyncSession, node: WikiNode, *,
                     actor_id: uuid.UUID | None) -> None:
    """A node was created (or copied, or uploaded) under a watched folder
    or space: `wiki_update` to watchers of its ancestors and its space.
    The title names the parent — or the space, for someone who can't
    see the parent. A watcher who can't see the node is logged as kept
    out (`_kept_out`)."""
    routes = await _watchers(db, node.space_id, node.path or [])
    viewers, blind = await _viewers(db, node, [pid for pid in routes if pid != actor_id])
    logged = await _logged(db, routes, [*viewers, *blind])
    _kept_out(db, "wiki_update", blind, logged)
    if not viewers:
        return
    actor = await _actor_name(db, actor_id)
    space_name = await db.scalar(select(WikiSpace.name).where(WikiSpace.id == node.space_id))
    parent = await db.get(WikiNode, node.parent_id) if node.parent_id else None
    parent_published = parent is not None and await _is_published(db, parent)
    space_key = await _space_key(db, node)
    for pid, ix in viewers.items():
        where = space_name
        if parent is not None and await _can_see(ix, parent, parent_published):
            where = parent.title
        await _deliver(db, node, [pid], kind="wiki_update",
                       title=f"{actor} added {node.title} to {where}", body="",
                       event="created", space_key=space_key, logged=logged)


async def on_comment(db: AsyncSession, node: WikiNode, comment: WikiComment, *,
                     actor_id: uuid.UUID | None, skip: Iterable[uuid.UUID] = ()) -> None:
    """A comment was posted: `wiki_comment` to the authors of earlier
    comments in its thread and the page's watchers, in that order for the
    cap: as the event sweep puts the people its code names first, a large
    watching group never pushes the people in the thread out. `skip` is
    who already got a mention for it (`on_mentions`) — a mentioned watcher
    gets only the mention."""
    participants = (await db.scalars(
        select(WikiComment.author_id).distinct()
        .where(WikiComment.thread_id == comment.thread_id,
               WikiComment.id != comment.id,
               WikiComment.author_id.is_not(None))
    )).all()
    skipped = set(skip)
    routes = await watchers_for(db, node)
    candidates = [pid for pid in dict.fromkeys([*participants, *routes]) if pid not in skipped]
    actor = await _actor_name(db, actor_id)
    text = str((comment.body or {}).get("text", ""))
    body = text if len(text) <= COMMENT_PREVIEW_CHARS \
        else text[:COMMENT_PREVIEW_CHARS - 1].rstrip() + "…"
    await _send(db, node, candidates, actor_id=actor_id, kind="wiki_comment",
                title=f"{actor} commented on {node.title}", body=body,
                event="comment", link_suffix=f"#comment-{comment.id}", routes=routes)


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
    requester (the decision note is the body) and `wiki_update` to the
    page's watchers (the requester only once). A review — and so its
    decision note — is for the page's editors (`GET /reviews/{id}`):
    watchers at edit or above get the note; view-only watchers hear about
    an approval (the page they read changed) without it, and nothing
    about a rejection (nothing they can see changed). An approval's
    publish is announced by this — callers don't also call
    `on_published` for it, and pass as `skip` who `pages.publish` already
    mentioned: they get no `wiki_update` (the requester still gets the
    decision). A requester or watcher who can't see the page is logged as
    kept out (`_kept_out`); a reader who hears nothing of a rejection is
    not, since they can see it. Raises ValueError for a review that isn't
    approved or rejected."""
    verb = _DECISION_VERBS.get(review.status)
    if verb is None:
        raise ValueError(f"review {review.id} is {review.status!r}, not decided")
    actor = await _actor_name(db, actor_id)
    title = f"{actor} {verb} {node.title}"
    note = review.decision_note or ""
    requester = [review.requested_by] if review.requested_by else []
    told = await _send(db, node, requester, actor_id=actor_id,
                       kind="wiki_review_decision", title=title, body=note,
                       event="review_decided")
    routes = await watchers_for(db, node)
    excluded = {*told, *requester, *skip, actor_id}
    watchers = [person_id for person_id in routes if person_id not in excluded]
    editors: list[uuid.UUID] = []
    readers: list[uuid.UUID] = []
    viewers, blind = await _viewers(db, node, watchers)
    for pid, ix in viewers.items():
        is_editor = level_rank(await ix.level_for_node(node)) >= level_rank("edit")
        (editors if is_editor else readers).append(pid)
    logged = await _logged(db, routes, [*editors, *readers, *blind])
    _kept_out(db, "wiki_update", blind, logged)
    await _deliver(db, node, editors, kind="wiki_update", title=title, body=note,
                   event="review_decided", logged=logged)
    if review.status == "approved":
        await _deliver(db, node, readers, kind="wiki_update", title=title, body="",
                       event="review_decided", logged=logged)


async def on_review_due(db: AsyncSession, node: WikiNode, *,
                        owner_id: uuid.UUID | None) -> set[uuid.UUID]:
    """A page's periodic review is due: `wiki_review_due` to its owner
    (sent by the worker — there is no actor). Returns who was notified."""
    if owner_id is None:
        return set()
    return await _send(db, node, [owner_id], actor_id=None, kind="wiki_review_due",
                       title=f"{node.title} is due for review", event="review_due")


async def to_person(db: AsyncSession, person_id: uuid.UUID, *, kind: str, title: str,
                    path: str, event: str, body: str = "",
                    payload: dict | None = None) -> bool:
    """One notification to one person about something that isn't a node
    (Phase 3's export-ready: the requester only, linking to
    `<wiki_origin><path>`) — still through `inbox.notify`, and still only
    to an active account. Who may see what it links to is the caller's
    check. Returns whether a notification was written (False for an
    inactive account, or someone who turned wiki notifications off)."""
    active = await db.scalar(
        select(UserAccount.person_id)
        .join(Person, Person.id == UserAccount.person_id)
        .where(UserAccount.person_id == person_id, UserAccount.disabled_at.is_(None),
               Person.archived_at.is_(None)))
    if active is None:
        return False
    row = await notify(db, person_id, kind, title, body=body,
                       link=f"{get_settings().wiki_origin.rstrip('/')}{path}",
                       payload={**(payload or {}), "event": event})
    return row is not None


# ── the send-time re-check ──────────────────────────────────────────


async def access_recheck(db: AsyncSession, notification: Notification) -> str | None:
    """The wiki's part of the re-check of a notice's email just before it
    goes out (email.recheck_notification, for a queued email and for a
    held one): `no_access` when the notice is about a node (its
    `payload.node_id`) that its person can't open now, by the wiki's own
    rule as the watch lists judge it (notifications/access.py `viewers`):
    a node in the trash or gone, a private one that isn't theirs, one
    their grants no longer reach, or a page they only read that isn't
    published. None for any other notice, and for a wiki notice about no
    node (an export's, sent with `to_person`). Never `not_watching`: most
    wiki notices aren't a watch's (a mention, a review), and none carries
    its routes. Reads only."""
    info = kind_info(notification.kind)
    raw = (notification.payload or {}).get("node_id")
    if info is None or info.category != "wiki" or raw is None:
        return None
    try:
        node_id = uuid.UUID(str(raw))
    except ValueError:              # not a node this module wrote: nothing to judge
        return None
    seen = await watch_access.viewers(db, Thing("wiki_node", node_id), [notification.person_id])
    return None if notification.person_id in seen else "no_access"
