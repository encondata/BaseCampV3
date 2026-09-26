"""Page comments and @mention lookup (spec §7); the rules live in
`serversherpa.wiki.comments`.

- `GET /nodes/{id}/comments` — the page's threads (view).
- `POST /nodes/{id}/comments` — start a thread or reply (edit, or view
  while the space's `readers_can_comment` is on); a reply reopens a
  resolved thread.
- `PATCH /comments/{id}` — edit your own comment.
- `DELETE /comments/{id}` — delete your own, or any as a manager.
- `POST /comments/threads/{thread_id}/resolve` and `/reopen` — edit, or
  the thread's author.
- `GET /nodes/{id}/mentionable?q=` — up to 10 people with an active
  account who can view the page, by name or email (view).

Comments belong to pages. A page the caller can't see — including a
never-published one, for view-only — is a 404, as are its comments.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping

from fastapi import APIRouter, Response
from sqlalchemy import func, or_, select

from serversherpa.api.routes.wiki.deps import WikiContext, visible_nodes
from serversherpa.api.routes.wiki.errors import err, forbidden, is_edit, not_found
from serversherpa.api.routes.wiki.schemas import (
    CommentBodyOut,
    CommentIn,
    CommentOut,
    CommentPatchIn,
    PersonRef,
    ThreadOut,
)
from serversherpa.api.routes.wiki.serialize import person_refs
from serversherpa.db.models import Person, UserAccount, WikiComment, WikiNode, WikiSpace
from serversherpa.services.audit import audit
from serversherpa.wiki import comments, notify
from serversherpa.wiki.permissions import level_rank, require_node_level

router = APIRouter()

MENTIONABLE_LIMIT = 10
# the most name/email matches checked for access per lookup — each costs
# an access resolution, and the picker asks again as the query narrows
MENTIONABLE_SCAN = 100


# ── lookups ─────────────────────────────────────────────────────────


async def _page(ctx: WikiContext, node_id: uuid.UUID) -> tuple[WikiNode, str]:
    """A page the caller can see, with their level on it; else 404."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    if node.kind != "page":
        raise not_found()
    shown, levels = await visible_nodes(ctx, [node])
    if not shown:
        raise not_found()
    return node, levels[node.id]


async def _comment(ctx: WikiContext, comment_id: uuid.UUID,
                   ) -> tuple[WikiComment, WikiNode, str]:
    """A live comment on a page the caller can see; else 404."""
    comment = await ctx.db.get(WikiComment, comment_id)
    if comment is None or comment.deleted_at is not None:
        raise not_found()
    node, level = await _page(ctx, comment.node_id)
    return comment, node, level


async def _require_can_comment(ctx: WikiContext, node: WikiNode, level: str) -> None:
    space = await ctx.db.get(WikiSpace, node.space_id)
    if not comments.can_comment(level, space):
        raise forbidden("edit")


async def _require_writable(ctx: WikiContext, node: WikiNode, level: str) -> None:
    """An author below edit acting on their own comment or thread: not in
    an archived space, which is read-only for everyone below edit."""
    if is_edit(level):
        return
    space = await ctx.db.get(WikiSpace, node.space_id)
    if space.archived_at is not None:
        raise forbidden("edit")


# ── serialization ───────────────────────────────────────────────────


def _people_in(threads: Iterable[comments.Thread]) -> set[uuid.UUID | None]:
    ids: set[uuid.UUID | None] = set()
    for t in threads:
        ids.add(t.start.resolved_by)
        for c in t.comments:
            ids.add(c.author_id)
            if c.deleted_at is None:
                ids.update(comments.mentions_of(c))
    return ids


def _comment_out(c: WikiComment, people: Mapping[uuid.UUID, PersonRef]) -> CommentOut:
    if c.deleted_at is not None:
        body = CommentBodyOut(text=comments.DELETED_TEXT, mentions=[])
    else:
        body = CommentBodyOut(
            text=str((c.body or {}).get("text", "")),
            mentions=[people[pid] for pid in comments.mentions_of(c) if pid in people])
    return CommentOut(
        id=c.id, thread_id=c.thread_id, parent_id=c.parent_id, body=body,
        author=people.get(c.author_id) if c.author_id else None,
        created_at=c.created_at, edited_at=c.edited_at,
        deleted=c.deleted_at is not None)


async def _threads_out(ctx: WikiContext, threads: list[comments.Thread]) -> list[ThreadOut]:
    people = await person_refs(ctx.db, _people_in(threads))
    return [ThreadOut(
        thread_id=t.start.thread_id, anchor=t.start.anchor,
        resolved_at=t.start.resolved_at,
        resolved_by=people.get(t.start.resolved_by) if t.start.resolved_by else None,
        comments=[_comment_out(c, people) for c in t.comments]) for t in threads]


async def _one_comment_out(ctx: WikiContext, c: WikiComment) -> CommentOut:
    people = await person_refs(ctx.db, [c.author_id, *comments.mentions_of(c)])
    return _comment_out(c, people)


def _audit(ctx: WikiContext, comment_id: uuid.UUID, action: str, changes: dict) -> None:
    audit(ctx.db, actor_id=ctx.principal.person_id, entity_type="wiki_comment",
          entity_id=str(comment_id), action=action, changes=changes)


# ── threads ─────────────────────────────────────────────────────────


@router.get("/nodes/{node_id}/comments", response_model=list[ThreadOut])
async def list_comments(node_id: uuid.UUID, ctx: WikiContext) -> list[ThreadOut]:
    node, _ = await _page(ctx, node_id)
    return await _threads_out(ctx, await comments.threads_for(ctx.db, node.id))


@router.post("/nodes/{node_id}/comments", response_model=CommentOut, status_code=201)
async def post_comment(node_id: uuid.UUID, body: CommentIn,
                       ctx: WikiContext) -> CommentOut:
    node, level = await _page(ctx, node_id)
    await _require_can_comment(ctx, node, level)
    thread = None
    if body.thread_id is not None:
        thread = await comments.thread_start(ctx.db, node, body.thread_id)
        if thread is None:
            raise not_found()
        # a reply reopens a resolved thread
        if comments.set_resolved(thread, None):
            _audit(ctx, thread.id, "reopen", {
                "node_id": str(node.id), "thread_id": str(thread.id), "by_reply": True})
    comment = await comments.post(
        ctx.db, node, author_id=ctx.principal.person_id, text=body.body.text,
        mentions=body.body.mentions, thread=thread, anchor=body.anchor)
    _audit(ctx, comment.id, "create", {
        "node_id": str(node.id), "thread_id": str(comment.thread_id),
        "parent_id": str(comment.parent_id) if comment.parent_id else None,
        "anchor": comment.anchor,
        "mentions": [str(pid) for pid in comments.mentions_of(comment)]})
    await ctx.db.commit()
    return await _one_comment_out(ctx, comment)


@router.patch("/comments/{comment_id}", response_model=CommentOut)
async def edit_comment(comment_id: uuid.UUID, body: CommentPatchIn,
                       ctx: WikiContext) -> CommentOut:
    comment, node, level = await _comment(ctx, comment_id)
    if comment.author_id != ctx.principal.person_id:
        raise err(403, "forbidden", "You can only edit your own comments.")
    await _require_can_comment(ctx, node, level)
    added = await comments.edit(ctx.db, node, comment, actor_id=ctx.principal.person_id,
                                text=body.body.text, mentions=body.body.mentions)
    _audit(ctx, comment.id, "edit", {
        "node_id": str(node.id), "thread_id": str(comment.thread_id),
        "mentions": [str(pid) for pid in comments.mentions_of(comment)],
        "mentions_added": [str(pid) for pid in added]})
    await ctx.db.commit()
    return await _one_comment_out(ctx, comment)


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(comment_id: uuid.UUID, ctx: WikiContext) -> Response:
    comment, node, level = await _comment(ctx, comment_id)
    if comment.author_id != ctx.principal.person_id \
            and level_rank(level) < level_rank("manage"):
        raise forbidden("manage")
    await _require_writable(ctx, node, level)
    comment_id, thread_id = comment.id, comment.thread_id
    kept = await comments.remove(ctx.db, comment)
    _audit(ctx, comment_id, "delete", {
        "node_id": str(node.id), "thread_id": str(thread_id), "kept": kept})
    await ctx.db.commit()
    return Response(status_code=204)


async def _set_resolved(ctx: WikiContext, thread_id: uuid.UUID,
                        resolve: bool) -> ThreadOut:
    start = await ctx.db.get(WikiComment, thread_id)
    if start is None or start.thread_id != start.id:
        raise not_found()
    node, level = await _page(ctx, start.node_id)
    me = ctx.principal.person_id
    if not is_edit(level) and start.author_id != me:
        raise forbidden("edit")
    await _require_writable(ctx, node, level)
    if comments.set_resolved(start, me if resolve else None):
        _audit(ctx, start.id, "resolve" if resolve else "reopen",
               {"node_id": str(node.id), "thread_id": str(start.id)})
        await ctx.db.commit()
    [thread] = await comments.threads_for(ctx.db, node.id, start.id)
    return (await _threads_out(ctx, [thread]))[0]


@router.post("/comments/threads/{thread_id}/resolve", response_model=ThreadOut)
async def resolve_thread(thread_id: uuid.UUID, ctx: WikiContext) -> ThreadOut:
    return await _set_resolved(ctx, thread_id, True)


@router.post("/comments/threads/{thread_id}/reopen", response_model=ThreadOut)
async def reopen_thread(thread_id: uuid.UUID, ctx: WikiContext) -> ThreadOut:
    return await _set_resolved(ctx, thread_id, False)


# ── mentionable ─────────────────────────────────────────────────────


@router.get("/nodes/{node_id}/mentionable", response_model=list[PersonRef])
async def mentionable(node_id: uuid.UUID, ctx: WikiContext, q: str = "") -> list[PersonRef]:
    """People to offer in the @mention picker: an active account, can view
    the page now, name or email containing `q` — not the caller. Checks
    the first MENTIONABLE_SCAN matches by name, so a query that matches
    many people who can't see the page may find fewer than it could."""
    node, _ = await _page(ctx, node_id)
    like = f"%{q.strip()}%"
    full_name = func.concat(func.coalesce(Person.preferred_name, Person.first_name),
                            " ", Person.last_name)
    people = (await ctx.db.scalars(
        select(Person)
        .join(UserAccount, UserAccount.person_id == Person.id)
        .where(UserAccount.disabled_at.is_(None), Person.archived_at.is_(None),
               Person.id != ctx.principal.person_id,
               or_(full_name.ilike(like), Person.first_name.ilike(like),
                   Person.last_name.ilike(like), Person.email.ilike(like)))
        .order_by(Person.last_name, Person.first_name, Person.id)
        .limit(MENTIONABLE_SCAN)
    )).all()
    viewers = await notify.recipients_who_can_view(ctx.db, node, [p.id for p in people])
    return [PersonRef(id=p.id, name=p.display_name)
            for p in people if p.id in viewers][:MENTIONABLE_LIMIT]
