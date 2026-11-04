"""Your own watches: GET and POST /auth/me/watches, GET /auth/me/watches/state and
PATCH and DELETE /auth/me/watches/{id}. A watch is on an initiative, a site, a truck or a device
(tests/test_device_watches.py covers what is special about devices), a wiki library, folder or
page (tests/test_wiki_watch_groups.py), or on chosen events everywhere (an Everything watch).
/me lists the person's own watches and those of the Active groups they belong to, for the things
they can open right now. A person's own watches are audited on their account (`user_account`)
when started, changed and stopped, as a group's are on the group; a wiki watch writes the wiki's
own audit instead.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 1, 2 and 10)"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from serversherpa.access.resolver import resolve_access_many
from serversherpa.db.models import (
    AuditLog,
    Client,
    Initiative,
    NotificationGroup,
    NotificationGroupMember,
    NotificationWatch,
    PermissionOverride,
    Person,
    PersonRole,
    Site,
    Truck,
)
from serversherpa.notifications import watches
from serversherpa.notifications.watches import (
    EVERYTHING,
    THINGS,
    WatchError,
    add_watch,
    group_watches,
)
from tests.test_sites_api import make_login
from tests.test_status_values_write import _make
from tests.wiki_helpers import _create, _setup, publish_via_db

WATCHES = "/auth/me/watches"
STATE = f"{WATCHES}/state"
INITIATIVE_CHANGED = "initiative_status_changed"
TRUCK_CHANGED = "truck_status_changed"


@dataclass(frozen=True)
class Login:
    """A person who can sign in: their id and the auth header for requests."""

    id: uuid.UUID
    headers: dict


def _code(resp):
    """The error's `code`; the raw detail for an answer that has none."""
    detail = resp.json().get("detail")
    return detail.get("code") if isinstance(detail, dict) else detail


async def _login(db, client, name, role="staff", **role_fields) -> Login:
    """Person `name` holding `role` (anchored with `role_fields`), signed in. Committed."""
    person = Person(first_name="Person", last_name=name,
                    email=f"person-{name.lower()}@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role=role, **role_fields))
    await db.commit()
    return Login(person.id, await make_login(db, client, person, person.email))


async def _things(db):
    """Initiative A, Site A and Truck A, committed."""
    initiative = Initiative(name="Initiative A", initiative_type="move")
    site, truck = Site(name="Site A"), Truck(name="Truck A")
    db.add_all([initiative, site, truck])
    await db.commit()
    return initiative, site, truck


async def _post(client, who, thing, thing_id=None, kinds=()):
    body = {"thing": thing, "id": str(thing_id) if thing_id is not None else None,
            "kinds": list(kinds)}
    return await client.post(WATCHES, headers=who.headers, json=body)


async def _patch(client, who, watch_id, kinds):
    return await client.patch(f"{WATCHES}/{watch_id}", headers=who.headers,
                              json={"kinds": list(kinds)})


async def _list(client, who):
    resp = await client.get(WATCHES, headers=who.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _state(client, who, thing, thing_id):
    return await client.get(STATE, headers=who.headers,
                            params={"thing": thing, "id": str(thing_id)})


async def _group(db, name, *members, enabled=True) -> NotificationGroup:
    group = NotificationGroup(name=name, enabled=enabled)
    db.add(group)
    await db.flush()
    db.add_all(NotificationGroupMember(group_id=group.id, person_id=person.id)
               for person in members)
    await db.commit()
    return group


async def _group_watch(db, group, thing=None, thing_id=None, kinds=(), *, created_at=None):
    """A watch of `group` on a thing, or an Everything watch when `thing` is None."""
    fields = {} if created_at is None else {"created_at": created_at}
    if thing is not None:
        fields[THINGS[thing].column] = thing_id
    db.add(NotificationWatch(group_id=group.id, kinds=list(kinds), **fields))
    await db.commit()


async def _count(db) -> int:
    return await db.scalar(select(func.count()).select_from(NotificationWatch))


async def _own_audits(db, person_id, action=None):
    """The `watch.*` audit rows written on the person's account (all of them, or those of one
    action), oldest first."""
    query = select(AuditLog).where(AuditLog.entity_type == "user_account",
                                   AuditLog.entity_id == str(person_id),
                                   AuditLog.action.startswith("watch."))
    if action is not None:
        query = query.where(AuditLog.action == action)
    return (await db.scalars(query.order_by(AuditLog.at))).all()


# ── watching and not watching ───────────────────────────────────────

async def test_watch_and_unwatch_an_initiative(client, db):
    me = await _login(db, client, "A")
    initiative, _site, _truck = await _things(db)

    resp = await _post(client, me, "initiative", initiative.id)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["thing"], body["thing_id"]) == ("initiative", str(initiative.id))
    assert body["thing_name"] == "Initiative A"
    assert body["link"] == f"/initiatives/{initiative.id}"
    assert body["kinds"] == []                          # every event that applies
    assert body["via"]["type"] == "you"
    assert body["created_at"]
    row = await db.get(NotificationWatch, uuid.UUID(body["id"]))
    assert (row.person_id, row.group_id, row.initiative_id, row.created_by) == (
        me.id, None, initiative.id, me.id)

    state = await _state(client, me, "initiative", initiative.id)
    assert state.status_code == 200, state.text
    assert state.json() == {"watching": True, "watch_id": body["id"], "kinds": []}
    assert [row["id"] for row in await _list(client, me)] == [body["id"]]

    resp = await client.delete(f"{WATCHES}/{body['id']}", headers=me.headers)
    assert resp.status_code == 204
    state = await _state(client, me, "initiative", initiative.id)
    assert state.json() == {"watching": False, "watch_id": None, "kinds": []}
    assert await _list(client, me) == []
    assert await _count(db) == 0


@pytest.mark.parametrize(("thing", "name", "label", "link"), [
    ("initiative", "Initiative A", "Initiative", "/initiatives/{id}"),
    ("site", "Site A", "Site", "/sites/{id}"),
    ("truck", "Truck A", "Truck", "/logistics/trucks/{id}"),
])
async def test_each_thing_has_its_name_and_page(client, db, thing, name, label, link):
    me = await _login(db, client, "A")
    initiative, site, truck = await _things(db)
    row = {"initiative": initiative, "site": site, "truck": truck}[thing]

    resp = await _post(client, me, thing, row.id)
    assert resp.status_code == 201, resp.text
    assert (resp.json()["thing"], resp.json()["thing_name"]) == (thing, name)
    # what the portal calls its kind (a wiki thing's depends on the row: a folder or a page)
    assert resp.json()["thing_label"] == label
    assert resp.json()["link"] == link.format(id=row.id)


async def test_choose_events(client, db):
    me = await _login(db, client, "A")
    initiative, site, truck = await _things(db)
    ids = {}
    for thing, row in (("initiative", initiative), ("site", site), ("truck", truck)):
        ids[thing] = (await _post(client, me, thing, row.id)).json()["id"]

    # an initiative and a site hear truck changes too
    for thing in ("initiative", "site"):
        resp = await _patch(client, me, ids[thing], [TRUCK_CHANGED])
        assert resp.status_code == 200, resp.text
        assert resp.json()["kinds"] == [TRUCK_CHANGED]
        assert resp.json()["thing"] == thing
    # a truck hears truck changes only
    resp = await _patch(client, me, ids["truck"], [INITIATIVE_CHANGED])
    assert (resp.status_code, _code(resp)) == (422, "invalid_kind")
    assert (await _patch(client, me, ids["truck"], [TRUCK_CHANGED])).status_code == 200

    # chosen in the registry's order, without repeats
    resp = await _patch(client, me, ids["site"], [TRUCK_CHANGED, INITIATIVE_CHANGED, TRUCK_CHANGED])
    assert resp.json()["kinds"] == [INITIATIVE_CHANGED, TRUCK_CHANGED]
    # a kind that does not exist, and one that is real but nobody can watch for
    for kind in ("nonsense", "report_ready"):
        resp = await _patch(client, me, ids["site"], [kind])
        assert (resp.status_code, _code(resp)) == (422, "invalid_kind"), kind
    # a refusal changed nothing
    stored = {row["thing"]: row["kinds"] for row in await _list(client, me)}
    assert stored == {"initiative": [TRUCK_CHANGED], "site": [INITIATIVE_CHANGED, TRUCK_CHANGED],
                      "truck": [TRUCK_CHANGED]}
    # none chosen goes back to every event that applies
    resp = await _patch(client, me, ids["site"], [])
    assert (resp.status_code, resp.json()["kinds"]) == (200, [])


async def test_everything(client, db):
    me = await _login(db, client, "A")

    resp = await _post(client, me, EVERYTHING)
    assert (resp.status_code, _code(resp)) == (422, "kinds_required")
    # only events that can be watched everywhere
    resp = await _post(client, me, EVERYTHING, kinds=["report_ready"])
    assert (resp.status_code, _code(resp)) == (422, "invalid_kind")

    resp = await _post(client, me, EVERYTHING, kinds=[INITIATIVE_CHANGED])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["thing"], body["thing_id"], body["thing_name"], body["thing_label"],
            body["link"]) == ("everything", None, None, None, None)
    assert body["kinds"] == [INITIATIVE_CHANGED]
    assert body["via"]["type"] == "you"

    # one Everything watch each: watching again is an edit, not a second row
    resp = await _post(client, me, EVERYTHING, kinds=[TRUCK_CHANGED])
    assert (resp.status_code, _code(resp)) == (409, "already_watching")
    resp = await _patch(client, me, body["id"], [INITIATIVE_CHANGED, TRUCK_CHANGED])
    assert (resp.status_code, resp.json()["kinds"]) == (200, [INITIATIVE_CHANGED, TRUCK_CHANGED])
    # it can name different events, never none
    resp = await _patch(client, me, body["id"], [])
    assert (resp.status_code, _code(resp)) == (422, "kinds_required")
    rows = await _list(client, me)
    assert [row["kinds"] for row in rows] == [[INITIATIVE_CHANGED, TRUCK_CHANGED]]
    assert await _count(db) == 1


async def test_errors(client, db):
    me = await _login(db, client, "A")
    other = await _login(db, client, "B")
    initiative, site, truck = await _things(db)
    ghost = uuid.uuid4()

    # something that is not a thing to watch
    for thing in ("bogus", "wiki", ""):
        resp = await _post(client, me, thing, ghost)
        assert (resp.status_code, _code(resp)) == (422, "invalid_thing"), thing
    # Everything has no id; every other thing needs one
    resp = await _post(client, me, EVERYTHING, initiative.id, kinds=[INITIATIVE_CHANGED])
    assert (resp.status_code, _code(resp)) == (422, "invalid_thing")
    for thing in ("initiative", "site", "truck", "device", "wiki_space", "wiki_node"):
        resp = await _post(client, me, thing)
        assert (resp.status_code, _code(resp)) == (422, "invalid_thing"), thing
        resp = await _post(client, me, thing, ghost)
        assert (resp.status_code, _code(resp)) == (404, "thing_not_found"), thing
    # a body can name a watch's fields and nothing more: not someone else's watch
    resp = await client.post(WATCHES, headers=me.headers, json={
        "thing": "site", "id": str(site.id), "kinds": [], "person_id": str(other.id)})
    assert resp.status_code == 422
    resp = await client.patch(f"{WATCHES}/{ghost}", headers=me.headers,
                              json={"kinds": [], "thing": "site"})
    assert resp.status_code == 422
    assert await _count(db) == 0

    # a second watch on the same thing
    assert (await _post(client, me, "site", site.id)).status_code == 201
    resp = await _post(client, me, "site", site.id, kinds=[TRUCK_CHANGED])
    assert (resp.status_code, _code(resp)) == (409, "already_watching")
    # ...is that person's own: someone else can watch the same thing
    assert (await _post(client, me, "truck", truck.id)).status_code == 201
    theirs = (await _post(client, other, "truck", truck.id)).json()["id"]

    # another person's watch, or none at all, is not found: to change or to delete
    for watch_id in (theirs, str(ghost)):
        resp = await _patch(client, me, watch_id, [TRUCK_CHANGED])
        assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
        resp = await client.delete(f"{WATCHES}/{watch_id}", headers=me.headers)
        assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
    # theirs is untouched, and still theirs to change
    assert await _count(db) == 3
    assert (await _patch(client, other, theirs, [TRUCK_CHANGED])).status_code == 200


async def test_a_client_user_cannot_watch_another_clients_initiative(client, db):
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.flush()
    initiative_a = Initiative(name="Initiative A", initiative_type="move", client_id=client_a.id)
    initiative_b = Initiative(name="Initiative B", initiative_type="move", client_id=client_b.id)
    site = Site(name="Site A")
    db.add_all([initiative_a, initiative_b, site])
    await db.commit()
    person = await _login(db, client, "A", "client_viewer", client_id=client_b.id)

    resp = await _post(client, person, "initiative", initiative_a.id)
    assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    assert "Initiative A" not in resp.text
    # a missing id answers the same, so the two can't be told apart
    missing = await _post(client, person, "initiative", uuid.uuid4())
    assert (missing.status_code, missing.json()) == (resp.status_code, resp.json())
    # their own client's initiative is theirs to watch; sites are global-only
    assert (await _post(client, person, "initiative", initiative_b.id)).status_code == 201
    resp = await _post(client, person, "site", site.id)
    assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    assert await _count(db) == 1


# ── the state of a Watch button ─────────────────────────────────────

async def test_state_counts_only_my_own_watch(client, db):
    me = await _login(db, client, "A")
    other = await _login(db, client, "B")
    initiative, site, _truck = await _things(db)
    group = await _group(db, "Group A", me)
    await _group_watch(db, group, "initiative", initiative.id)
    assert (await _post(client, other, "initiative", initiative.id)).status_code == 201

    # not watching: the group's watch and the other person's are not mine
    state = await _state(client, me, "initiative", initiative.id)
    assert state.json() == {"watching": False, "watch_id": None, "kinds": []}
    mine = (await _post(client, me, "site", site.id, kinds=[TRUCK_CHANGED])).json()["id"]
    state = await _state(client, me, "site", site.id)
    assert state.json() == {"watching": True, "watch_id": mine, "kinds": [TRUCK_CHANGED]}
    # a thing with no watch at all, even one that does not exist
    state = await _state(client, me, "truck", uuid.uuid4())
    assert (state.status_code, state.json()["watching"]) == (200, False)


@pytest.mark.parametrize("thing", ["bogus", "wiki", EVERYTHING, ""])
async def test_state_of_an_unknown_thing_is_refused(client, db, thing):
    me = await _login(db, client, "A")
    resp = await _state(client, me, thing, uuid.uuid4())
    assert (resp.status_code, _code(resp)) == (422, "invalid_thing")


# ── what /me lists ──────────────────────────────────────────────────

async def test_list_includes_enabled_groups_only_and_visible_things(client, db):
    me = await _login(db, client, "A")
    other = await _login(db, client, "B")
    initiative, site, truck = await _things(db)
    group_a = await _group(db, "Group A", me)
    group_b = await _group(db, "Group B", me, enabled=False)       # Paused
    group_c = await _group(db, "Group C", other)                   # not mine
    await _group_watch(db, group_a, "site", site.id)
    await _group_watch(db, group_b, "truck", truck.id)
    await _group_watch(db, group_c, "initiative", initiative.id)
    assert (await _post(client, me, "initiative", initiative.id)).status_code == 201

    resp = await client.get(WATCHES, headers=me.headers)
    rows = resp.json()
    assert [(row["thing"], row["via"]["type"], row["via"]["name"]) for row in rows] == [
        ("initiative", "you", None), ("site", "group", "Group A")]
    assert rows[1]["via"]["id"] == str(group_a.id)
    assert (rows[1]["thing_name"], rows[1]["link"]) == ("Site A", f"/sites/{site.id}")
    # nothing of the Paused group's, or of a group I am not in
    assert "Truck A" not in resp.text and "Group B" not in resp.text and "Group C" not in resp.text

    # Resuming the group lists its watch
    group_b.enabled = True
    await db.commit()
    assert [row["thing"] for row in await _list(client, me)] == ["initiative", "truck", "site"]


async def test_a_group_watch_on_something_i_cannot_open_is_not_listed(client, db):
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.flush()
    initiative_a = Initiative(name="Initiative A", initiative_type="move", client_id=client_a.id)
    initiative_b = Initiative(name="Initiative B", initiative_type="move", client_id=client_b.id)
    site = Site(name="Site A")
    db.add_all([initiative_a, initiative_b, site])
    await db.commit()
    me = await _login(db, client, "A", "client_viewer", client_id=client_b.id)
    group = await _group(db, "Group A", me)
    await _group_watch(db, group, "initiative", initiative_a.id)
    await _group_watch(db, group, "initiative", initiative_b.id)
    await _group_watch(db, group, "site", site.id)
    await _group_watch(db, group, None, kinds=[INITIATIVE_CHANGED])

    resp = await client.get(WATCHES, headers=me.headers)
    rows = resp.json()
    # their own client's initiative, and Everything (no thing to be named)
    assert sorted((row["thing"], row["thing_name"]) for row in rows) == [
        ("everything", None), ("initiative", "Initiative B")]
    # a thing's name does not leave through a group
    assert "Initiative A" not in resp.text and "Site A" not in resp.text


async def test_a_watch_i_can_no_longer_open_stays_but_is_out_of_sight(client, db):
    me = await _login(db, client, "A")
    initiative, site, _truck = await _things(db)
    watch_id = (await _post(client, me, "initiative", initiative.id)).json()["id"]
    assert (await _post(client, me, "site", site.id)).status_code == 201

    db.add(PermissionOverride(person_id=me.id, resource="initiatives", action="view", allow=False))
    await db.commit()
    # the list leaves it out, and the rest of the watch's answers say nothing about the thing
    assert [row["thing"] for row in await _list(client, me)] == ["site"]
    resp = await _patch(client, me, watch_id, [TRUCK_CHANGED])
    assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
    resp = await _post(client, me, "initiative", initiative.id)
    assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    assert await _count(db) == 2                         # it stayed

    # access comes back, and so does the watch
    await db.execute(PermissionOverride.__table__.delete())
    await db.commit()
    assert [row["thing"] for row in await _list(client, me)] == ["site", "initiative"]
    assert (await _patch(client, me, watch_id, [TRUCK_CHANGED])).status_code == 200


async def test_i_can_stop_watching_what_i_can_no_longer_open(client, db):
    me = await _login(db, client, "A")
    initiative, _site, _truck = await _things(db)
    watch_id = (await _post(client, me, "initiative", initiative.id)).json()["id"]
    db.add(PermissionOverride(person_id=me.id, resource="initiatives", action="view", allow=False))
    await db.commit()

    resp = await client.delete(f"{WATCHES}/{watch_id}", headers=me.headers)
    assert resp.status_code == 204
    assert await _count(db) == 0


async def test_list_puts_mine_first_then_my_groups_each_newest_first(client, db):
    me = await _login(db, client, "A")
    _initiative, site, truck = await _things(db)
    group = await _group(db, "Group A", me)
    start = datetime(2026, 1, 1, tzinfo=UTC)
    day = timedelta(days=1)
    db.add_all([
        NotificationWatch(person_id=me.id, site_id=site.id, created_at=start + day),
        NotificationWatch(person_id=me.id, truck_id=truck.id, created_at=start + 3 * day),
    ])
    await db.commit()
    await _group_watch(db, group, "site", site.id, created_at=start + 2 * day)
    await _group_watch(db, group, "truck", truck.id, created_at=start + 4 * day)

    rows = await _list(client, me)
    assert [(row["via"]["type"], row["thing"]) for row in rows] == [
        ("you", "truck"), ("you", "site"), ("group", "truck"), ("group", "site")]


# ── what is audited ─────────────────────────────────────────────────

async def test_own_watch_add_is_audited_on_the_account(client, db):
    me = await _login(db, client, "A")
    initiative, _site, _truck = await _things(db)

    resp = await _post(client, me, "initiative", initiative.id, kinds=[TRUCK_CHANGED])
    assert resp.status_code == 201, resp.text

    (added,) = await _own_audits(db, me.id)
    assert (added.entity_type, added.entity_id, added.action, added.actor_person_id) == (
        "user_account", str(me.id), "watch.add", me.id)
    assert added.changes == {"thing": "initiative", "thing_id": str(initiative.id),
                             "kinds": [TRUCK_CHANGED]}

    # watching it again is refused and writes nothing more
    resp = await _post(client, me, "initiative", initiative.id)
    assert (resp.status_code, _code(resp)) == (409, "already_watching")
    assert len(await _own_audits(db, me.id)) == 1


async def test_own_everything_watch_add_is_audited(client, db):
    me = await _login(db, client, "A")

    resp = await _post(client, me, EVERYTHING, kinds=[INITIATIVE_CHANGED])
    assert resp.status_code == 201, resp.text

    # it has no thing to name, so the row says "everything" with no id
    (added,) = await _own_audits(db, me.id)
    assert (added.action, added.actor_person_id) == ("watch.add", me.id)
    assert added.changes == {"thing": EVERYTHING, "thing_id": None, "kinds": [INITIATIVE_CHANGED]}


async def test_own_watch_kind_change_is_audited_once(client, db):
    me = await _login(db, client, "A")
    initiative, _site, _truck = await _things(db)
    watch_id = (await _post(client, me, "initiative", initiative.id,
                            kinds=[INITIATIVE_CHANGED])).json()["id"]

    resp = await _patch(client, me, watch_id, [TRUCK_CHANGED])
    assert resp.status_code == 200, resp.text
    (updated,) = await _own_audits(db, me.id, "watch.update")
    assert (updated.entity_type, updated.entity_id, updated.actor_person_id) == (
        "user_account", str(me.id), me.id)
    # the row names the watch it changed, as the add and remove rows do
    assert updated.changes == {"thing": "initiative", "thing_id": str(initiative.id),
                               "kinds": {"from": [INITIATIVE_CHANGED], "to": [TRUCK_CHANGED]}}

    # the same events again, even repeated, change nothing and write nothing; nor does a refusal
    for kinds in ([TRUCK_CHANGED], [TRUCK_CHANGED, TRUCK_CHANGED]):
        resp = await _patch(client, me, watch_id, kinds)
        assert resp.status_code == 200, resp.text
    resp = await _patch(client, me, watch_id, ["nonsense"])
    assert (resp.status_code, _code(resp)) == (422, "invalid_kind")
    assert [row.action for row in await _own_audits(db, me.id)] == ["watch.add", "watch.update"]


async def test_own_watch_remove_is_audited(client, db):
    me = await _login(db, client, "A")
    initiative, _site, _truck = await _things(db)
    watch_id = (await _post(client, me, "initiative", initiative.id)).json()["id"]
    everything_id = (await _post(client, me, EVERYTHING, kinds=[INITIATIVE_CHANGED])).json()["id"]

    resp = await client.delete(f"{WATCHES}/{watch_id}", headers=me.headers)
    assert resp.status_code == 204
    (removed,) = await _own_audits(db, me.id, "watch.remove")
    assert (removed.entity_type, removed.entity_id, removed.actor_person_id) == (
        "user_account", str(me.id), me.id)
    assert removed.changes == {"thing": "initiative", "thing_id": str(initiative.id)}

    # an Everything watch has no thing to name: "everything" with no id
    resp = await client.delete(f"{WATCHES}/{everything_id}", headers=me.headers)
    assert resp.status_code == 204
    assert [row.changes for row in await _own_audits(db, me.id, "watch.remove")] == [
        {"thing": "initiative", "thing_id": str(initiative.id)},
        {"thing": EVERYTHING, "thing_id": None}]


async def test_own_wiki_watch_writes_only_the_wikis_audit(client, db):
    """A wiki watch is the wiki's own as well, and the wiki audits it (`wiki_watch`: `watch`
    and `unwatch`), from /me as from its own Watch button. It writes no second row on the
    person's account."""
    s = await _setup(client, db)
    viewer = Login(s["viewer_id"], s["viewer"])
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])        # a reader can't see a page never published

    async def audited():
        """Everything the viewer has had audited so far, apart from signing in, oldest first."""
        rows = await db.execute(
            select(AuditLog.entity_type, AuditLog.entity_id, AuditLog.action, AuditLog.changes)
            .where(AuditLog.actor_person_id == viewer.id, AuditLog.entity_type != "auth")
            .order_by(AuditLog.at))
        return [tuple(row) for row in rows]

    resp = await _post(client, viewer, "wiki_node", page["id"])
    assert resp.status_code == 201, resp.text
    watch_id = resp.json()["id"]
    watched = ("wiki_watch", watch_id, "watch", {"node_id": page["id"]})
    assert await audited() == [watched]

    resp = await client.delete(f"{WATCHES}/{watch_id}", headers=viewer.headers)
    assert resp.status_code == 204
    assert await audited() == [watched, ("wiki_watch", watch_id, "unwatch",
                                         {"node_id": page["id"], "space_id": None})]
    assert await _own_audits(db, viewer.id) == []


# ── read-only mode ──────────────────────────────────────────────────

async def test_writes_blocked_in_read_only_mode(client, db):
    super_admin = await _make(db, client, "super_admin", "sa@test.example.com")
    me = await _login(db, client, "A")
    initiative, site, _truck = await _things(db)
    watch_id = (await _post(client, me, "initiative", initiative.id)).json()["id"]
    assert (await client.put("/system/admin", headers=super_admin,
                             json={"read_only": True})).status_code == 200

    resp = await _post(client, me, "site", site.id)
    assert resp.status_code == 423, resp.text
    assert _code(resp) == "read_only_mode"
    resp = await _patch(client, me, watch_id, [TRUCK_CHANGED])
    assert (resp.status_code, _code(resp)) == (423, "read_only_mode")
    resp = await client.delete(f"{WATCHES}/{watch_id}", headers=me.headers)
    assert (resp.status_code, _code(resp)) == (423, "read_only_mode")
    # nothing changed; reading is not frozen
    rows = await _list(client, me)
    assert [(row["thing"], row["kinds"]) for row in rows] == [("initiative", [])]
    assert (await _state(client, me, "initiative", initiative.id)).status_code == 200


# ── the module's own rules ──────────────────────────────────────────

async def _staff(db) -> tuple[Person, object]:
    """A staff person and their resolved access."""
    person = Person(first_name="Person", last_name="A")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="staff"))
    await db.commit()
    return person, (await resolve_access_many(db, [person.id]))[person.id]


async def _add_own(db, person, access, thing, initiative, *, created_by=None):
    """`person` watching `thing` for themselves: the initiative, or Everything."""
    return await add_watch(
        db, thing=thing, thing_id=initiative.id if thing == "initiative" else None,
        kinds=[] if thing == "initiative" else [INITIATIVE_CHANGED], viewer_id=person.id,
        viewer_access=access, created_by=created_by or person.id, person_id=person.id)


@pytest.mark.parametrize("thing", ["initiative", EVERYTHING])
async def test_a_watch_already_there_is_refused_before_any_insert(db, monkeypatch, thing):
    person, access = await _staff(db)
    initiative, _site, _truck = await _things(db)
    await _add_own(db, person, access, thing, initiative)
    await db.commit()

    def no_insert(*args, **kwargs):
        raise AssertionError("tried to insert a watch that is already there")

    monkeypatch.setattr(db, "begin_nested", no_insert)
    with pytest.raises(WatchError) as caught:
        await _add_own(db, person, access, thing, initiative)
    assert (caught.value.status, caught.value.code) == (409, "already_watching")


@pytest.mark.parametrize("thing", ["initiative", EVERYTHING])
async def test_a_lost_race_reads_as_already_watching(db, monkeypatch, thing):
    person, access = await _staff(db)
    initiative, _site, _truck = await _things(db)
    await _add_own(db, person, access, thing, initiative)
    await db.commit()

    async def nothing_yet(*args, **kwargs):
        return None

    # a second request inserted its row after this one looked: the unique index answers
    monkeypatch.setattr(watches, "_existing", nothing_yet)
    with pytest.raises(WatchError) as caught:
        await _add_own(db, person, access, thing, initiative)
    assert (caught.value.status, caught.value.code) == (409, "already_watching")
    # the session still works, and the first watch is the only one
    assert await _count(db) == 1


async def test_another_integrity_error_is_not_mistaken_for_a_duplicate(db):
    person, access = await _staff(db)
    initiative, _site, _truck = await _things(db)

    # a creator who is not a person: the foreign key refuses it, and that is not "already
    # watching"
    with pytest.raises(IntegrityError):
        await _add_own(db, person, access, "initiative", initiative, created_by=uuid.uuid4())
    assert await _count(db) == 0


async def test_a_watch_has_one_subscriber(db):
    person, access = await _staff(db)
    group = await _group(db, "Group A", person)
    for fields in ({}, {"person_id": person.id, "group_id": group.id}):
        with pytest.raises(ValueError, match="exactly one"):
            await add_watch(db, thing=EVERYTHING, thing_id=None, kinds=[INITIATIVE_CHANGED],
                            viewer_id=person.id, viewer_access=access, created_by=person.id,
                            **fields)
    assert await _count(db) == 0


async def test_a_group_watch_is_added_as_the_admin_who_can_see_the_thing(db):
    admin, access = await _staff(db)
    group = await _group(db, "Group A")
    initiative, site, _truck = await _things(db)

    watch = await add_watch(db, thing="site", thing_id=site.id, kinds=[TRUCK_CHANGED],
                            viewer_id=admin.id, viewer_access=access, created_by=admin.id,
                            group_id=group.id)
    assert (watch.person_id, watch.group_id, watch.site_id, watch.kinds, watch.created_by) == (
        None, group.id, site.id, [TRUCK_CHANGED], admin.id)
    assert watch.id is not None and watch.created_at is not None      # flushed
    with pytest.raises(WatchError) as caught:
        await add_watch(db, thing="site", thing_id=site.id, kinds=[], viewer_id=admin.id,
                        viewer_access=access, created_by=admin.id, group_id=group.id)
    assert (caught.value.status, caught.value.code) == (409, "already_watching")

    # the viewer's own access decides, not the group's: this one may not open initiatives
    db.add(PermissionOverride(person_id=admin.id, resource="initiatives", action="view",
                              allow=False))
    await db.commit()
    narrowed = (await resolve_access_many(db, [admin.id]))[admin.id]
    with pytest.raises(WatchError) as caught:
        await add_watch(db, thing="initiative", thing_id=initiative.id, kinds=[],
                        viewer_id=admin.id, viewer_access=narrowed, created_by=admin.id,
                        group_id=group.id)
    assert (caught.value.status, caught.value.code) == (404, "thing_not_found")


async def test_group_watches_lists_every_watch_the_asker_can_open_newest_first(db):
    asker, _access = await _staff(db)               # opens sites, trucks and initiatives
    group, other = await _group(db, "Group A"), await _group(db, "Group B")
    initiative, site, truck = await _things(db)
    start = datetime(2026, 1, 1, tzinfo=UTC)
    await _group_watch(db, group, "site", site.id, created_at=start)
    await _group_watch(db, group, "truck", truck.id, created_at=start + timedelta(days=2))
    await _group_watch(db, group, None, kinds=[INITIATIVE_CHANGED],
                       created_at=start + timedelta(days=1))
    await _group_watch(db, other, "initiative", initiative.id)

    views = await group_watches(db, group.id, asker.id)
    assert [(v.thing, v.thing_name, v.link) for v in views] == [
        ("truck", "Truck A", f"/logistics/trucks/{truck.id}"),
        (EVERYTHING, None, None),
        ("site", "Site A", f"/sites/{site.id}"),
    ]
    assert all(v.group is not None and v.group.id == group.id for v in views)
    assert views[1].thing_id is None and views[0].thing_id == truck.id
    assert await group_watches(db, uuid.uuid4(), asker.id) == []

    # someone who can't open trucks gets the rest: Everything has no thing to open
    db.add(PermissionOverride(person_id=asker.id, resource="trucks", action="view", allow=False))
    await db.commit()
    assert [v.thing for v in await group_watches(db, group.id, asker.id)] == [EVERYTHING, "site"]
