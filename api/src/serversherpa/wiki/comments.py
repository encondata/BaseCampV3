"""Page comments (spec §7): the rules behind `/wiki/.../comments`.

A thread is its first comment plus the replies to it: the first
comment's `thread_id` is its own id, and a reply copies it (with
`parent_id` pointing at the first comment — threads are flat). An
inline thread (`anchor`) is tied to a `commentThread` mark in the page
whose id is the thread id; the mark may later be deleted from the page,
and the thread stays (the rail shows it as orphaned). Whether a thread
is resolved lives on its first comment; a reply reopens a resolved
thread (the route does that, and audits it).

A body is plain text plus the ids of the people it @mentions,
`{"text": str, "mentions": [uuid str]}` — never HTML. Only people who
can view the page may be mentioned; anyone else is dropped silently.

Deleting a comment that has replies keeps its row (`deleted_at` set, its
body emptied) so the thread still reads; any other comment's row is
removed, and a thread left with nothing but deleted comments goes with
it. Replying and deleting both lock the thread's first comment, so a
delete can't remove a thread a reply is joining.

Like `pages`, these helpers only `flush()`; the routes check who may do
what, audit, and commit.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import WikiComment, WikiNode, WikiSpace
from serversherpa.wiki import notify
from serversherpa.wiki.content import CONTROL_CHARS
from serversherpa.wiki.permissions import level_rank
from serversherpa.wiki.space_settings import space_setting

MAX_TEXT_CHARS = 5000

# what a reader sees in place of a deleted comment's text
DELETED_TEXT = "Comment deleted"


def utcnow() -> datetime:
    return datetime.now(UTC)


def can_comment(level: str | None, space: WikiSpace) -> bool:
    """Edit (or more) may always comment; view may while the space's
    `readers_can_comment` is on — and never in an archived space (where
    everyone but a wiki administrator is down to view)."""
    if level_rank(level) >= level_rank("edit"):
        return True
    return (level == "view" and space.archived_at is None
            and bool(space_setting(space, "readers_can_comment")))


def check_text(text: str) -> str:
    """`text`, unless it carries control characters other than tab,
    newline and carriage return (422 `bad_body`)."""
    if CONTROL_CHARS.search(text):
        raise HTTPException(status_code=422, detail={
            "code": "bad_body",
            "message": "The comment contains characters that can't be saved."})
    return text


def comment_link_suffix(comment: WikiComment) -> str:
    return f"#comment-{comment.id}"


def mentions_of(comment: WikiComment) -> list[uuid.UUID]:
    """The people a stored comment body mentions, in order."""
    out: list[uuid.UUID] = []
    for raw in (comment.body or {}).get("mentions") or []:
        try:
            out.append(uuid.UUID(str(raw)))
        except ValueError:
            continue
    return out


async def viewable_mentions(db: AsyncSession, node: WikiNode,
                            person_ids: Iterable[uuid.UUID]) -> list[uuid.UUID]:
    """`person_ids` without repeats and without anyone who can't view
    `node` now (see `notify.recipients_who_can_view`), in order."""
    ids = list(dict.fromkeys(person_ids))
    if not ids:
        return []
    viewers = await notify.recipients_who_can_view(db, node, ids)
    return [pid for pid in ids if pid in viewers]


def _body(text: str, mentions: Sequence[uuid.UUID]) -> dict:
    return {"text": text, "mentions": [str(pid) for pid in mentions]}


async def thread_start(db: AsyncSession, node: WikiNode,
                       thread_id: uuid.UUID) -> WikiComment | None:
    """The first comment of thread `thread_id` on `node`, or None —
    row-locked for the rest of the transaction (see `remove`)."""
    return await db.scalar(
        select(WikiComment).where(
            WikiComment.id == thread_id, WikiComment.thread_id == thread_id,
            WikiComment.node_id == node.id)
        .with_for_update().execution_options(populate_existing=True))


async def _notify_posted(db: AsyncSession, node: WikiNode, comment: WikiComment,
                         mentioned: Sequence[uuid.UUID], *,
                         actor_id: uuid.UUID) -> None:
    if mentioned:
        await notify.on_mentions(db, node, mentioned, actor_id=actor_id,
                                 context="comment",
                                 link_suffix=comment_link_suffix(comment))
    await notify.on_comment(db, node, comment, actor_id=actor_id, skip=mentioned)


async def post(db: AsyncSession, node: WikiNode, *, author_id: uuid.UUID, text: str,
               mentions: Iterable[uuid.UUID], thread: WikiComment | None,
               anchor: bool) -> WikiComment:
    """Add a comment: a new thread (`thread` None; `anchor` for an inline
    one), or a reply to `thread` (its first comment; `anchor` is then the
    thread's business and ignored). Notifies the people it mentions, then
    the page's watchers and the thread's earlier participants."""
    mentioned = await viewable_mentions(db, node, mentions)
    comment_id = uuid.uuid4()
    comment = WikiComment(
        id=comment_id, node_id=node.id,
        thread_id=thread.id if thread is not None else comment_id,
        parent_id=thread.id if thread is not None else None,
        anchor=anchor if thread is None else False,
        body=_body(text, mentioned), author_id=author_id)
    db.add(comment)
    await db.flush()
    await db.refresh(comment)      # created_at, as the database set it
    await _notify_posted(db, node, comment, mentioned, actor_id=author_id)
    return comment


async def edit(db: AsyncSession, node: WikiNode, comment: WikiComment, *,
               actor_id: uuid.UUID, text: str,
               mentions: Iterable[uuid.UUID]) -> list[uuid.UUID]:
    """Replace a comment's body; people mentioned now who weren't before
    get a mention (nobody else hears about an edit). Returns them."""
    before = set(mentions_of(comment))
    mentioned = await viewable_mentions(db, node, mentions)
    comment.body = _body(text, mentioned)
    comment.edited_at = utcnow()
    await db.flush()
    added = [pid for pid in mentioned if pid not in before]
    if added:
        await notify.on_mentions(db, node, added, actor_id=actor_id, context="comment",
                                 link_suffix=comment_link_suffix(comment))
    return added


async def remove(db: AsyncSession, comment: WikiComment) -> bool:
    """Delete a comment — keeping its row, emptied, when it has replies
    (see the module docstring). Returns whether the row was kept. Locks
    the thread's first comment first, like a reply (`thread_start`)."""
    await db.execute(select(WikiComment.id)
                     .where(WikiComment.id == comment.thread_id).with_for_update())
    # threads are flat: only a thread's first comment has replies
    has_replies = comment.id == comment.thread_id and await db.scalar(select(exists().where(
        WikiComment.node_id == comment.node_id, WikiComment.thread_id == comment.id,
        WikiComment.id != comment.id)))
    if has_replies:
        comment.deleted_at = utcnow()
        comment.body = _body("", [])
        await db.flush()
        return True
    thread_id = comment.thread_id
    await db.delete(comment)
    await db.flush()
    live = await db.scalar(select(exists().where(
        WikiComment.thread_id == thread_id, WikiComment.deleted_at.is_(None))))
    if not live:
        await db.execute(delete(WikiComment).where(WikiComment.thread_id == thread_id))
    return False


def set_resolved(start: WikiComment, actor_id: uuid.UUID | None) -> bool:
    """Resolve (`actor_id` given) or reopen (None) the thread `start`
    begins. Returns whether that changed anything."""
    if (start.resolved_at is not None) == (actor_id is not None):
        return False
    start.resolved_at = utcnow() if actor_id is not None else None
    start.resolved_by = actor_id
    return True


@dataclass
class Thread:
    start: WikiComment                  # the first comment (anchor, resolution)
    comments: list[WikiComment]         # the whole thread, oldest first


async def threads_for(db: AsyncSession, node_id: uuid.UUID,
                      thread_id: uuid.UUID | None = None) -> list[Thread]:
    """Every thread on the node (or just `thread_id`), oldest first, each
    with its comments oldest first — resolved and orphaned ones too."""
    q = select(WikiComment).where(WikiComment.node_id == node_id)
    if thread_id is not None:
        q = q.where(WikiComment.thread_id == thread_id)
    rows = (await db.scalars(q.order_by(WikiComment.created_at, WikiComment.id))).all()
    grouped: dict[uuid.UUID, list[WikiComment]] = {}
    for row in rows:
        grouped.setdefault(row.thread_id, []).append(row)
    return [Thread(start=next((c for c in comments if c.id == tid), comments[0]),
                   comments=comments)
            for tid, comments in grouped.items()]
