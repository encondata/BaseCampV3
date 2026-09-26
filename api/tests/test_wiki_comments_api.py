"""Tests for the wiki's comment threads (Phase 2 Task 3): who may read,
post, edit, delete, resolve and reopen; thread/reply ordering; soft
delete; orphaned inline threads; the notifications a comment sends
(watchers and earlier participants, a mentioned person only the
mention); and the audit trail."""
import uuid

from sqlalchemy import event, select
from sqlalchemy.engine import Engine

from serversherpa.db.models import AuditLog, Client, Notification, WikiComment
from tests.wiki_helpers import _create, _setup, login_as, publish_via_db

# ── helpers ─────────────────────────────────────────────────────────


async def _page(client, db, s, title="Runbook", publish=True, parent=None):
    page = await _create(client, s["owner"], s["space"], title, kind="page", parent=parent)
    if publish:
        await publish_via_db(db, page["id"])
    return page


async def _post(client, headers, page, text="Looks good", *, mentions=(), thread_id=None,
                anchor=None, expect=201):
    body = {"body": {"text": text, "mentions": [str(m) for m in mentions]}}
    if thread_id is not None:
        body["thread_id"] = thread_id
    if anchor is not None:
        body["anchor"] = anchor
    resp = await client.post(f"/wiki/nodes/{page['id']}/comments", headers=headers,
                             json=body)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _threads(client, headers, page, expect=200):
    resp = await client.get(f"/wiki/nodes/{page['id']}/comments", headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _set_readers_can_comment(client, s, value):
    resp = await client.patch(f"/wiki/spaces/{s['space']['key']}", headers=s["owner"],
                              json={"settings": {"readers_can_comment": value}})
    assert resp.status_code == 200, resp.text


async def _inbox(db, person_id, kind=None):
    q = select(Notification).where(Notification.person_id == person_id)
    if kind is not None:
        q = q.where(Notification.kind == kind)
    return (await db.scalars(q.order_by(Notification.created_at))).all()


async def _audits(db, comment_id):
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_comment",
        AuditLog.entity_id == str(comment_id)).order_by(AuditLog.at))).all()


# ── posting & reading ───────────────────────────────────────────────


async def test_post_starts_a_thread_and_replies_join_it_in_order(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)

    first = await _post(client, s["editor"], page, "Step 3 is out of date")
    assert first["thread_id"] == first["id"]
    assert first["parent_id"] is None
    assert first["body"] == {"text": "Step 3 is out of date", "mentions": []}
    assert first["author"]["id"] == str(s["editor_id"])
    assert first["deleted"] is False and first["edited_at"] is None

    reply = await _post(client, s["viewer"], page, "Agreed", thread_id=first["id"])
    assert reply["thread_id"] == first["id"]
    assert reply["parent_id"] == first["id"]
    later = await _post(client, s["owner"], page, "Second thread", anchor=True)
    await _post(client, s["owner"], page, "Fixed", thread_id=first["id"])

    threads = await _threads(client, s["viewer"], page)
    assert [(t["thread_id"], t["anchor"], t["resolved_at"]) for t in threads] == [
        (first["id"], False, None), (later["id"], True, None)]
    assert [c["body"]["text"] for c in threads[0]["comments"]] == [
        "Step 3 is out of date", "Agreed", "Fixed"]
    assert threads[0]["resolved_by"] is None


async def test_body_text_is_validated(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    await _post(client, s["editor"], page, "   ", expect=422)
    await _post(client, s["editor"], page, "x" * 5001, expect=422)
    assert (await _post(client, s["editor"], page, "x" * 5000))["body"]["text"] == "x" * 5000


async def test_reply_to_a_thread_on_another_page_is_404(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    other = await _page(client, db, s, "Other")
    thread = await _post(client, s["editor"], other)
    await _post(client, s["editor"], page, "hi", thread_id=thread["id"], expect=404)
    await _post(client, s["editor"], page, "hi", thread_id=str(uuid.uuid4()), expect=404)


async def test_readers_can_comment_on_and_off(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)

    # default on: view level may comment
    await _post(client, s["viewer"], page, "reader comment")
    await _set_readers_can_comment(client, s, False)
    resp = await client.post(f"/wiki/nodes/{page['id']}/comments", headers=s["viewer"],
                             json={"body": {"text": "again", "mentions": []}})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"
    # editors still can; readers still read
    await _post(client, s["editor"], page, "editor comment")
    threads = await _threads(client, s["viewer"], page)
    assert len(threads) == 2


async def test_people_who_cannot_see_the_page_get_404(client, db):
    s = await _setup(client, db)
    draft = await _page(client, db, s, "Draft", publish=False)
    # never published: a reader can't see it or its comments
    await _threads(client, s["viewer"], draft, expect=404)
    await _post(client, s["viewer"], draft, expect=404)
    # editors can comment on a draft
    await _post(client, s["editor"], draft)

    folder = await _create(client, s["owner"], s["space"], "Guides")
    await _threads(client, s["owner"], folder, expect=404)

    acme = Client(name=f"Acme {uuid.uuid4().hex[:6]}")
    db.add(acme)
    await db.flush()
    stranger_h, _ = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    page = await _page(client, db, s)
    await _threads(client, stranger_h, page, expect=404)


# ── editing & deleting ──────────────────────────────────────────────


async def test_only_the_author_edits(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    c = await _post(client, s["viewer"], page, "tpyo")

    resp = await client.patch(f"/wiki/comments/{c['id']}", headers=s["owner"],
                              json={"body": {"text": "hijack", "mentions": []}})
    assert resp.status_code == 403
    resp = await client.patch(f"/wiki/comments/{c['id']}", headers=s["viewer"],
                              json={"body": {"text": "typo", "mentions": []}})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["body"]["text"] == "typo"
    assert out["edited_at"] is not None


async def test_delete_own_or_as_manager(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    first = await _post(client, s["viewer"], page, "question")
    reply = await _post(client, s["editor"], page, "answer", thread_id=first["id"])

    # neither the author nor a manager: forbidden
    resp = await client.delete(f"/wiki/comments/{first['id']}", headers=s["editor"])
    assert resp.status_code == 403
    # the author deletes a comment that has replies: kept, body hidden
    resp = await client.delete(f"/wiki/comments/{first['id']}", headers=s["viewer"])
    assert resp.status_code == 204
    [thread] = await _threads(client, s["viewer"], page)
    assert [(c["id"], c["deleted"], c["body"]) for c in thread["comments"]] == [
        (first["id"], True, {"text": "Comment deleted", "mentions": []}),
        (reply["id"], False, {"text": "answer", "mentions": []})]
    # a deleted comment can't be edited or deleted again
    resp = await client.patch(f"/wiki/comments/{first['id']}", headers=s["viewer"],
                              json={"body": {"text": "back", "mentions": []}})
    assert resp.status_code == 404

    # a manager deletes the last reply: nothing live is left, so the thread goes
    resp = await client.delete(f"/wiki/comments/{reply['id']}", headers=s["owner"])
    assert resp.status_code == 204
    assert await _threads(client, s["viewer"], page) == []


async def test_deleting_a_reply_without_replies_removes_it(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    first = await _post(client, s["viewer"], page, "question")
    reply = await _post(client, s["viewer"], page, "never mind", thread_id=first["id"])

    resp = await client.delete(f"/wiki/comments/{reply['id']}", headers=s["viewer"])
    assert resp.status_code == 204
    [thread] = await _threads(client, s["viewer"], page)
    assert [c["id"] for c in thread["comments"]] == [first["id"]]
    assert await db.get(WikiComment, uuid.UUID(reply["id"])) is None


# ── resolve / reopen ────────────────────────────────────────────────


async def test_resolve_and_reopen(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    mine = await _post(client, s["viewer"], page, "mine")
    theirs = await _post(client, s["owner"], page, "theirs")
    await _post(client, s["viewer"], page, "reply", thread_id=theirs["id"])

    # the thread's author may resolve their own thread
    resp = await client.post(f"/wiki/comments/threads/{mine['id']}/resolve",
                             headers=s["viewer"])
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["thread_id"] == mine["id"]
    assert out["resolved_at"] is not None
    assert out["resolved_by"]["id"] == str(s["viewer_id"])
    # a reader who only replied to it may not
    resp = await client.post(f"/wiki/comments/threads/{theirs['id']}/resolve",
                             headers=s["viewer"])
    assert resp.status_code == 403
    # an editor may
    resp = await client.post(f"/wiki/comments/threads/{theirs['id']}/resolve",
                             headers=s["editor"])
    assert resp.status_code == 200

    threads = {t["thread_id"]: t for t in await _threads(client, s["viewer"], page)}
    assert threads[theirs["id"]]["resolved_by"]["id"] == str(s["editor_id"])

    resp = await client.post(f"/wiki/comments/threads/{mine['id']}/reopen",
                             headers=s["viewer"])
    assert resp.status_code == 200
    assert resp.json()["resolved_at"] is None
    assert resp.json()["resolved_by"] is None

    resp = await client.post(f"/wiki/comments/threads/{uuid.uuid4()}/resolve",
                             headers=s["editor"])
    assert resp.status_code == 404


async def test_orphaned_inline_thread_is_still_listed(client, db):
    """An inline thread whose commentThread mark was deleted from the page
    stays in the listing (the rail shows it as orphaned)."""
    s = await _setup(client, db)
    page = await _page(client, db, s)   # published content has no marks at all
    thread = await _post(client, s["editor"], page, "about this sentence", anchor=True)
    [listed] = await _threads(client, s["viewer"], page)
    assert listed["thread_id"] == thread["id"]
    assert listed["anchor"] is True


# ── notifications ───────────────────────────────────────────────────


async def test_comment_notifies_watchers_and_participants_once(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)   # the owner auto-watches it
    first = await _post(client, s["viewer"], page, "question")
    assert [n.kind for n in await _inbox(db, s["owner_id"])] == ["wiki_comment"]

    reply = await _post(client, s["editor"], page, "answer", thread_id=first["id"])

    got = await _inbox(db, s["viewer_id"])
    assert [(n.kind, n.link.rsplit("#", 1)[1]) for n in got] == [
        ("wiki_comment", f"comment-{reply['id']}")]
    assert len(await _inbox(db, s["owner_id"])) == 2
    assert await _inbox(db, s["editor_id"]) == []   # the actor


async def test_mentioned_watcher_gets_only_the_mention(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    c = await _post(client, s["editor"], page, "@Owner please look",
                    mentions=[s["owner_id"]])
    got = await _inbox(db, s["owner_id"])
    assert [(n.kind, n.link.rsplit("#", 1)[1]) for n in got] == [
        ("wiki_mention", f"comment-{c['id']}")]


# ── audit ───────────────────────────────────────────────────────────


async def test_every_write_is_audited(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    c = await _post(client, s["editor"], page, "one", mentions=[s["viewer_id"]])
    await client.patch(f"/wiki/comments/{c['id']}", headers=s["editor"],
                       json={"body": {"text": "two", "mentions": []}})
    await client.post(f"/wiki/comments/threads/{c['id']}/resolve", headers=s["editor"])
    await client.post(f"/wiki/comments/threads/{c['id']}/reopen", headers=s["editor"])
    await client.delete(f"/wiki/comments/{c['id']}", headers=s["editor"])

    rows = await _audits(db, c["id"])
    assert [r.action for r in rows] == ["create", "edit", "resolve", "reopen", "delete"]
    assert all(r.actor_person_id == s["editor_id"] for r in rows)
    assert rows[0].changes["node_id"] == page["id"]
    assert rows[0].changes["thread_id"] == c["id"]
    assert rows[0].changes["mentions"] == [str(s["viewer_id"])]


async def test_an_archived_space_is_read_only_for_its_readers(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    mine = await _post(client, s["viewer"], page, "mine")
    resp = await client.post(f"/wiki/spaces/{s['space']['key']}/archive", headers=s["owner"])
    assert resp.status_code == 200, resp.text

    # still readable, but no commenting, editing, deleting or resolving
    assert len(await _threads(client, s["viewer"], page)) == 1
    await _post(client, s["viewer"], page, "more", expect=403)
    resp = await client.patch(f"/wiki/comments/{mine['id']}", headers=s["viewer"],
                              json={"body": {"text": "edit", "mentions": []}})
    assert resp.status_code == 403
    resp = await client.post(f"/wiki/comments/threads/{mine['id']}/resolve",
                             headers=s["viewer"])
    assert resp.status_code == 403
    resp = await client.delete(f"/wiki/comments/{mine['id']}", headers=s["viewer"])
    assert resp.status_code == 403


async def test_a_reply_reopens_a_resolved_thread(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    first = await _post(client, s["editor"], page, "question")
    resp = await client.post(f"/wiki/comments/threads/{first['id']}/resolve",
                             headers=s["editor"])
    assert resp.status_code == 200

    await _post(client, s["viewer"], page, "one more thing", thread_id=first["id"])

    [thread] = await _threads(client, s["viewer"], page)
    assert thread["resolved_at"] is None and thread["resolved_by"] is None
    rows = await _audits(db, first["id"])
    assert [(r.action, r.actor_person_id, r.changes.get("by_reply")) for r in rows] == [
        ("create", s["editor_id"], None), ("resolve", s["editor_id"], None),
        ("reopen", s["viewer_id"], True)]

    # a reply to an open thread records no reopen
    await _post(client, s["viewer"], page, "and another", thread_id=first["id"])
    assert len(await _audits(db, first["id"])) == 3


async def test_control_characters_in_text_are_rejected(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    for text in ("nul\x00byte", "bell\x07", "del\x7f"):
        resp = await client.post(f"/wiki/nodes/{page['id']}/comments", headers=s["editor"],
                                 json={"body": {"text": text, "mentions": []}})
        assert resp.status_code == 422, text
        assert resp.json()["detail"]["code"] == "bad_body"
    c = await _post(client, s["editor"], page, "tabs\tand\nnewlines\r\nare fine")
    resp = await client.patch(f"/wiki/comments/{c['id']}", headers=s["editor"],
                              json={"body": {"text": "bad\x00", "mentions": []}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_body"


async def test_editing_after_readers_lose_commenting_is_forbidden(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    c = await _post(client, s["viewer"], page, "mine")
    await _set_readers_can_comment(client, s, False)
    resp = await client.patch(f"/wiki/comments/{c['id']}", headers=s["viewer"],
                              json={"body": {"text": "edited", "mentions": []}})
    assert resp.status_code == 403


async def test_soft_delete_clears_the_stored_body(client, db):
    s = await _setup(client, db)
    page = await _page(client, db, s)
    first = await _post(client, s["viewer"], page, "secret", mentions=[s["editor_id"]])
    await _post(client, s["editor"], page, "reply", thread_id=first["id"])
    resp = await client.delete(f"/wiki/comments/{first['id']}", headers=s["viewer"])
    assert resp.status_code == 204
    db.expire_all()
    row = await db.get(WikiComment, uuid.UUID(first["id"]))
    assert row.deleted_at is not None
    assert row.body == {"text": "", "mentions": []}


async def test_reply_and_delete_lock_the_thread_start(client, db):
    """A reply and a delete both take the thread's first comment FOR
    UPDATE, so a hard delete can't cascade away a reply being added."""
    s = await _setup(client, db)
    page = await _page(client, db, s)
    first = await _post(client, s["editor"], page, "question")
    seen = []

    def _record(conn, cursor, statement, *args):
        if "wiki_comments" in statement and "FOR UPDATE" in statement:
            seen.append(statement)

    event.listen(Engine, "before_cursor_execute", _record)
    try:
        reply = await _post(client, s["viewer"], page, "answer", thread_id=first["id"])
        assert len(seen) == 1
        resp = await client.delete(f"/wiki/comments/{reply['id']}", headers=s["viewer"])
        assert resp.status_code == 204
        assert len(seen) == 2
    finally:
        event.remove(Engine, "before_cursor_execute", _record)
