"""Tests for the wiki's notification fan-out (`serversherpa.wiki.notify`,
Phase 2 Task 2): who a page/folder/space event reaches — watchers of the
node, its ancestors and its space, never the actor, never someone who
can't view the node when it's sent, once each — the notification's
shape (title, absolute link, payload), auto-watching, the routes
that emit the events (create, copy, upload complete, publish), and the
send-time re-check of a wiki notice's email (`access_recheck`)."""
import logging
import uuid
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import delete, func, select, update

from serversherpa.config import get_settings
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Client,
    EmailOutbox,
    Notification,
    NotificationGroup,
    NotificationHeld,
    NotificationLog,
    NotificationWatch,
    PermissionOverride,
    Person,
    UserAccount,
    WikiComment,
    WikiNode,
    WikiPage,
    WikiReview,
)
from serversherpa.mail import outbox as outbox_mod
from serversherpa.mail.delivery import deliver_once
from serversherpa.notifications import email as email_mod
from serversherpa.notifications.email import recheck_before_send
from serversherpa.notifications.summary import run_summaries_once
from serversherpa.services import storage
from serversherpa.wiki import notify
from tests.test_mail_delivery import FakeSend, _assert_dropped, _run
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

    rows = (await db.scalars(select(NotificationWatch).where(
        NotificationWatch.person_id == s["editor_id"]))).all()
    assert [r.wiki_node_id for r in rows] == [uuid.UUID(page["id"])]


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

    watched = set((await db.scalars(select(NotificationWatch.wiki_node_id).where(
        NotificationWatch.person_id == s["editor_id"]))).all())
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
    assert (await db.scalar(select(func.count()).select_from(NotificationWatch).where(
        NotificationWatch.person_id == s["editor_id"]))) == 0


# ── service ─────────────────────────────────────────────────────────


async def test_auto_watch_is_idempotent(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    node_id = uuid.UUID(page["id"])
    await notify.auto_watch(db, s["viewer_id"], node_id)
    await notify.auto_watch(db, s["viewer_id"], node_id)
    await db.commit()
    count = await db.scalar(select(func.count()).select_from(NotificationWatch).where(
        NotificationWatch.person_id == s["viewer_id"],
        NotificationWatch.wiki_node_id == node_id))
    assert count == 1


async def test_auto_watch_stores_the_persons_own_row_naming_no_events(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await notify.auto_watch(db, s["viewer_id"], uuid.UUID(page["id"]))
    await db.commit()
    row = (await db.scalars(select(NotificationWatch).where(
        NotificationWatch.person_id == s["viewer_id"]))).one()
    assert (row.wiki_node_id, row.wiki_space_id, row.group_id, row.kinds, row.created_by) == (
        uuid.UUID(page["id"]), None, None, [], s["viewer_id"])


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
    # each by their own watch (a group's members come with the group's route:
    # tests/test_wiki_watch_groups.py)
    assert got == {s["owner_id"]: {"watch"}, s["viewer_id"]: {"watch"},
                   s["editor_id"]: {"watch"}}


async def test_watchers_for_is_people_never_a_groups_row(client, db):
    """A group's watch on the folder is a row with no person in it: it reaches the group's
    members, and a group with none adds no one to the people who watch (never a None, never
    the group's own id)."""
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page",
                         parent=folder)
    group = NotificationGroup(name="Group A")
    db.add(group)
    await db.flush()
    db.add(NotificationWatch(group_id=group.id, wiki_node_id=uuid.UUID(folder["id"])))
    await db.commit()

    got = await notify.watchers_for(db, await _node(db, page["id"]))
    # the owner auto-watched what they created; the group has no members
    assert got == {s["owner_id"]: {"watch"}}


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
    # a rejection is about a draft readers can't see: view-only watchers
    # don't hear about it (see test_review_decision_note_reaches_only_editors)
    assert await _inbox(db, s["viewer_id"], "wiki_update") == []

    # skip: someone already told (e.g. mentioned in the approved version)
    review.status = "approved"
    await notify.on_review_decided(db, node, review, actor_id=s["owner_id"])
    before = len(await _inbox(db, s["viewer_id"]))
    await notify.on_review_decided(db, node, review, actor_id=s["owner_id"],
                                   skip=[s["viewer_id"]])
    assert len(await _inbox(db, s["viewer_id"])) == before

    await notify.on_review_due(db, node, owner_id=s["owner_id"])
    got = await _inbox(db, s["owner_id"], "wiki_review_due")
    assert [(n.title, n.link) for n in got] == [("Runbook is due for review",
                                                 _link(page["id"]))]


async def test_review_decision_note_reaches_only_editors(client, db):
    """`GET /reviews/{id}` is for editors and the requester, so a decision
    note is too: an edit-level watcher gets it; a view-only watcher hears
    about an approval (the page changed) without the note, and nothing
    about a rejection (nothing they can see changed)."""
    s = await _setup(client, db)
    editor2_h, editor2_id = await login_as(client, db, roles=("staff",))
    await _put_grants(client, s["owner"], s["space"], [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
        {"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "edit"},
        {"principal_type": "person", "principal_id": str(editor2_id), "level": "edit"},
        {"principal_type": "internal", "level": "view"},
    ])
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    node = await _node(db, page["id"])
    version_id = (await db.get(WikiPage, node.id)).published_version_id
    await _watch(client, s["viewer"], node=page)
    await _watch(client, editor2_h, node=page)
    owner = await _name(db, s["owner_id"])

    rejected = WikiReview(node_id=node.id, version_id=version_id, status="rejected",
                          requested_by=s["editor_id"], decision_note="Step 3 is wrong")
    db.add(rejected)
    await db.flush()
    await notify.on_review_decided(db, node, rejected, actor_id=s["owner_id"])
    assert [(n.title, n.body) for n in await _inbox(db, editor2_id, "wiki_update")] == [
        (f"{owner} requested changes to Runbook", "Step 3 is wrong")]
    assert await _inbox(db, s["viewer_id"]) == []

    approved = WikiReview(node_id=node.id, version_id=version_id, status="approved",
                          requested_by=s["editor_id"], decision_note="Looks good now")
    db.add(approved)
    await db.flush()
    await notify.on_review_decided(db, node, approved, actor_id=s["owner_id"])
    assert [(n.title, n.body) for n in await _inbox(db, editor2_id, "wiki_update")][-1] == \
        (f"{owner} approved Runbook", "Looks good now")
    assert [(n.title, n.body) for n in await _inbox(db, s["viewer_id"])] == [
        (f"{owner} approved Runbook", "")]


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


async def test_to_person_links_anywhere_in_the_wiki_for_one_active_person(client, db):
    """For events about something that isn't a node (Phase 3's export
    ready): one recipient, any wiki path, still through inbox.notify and
    still only to an active account."""
    _, person_id = await login_as(client, db)
    sent = await notify.to_person(db, person_id, kind="wiki_update", title="Your export is ready",
                                  path="/exports/abc", event="export_ready",
                                  payload={"job_id": "abc"})
    assert sent is True
    [note] = await _inbox(db, person_id)
    assert note.link == f"{get_settings().wiki_origin.rstrip('/')}/exports/abc"
    assert note.payload == {"job_id": "abc", "event": "export_ready"}

    account = await db.scalar(select(UserAccount).where(UserAccount.person_id == person_id))
    account.disabled_at = func.now()
    await db.flush()
    assert await notify.to_person(db, person_id, kind="wiki_update", title="Again",
                                  path="/exports/abc", event="export_ready") is False
    assert len(await _inbox(db, person_id)) == 1


async def test_counts_only_cover_notifications_actually_written(client, db):
    """Someone who turned wiki notifications off gets no row, so they are
    not counted as notified (to_person's bool, on_review_due's set)."""
    s = await _setup(client, db)
    off = {"notif": {"switches": {"wiki": {"inbox": False, "email": False}}}}
    account = await db.scalar(select(UserAccount).where(UserAccount.person_id == s["owner_id"]))
    account.ui_prefs = off
    await db.flush()
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    node = await _node(db, page["id"])
    assert await notify.on_review_due(db, node, owner_id=s["owner_id"]) == set()
    assert await _inbox(db, s["owner_id"], "wiki_review_due") == []
    assert await notify.to_person(db, s["owner_id"], kind="wiki_update", title="Export",
                                  path="/exports/abc", event="export_ready") is False
    assert await _inbox(db, s["owner_id"]) == []


# ── the send-time re-check ──────────────────────────────────────────
# A wiki notice's email, queued or held for a summary, is asked again just before it goes out
# (email.recheck_notification): can its person still open the page it is about, by the wiki's
# own rule? What changes meanwhile is done through the wiki's own routes, and the re-check is
# asked in a session of its own, as the delivery worker and the summary sweep ask it. Nothing
# is ever sent to a real server.

CHICAGO = ZoneInfo("America/Chicago")
# Quiet hours from 9:00 PM to 6:00 AM, every day: an email written at EVENING is held for the
# summary, which is due an hour before they end.
QUIET = {"notif": {"schedule": {"timezone": "America/Chicago",
                                "quiet_start": "21:00", "quiet_end": "06:00"}}}
EVENING = datetime(2026, 11, 2, 22, 0, tzinfo=CHICAGO)
MORNING = datetime(2026, 11, 3, 5, 0, tzinfo=CHICAGO)


@pytest.fixture
def clock(monkeypatch):
    """Set the instant an email is decided (email._now) and queued (outbox._now)."""
    def set_to(instant: datetime) -> datetime:
        monkeypatch.setattr(email_mod, "_now", lambda: instant)
        monkeypatch.setattr(outbox_mod, "_now", lambda: instant)
        return instant
    return set_to


async def _mail_of(person_id) -> EmailOutbox:
    """The one email queued for the person."""
    async with get_sessionmaker()() as session:
        return await session.scalar(select(EmailOutbox)
                                    .where(EmailOutbox.person_id == person_id))


async def _recheck(mail) -> str | None:
    """What the delivery worker asks just before it sends: in a session of its own."""
    async with get_sessionmaker()() as session:
        return await recheck_before_send(session, mail)


async def _held() -> list[NotificationHeld]:
    async with get_sessionmaker()() as session:
        return list(await session.scalars(select(NotificationHeld)
                                          .order_by(NotificationHeld.id)))


async def _published_again(client, db, s, *readers) -> dict:
    """Runbook, made and so watched by the owner, published, and watched by each of `readers`
    (their headers), is published again by the editor: each of its watchers gets a
    wiki_update. Returns the page."""
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    for headers in readers:
        await _watch(client, headers, node=page)
    await _set_draft(client, s["editor"], page["id"], "v2")
    await publish_via_api(client, s["editor"], page["id"])
    return page


def _named_only(s, *readers) -> list[dict]:
    """The library's grants without `internal`: its manager, its editor and `readers`, who read
    it by name."""
    return [{"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
            {"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "edit"},
            *({"principal_type": "person", "principal_id": str(person_id), "level": "view"}
              for person_id in readers)]


async def test_a_queued_wiki_email_is_dropped_once_the_page_is_private(client, db, email_on):
    """Once its author makes the page private, a reader's queued email of it is dropped
    `no_access`, and the author's goes out. Not watching the page any more drops nothing: a
    wiki notice carries no route, and most aren't a watch's."""
    s = await _setup(client, db)
    page = await _published_again(client, db, s, s["viewer"])
    reader, author = await _mail_of(s["viewer_id"]), await _mail_of(s["owner_id"])
    assert (reader.kind, author.kind) == ("wiki_update", "wiki_update")
    assert await _recheck(reader) is None

    await _run(delete(NotificationWatch).where(NotificationWatch.person_id == s["viewer_id"]))
    assert await _recheck(reader) is None

    resp = await client.patch(f"/wiki/nodes/{page['id']}/privacy", headers=s["owner"],
                              json={"is_private": True})
    assert resp.status_code == 200, resp.text
    assert await _recheck(reader) == "no_access"
    assert await _recheck(author) is None

    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 2
    assert [call["to"] for call in send.calls] == [author.to_address]
    log = await _assert_dropped(reader.id, "no_access")
    assert (log.person_id, log.notification_id, log.kind, log.category) == (
        s["viewer_id"], reader.notification_id, "wiki_update", "wiki")


async def test_a_queued_wiki_email_is_dropped_once_its_reader_loses_their_level(
        client, db, email_on):
    """A reader who loses their level on the page (the library stops letting all staff read
    it) has their queued email of it dropped `no_access`; a reader the library still names gets
    theirs."""
    s = await _setup(client, db)
    keeper_h, keeper = await login_as(client, db)
    await _published_again(client, db, s, s["viewer"], keeper_h)
    lost, kept = await _mail_of(s["viewer_id"]), await _mail_of(keeper)
    owners = await _mail_of(s["owner_id"])

    await _put_grants(client, s["owner"], s["space"], _named_only(s, keeper))
    assert await _recheck(lost) == "no_access"
    assert await _recheck(kept) is None

    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 3
    assert sorted(call["to"] for call in send.calls) == sorted(
        [kept.to_address, owners.to_address])
    await _assert_dropped(lost.id, "no_access")


async def test_a_queued_wiki_email_of_a_page_in_the_trash_or_gone_is_dropped(
        client, db, email_on):
    """A page in the trash opens for nobody, so its emails are dropped `no_access` meanwhile,
    and go again once it is restored; a page deleted for good opens for nobody either."""
    s = await _setup(client, db)
    page = await _published_again(client, db, s, s["viewer"])
    mails = [await _mail_of(s["viewer_id"]), await _mail_of(s["owner_id"])]

    async def trash() -> str:
        resp = await client.delete(f"/wiki/nodes/{page['id']}", headers=s["owner"])
        assert resp.status_code == 200, resp.text
        return resp.json()["batch_id"]

    batch_id = await trash()
    assert [await _recheck(mail) for mail in mails] == ["no_access", "no_access"]
    resp = await client.post(f"/wiki/trash/{batch_id}/restore", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    assert [await _recheck(mail) for mail in mails] == [None, None]

    batch_id = await trash()
    resp = await client.delete(f"/wiki/trash/{batch_id}", headers=s["owner"])
    assert resp.status_code == 204, resp.text
    assert await db.scalar(select(WikiNode.id).where(WikiNode.id == uuid.UUID(page["id"]))) \
        is None
    assert [await _recheck(mail) for mail in mails] == ["no_access", "no_access"]


async def test_a_held_wiki_email_is_dropped_from_the_summary_when_its_reader_cant_see_it(
        client, db, email_on, clock):
    """An email held for the summary is asked the same when the summary is due: the reader who
    lost their level on the page is dropped from it `no_access`, and the reader the library
    still names gets their summary."""
    s = await _setup(client, db)
    keeper_h, keeper = await login_as(client, db)
    await _run(update(UserAccount)
               .where(UserAccount.person_id.in_([s["viewer_id"], keeper])).values(ui_prefs=QUIET))
    clock(EVENING)
    await _published_again(client, db, s, s["viewer"], keeper_h)
    held = {row.person_id: row for row in await _held()}
    assert set(held) == {s["viewer_id"], keeper}

    await _put_grants(client, s["owner"], s["space"], _named_only(s, keeper))
    clock(MORNING)
    assert await run_summaries_once(get_sessionmaker(), now=MORNING) == 1      # the keeper's
    assert await _held() == []
    async with get_sessionmaker()() as session:
        dropped = list(await session.scalars(select(NotificationLog).where(
            NotificationLog.event == "email_skipped")))
        summaries = list(await session.scalars(select(EmailOutbox).where(
            EmailOutbox.template == "notification_summary")))
    assert [(row.person_id, row.notification_id, row.kind, row.reason) for row in dropped] == [
        (s["viewer_id"], held[s["viewer_id"]].notification_id, "wiki_update", "no_access")]
    assert [summary.person_id for summary in summaries] == [keeper]


async def test_a_wiki_export_email_is_never_rechecked_for_access(client, db, email_on):
    """An export's notice is about no page (its payload names the job, not a node), so the
    re-check asks nothing of the wiki for it: its email goes even to someone who can't read the
    wiki at all any more."""
    _, person = await login_as(client, db)
    assert await notify.to_person(db, person, kind="wiki_export_ready",
                                  title="Your export is ready", path="/exports/abc",
                                  event="export_ready", payload={"job_id": "abc"})
    await db.commit()
    mail = await _mail_of(person)
    assert mail.kind == "wiki_export_ready"

    db.add(PermissionOverride(person_id=person, resource="wiki", action="view", allow=False))
    await db.commit()
    assert await _recheck(mail) is None


class _NoDatabase:
    """A session the code must not use: any query through it fails the test."""

    def __getattr__(self, name):
        raise AssertionError(f"the database was asked ({name})")


@pytest.mark.parametrize(("kind", "payload"), [
    pytest.param("wiki_update", {"space_key": "alpha", "event": "published"}, id="no node_id"),
    pytest.param("wiki_update", {"node_id": "junk"}, id="junk"),
    pytest.param("wiki_update", {"node_id": ""}, id="empty"),
    pytest.param("wiki_update", {"node_id": None}, id="None"),
    pytest.param("wiki_update", {"node_id": 42}, id="an int"),
    pytest.param("not_a_kind", {"node_id": str(uuid.uuid4())}, id="an unlisted kind"),
    pytest.param("initiative_status_changed", {"node_id": str(uuid.uuid4())},
                 id="a kind outside the wiki"),
])
async def test_the_wiki_check_asks_nothing_of_a_notice_that_names_no_node(kind, payload):
    """A notice whose payload names no node, or something that isn't a node's id, or whose
    kind isn't one of the wiki's, has nothing for the wiki to judge: None, and the database
    is never asked."""
    notification = Notification(person_id=uuid.uuid4(), kind=kind, title="Title",
                                payload=payload)
    assert await notify.access_recheck(_NoDatabase(), notification) is None


async def test_the_wiki_check_comes_where_no_access_does(client, db, email_on):
    """The first reason that applies decides, and the wiki's check is no access: an inactive
    person comes before it, the Email switch after it."""
    s = await _setup(client, db)
    await _published_again(client, db, s, s["viewer"])
    mail = await _mail_of(s["viewer_id"])
    await _put_grants(client, s["owner"], s["space"], _named_only(s))
    await _run(update(UserAccount).where(UserAccount.person_id == s["viewer_id"])
               .values(ui_prefs={"notif": {"switches": {"wiki": {"email": False}}}}))
    await _run(update(Person).where(Person.id == s["viewer_id"])
               .values(archived_at=datetime.now(UTC)))

    assert await _recheck(mail) == "recipient_inactive"
    await _run(update(Person).where(Person.id == s["viewer_id"]).values(archived_at=None))
    assert await _recheck(mail) == "no_access"
    await _put_grants(client, s["owner"], s["space"], [
        *_named_only(s), {"principal_type": "internal", "level": "view"}])
    assert await _recheck(mail) == "category_turned_down"
    await _run(update(UserAccount).where(UserAccount.person_id == s["viewer_id"])
               .values(ui_prefs={}))
    assert await _recheck(mail) is None
