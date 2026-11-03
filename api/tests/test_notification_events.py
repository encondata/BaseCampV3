"""notifications/events.announce(), which adds a notification_events row to the caller's
transaction, and the two status changes that announce themselves (an initiative's and a
truck's, notifications/status_changes.py) from the four places a status changes: the
initiative edit, the truck edit, the trucks bulk import and the MacroPoint manual update.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 4 and 5)"""

import uuid
from datetime import UTC, datetime
from itertools import pairwise
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func, select

from serversherpa.api.routes import initiatives as initiative_routes
from serversherpa.db.models import (
    Initiative,
    InitiativeLink,
    NotificationEvent,
    NotificationLog,
    Person,
    Site,
    SystemConfig,
    Truck,
    UserAccount,
)
from serversherpa.notifications.events import EventItem, Thing, announce
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.status_changes import (
    announce_initiative_status_changed,
    announce_truck_status_changed,
    event_time,
)
from serversherpa.trucks.macropoint.parse import ParsedMessage, parse_inputs
from tests.test_macropoint_api import APPLY, FIX, JAMIE, JAMIE_TOKEN, form
from tests.test_sites_api import login
from tests.test_status_values_write import _make


def _ref(kind: str, thing_id) -> dict:
    """A reached thing as the event stores it."""
    return {"type": kind, "id": str(thing_id)}


async def _events(db) -> list[NotificationEvent]:
    """Every event, in the order it was announced."""
    return list(await db.scalars(select(NotificationEvent).order_by(NotificationEvent.id)))


async def _admin(db, client):
    """A global admin's auth header and person id."""
    hdrs = await _make(db, client, "admin", "admin@test.example.com")
    return hdrs, await db.scalar(select(Person.id).where(Person.email == "admin@test.example.com"))


async def _initiative_tree(db):
    """Initiative A with all three of its site columns set, under Initiative B."""
    site, origin, destination = (Site(name=f"Site {n}") for n in "ABC")
    db.add_all([site, origin, destination])
    await db.flush()
    parent = Initiative(name="Initiative B", initiative_type="project")
    child = Initiative(name="Initiative A", initiative_type="move", site_id=site.id,
                       origin_site_id=origin.id, destination_site_id=destination.id)
    db.add_all([parent, child])
    await db.flush()
    db.add(InitiativeLink(parent_id=parent.id, child_id=child.id))
    await db.commit()
    return parent, child, (site, origin, destination)


async def _truck_on(db, initiative):
    """Truck A on `initiative`, with a start and an end site of its own."""
    start, end = Site(name="Site D"), Site(name="Site E")
    db.add_all([start, end])
    await db.flush()
    truck = Truck(name="Truck A", initiative_id=initiative.id,
                  start_site_id=start.id, end_site_id=end.id)
    db.add(truck)
    await db.commit()
    return truck, start, end


# ── announce() ──────────────────────────────────────────────────────

async def test_announce_is_part_of_the_callers_transaction(db, seeded_user):
    actor_id = seeded_user.id
    subject = Thing("initiative", uuid.uuid4())
    site_a, initiative_b = Thing("site", uuid.uuid4()), Thing("initiative", uuid.uuid4())
    at = datetime(2026, 11, 2, 20, 4, tzinfo=UTC)
    item = EventItem("Initiative A: Planned → In progress", "A line", "/initiatives/x",
                     initiative_id=subject.id, at=at)

    # rolled back with the caller's work, it leaves nothing behind
    event = announce(db, "initiative_status_changed", subject=subject, item=item)
    assert isinstance(event, NotificationEvent)
    assert event in db.new and event.id is None      # added to the session, nothing sent yet
    await db.flush()                                 # the INSERT really happens...
    await db.rollback()                              # ...and the rollback takes it back
    assert await db.scalar(select(func.count()).select_from(NotificationEvent)) == 0

    # committed with it, one row waits to be sent
    event = announce(db, "initiative_status_changed", subject=subject, item=item,
                     reaches=[site_a, initiative_b, site_a, subject], actor_id=actor_id)
    await db.commit()
    await db.refresh(event)                          # what the database holds
    assert event.kind == "initiative_status_changed"
    assert (event.subject_type, event.subject_id) == ("initiative", subject.id)
    assert event.item == {
        "title": "Initiative A: Planned → In progress", "line": "A line",
        "link": "/initiatives/x", "initiative_id": str(subject.id),
        "at": "2026-11-02T20:04:00+00:00", "list_link": None}
    # de-duplicated in order, and never the subject itself
    assert event.reaches == [_ref("site", site_a.id), _ref("initiative", initiative_b.id)]
    assert event.actor_id == actor_id
    assert (event.watchers, event.sent_at, event.rule_id) == (True, None, None)
    assert (event.person_ids, event.group_ids) == ([], [])
    assert len(await _events(db)) == 1


async def test_announce_keeps_the_names_it_is_given(db, seeded_user):
    person_id, group_id = seeded_user.id, uuid.uuid4()
    event = announce(db, "truck_status_changed", subject=Thing("truck", uuid.uuid4()),
                     item=EventItem("Truck A: Created → Active"), person_ids=[person_id],
                     group_ids=(group_id,), watchers=False)
    await db.commit()
    await db.refresh(event)                          # what the database holds
    assert (event.person_ids, event.group_ids, event.watchers) == ([person_id], [group_id], False)
    assert event.reaches == []


async def test_announce_rejects_unknown_kind(db):
    with pytest.raises(ValueError):
        announce(db, "nope", subject=Thing("truck", uuid.uuid4()), item=EventItem("x"))
    assert not db.new                                # nothing was added


async def test_the_new_categories_follow_the_switches(db, seeded_user):
    """notify() treats a status change like any other kind: the person's own switch for
    Initiatives or Trucks, or failing that the company default, decides if their inbox
    hears it."""
    person_id = seeded_user.id
    assert await notify(db, person_id, "truck_status_changed", "Truck A: Created → Active")
    assert await notify(db, person_id, "initiative_status_changed",
                        "Initiative A: Planned → Scheduled")

    account = await db.get(UserAccount, person_id)
    account.ui_prefs = {"notif": {"switches": {"trucks": {"inbox": False}}}}
    db.add(SystemConfig(section="notifications", data={
        "defaults": {"initiatives": {"inbox": False, "email": False}}}))
    await db.commit()
    assert await notify(db, person_id, "truck_status_changed", "Truck A: Active → In Transit") is None
    assert await notify(db, person_id, "initiative_status_changed",
                        "Initiative A: Scheduled → In progress") is None
    await db.commit()

    suppressed = (await db.scalars(select(NotificationLog).where(
        NotificationLog.event == "inbox_suppressed").order_by(NotificationLog.id))).all()
    assert [(row.kind, row.category, row.reason, row.detail["source"]) for row in suppressed] == [
        ("truck_status_changed", "trucks", "category_off", "own"),
        ("initiative_status_changed", "initiatives", "category_off", "default")]


def test_thing_and_item_json():
    thing_id = uuid.uuid4()
    thing = Thing("site", thing_id)
    assert thing.to_json() == {"type": "site", "id": str(thing_id)}
    assert Thing.from_json(thing.to_json()) == thing
    assert Thing("site", thing_id) == thing and hash(Thing("site", thing_id)) == hash(thing)

    # every key is always there, so the sweep can read them without guessing
    assert EventItem("T").to_json() == {
        "title": "T", "line": "", "link": None, "initiative_id": None, "at": None,
        "list_link": None}
    initiative_id = uuid.uuid4()
    assert EventItem("T", "L", "/x", initiative_id=initiative_id,
                     at=datetime(2026, 11, 2, 20, 4, tzinfo=UTC), list_link="/y").to_json() == {
        "title": "T", "line": "L", "link": "/x", "initiative_id": str(initiative_id),
        "at": "2026-11-02T20:04:00+00:00", "list_link": "/y"}

    # a status rule's notice also says what it matched: the kind of thing, how many, which
    first, second = uuid.uuid4(), uuid.uuid4()
    assert EventItem("T", matched_type="asset", matched_ids=(first, second)).to_json() == {
        "title": "T", "line": "", "link": None, "initiative_id": None, "at": None,
        "list_link": None, "count": 2, "matched_type": "asset",
        "matched_ids": [str(first), str(second)]}


@pytest.mark.parametrize("at,expected", [
    (datetime(2026, 11, 2, 20, 4, tzinfo=UTC), "Nov 2, 3:04 PM EST"),
    (datetime(2026, 7, 4, 15, 30, tzinfo=UTC), "Jul 4, 11:30 AM EDT"),       # summer time
    (datetime(2026, 11, 2, 5, 0, tzinfo=UTC), "Nov 2, 12:00 AM EST"),        # midnight
    (datetime(2026, 11, 2, 17, 5, tzinfo=UTC), "Nov 2, 12:05 PM EST"),       # just after noon
    (datetime(2026, 11, 3, 4, 59, tzinfo=UTC), "Nov 2, 11:59 PM EST"),       # the local day
    (datetime(2026, 11, 2, 12, 0, tzinfo=ZoneInfo("America/Los_Angeles")),   # any aware time
     "Nov 2, 3:00 PM EST"),
])
def test_event_time_is_read_in_the_reference_zone(at, expected):
    assert event_time(at) == expected


# ── initiative status ───────────────────────────────────────────────

async def test_initiative_status_patch_announces(client, db):
    hdrs, admin_id = await _admin(db, client)
    parent, initiative, (site, origin, destination) = await _initiative_tree(db)

    resp = await client.patch(f"/initiatives/{initiative.id}", headers=hdrs,
                              json={"status": "in_progress"})
    assert resp.status_code == 200, resp.text

    [event] = await _events(db)
    assert event.kind == "initiative_status_changed"
    assert (event.subject_type, event.subject_id) == ("initiative", initiative.id)
    assert event.actor_id == admin_id
    assert event.item == {
        "title": "Initiative A: Planned → In progress", "line": "",
        "link": f"/initiatives/{initiative.id}", "initiative_id": str(initiative.id), "at": None,
        "list_link": None}
    # the parent, then the three sites in the order the columns are named
    assert event.reaches == [_ref("initiative", parent.id), _ref("site", site.id),
                             _ref("site", origin.id), _ref("site", destination.id)]
    assert (event.watchers, event.sent_at, event.rule_id) == (True, None, None)
    assert (event.person_ids, event.group_ids) == ([], [])


async def test_initiative_status_patch_reaches_every_parent_by_id(client, db):
    """Parents are worked out up the whole link graph, and listed by id so the
    stored order is the same every time."""
    hdrs, _ = await _admin(db, client)
    # a chain seven deep (six parents: an unsorted list would match by luck 1 time in 700):
    # each initiative is the child of the one before it
    chain = [Initiative(name=f"Initiative {n}", initiative_type="project") for n in "GFEDCBA"]
    db.add_all(chain)
    await db.flush()
    db.add_all([InitiativeLink(parent_id=above.id, child_id=below.id)
                for above, below in pairwise(chain)])
    await db.commit()

    resp = await client.patch(f"/initiatives/{chain[-1].id}", headers=hdrs,
                              json={"status": "completed"})
    assert resp.status_code == 200, resp.text
    [event] = await _events(db)
    assert event.reaches == [_ref("initiative", i) for i in sorted(i.id for i in chain[:-1])]


async def test_initiative_patch_without_a_status_change_is_silent(client, db):
    hdrs, _ = await _admin(db, client)
    _, initiative, _ = await _initiative_tree(db)
    url = f"/initiatives/{initiative.id}"

    assert (await client.patch(url, headers=hdrs, json={"name": "Initiative X"})).status_code == 200
    assert (await client.patch(url, headers=hdrs, json={"status": "planned"})).status_code == 200
    assert (await client.patch(url, headers=hdrs, json={
        "name": "Initiative Y", "status": "planned"})).status_code == 200
    assert await _events(db) == []

    # the same route does announce a real change
    assert (await client.patch(url, headers=hdrs, json={"status": "scheduled"})).status_code == 200
    [event] = await _events(db)
    assert event.item["title"] == "Initiative Y: Planned → Scheduled"


async def test_a_status_with_no_label_shows_as_its_key(db):
    """The title uses the status labels, and a status the vocabulary doesn't know
    reads as the key it is stored under."""
    initiative = Initiative(name="Initiative A", initiative_type="move")
    truck = Truck(name="Truck A")
    db.add_all([initiative, truck])
    await db.flush()
    event = await announce_initiative_status_changed(
        db, initiative, old="mystery", new="planned", actor_id=None)
    assert event.item["title"] == "Initiative A: mystery → Planned"
    event = await announce_truck_status_changed(
        db, truck, old="created", new="mystery", actor_id=None)
    assert event.item["title"] == "Truck A: Created → mystery"
    await db.rollback()


async def test_a_failed_initiative_save_announces_nothing(client, db, monkeypatch):
    """The event is part of the save: a code another save took meanwhile (forced here by
    skipping the check) is the usual 409, and the status change and its event are rolled
    back together."""
    hdrs, _ = await _admin(db, client)
    _, initiative, _ = await _initiative_tree(db)
    db.add(Initiative(name="Initiative C", initiative_type="project", code="LV3"))
    await db.commit()

    async def never_taken(db, code, exclude_id=None):
        return False

    monkeypatch.setattr(initiative_routes, "code_taken", never_taken)
    resp = await client.patch(f"/initiatives/{initiative.id}", headers=hdrs,
                              json={"status": "in_progress", "code": "LV3"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "code_in_use")
    assert await _events(db) == []
    await db.refresh(initiative)
    assert (initiative.status, initiative.code) == ("planned", None)


async def test_creating_is_silent(client, db):
    hdrs, _ = await _admin(db, client)
    resp = await client.post("/initiatives", headers=hdrs, json={
        "name": "Initiative A", "initiative_type": "project", "status": "in_progress"})
    assert resp.status_code == 201, resp.text
    resp = await client.post("/trucks", headers=hdrs, json={
        "name": "Truck A", "status": "in_transit"})
    assert resp.status_code == 201, resp.text
    assert await _events(db) == []


# ── truck status ────────────────────────────────────────────────────

async def test_truck_edit_announces(client, db):
    hdrs, admin_id = await _admin(db, client)
    parent, initiative, _ = await _initiative_tree(db)
    truck, start, end = await _truck_on(db, initiative)

    resp = await client.patch(f"/trucks/{truck.id}", headers=hdrs, json={"status": "in_transit"})
    assert resp.status_code == 200, resp.text

    [event] = await _events(db)
    assert event.kind == "truck_status_changed"
    assert (event.subject_type, event.subject_id) == ("truck", truck.id)
    assert event.actor_id == admin_id
    assert event.item == {
        "title": "Truck A: Created → In Transit", "line": "",
        "link": f"/logistics/trucks/{truck.id}", "initiative_id": str(initiative.id), "at": None,
        "list_link": None}
    # its initiative, that one's parent, then its own start and end sites
    # (not the initiative's sites)
    assert event.reaches == [_ref("initiative", initiative.id), _ref("initiative", parent.id),
                             _ref("site", start.id), _ref("site", end.id)]
    assert (event.watchers, event.sent_at, event.rule_id) == (True, None, None)


async def test_truck_with_no_initiative_or_sites_reaches_nothing(client, db):
    hdrs, _ = await _admin(db, client)
    truck = Truck(name="Truck A")
    db.add(truck)
    await db.commit()
    assert (await client.patch(f"/trucks/{truck.id}", headers=hdrs,
                               json={"status": "active"})).status_code == 200
    [event] = await _events(db)
    assert event.reaches == []
    assert event.item["initiative_id"] is None


async def test_truck_patch_without_a_status_change_is_silent(client, db):
    hdrs, _ = await _admin(db, client)
    truck = Truck(name="Truck A")
    db.add(truck)
    await db.commit()
    url = f"/trucks/{truck.id}"

    assert (await client.patch(url, headers=hdrs, json={"name": "Truck X"})).status_code == 200
    assert (await client.patch(url, headers=hdrs, json={"status": "created"})).status_code == 200
    assert await _events(db) == []

    assert (await client.patch(url, headers=hdrs, json={"status": "active"})).status_code == 200
    [event] = await _events(db)
    assert event.item["title"] == "Truck X: Created → Active"


async def test_truck_bulk_import_update_announces(client, db):
    hdrs, admin_id = await _admin(db, client)
    parent, initiative, _ = await _initiative_tree(db)
    a, b, d = (Truck(name=f"Truck {n}") for n in "ABD")
    a.initiative_id = initiative.id
    db.add_all([a, b, d])
    await db.commit()

    resp = await client.post("/trucks/bulk-import/commit", headers=hdrs, json={
        "rows": [
            {"name": "Truck A", "status": "active"},        # approved, status changes
            {"name": "Truck B", "status": "active"},        # a status change nobody approved
            {"name": "Truck C", "status": "active"},        # a new truck
            {"name": "Truck D", "driver_name": "Person A"},  # approved, status untouched
        ],
        "approved_updates": [str(a.id), str(d.id)], "source": "fleet.csv"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["created"], body["updated"], body["skipped"]) == (1, 2, 1)

    [event] = await _events(db)                          # Truck A's, and only that one
    assert event.kind == "truck_status_changed"
    assert (event.subject_type, event.subject_id, event.actor_id) == ("truck", a.id, admin_id)
    assert event.item["title"] == "Truck A: Created → Active"
    assert event.item["line"] == "" and event.item["at"] is None
    assert event.reaches == [_ref("initiative", initiative.id), _ref("initiative", parent.id)]


async def test_macropoint_apply_announces_each_change(client, db, seeded_user):
    hdrs = await login(client)
    actor_id = seeded_user.id
    parent, initiative, _ = await _initiative_tree(db)
    truck, start, end = await _truck_on(db, initiative)

    resp = await client.post(APPLY, headers=hdrs, files=form(
        JAMIE, assignments={f"order:{JAMIE_TOKEN}": str(truck.id)}))
    assert resp.status_code == 200, resp.text
    assert resp.json()["status_changes"] == 2            # Created -> In Transit -> At Destination

    messages = [m for m in parse_inputs([(n, (FIX / n).read_bytes()) for n in JAMIE], "")
                if isinstance(m, ParsedMessage)]
    departed = next(m for m in messages if (m.event_kind, m.stop) == ("departed", "pickup"))
    arrived = next(m for m in messages if (m.event_kind, m.stop) == ("arrived", "drop_off"))

    first, second = await _events(db)                    # oldest first
    assert [e.item["title"] for e in (first, second)] == [
        "Truck A: Created → In Transit", "Truck A: In Transit → At Destination"]
    # each carries the time of the message that moved the truck, not the time of the apply
    assert (first.item["line"], second.item["line"]) == (
        event_time(departed.recorded_at), event_time(arrived.recorded_at))
    assert first.item["line"] == "Oct 15, 11:11 AM EDT"
    assert [datetime.fromisoformat(e.item["at"]) for e in (first, second)] == [
        departed.recorded_at, arrived.recorded_at]
    for event in (first, second):
        assert (event.kind, event.subject_type, event.subject_id) == (
            "truck_status_changed", "truck", truck.id)
        assert event.actor_id == actor_id
        assert event.item["link"] == f"/logistics/trucks/{truck.id}"
        assert event.item["initiative_id"] == str(initiative.id)
        assert event.reaches == [_ref("initiative", initiative.id), _ref("initiative", parent.id),
                                 _ref("site", start.id), _ref("site", end.id)]


async def test_macropoint_apply_without_a_move_is_silent(client, db, seeded_user):
    """Locations, and trip events that move no status, announce nothing."""
    hdrs = await login(client)
    truck = Truck(name="Truck A", status="at_destination")
    db.add(truck)
    await db.commit()
    resp = await client.post(APPLY, headers=hdrs, files=form(
        JAMIE, assignments={f"order:{JAMIE_TOKEN}": str(truck.id)}))
    assert resp.status_code == 200, resp.text
    assert resp.json()["status_changes"] == 0
    assert await _events(db) == []
