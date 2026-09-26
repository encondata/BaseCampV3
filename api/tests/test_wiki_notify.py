"""Tests for the wiki's notification fan-out (`serversherpa.wiki.notify`,
Phase 2 Task 2): who a page/folder/space event reaches — watchers of the
node, its ancestors and its space, never the actor, never someone who
can't view the node when it's sent, once each — the notification's
shape (title, absolute link, payload), auto-watching, and the routes
that emit the events (create, copy, upload complete, publish)."""
import logging
import uuid

import pytest
from sqlalchemy import func, select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Client,
    Notification,
    Person,
    UserAccount,
    WikiComment,
    WikiNode,
    WikiPage,
    WikiReview,
    WikiWatch,
)
from serversherpa.services import storage
from serversherpa.wiki import notify
from tests.wiki_helpers import (
    _create,
    _put_grants,
    _setup,
    login_as,
    publish_via_api,
    publish_via_db,
)

# ── helpers ─────────────────────────────────────────────────────────


def _link(node_id, suffix=""):
    return f"{get_settings().wiki_origin.rstrip('/')}/n/{node_id}{suffix}"


async def _watch(client, headers, *, node=None, space=None):
    body = {"node_id": node["id"]} if node else {"space_id": space["id"]}
    resp = await client.put("/wiki/watches", headers=headers, json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _inbox(db, person_id, kind=None):
    q = select(Notification).where(Notification.person_id == person_id)
    if kind is not None:
        q = q.where(Notification.kind == kind)
    return (await db.scalars(q.order_by(Notification.created_at))).all()


async def _name(db, person_id):
    return (await db.get(Person, person_id)).display_name


async def _node(db, node_id) -> WikiNode:
    db.expire_all()
    return await db.get(WikiNode, uuid.UUID(str(node_id)))


async def _set_draft(client, headers, page_id, text):
    """Seed a draft through the import route (the page was never live)."""
    resp = await client.put(f"/wiki/nodes/{page_id}/draft", headers=headers, json={
        "content_json": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}]}})
    assert resp.status_code == 204, resp.text


async def _outsider(client, db):
    """A client-side person who can't see an internal space at all."""
    acme = Client(name=f"Acme {uuid.uuid4().hex[:6]}")
    db.add(acme)
    await db.flush()
    _, person_id = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    return person_id


async def _editor(client, db, s):
    """Another person with edit on the whole space."""
    headers, person_id = await login_as(client, db)
    await _put_grants(client, s["owner"], s["space"], [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
        {"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "edit"},
        {"principal_type": "person", "principal_id": str(person_id), "level": "edit"},
        {"principal_type": "internal", "level": "view"},
    ])
    return headers, person_id


# ── publish ─────────────────────────────────────────────────────────


async def test_publish_notifies_page_watchers_but_not_the_actor(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    await _watch(client, s["viewer"], node=page)
    await _set_draft(client, s["editor"], page["id"], "v2")

    await publish_via_api(client, s["editor"], page["id"], note="Second pass")

    got = await _inbox(db, s["viewer_id"])
    assert len(got) == 1
    n = got[0]
    assert n.kind == "wiki_update"
    assert n.title == f"{await _name(db, s['editor_id'])} published Runbook"
    assert n.body == "Second pass"
    assert n.link == _link(page["id"])
    assert n.payload == {"node_id": page["id"], "space_key": s["space"]["key"],
                         "event": "published"}
    # the owner auto-watched the page they created; the actor gets nothing
    assert [x.kind for x in await _inbox(db, s["owner_id"])] == ["wiki_update"]
    assert await _inbox(db, s["editor_id"]) == []


async def test_first_publish_notifies_a_view_only_space_watcher(client, db):
    s = await _setup(client, db)
    await _watch(client, s["viewer"], space=s["space"])
    page = await _create(client, s["editor"], s["space"], "Runbook", kind="page")
    assert await _inbox(db, s["viewer_id"]) == []     # unpublished: not announced

    await publish_via_api(client, s["editor"], page["id"])

    got = await _inbox(db, s["viewer_id"])
    assert [(n.kind, n.title, n.link) for n in got] == [
        ("wiki_update", f"{await _name(db, s['editor_id'])} published Runbook",
         _link(page["id"]))]


async def test_publish_auto_watches_the_publisher(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_api(client, s["editor"], page["id"])

    rows = (await db.scalars(select(WikiWatch).where(
        WikiWatch.person_id == s["editor_id"]))).all()
    assert [r.node_id for r in rows] == [uuid.UUID(page["id"])]


async def test_ancestor_and_space_watchers_are_notified_once_each(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page",
                         parent=folder)
    await publish_via_db(db, page["id"])
    folder_watcher_h, folder_watcher = await login_as(client, db)
    space_watcher_h, space_watcher = await login_as(client, db)
    await _watch(client, folder_watcher_h, node=folder)
    await _watch(client, space_watcher_h, space=s["space"])
    # the viewer watches all three levels — still one notification
    for target in ({"node": page}, {"node": folder}, {"space": s["space"]}):
        await _watch(client, s["viewer"], **target)
    await _set_draft(client, s["editor"], page["id"], "v2")

    await publish_via_api(client, s["editor"], page["id"])

    for person_id in (folder_watcher, space_watcher, s["viewer_id"]):
        got = await _inbox(db, person_id)
        assert [n.link for n in got] == [_link(page["id"])], person_id


async def test_a_watcher_who_lost_access_gets_nothing(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    await _watch(client, s["viewer"], space=s["space"])
    # internal view removed: the viewer's watch stays but they can't see it
    await _put_grants(client, s["owner"], s["space"], [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
        {"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "edit"},
    ])
    await _set_draft(client, s["editor"], page["id"], "v2")

    await publish_via_api(client, s["editor"], page["id"])

    assert await _inbox(db, s["viewer_id"]) == []


async def test_a_watcher_without_an_active_account_is_skipped(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    await _watch(client, s["viewer"], space=s["space"])
    account = await db.scalar(select(UserAccount).where(
        UserAccount.person_id == s["viewer_id"]))
    account.disabled_at = func.now()
    await db.commit()
    await _set_draft(client, s["editor"], page["id"], "v2")

    await publish_via_api(client, s["editor"], page["id"])

    assert await _inbox(db, s["viewer_id"]) == []


# ── create / copy / upload ──────────────────────────────────────────


async def test_creating_a_node_notifies_ancestor_and_space_watchers(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    await _watch(client, s["viewer"], node=folder)
    await _watch(client, s["editor"], space=s["space"])
    creator_h, creator_id = await _editor(client, db, s)

    sub = await _create(client, creator_h, s["space"], "Network", parent=folder)
    await _create(client, creator_h, s["space"], "Archive")

    creator = await _name(db, creator_id)
    viewer_got = await _inbox(db, s["viewer_id"])
    assert [(n.kind, n.title, n.link) for n in viewer_got] == [
        ("wiki_update", f"{creator} added Network to Guides", _link(sub["id"]))]
    assert viewer_got[0].payload == {"node_id": sub["id"],
                                     "space_key": s["space"]["key"], "event": "created"}
    editor_titles = [n.title for n in await _inbox(db, s["editor_id"])]
    assert editor_titles == [f"{creator} added Network to Guides",
                             f"{creator} added Archive to {s['space']['name']}"]
    # the owner created Guides (auto-watched) — Network is inside it
    assert [n.link for n in await _inbox(db, s["owner_id"])] == [_link(sub["id"])]
    assert await _inbox(db, creator_id) == []


async def test_creating_pages_and_folders_auto_watches_the_creator(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["editor"], s["space"], "Guides")
    page = await _create(client, s["editor"], s["space"], "Runbook", kind="page")

    watched = set((await db.scalars(select(WikiWatch.node_id).where(
        WikiWatch.person_id == s["editor_id"]))).all())
    assert watched == {uuid.UUID(folder["id"]), uuid.UUID(page["id"])}


async def test_a_new_unpublished_page_is_not_announced_to_view_only_watchers(client, db):
    s = await _setup(client, db)
    await _watch(client, s["viewer"], space=s["space"])
    await _watch(client, s["owner"], space=s["space"])

    page = await _create(client, s["editor"], s["space"], "Draft plan", kind="page")

    # a reader can't see a never-published page; the manager can
    assert await _inbox(db, s["viewer_id"]) == []
    assert [n.link for n in await _inbox(db, s["owner_id"])] == [_link(page["id"])]


async def test_copying_announces_the_copy_root(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    target = await _create(client, s["owner"], s["space"], "Copies")
    await _create(client, s["owner"], s["space"], "Child", parent=folder)
    await _watch(client, s["viewer"], node=target)

    resp = await client.post(f"/wiki/nodes/{folder['id']}/copy", headers=s["editor"],
                             json={"parent_id": target["id"]})
    assert resp.status_code == 201, resp.text
    copy = resp.json()

    got = await _inbox(db, s["viewer_id"])
    assert [(n.title, n.link) for n in got] == [
        (f"{await _name(db, s['editor_id'])} added Guides to Copies", _link(copy["id"]))]


async def test_upload_complete_announces_the_file_without_auto_watching(
        client, db, monkeypatch):
    s = await _setup(client, db)
    await _watch(client, s["viewer"], space=s["space"])
    resp = await client.post("/wiki/uploads", headers=s["editor"], json={
        "target": "node", "space_id": s["space"]["id"], "parent_id": None,
        "filename": "rack.png", "content_type": "image/png", "size": 5})
    assert resp.status_code == 200, resp.text

    async def _head(key):
        return {"size": 5, "content_type": "image/png"}
    monkeypatch.setattr(storage, "head_object", _head)
    resp = await client.post("/wiki/uploads/complete", headers=s["editor"],
                             json={"upload_id": resp.json()["upload_id"]})
    assert resp.status_code == 201, resp.text
    node = resp.json()

    got = await _inbox(db, s["viewer_id"])
    assert [(n.title, n.link) for n in got] == [
        (f"{await _name(db, s['editor_id'])} added rack.png to {s['space']['name']}",
         _link(node["id"]))]
    assert (await db.scalar(select(func.count()).select_from(WikiWatch).where(
        WikiWatch.person_id == s["editor_id"]))) == 0


# ── service ─────────────────────────────────────────────────────────


async def test_auto_watch_is_idempotent(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    node_id = uuid.UUID(page["id"])
    await notify.auto_watch(db, s["viewer_id"], node_id)
    await notify.auto_watch(db, s["viewer_id"], node_id)
    await db.commit()
    count = await db.scalar(select(func.count()).select_from(WikiWatch).where(
        WikiWatch.person_id == s["viewer_id"], WikiWatch.node_id == node_id))
    assert count == 1


async def test_watchers_for_covers_the_node_its_ancestors_and_its_space(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page",
                         parent=folder)
    other = await _create(client, s["owner"], s["space"], "Elsewhere")
    await _watch(client, s["viewer"], node=folder)
    await _watch(client, s["editor"], space=s["space"])
    other_watcher_h, _ = await login_as(client, db)
    await _watch(client, other_watcher_h, node=other)

    got = await notify.watchers_for(db, await _node(db, page["id"]))
    assert got == {s["owner_id"], s["viewer_id"], s["editor_id"]}


async def test_recipients_who_can_view_filters_and_caps(client, db, monkeypatch, caplog):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    node = await _node(db, page["id"])
    outsider = await _outsider(client, db)
    people = [s["owner_id"], s["viewer_id"], s["editor_id"], outsider, uuid.uuid4()]

    # never published: view-only can't see it; nor can the outsider, nor a stranger
    assert await notify.recipients_who_can_view(db, node, people) == {
        s["owner_id"], s["editor_id"]}
    await publish_via_db(db, page["id"])
    node = await _node(db, page["id"])
    assert await notify.recipients_who_can_view(db, node, people) == {
        s["owner_id"], s["editor_id"], s["viewer_id"]}

    monkeypatch.setattr(notify, "MAX_RECIPIENTS", 2)
    with caplog.at_level(logging.WARNING, logger="serversherpa.wiki.notify"):
        got = await notify.recipients_who_can_view(db, node, people)
    # only the first two candidates are evaluated
    assert got == {s["owner_id"], s["viewer_id"]}
    assert "capped" in caplog.text


async def test_on_comment_reaches_watchers_and_thread_participants(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    node = await _node(db, page["id"])
    _, participant = await login_as(client, db)
    mentioned_h, mentioned = await login_as(client, db)
    await _watch(client, mentioned_h, node=page)
    thread_id = uuid.uuid4()
    db.add(WikiComment(id=thread_id, node_id=node.id, thread_id=thread_id,
                       body={"text": "first", "mentions": []}, author_id=participant))
    reply = WikiComment(node_id=node.id, thread_id=thread_id, parent_id=thread_id,
                        body={"text": "Looks good to me", "mentions": []},
                        author_id=s["viewer_id"])
    db.add(reply)
    await db.flush()

    await notify.on_comment(db, node, reply, actor_id=s["viewer_id"], skip=[mentioned])

    for person_id in (participant, s["owner_id"]):
        got = await _inbox(db, person_id)
        assert [(n.kind, n.body, n.link) for n in got] == [
            ("wiki_comment", "Looks good to me", _link(page["id"], f"#comment-{reply.id}"))]
        assert got[0].title == f"{await _name(db, s['viewer_id'])} commented on Runbook"
    assert await _inbox(db, mentioned) == []           # got the mention instead
    assert await _inbox(db, s["viewer_id"]) == []      # the actor


async def test_on_mentions_skips_the_actor_and_non_viewers(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    node = await _node(db, page["id"])
    outsider = await _outsider(client, db)

    await notify.on_mentions(db, node, [s["viewer_id"], s["editor_id"], outsider],
                             actor_id=s["editor_id"], context="comment",
                             link_suffix="#comment-x")

    got = await _inbox(db, s["viewer_id"])
    assert [(n.kind, n.link) for n in got] == [
        ("wiki_mention", _link(page["id"], "#comment-x"))]
    editor = await _name(db, s["editor_id"])
    assert got[0].title == f"{editor} mentioned you in a comment on Runbook"
    assert got[0].payload["event"] == "mention"
    assert await _inbox(db, s["editor_id"]) == []
    assert await _inbox(db, outsider) == []

    await notify.on_mentions(db, node, [s["viewer_id"]], actor_id=s["editor_id"],
                             context="page")
    assert (await _inbox(db, s["viewer_id"]))[-1].title == f"{editor} mentioned you in Runbook"


async def test_review_notifications(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    node = await _node(db, page["id"])
    version_id = (await db.get(WikiPage, node.id)).published_version_id
    await _watch(client, s["viewer"], node=page)
    review = WikiReview(node_id=node.id, version_id=version_id,
                        requested_by=s["editor_id"], note="Please check step 3")
    db.add(review)
    await db.flush()

    await notify.on_review_requested(db, node, review, [s["owner_id"], s["editor_id"]],
                                     actor_id=s["editor_id"])
    got = await _inbox(db, s["owner_id"], "wiki_review_request")
    editor = await _name(db, s["editor_id"])
    assert [(n.title, n.body) for n in got] == [
        (f"{editor} asked you to review Runbook", "Please check step 3")]
    assert await _inbox(db, s["editor_id"]) == []

    review.status = "rejected"
    review.decided_by = s["owner_id"]
    review.decision_note = "Step 3 is wrong"
    await notify.on_review_decided(db, node, review, actor_id=s["owner_id"])
    owner = await _name(db, s["owner_id"])
    got = await _inbox(db, s["editor_id"], "wiki_review_decision")
    assert [(n.title, n.body) for n in got] == [
        (f"{owner} requested changes to Runbook", "Step 3 is wrong")]
    # watchers hear about the decision too
    got = await _inbox(db, s["viewer_id"], "wiki_update")
    assert [n.title for n in got] == [f"{owner} requested changes to Runbook"]

    await notify.on_review_due(db, node, owner_id=s["owner_id"])
    got = await _inbox(db, s["owner_id"], "wiki_review_due")
    assert [(n.title, n.link) for n in got] == [("Runbook is due for review",
                                                 _link(page["id"]))]


async def test_review_decided_names_approvals_and_rejects_other_statuses(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    node = await _node(db, page["id"])
    version_id = (await db.get(WikiPage, node.id)).published_version_id
    review = WikiReview(node_id=node.id, version_id=version_id,
                        requested_by=s["editor_id"])
    db.add(review)
    await db.flush()

    review.status = "approved"
    await notify.on_review_decided(db, node, review, actor_id=s["owner_id"])
    got = await _inbox(db, s["editor_id"], "wiki_review_decision")
    assert [n.title for n in got] == [f"{await _name(db, s['owner_id'])} approved Runbook"]

    for status in ("pending", "withdrawn"):
        review.status = status
        with pytest.raises(ValueError):
            await notify.on_review_decided(db, node, review, actor_id=s["owner_id"])
    assert len(await _inbox(db, s["editor_id"])) == 1
