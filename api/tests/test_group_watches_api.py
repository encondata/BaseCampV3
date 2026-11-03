"""A group's watches: GET and POST /notifications/groups/{id}/watches, and PATCH and DELETE
/notifications/groups/{id}/watches/{watch_id}. An admin points a notification group at an
initiative, a site, a truck or a device (tests/test_device_watches.py covers what is special about
devices), a wiki library, folder or page (tests/test_wiki_watch_groups.py), or at chosen events
everywhere, and every member of an Active group hears what the group watches. `notifications:view` lists a group's watches, `notifications:change` adds,
changes and removes them, and each of those is audited on the group.

The rules of a watch (what can be watched, which events fit, who can open the thing) are the
watches module's and are tested in test_watches_api.py; these tests cover the routes.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 3 and 10)"""

import uuid

from sqlalchemy import select

from serversherpa.db.models import AuditLog, NotificationWatch, PermissionOverride
from serversherpa.notifications.watches import EVERYTHING
from tests.test_status_values_write import _make
from tests.test_watches_api import (
    INITIATIVE_CHANGED,
    TRUCK_CHANGED,
    WATCHES,
    _code,
    _count,
    _group,
    _group_watch,
    _list,
    _login,
    _things,
)


def _url(group_id) -> str:
    return f"/notifications/groups/{group_id}/watches"


async def _post(client, who, group_id, thing, thing_id=None, kinds=()):
    body = {"thing": thing, "id": str(thing_id) if thing_id is not None else None,
            "kinds": list(kinds)}
    return await client.post(_url(group_id), headers=who.headers, json=body)


async def _patch(client, who, group_id, watch_id, kinds):
    return await client.patch(f"{_url(group_id)}/{watch_id}", headers=who.headers,
                              json={"kinds": list(kinds)})


async def _delete(client, who, group_id, watch_id):
    return await client.delete(f"{_url(group_id)}/{watch_id}", headers=who.headers)


async def _every_route(client, who, group_id, watch_id, site_id):
    """The four routes in turn: list, add a site watch, choose events, remove."""
    return [
        await client.get(_url(group_id), headers=who.headers),
        await _post(client, who, group_id, "site", site_id),
        await _patch(client, who, group_id, watch_id, []),
        await _delete(client, who, group_id, watch_id),
    ]


async def _audits(db, group, action=None):
    """The audit rows written on the group (all of them, or those of one action), oldest
    first."""
    query = select(AuditLog).where(AuditLog.entity_type == "notification_group",
                                   AuditLog.entity_id == str(group.id))
    if action is not None:
        query = query.where(AuditLog.action == action)
    return (await db.scalars(query.order_by(AuditLog.at))).all()


async def _any_audit(db) -> bool:
    """Whether any group event was audited at all. The groups here are made directly, so
    only the routes under test can write one."""
    return await db.scalar(select(AuditLog.id).where(
        AuditLog.entity_type == "notification_group").limit(1)) is not None


async def _kinds(db, watch_id):
    """The watch's stored kinds, or None once it is gone. Read as a column, so it is never a
    stale copy of a row this session loaded earlier."""
    return await db.scalar(select(NotificationWatch.kinds).where(NotificationWatch.id == watch_id))


async def _watch_id(db, group):
    """The id of the group's only watch."""
    return await db.scalar(select(NotificationWatch.id).where(
        NotificationWatch.group_id == group.id))


# ── adding, listing, changing and removing ──────────────────────────

async def test_admin_adds_and_removes_a_group_watch(client, db):
    admin = await _login(db, client, "A", "admin")
    _initiative, site, _truck = await _things(db)
    group = await _group(db, "Group A")

    # add: every event that applies
    resp = await _post(client, admin, group.id, "site", site.id)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["thing"], body["thing_id"], body["thing_name"]) == ("site", str(site.id), "Site A")
    assert body["link"] == f"/sites/{site.id}"
    assert body["kinds"] == []
    assert body["via"] == {"type": "group", "id": str(group.id), "name": "Group A"}
    watch_id = uuid.UUID(body["id"])
    row = await db.get(NotificationWatch, watch_id)
    assert (row.group_id, row.person_id, row.site_id, row.created_by) == (
        group.id, None, site.id, admin.id)
    (added,) = await _audits(db, group)
    assert (added.action, added.actor_person_id, added.entity_id) == (
        "watch.add", admin.id, str(group.id))
    assert added.changes == {"thing": "site", "thing_id": str(site.id), "kinds": []}

    # list
    resp = await client.get(_url(group.id), headers=admin.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == [body]

    # choose events
    resp = await _patch(client, admin, group.id, watch_id, [TRUCK_CHANGED])
    assert resp.status_code == 200, resp.text
    assert resp.json() == {**body, "kinds": [TRUCK_CHANGED]}
    assert await _kinds(db, watch_id) == [TRUCK_CHANGED]
    (updated,) = await _audits(db, group, "watch.update")
    assert (updated.actor_person_id, updated.entity_id) == (admin.id, str(group.id))
    # the row names the watch it changed, as the add and remove rows do
    assert updated.changes == {"thing": "site", "thing_id": str(site.id),
                               "kinds": {"from": [], "to": [TRUCK_CHANGED]}}
    assert [row["kinds"] for row in (await client.get(
        _url(group.id), headers=admin.headers)).json()] == [[TRUCK_CHANGED]]

    # remove
    resp = await _delete(client, admin, group.id, watch_id)
    assert resp.status_code == 204
    assert resp.content == b""
    assert await _kinds(db, watch_id) is None
    assert (await client.get(_url(group.id), headers=admin.headers)).json() == []
    (removed,) = await _audits(db, group, "watch.remove")
    assert (removed.actor_person_id, removed.entity_id) == (admin.id, str(group.id))
    assert removed.changes == {"thing": "site", "thing_id": str(site.id)}
    assert [a.action for a in await _audits(db, group)] == [
        "watch.add", "watch.update", "watch.remove"]


async def test_an_everything_watch(client, db):
    admin = await _login(db, client, "A", "admin")
    group = await _group(db, "Group A")

    resp = await _post(client, admin, group.id, EVERYTHING, kinds=[INITIATIVE_CHANGED])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["thing"], body["thing_id"], body["thing_name"], body["link"]) == (
        EVERYTHING, None, None, None)
    assert body["kinds"] == [INITIATIVE_CHANGED]
    assert body["via"] == {"type": "group", "id": str(group.id), "name": "Group A"}
    # it has no thing to name, so each of its audit rows says "everything" with no id
    (added,) = await _audits(db, group, "watch.add")
    assert added.changes == {"thing": EVERYTHING, "thing_id": None, "kinds": [INITIATIVE_CHANGED]}

    resp = await _patch(client, admin, group.id, body["id"], [TRUCK_CHANGED, INITIATIVE_CHANGED])
    assert (resp.status_code, resp.json()["kinds"]) == (200, [INITIATIVE_CHANGED, TRUCK_CHANGED])
    (updated,) = await _audits(db, group, "watch.update")
    assert updated.changes == {"thing": EVERYTHING, "thing_id": None,
                               "kinds": {"from": [INITIATIVE_CHANGED],
                                         "to": [INITIATIVE_CHANGED, TRUCK_CHANGED]}}

    assert (await _delete(client, admin, group.id, body["id"])).status_code == 204
    (removed,) = await _audits(db, group, "watch.remove")
    assert removed.changes == {"thing": EVERYTHING, "thing_id": None}
    assert await _count(db) == 0


async def test_choosing_the_same_events_again_writes_no_audit(client, db):
    admin = await _login(db, client, "A", "admin")
    _initiative, site, _truck = await _things(db)
    group = await _group(db, "Group A")
    watch = (await _post(client, admin, group.id, "site", site.id, kinds=[TRUCK_CHANGED])).json()

    # the same events, even repeated, change nothing
    resp = await _patch(client, admin, group.id, watch["id"], [TRUCK_CHANGED, TRUCK_CHANGED])
    assert (resp.status_code, resp.json()) == (200, watch)
    assert await _audits(db, group, "watch.update") == []

    resp = await _patch(client, admin, group.id, watch["id"], [])
    assert (resp.status_code, resp.json()["kinds"]) == (200, [])
    (updated,) = await _audits(db, group, "watch.update")
    assert updated.changes == {"thing": "site", "thing_id": str(site.id),
                               "kinds": {"from": [TRUCK_CHANGED], "to": []}}


async def test_a_paused_group_can_still_be_edited(client, db):
    admin = await _login(db, client, "A", "admin")
    _initiative, site, truck = await _things(db)
    group = await _group(db, "Group A", enabled=False)         # Paused: delivers nothing

    resp = await _post(client, admin, group.id, "site", site.id)
    assert resp.status_code == 201, resp.text
    watch_id = resp.json()["id"]
    assert (await _post(client, admin, group.id, "truck", truck.id)).status_code == 201
    # the admin sees what the paused group watches, newest first
    assert [row["thing"] for row in (await client.get(
        _url(group.id), headers=admin.headers)).json()] == ["truck", "site"]
    assert (await _patch(client, admin, group.id, watch_id, [TRUCK_CHANGED])).status_code == 200
    assert (await _delete(client, admin, group.id, watch_id)).status_code == 204
    assert await _count(db) == 1


async def test_the_admin_has_to_be_able_to_open_the_thing(client, db):
    # the viewer is the admin who is adding, not the group's members
    admin = await _login(db, client, "A", "admin")
    member = await _login(db, client, "B")
    _initiative, site, truck = await _things(db)
    group = await _group(db, "Group A", member)
    db.add(PermissionOverride(person_id=admin.id, resource="sites", action="view", allow=False))
    await db.commit()

    resp = await _post(client, admin, group.id, "site", site.id)
    assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    assert "Site A" not in resp.text
    assert await _count(db) == 0
    assert not await _any_audit(db)
    # a truck is still theirs to add
    assert (await _post(client, admin, group.id, "truck", truck.id)).status_code == 201


async def test_the_list_shows_only_what_the_asker_can_open(client, db):
    """The group page lists what the person asking can open now, by each thing's own page, as
    /me does (a wiki library, folder or page by the wiki's own rule:
    tests/test_wiki_watch_groups.py): an admin denied sites gets neither the group's site watch
    nor its name, another admin gets it, and an Everything watch, which has no thing to open,
    is listed for both. Only the list narrows: the rows stay as they are."""
    admin = await _login(db, client, "A", "admin")
    blind = await _login(db, client, "B", "admin")
    db.add(PermissionOverride(person_id=blind.id, resource="sites", action="view", allow=False))
    await db.commit()
    _initiative, site, truck = await _things(db)
    group = await _group(db, "Group A")
    await _group_watch(db, group, "site", site.id)
    await _group_watch(db, group, "truck", truck.id)
    await _group_watch(db, group, None, kinds=[INITIATIVE_CHANGED])

    resp = await client.get(_url(group.id), headers=admin.headers)
    assert resp.status_code == 200, resp.text
    assert sorted(row["thing"] for row in resp.json()) == [EVERYTHING, "site", "truck"]
    resp = await client.get(_url(group.id), headers=blind.headers)
    assert resp.status_code == 200, resp.text
    assert sorted(row["thing"] for row in resp.json()) == [EVERYTHING, "truck"]
    assert "Site A" not in resp.text
    assert await _count(db) == 3


# ── who may ─────────────────────────────────────────────────────────

async def test_permissions(client, db):
    staff = await _login(db, client, "A")                  # no notifications permission at all
    viewer = await _login(db, client, "B")
    db.add(PermissionOverride(person_id=viewer.id, resource="notifications", action="view",
                              allow=True))
    await db.commit()
    _initiative, site, _truck = await _things(db)
    group = await _group(db, "Group A")
    await _group_watch(db, group, "site", site.id, [TRUCK_CHANGED])
    watch_id = await _watch_id(db, group)

    # staff is refused everywhere, before the group is even looked up
    for group_id in (group.id, uuid.uuid4()):
        responses = await _every_route(client, staff, group_id, watch_id, site.id)
        assert [(r.status_code, _code(r)) for r in responses] == [(403, "forbidden")] * 4

    # view without change: the list, and nothing else
    responses = await _every_route(client, viewer, group.id, watch_id, site.id)
    assert [r.status_code for r in responses] == [200, 403, 403, 403]
    assert [_code(r) for r in responses[1:]] == ["forbidden"] * 3
    assert [row["id"] for row in responses[0].json()] == [str(watch_id)]
    # no change was made
    assert await _count(db) == 1
    assert await _kinds(db, watch_id) == [TRUCK_CHANGED]
    assert not await _any_audit(db)


async def test_errors(client, db):
    admin = await _login(db, client, "A", "admin")
    _initiative, site, truck = await _things(db)
    group, other = await _group(db, "Group A"), await _group(db, "Group B")
    ghost = uuid.uuid4()
    await _group_watch(db, other, "site", site.id)
    theirs = await _watch_id(db, other)
    # a person's own watch (the admin's)
    resp = await client.post(WATCHES, headers=admin.headers,
                             json={"thing": "truck", "id": str(truck.id), "kinds": []})
    assert resp.status_code == 201, resp.text
    personal = resp.json()["id"]

    # a group that is not there: to list, add, change or remove
    responses = await _every_route(client, admin, ghost, theirs, site.id)
    assert [(r.status_code, _code(r)) for r in responses] == [(404, "group_not_found")] * 4

    # a watch that is not this group's: another group's, a person's, or none at all
    for watch_id in (theirs, personal, ghost):
        resp = await _patch(client, admin, group.id, watch_id, [TRUCK_CHANGED])
        assert (resp.status_code, _code(resp)) == (404, "watch_not_found"), watch_id
        resp = await _delete(client, admin, group.id, watch_id)
        assert (resp.status_code, _code(resp)) == (404, "watch_not_found"), watch_id
    # both are untouched, and the group's own watch is the one its routes reach
    assert await _count(db) == 2
    assert await _kinds(db, theirs) == []
    assert await _kinds(db, uuid.UUID(personal)) == []
    assert (await _patch(client, admin, other.id, theirs, [TRUCK_CHANGED])).status_code == 200

    # a second watch on the same thing is an edit, not another row; another group may watch it
    assert (await _post(client, admin, group.id, "site", site.id)).status_code == 201
    resp = await _post(client, admin, group.id, "site", site.id, kinds=[TRUCK_CHANGED])
    assert (resp.status_code, _code(resp)) == (409, "already_watching")
    assert await _count(db) == 3

    # Everything has to name its events, and one watch of it each
    resp = await _post(client, admin, group.id, EVERYTHING)
    assert (resp.status_code, _code(resp)) == (422, "kinds_required")
    everything = await _post(client, admin, group.id, EVERYTHING, kinds=[INITIATIVE_CHANGED])
    assert everything.status_code == 201, everything.text
    resp = await _post(client, admin, group.id, EVERYTHING, kinds=[TRUCK_CHANGED])
    assert (resp.status_code, _code(resp)) == (409, "already_watching")
    resp = await _patch(client, admin, group.id, everything.json()["id"], [])
    assert (resp.status_code, _code(resp)) == (422, "kinds_required")

    # the watches module's other answers come through as they do for a person's own watch
    refused = [
        ({"thing": "bogus", "id": str(ghost)}, 422, "invalid_thing"),
        ({"thing": "wiki", "id": str(ghost)}, 422, "invalid_thing"),
        ({"thing": "truck"}, 422, "invalid_thing"),
        ({"thing": "device"}, 422, "invalid_thing"),
        ({"thing": "wiki_node"}, 422, "invalid_thing"),
        ({"thing": EVERYTHING, "id": str(site.id), "kinds": [INITIATIVE_CHANGED]},
         422, "invalid_thing"),
        ({"thing": "truck", "id": str(ghost)}, 404, "thing_not_found"),
        ({"thing": "device", "id": str(ghost)}, 404, "thing_not_found"),
        ({"thing": "wiki_space", "id": str(ghost)}, 404, "thing_not_found"),
        ({"thing": "wiki_node", "id": str(ghost)}, 404, "thing_not_found"),
        ({"thing": "truck", "id": str(truck.id), "kinds": [INITIATIVE_CHANGED]},
         422, "invalid_kind"),
        ({"thing": EVERYTHING, "kinds": ["report_ready"]}, 422, "invalid_kind"),
    ]
    for body, status, code in refused:
        resp = await client.post(_url(group.id), headers=admin.headers, json=body)
        assert (resp.status_code, _code(resp)) == (status, code), body
    truck_watch = (await _post(client, admin, group.id, "truck", truck.id)).json()["id"]
    resp = await _patch(client, admin, group.id, truck_watch, [INITIATIVE_CHANGED])
    assert (resp.status_code, _code(resp)) == (422, "invalid_kind")
    # a body names a watch's fields and nothing more: not another group, not a person
    for extra in ({"group_id": str(other.id)}, {"person_id": str(admin.id)}):
        resp = await client.post(_url(group.id), headers=admin.headers, json={
            "thing": "site", "id": str(site.id), "kinds": [], **extra})
        assert resp.status_code == 422, extra
    resp = await client.patch(f"{_url(group.id)}/{truck_watch}", headers=admin.headers,
                              json={"kinds": [], "thing": "site"})
    assert resp.status_code == 422

    # a refusal changes nothing and writes no audit row (the three additions above did)
    assert await _count(db) == 5
    assert [a.action for a in await _audits(db, group)] == ["watch.add"] * 3
    assert [a.action for a in await _audits(db, other)] == ["watch.update"]


async def test_read_only_mode_blocks_writes(client, db):
    super_admin = await _make(db, client, "super_admin", "sa@test.example.com")
    admin = await _login(db, client, "A", "admin")
    _initiative, site, _truck = await _things(db)
    group = await _group(db, "Group A")
    await _group_watch(db, group, "site", site.id, [TRUCK_CHANGED])
    watch_id = await _watch_id(db, group)
    assert (await client.put("/system/admin", headers=super_admin,
                             json={"read_only": True})).status_code == 200

    responses = await _every_route(client, admin, group.id, watch_id, site.id)
    assert responses[0].status_code == 200                 # reading is not frozen
    assert [(r.status_code, _code(r)) for r in responses[1:]] == [(423, "read_only_mode")] * 3
    assert [row["kinds"] for row in responses[0].json()] == [[TRUCK_CHANGED]]
    assert await _count(db) == 1
    assert await _kinds(db, watch_id) == [TRUCK_CHANGED]
    assert not await _any_audit(db)


# ── a member's view of the group's watches ──────────────────────────

async def test_a_member_cannot_change_the_groups_watch_through_their_own_routes(client, db):
    member = await _login(db, client, "A")
    _initiative, site, _truck = await _things(db)
    group = await _group(db, "Group A", member)
    await _group_watch(db, group, "site", site.id, [TRUCK_CHANGED])
    watch_id = await _watch_id(db, group)

    # the member hears it, and sees it on /me as the group's
    (shown,) = await _list(client, member)
    assert (shown["id"], shown["via"]["type"], shown["via"]["name"]) == (
        str(watch_id), "group", "Group A")

    # but it is not theirs to change or stop: /me answers as it does for anyone else's watch
    resp = await client.patch(f"{WATCHES}/{watch_id}", headers=member.headers,
                              json={"kinds": [INITIATIVE_CHANGED]})
    assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
    resp = await client.delete(f"{WATCHES}/{watch_id}", headers=member.headers)
    assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
    # the watch is as it was
    assert await _count(db) == 1
    assert await _kinds(db, watch_id) == [TRUCK_CHANGED]
    assert [row["kinds"] for row in await _list(client, member)] == [[TRUCK_CHANGED]]
