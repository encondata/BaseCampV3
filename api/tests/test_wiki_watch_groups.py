"""Groups and /me see wiki watches (notifications Phase 2, slice 5). A notification group
watches a wiki library, folder or page from the group page (`thing` "wiki_space" or
"wiki_node", naming no events: a wiki watch hears every page update and comment), and the
wiki's own fan-out (wiki/notify.py, still in the request) reaches the members of its Active
groups beside the people watching, through the wiki's own access rule, logging each person's
routes as the event sweep does. /me lists the wiki watches a person can see now, their own and
their groups', each linking to the wiki.

The wiki's own Watch button, Watching page and state endpoint still show only the person's own
watches (tests/test_wiki_watches_api.py), and who can see a library, folder or page is pinned
against the wiki's pages in tests/test_notification_access.py.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 2, 3 and 7)"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog,
    Client,
    Initiative,
    Notification,
    NotificationGroup,
    NotificationGroupMember,
    NotificationLog,
    NotificationWatch,
    Person,
    WikiComment,
    WikiNode,
    WikiPageVersion,
    WikiReview,
)
from serversherpa.notifications.kinds import KINDS
from serversherpa.notifications.watches import watches_hearing
from serversherpa.wiki import notify
from tests.wiki_helpers import _create, _setup, login_as, publish_via_api, publish_via_db

WATCHES = "/auth/me/watches"


# ── helpers ─────────────────────────────────────────────────────────


def _wiki(path: str) -> str:
    """The absolute wiki URL of `path`."""
    return f"{get_settings().wiki_origin.rstrip('/')}{path}"


def _code(resp):
    """The error's `code`; the raw detail for an answer that has none."""
    detail = resp.json().get("detail")
    return detail.get("code") if isinstance(detail, dict) else detail


def _grant(person_id, level) -> dict:
    return {"principal_type": "person", "principal_id": str(person_id), "level": level}


async def _node(db, node_id) -> WikiNode:
    db.expire_all()
    return await db.get(WikiNode, uuid.UUID(str(node_id)))


async def _name(db, person_id) -> str:
    return (await db.get(Person, person_id)).display_name


async def _outsider(client, db):
    """A client's user, who can't see an internal library at all: (headers, person id)."""
    acme = Client(name=f"Acme {uuid.uuid4().hex[:6]}")
    db.add(acme)
    await db.flush()
    return await login_as(client, db, roles=("client_viewer",), client_id=acme.id)


async def _group(db, name, *member_ids, enabled=True) -> NotificationGroup:
    group = NotificationGroup(name=name, enabled=enabled)
    db.add(group)
    await db.flush()
    db.add_all(NotificationGroupMember(group_id=group.id, person_id=person_id)
               for person_id in member_ids)
    await db.commit()
    return group


async def _group_watch(db, group, *, node=None, space=None, created_at=None) -> uuid.UUID:
    """The group's watch on a library (`space`) or a folder or page (`node`), as the group
    page stores one: no events named. Committed; returns its id."""
    fields = ({"wiki_node_id": uuid.UUID(node["id"])} if node is not None
              else {"wiki_space_id": uuid.UUID(space["id"])})
    if created_at is not None:
        fields["created_at"] = created_at
    watch = NotificationWatch(group_id=group.id, **fields)
    db.add(watch)
    await db.flush()
    watch_id = watch.id
    await db.commit()
    return watch_id


async def _watch(client, headers, *, node=None, space=None) -> dict:
    """A watch of the person's own, through the wiki's Watch button (PUT /wiki/watches)."""
    body = {"node_id": node["id"]} if node is not None else {"space_id": space["id"]}
    resp = await client.put("/wiki/watches", headers=headers, json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _only(client, headers, node, grants) -> None:
    """The node stops inheriting the library's grants and keeps only `grants`."""
    resp = await client.put(f"/wiki/nodes/{node['id']}/permissions", headers=headers,
                            json={"inherit": False, "grants": grants})
    assert resp.status_code == 200, resp.text


async def _make_private(client, headers, node) -> None:
    """Only the node's author (who must be the one asking) and developers see it now."""
    resp = await client.patch(f"/wiki/nodes/{node['id']}/privacy", headers=headers,
                              json={"is_private": True})
    assert resp.status_code == 200, resp.text


async def _trash(client, headers, node) -> None:
    resp = await client.delete(f"/wiki/nodes/{node['id']}", headers=headers)
    assert resp.status_code == 200, resp.text


async def _set_draft(client, headers, page_id, text) -> None:
    """A new draft for the page, so that it has something to publish again."""
    resp = await client.put(f"/wiki/nodes/{page_id}/draft", headers=headers, json={
        "content_json": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}]}})
    assert resp.status_code == 204, resp.text


async def _inbox(db, person_id) -> list[Notification]:
    return (await db.scalars(select(Notification).where(Notification.person_id == person_id)
                             .order_by(Notification.created_at))).all()


async def _routes(db, person_id) -> list[dict]:
    """What the Delivery log recorded with each inbox row written for the person, oldest
    first: the routes that reached them (`via`) and the names of the groups among them."""
    return [row.detail for row in await db.scalars(
        select(NotificationLog).where(NotificationLog.person_id == person_id,
                                      NotificationLog.event == "inbox_written")
        .order_by(NotificationLog.id))]


async def _list(client, headers) -> list[dict]:
    resp = await client.get(WATCHES, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _shown(rows) -> list[tuple]:
    """Each /me row as the table shows it: what it is on, its name and kind, its link, its
    events and whose it is."""
    return [(row["thing"], row["thing_id"], row["thing_name"], row["thing_label"], row["link"],
             row["kinds"], row["via"]) for row in rows]


async def _audits(db, entity_type, entity_id, action) -> list[AuditLog]:
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == entity_type, AuditLog.entity_id == str(entity_id),
        AuditLog.action == action).order_by(AuditLog.at))).all()


YOU = {"type": "you", "id": None, "name": None}


# ── the fan-out ─────────────────────────────────────────────────────


async def test_group_wiki_watch_fan_out(client, db):
    """An Active group watching a folder: its members hear a page published under it, by the
    page's own access (a member who reads the folder but not the page hears nothing, nor does
    one who can't see the library), never the actor, and someone reached by a watch of their
    own and the group's is told once. A Paused group's members hear nothing until it is
    resumed. Each notice logs the routes that reached its person, with the groups' names,
    exactly as the event sweep's do; the notice itself is the wiki's as before."""
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page", parent=folder)
    _, member = await login_as(client, db)          # staff: reads the library through `internal`
    _, blind = await login_as(client, db)           # reads the folder, not the page (below)
    _, outsider = await _outsider(client, db)
    _, resting = await login_as(client, db)         # in the Paused group only
    # the page keeps readers of its own: `blind` reads the folder but not the page
    await _only(client, s["owner"], page, [
        _grant(s["owner_id"], "manage"), _grant(s["editor_id"], "edit"),
        *(_grant(person_id, "view") for person_id in (s["viewer_id"], member, resting))])
    group = await _group(db, "Group A", member, blind, outsider, s["viewer_id"], s["editor_id"])
    paused = await _group(db, "Group B", resting, enabled=False)
    await _group_watch(db, group, node=folder)
    await _group_watch(db, paused, node=folder)
    await _watch(client, s["viewer"], node=folder)  # the viewer watches the folder themself too

    await publish_via_api(client, s["editor"], page["id"], note="First pass")

    title = f"{await _name(db, s['editor_id'])} published Runbook"
    for person_id in (s["owner_id"], s["viewer_id"], member):
        got = await _inbox(db, person_id)
        assert [(n.kind, n.title, n.body, n.link) for n in got] == [
            ("wiki_update", title, "First pass", _wiki(f"/n/{page['id']}"))], person_id
        assert got[0].payload == {"node_id": page["id"], "space_key": s["space"]["key"],
                                  "event": "published"}
    # can't see the page, can't see the library, the actor, a Paused group's member
    for person_id in (blind, outsider, s["editor_id"], resting):
        assert await _inbox(db, person_id) == [], person_id

    route = f"group:{group.id}"
    assert await _routes(db, member) == [{"via": [route], "names": {route: "Group A"}}]
    # sorted by code, as the event sweep logs a person's routes
    assert await _routes(db, s["viewer_id"]) == [
        {"via": [route, "watch"], "names": {route: "Group A"}}]
    # the owner watches the folder and the page they created, and is in no group
    assert await _routes(db, s["owner_id"]) == [{"via": ["watch"], "names": {}}]

    # resumed, the Paused group's watch reaches its member again
    paused.enabled = True
    await db.commit()
    await _set_draft(client, s["editor"], page["id"], "v2")
    await publish_via_api(client, s["editor"], page["id"])
    assert [n.title for n in await _inbox(db, resting)] == [title]
    resumed = f"group:{paused.id}"
    assert await _routes(db, resting) == [{"via": [resumed], "names": {resumed: "Group B"}}]
    for person_id in (blind, outsider, s["editor_id"]):
        assert await _inbox(db, person_id) == [], person_id


async def test_group_members_hear_new_items_comments_and_review_decisions(client, db):
    """Every wiki event its watchers hear reaches an Active group's members too, logged as
    reaching them through the group: something added under what the group watches, a comment,
    a review's decision (a reader hears of an approval without its note, as a reader watching
    the page themself does). A page waits for its first publish before readers hear of it."""
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    _, member = await login_as(client, db)          # a reader, through `internal`
    group = await _group(db, "Group A", member)
    route = f"group:{group.id}"
    await _group_watch(db, group, space=s["space"])
    editor = await _name(db, s["editor_id"])

    network = await _create(client, s["editor"], s["space"], "Network", parent=folder)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page", parent=folder)
    assert [(n.kind, n.title, n.link) for n in await _inbox(db, member)] == [
        ("wiki_update", f"{editor} added Network to Guides", _wiki(f"/n/{network['id']}"))]

    version_id = (await publish_via_db(db, page["id"])).id
    node = await _node(db, page["id"])
    thread_id = uuid.uuid4()
    comment = WikiComment(id=thread_id, node_id=node.id, thread_id=thread_id,
                          body={"text": "Step 3 changed", "mentions": []},
                          author_id=s["editor_id"])
    db.add(comment)
    await db.flush()
    await notify.on_comment(db, node, comment, actor_id=s["editor_id"])
    review = WikiReview(node_id=node.id, version_id=version_id, status="approved",
                        requested_by=s["editor_id"], decided_by=s["owner_id"],
                        decision_note="Fine by me")
    db.add(review)
    await db.flush()
    await notify.on_review_decided(db, node, review, actor_id=s["owner_id"])
    await db.commit()

    got = await _inbox(db, member)
    assert [(n.kind, n.title, n.body) for n in got[1:]] == [
        ("wiki_comment", f"{editor} commented on Runbook", "Step 3 changed"),
        ("wiki_update", f"{await _name(db, s['owner_id'])} approved Runbook", "")]
    assert await _routes(db, member) == [{"via": [route], "names": {route: "Group A"}}] * 3


async def test_watchers_come_in_a_fixed_order_and_the_cap_keeps_the_first(
        client, db, monkeypatch, caplog):
    """`watchers_for` gives each person once, with every route that reaches them: people with
    a watch of their own first, oldest watch first, then the members of the Active groups whose
    watch matches, longest-standing first. A Paused group's members, and those of a group that
    watches none of it, are not among them. The cap keeps the first MAX_RECIPIENTS of them all,
    group members included."""
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page", parent=folder)
    version_id = (await publish_via_db(db, page["id"])).id
    first, second, early, late, resting = [(await login_as(client, db))[1] for _ in range(5)]
    group = NotificationGroup(name="Group A")
    paused = NotificationGroup(name="Group B", enabled=False)
    elsewhere = NotificationGroup(name="Group C")
    db.add_all([group, paused, elsewhere])
    await db.flush()
    route = f"group:{group.id}"
    start = datetime(2026, 1, 1, tzinfo=UTC)
    day = timedelta(days=1)
    page_id, folder_id = uuid.UUID(page["id"]), uuid.UUID(folder["id"])
    db.add_all([
        NotificationWatch(person_id=second, wiki_node_id=folder_id, created_at=start),
        NotificationWatch(person_id=first, wiki_space_id=uuid.UUID(s["space"]["id"]),
                          created_at=start - day),
        NotificationWatch(group_id=group.id, wiki_node_id=page_id, created_at=start),
        NotificationWatch(group_id=paused.id, wiki_node_id=page_id, created_at=start),
        NotificationGroupMember(group_id=group.id, person_id=late, added_at=start + day),
        NotificationGroupMember(group_id=group.id, person_id=early, added_at=start - day),
        NotificationGroupMember(group_id=group.id, person_id=second, added_at=start),
        NotificationGroupMember(group_id=paused.id, person_id=resting),
        NotificationGroupMember(group_id=elsewhere.id, person_id=resting),
    ])
    await db.commit()
    node = await _node(db, page["id"])
    version = await db.get(WikiPageVersion, version_id)

    got = await notify.watchers_for(db, node)
    # the owner's own watches (they created the folder and the page) are newer than the others
    assert list(got) == [first, second, s["owner_id"], early, late]
    assert got == {first: {"watch"}, second: {"watch", route}, s["owner_id"]: {"watch"},
                   early: {route}, late: {route}}

    monkeypatch.setattr(notify, "MAX_RECIPIENTS", 3)
    with caplog.at_level(logging.WARNING, logger="serversherpa.wiki.notify"):
        await notify.on_published(db, node, actor_id=None, version=version)
    assert "capped" in caplog.text
    told = [person_id for person_id in (first, second, s["owner_id"], early, late, resting)
            if await _inbox(db, person_id)]
    assert told == [first, second, s["owner_id"]]


# ── /me ─────────────────────────────────────────────────────────────


async def test_me_lists_only_visible_wiki_watches(client, db):
    """/me lists a wiki watch, the person's own or a group's, only while they can see its
    library, folder or page by the wiki's own rule: a group's watch on a private page shows to
    the members who can see it and to no other, nor does its title reach them; a page that was
    never published is not a reader's to see; the trash hides what is in it. A group's row says
    which group, and every row names its kind and links to the wiki."""
    s = await _setup(client, db)
    space = s["space"]
    folder = await _create(client, s["owner"], space, "Guides")
    page = await _create(client, s["owner"], space, "Runbook", kind="page", parent=folder)
    await publish_via_db(db, page["id"])
    draft = await _create(client, s["owner"], space, "Unannounced", kind="page", parent=folder)
    secret = await _create(client, s["editor"], space, "Secret plans", kind="page")
    await _make_private(client, s["editor"], secret)      # its author is the editor
    retired = await _create(client, s["owner"], space, "Retired", kind="page")
    await publish_via_db(db, retired["id"])
    await _trash(client, s["owner"], retired)
    outsider_h, outsider = await _outsider(client, db)
    group = await _group(db, "Group A", s["viewer_id"], s["editor_id"], outsider)
    paused = await _group(db, "Group B", s["viewer_id"], enabled=False)
    start = datetime(2026, 1, 1, tzinfo=UTC)
    for days, target in enumerate(({"space": space}, {"node": folder}, {"node": page},
                                   {"node": draft}, {"node": secret}, {"node": retired})):
        await _group_watch(db, group, created_at=start + timedelta(days=days), **target)
    await _group_watch(db, paused, node=folder)
    mine = await _watch(client, s["viewer"], node=page)

    def page_row(node, via, label="Wiki page"):
        return ("wiki_node", node["id"], node["title"], label, _wiki(f"/n/{node['id']}"), [],
                via)

    group_a = {"type": "group", "id": str(group.id), "name": "Group A"}
    library_row = ("wiki_space", space["id"], space["name"], "Wiki library",
                   _wiki(f"/library/{space['key']}"), [], group_a)
    folder_row = page_row(folder, group_a, "Wiki folder")

    # a reader: their own watch, then the group's that they can see, newest first
    resp = await client.get(WATCHES, headers=s["viewer"])
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert _shown(rows) == [page_row(page, YOU), page_row(page, group_a), folder_row,
                            library_row]
    assert rows[0]["id"] == mine["id"]
    for hidden in ("Unannounced", "Secret plans", "Retired", "Group B"):
        assert hidden not in resp.text, hidden

    # the private page's author sees it, and the never-published page they can edit; their
    # own watch is the one they made creating it
    assert _shown(await _list(client, s["editor"])) == [
        page_row(secret, YOU), page_row(secret, group_a), page_row(draft, group_a),
        page_row(page, group_a), folder_row, library_row]

    # someone who can't see the library sees none of it
    resp = await client.get(WATCHES, headers=outsider_h)
    assert resp.status_code == 200, resp.text
    assert resp.json() == []
    assert "Guides" not in resp.text and "Runbook" not in resp.text


async def test_my_wiki_watches_change_and_go_from_me_as_from_the_wiki(client, db):
    """A wiki watch of one's own names no events on /me either: choosing none is accepted and
    stores none, choosing any is 422 `invalid_kind`. Stopping one from /me is recorded as the
    wiki records its own (`wiki_watch` `unwatch`), so the wiki's history stays whole whichever
    page removed it, and so is watching a wiki thing from /me (`watch`); watches on portal
    things come and go unaudited, as before."""
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    node_watch = await _watch(client, s["viewer"], node=folder)
    space_watch = await _watch(client, s["viewer"], space=s["space"])

    resp = await client.patch(f"{WATCHES}/{node_watch['id']}", headers=s["viewer"],
                              json={"kinds": []})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["id"], body["thing"], body["thing_label"], body["kinds"], body["via"]) == (
        node_watch["id"], "wiki_node", "Wiki folder", [], YOU)
    for kinds in (["wiki_update"], ["wiki_comment", "wiki_update"],
                  ["initiative_status_changed"], ["nonsense"]):
        resp = await client.patch(f"{WATCHES}/{space_watch['id']}", headers=s["viewer"],
                                  json={"kinds": kinds})
        assert (resp.status_code, _code(resp)) == (422, "invalid_kind"), kinds
    stored = (await db.scalars(select(NotificationWatch.kinds).where(
        NotificationWatch.person_id == s["viewer_id"]))).all()
    assert stored == [[], []]

    for watch, changes in ((node_watch, {"node_id": folder["id"], "space_id": None}),
                           (space_watch, {"node_id": None, "space_id": s["space"]["id"]})):
        resp = await client.delete(f"{WATCHES}/{watch['id']}", headers=s["viewer"])
        assert resp.status_code == 204, resp.text
        (row,) = await _audits(db, "wiki_watch", watch["id"], "unwatch")
        assert (row.actor_person_id, row.changes) == (s["viewer_id"], changes)
    resp = await client.get("/wiki/watches", headers=s["viewer"])
    assert resp.json() == []

    # watched again from /me: the wiki records it, and its own Watching page lists it
    resp = await client.post(WATCHES, headers=s["viewer"],
                             json={"thing": "wiki_node", "id": folder["id"], "kinds": []})
    assert resp.status_code == 201, resp.text
    again = resp.json()
    assert (again["thing_label"], again["link"]) == ("Wiki folder", _wiki(f"/n/{folder['id']}"))
    (row,) = await _audits(db, "wiki_watch", again["id"], "watch")
    assert (row.actor_person_id, row.changes) == (s["viewer_id"], {"node_id": folder["id"]})
    assert [w["id"] for w in (await client.get("/wiki/watches", headers=s["viewer"])).json()] \
        == [again["id"]]

    # a watch on a portal thing comes and goes unaudited, as it always has
    initiative = Initiative(name="Initiative A", initiative_type="move")
    db.add(initiative)
    await db.commit()
    resp = await client.post(WATCHES, headers=s["viewer"],
                             json={"thing": "initiative", "id": str(initiative.id), "kinds": []})
    assert resp.status_code == 201, resp.text
    portal_id = resp.json()["id"]
    assert resp.json()["thing_label"] == "Initiative"
    assert (await client.delete(f"{WATCHES}/{portal_id}", headers=s["viewer"])).status_code == 204
    assert await db.scalar(select(AuditLog.id).where(AuditLog.entity_id == portal_id)) is None


# ── the group page ──────────────────────────────────────────────────


async def test_group_watches_a_library_and_a_page(client, db):
    """An admin points a group at a library, a folder or a page they can see: 201, with the
    kind's label and the wiki link, audited on the group like any other group watch. A wiki
    watch names no events, so any kinds at all are 422 `invalid_kind`, adding and changing.
    What the admin can't see (someone else's private page, a page in the trash) is 404
    `thing_not_found` and names nothing."""
    admin_h, admin = await login_as(client, db, roles=("admin",))   # also a wiki administrator
    s = await _setup(client, db)
    space = s["space"]
    folder = await _create(client, s["owner"], space, "Guides")
    page = await _create(client, s["owner"], space, "Runbook", kind="page", parent=folder)
    await publish_via_db(db, page["id"])
    other = await _create(client, s["owner"], space, "Other", kind="page")
    secret = await _create(client, s["editor"], space, "Secret plans", kind="page")
    await _make_private(client, s["editor"], secret)
    retired = await _create(client, s["owner"], space, "Retired", kind="page")
    await _trash(client, s["owner"], retired)
    group = await _group(db, "Group A")
    url = f"/notifications/groups/{group.id}/watches"
    via = {"type": "group", "id": str(group.id), "name": "Group A"}

    resp = await client.post(url, headers=admin_h,
                             json={"thing": "wiki_space", "id": space["id"], "kinds": []})
    assert resp.status_code == 201, resp.text
    library = resp.json()
    assert _shown([library]) == [("wiki_space", space["id"], space["name"], "Wiki library",
                                  _wiki(f"/library/{space['key']}"), [], via)]
    added = {"library": library}
    for key, node, label in (("page", page, "Wiki page"), ("folder", folder, "Wiki folder")):
        resp = await client.post(url, headers=admin_h, json={"thing": "wiki_node", "id": node["id"]})
        assert resp.status_code == 201, resp.text
        added[key] = resp.json()
        assert _shown([added[key]]) == [("wiki_node", node["id"], node["title"], label,
                                         _wiki(f"/n/{node['id']}"), [], via)]
    audits = await _audits(db, "notification_group", group.id, "watch.add")
    assert [(a.actor_person_id, a.changes) for a in audits] == [
        (admin, {"thing": "wiki_space", "thing_id": space["id"], "kinds": []}),
        (admin, {"thing": "wiki_node", "thing_id": page["id"], "kinds": []}),
        (admin, {"thing": "wiki_node", "thing_id": folder["id"], "kinds": []})]
    resp = await client.get(url, headers=admin_h)
    assert resp.json() == [added["folder"], added["page"], added["library"]]

    # a wiki watch hears every page update and comment: it names no events
    for body in ({"thing": "wiki_node", "id": other["id"], "kinds": ["wiki_update"]},
                 {"thing": "wiki_node", "id": other["id"], "kinds": ["initiative_status_changed"]},
                 {"thing": "wiki_space", "id": space["id"], "kinds": ["wiki_comment"]}):
        resp = await client.post(url, headers=admin_h, json=body)
        assert (resp.status_code, _code(resp)) == (422, "invalid_kind"), body
    resp = await client.patch(f"{url}/{added['page']['id']}", headers=admin_h,
                              json={"kinds": ["wiki_update"]})
    assert (resp.status_code, _code(resp)) == (422, "invalid_kind")
    resp = await client.patch(f"{url}/{added['page']['id']}", headers=admin_h, json={"kinds": []})
    assert (resp.status_code, resp.json()) == (200, added["page"])
    assert await _audits(db, "notification_group", group.id, "watch.update") == []

    # what the admin can't see is not found, and its title doesn't come back
    for node in (secret, retired):
        resp = await client.post(url, headers=admin_h, json={"thing": "wiki_node", "id": node["id"]})
        assert (resp.status_code, _code(resp)) == (404, "thing_not_found"), node["title"]
        assert node["title"] not in resp.text
    for thing in ("wiki_space", "wiki_node"):
        resp = await client.post(url, headers=admin_h, json={"thing": thing, "id": str(uuid.uuid4())})
        assert (resp.status_code, _code(resp)) == (404, "thing_not_found"), thing
    # one watch per thing
    resp = await client.post(url, headers=admin_h, json={"thing": "wiki_node", "id": page["id"]})
    assert (resp.status_code, _code(resp)) == (409, "already_watching")

    resp = await client.delete(f"{url}/{added['page']['id']}", headers=admin_h)
    assert resp.status_code == 204, resp.text
    (removed,) = await _audits(db, "notification_group", group.id, "watch.remove")
    assert removed.changes == {"thing": "wiki_node", "thing_id": page["id"]}
    assert [row["id"] for row in (await client.get(url, headers=admin_h)).json()] == [
        added["folder"]["id"], added["library"]["id"]]


async def test_the_group_page_lists_only_the_wiki_watches_the_asker_can_see(client, db):
    """The group page lists a group's watch only while the person asking can open its thing,
    by the rule /me uses, which for the wiki is the wiki's own: a wiki administrator doesn't
    get the group's watch on someone else's private page, nor its title, and a developer does.
    Nobody gets one on a page in the trash, and it is listed again once the page is restored.
    The rows stay where they are throughout."""
    admin_h, _admin = await login_as(client, db, roles=("admin",))     # a wiki administrator
    developer_h, _developer = await login_as(client, db, roles=("developer",))
    s = await _setup(client, db)
    space = s["space"]
    secret = await _create(client, s["editor"], space, "Secret plans", kind="page")
    await _make_private(client, s["editor"], secret)       # its author is the editor
    retired = await _create(client, s["owner"], space, "Retired", kind="page")
    await publish_via_db(db, retired["id"])
    group = await _group(db, "Group A")
    start = datetime(2026, 1, 1, tzinfo=UTC)
    ids = {}
    for days, (name, target) in enumerate((("library", {"space": space}),
                                           ("secret", {"node": secret}),
                                           ("retired", {"node": retired}))):
        ids[name] = str(await _group_watch(db, group, created_at=start + timedelta(days=days),
                                           **target))
    url = f"/notifications/groups/{group.id}/watches"

    async def listed(headers):
        resp = await client.get(url, headers=headers)
        assert resp.status_code == 200, resp.text
        return resp, [row["id"] for row in resp.json()]

    resp, rows = await listed(admin_h)
    assert rows == [ids["retired"], ids["library"]]
    assert "Secret plans" not in resp.text
    _, rows = await listed(developer_h)
    assert rows == [ids["retired"], ids["secret"], ids["library"]]

    resp = await client.delete(f"/wiki/nodes/{retired['id']}", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    batch_id = resp.json()["batch_id"]
    for headers in (admin_h, developer_h):
        resp, rows = await listed(headers)
        assert ids["retired"] not in rows and "Retired" not in resp.text
    resp = await client.post(f"/wiki/trash/{batch_id}/restore", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    _, rows = await listed(admin_h)
    assert rows == [ids["retired"], ids["library"]]
    assert await db.scalar(select(func.count()).select_from(NotificationWatch).where(
        NotificationWatch.group_id == group.id)) == 3


# ── Check delivery ──────────────────────────────────────────────────


async def test_check_delivery_lists_no_wiki_watches(client, db):
    """Check delivery lists the watches that would hear a kind. No wiki kind is one a watch
    chooses (the wiki's own fan-out decides who hears it), so a wiki watch, the person's own or
    a group's, is never listed there, though /me lists both."""
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    await _watch(client, s["viewer"], node=folder)
    group = await _group(db, "Group A", s["viewer_id"])
    await _group_watch(db, group, space=s["space"])
    assert [row["thing"] for row in await _list(client, s["viewer"])] == [
        "wiki_node", "wiki_space"]

    wiki_kinds = [kind for kind, info in KINDS.items() if info.category == "wiki"]
    assert wiki_kinds
    for kind in wiki_kinds:
        assert await watches_hearing(db, s["viewer_id"], kind) == [], kind
