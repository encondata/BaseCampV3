"""Which watches an event reaches (notifications/watches.matching_routes), and the rules a
watch's events are stored under (kinds_for, clean_kinds). Events are built the way the app
builds them, through announce() or the two status-change helpers, and committed.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 1 and 4)"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from serversherpa.db.models import (
    Device,
    Initiative,
    InitiativeLink,
    NotificationGroup,
    NotificationGroupMember,
    NotificationWatch,
    Person,
    Site,
    Truck,
)
from serversherpa.notifications.events import EventItem, Thing, announce
from serversherpa.notifications.status_changes import (
    announce_initiative_status_changed,
    announce_truck_status_changed,
)
from serversherpa.notifications.watches import (
    _THING_COLUMNS,
    EVERYTHING,
    THINGS,
    WatchError,
    clean_kinds,
    kinds_for,
    matching_routes,
)

INITIATIVE_CHANGED = "initiative_status_changed"
TRUCK_CHANGED = "truck_status_changed"
DEVICE_OFFLINE = "device_offline"
RULE_MATCHED = "status_rule_matched"


async def _people(db, *names) -> list[Person]:
    people = [Person(first_name="Person", last_name=name) for name in names]
    db.add_all(people)
    await db.commit()
    return people


async def _group(db, name, members, *, enabled=True) -> NotificationGroup:
    group = NotificationGroup(name=name, enabled=enabled)
    db.add(group)
    await db.flush()
    db.add_all(NotificationGroupMember(group_id=group.id, person_id=person.id)
               for person in members)
    await db.commit()
    return group


async def _initiative(db, name, **fields) -> Initiative:
    row = Initiative(name=name, initiative_type="move", **fields)
    db.add(row)
    await db.commit()
    return row


async def _site(db, name) -> Site:
    row = Site(name=name)
    db.add(row)
    await db.commit()
    return row


async def _truck(db, name, **fields) -> Truck:
    row = Truck(name=name, **fields)
    db.add(row)
    await db.commit()
    return row


async def _device(db, name) -> Device:
    row = Device(device_type="fixed_reader", name=name)
    db.add(row)
    await db.commit()
    return row


async def _watch(db, subscriber, thing=None, kinds=()):
    """A watch for `subscriber` (a Person or a NotificationGroup) on `thing`, or an Everything
    watch when `thing` is None."""
    fields = ({"person_id": subscriber.id} if isinstance(subscriber, Person)
              else {"group_id": subscriber.id})
    if thing is not None:
        fields[THINGS[thing.type].column] = thing.id
    db.add(NotificationWatch(kinds=list(kinds), **fields))
    await db.commit()


async def _event(db, kind, subject, *reaches, **fields):
    event = announce(db, kind, subject=subject, item=EventItem("Title"), reaches=reaches,
                     **fields)
    await db.commit()
    return event


def _on(row, kind="initiative") -> Thing:
    return Thing(kind, row.id)


# ── the matching ────────────────────────────────────────────────────

async def test_a_watch_on_the_subject_matches(db):
    person_a, person_b = await _people(db, "A", "B")
    initiative_a = await _initiative(db, "Initiative A")
    initiative_b = await _initiative(db, "Initiative B")
    await _watch(db, person_a, _on(initiative_a))
    await _watch(db, person_b, _on(initiative_b))

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative_a))
    assert await matching_routes(db, event) == {person_a.id: {"watch"}}


async def test_a_watch_on_a_parent_in_reaches_matches(db):
    person_a, person_b = await _people(db, "A", "B")
    parent = await _initiative(db, "Initiative B")
    child = await _initiative(db, "Initiative A")
    unrelated = await _initiative(db, "Initiative C")
    await _watch(db, person_a, _on(parent))
    await _watch(db, person_b, _on(unrelated))

    event = await _event(db, INITIATIVE_CHANGED, _on(child), _on(parent))
    assert await matching_routes(db, event) == {person_a.id: {"watch"}}


async def test_a_site_watch_matches_through_reaches(db):
    person_a, person_b = await _people(db, "A", "B")
    initiative = await _initiative(db, "Initiative A")
    site, other = await _site(db, "Site A"), await _site(db, "Site B")
    await _watch(db, person_a, _on(site, "site"))
    await _watch(db, person_b, _on(other, "site"))

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative), _on(site, "site"))
    assert await matching_routes(db, event) == {person_a.id: {"watch"}}


async def test_a_watch_whose_events_exclude_the_type_does_not_match(db):
    narrow, wide, named = await _people(db, "A", "B", "C")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, narrow, _on(initiative), [TRUCK_CHANGED])
    await _watch(db, wide, _on(initiative))                         # no events named: all
    await _watch(db, named, _on(initiative), [TRUCK_CHANGED, INITIATIVE_CHANGED])

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative))
    assert await matching_routes(db, event) == {wide.id: {"watch"}, named.id: {"watch"}}

    # a truck on the initiative: the narrow watch hears it
    truck = Truck(name="Truck A", initiative_id=initiative.id)
    db.add(truck)
    await db.commit()
    event = await _event(db, TRUCK_CHANGED, _on(truck, "truck"), _on(initiative))
    assert await matching_routes(db, event) == {
        narrow.id: {"watch"}, wide.id: {"watch"}, named.id: {"watch"}}


async def test_an_everything_watch_matches_an_everywhere_kind(db):
    person_a, person_b = await _people(db, "A", "B")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person_a, None, [INITIATIVE_CHANGED])
    await _watch(db, person_b, None, [TRUCK_CHANGED])

    # it needs no thing to point at: the initiative is nobody's watch
    event = await _event(db, INITIATIVE_CHANGED, _on(initiative))
    assert await matching_routes(db, event) == {person_a.id: {"watch"}}


@pytest.mark.parametrize("kind", ["initiative", "site", "truck"])
async def test_a_thing_watch_is_not_an_everything_watch(db, kind):
    """A watch on some other thing that names the type does not hear this thing's events,
    whichever column the other thing is in."""
    person, = await _people(db, "A")
    initiative = await _initiative(db, "Initiative A")
    make = {"initiative": lambda: _initiative(db, "Initiative B"),
            "site": lambda: _site(db, "Site A"), "truck": lambda: _truck(db, "Truck A")}
    other = await make[kind]()
    await _watch(db, person, _on(other, kind), [INITIATIVE_CHANGED, TRUCK_CHANGED])

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative))
    assert await matching_routes(db, event) == {}


async def test_an_everything_watch_needs_a_kind_that_is_everywhere(db):
    """Even if the row names a kind that cannot be watched everywhere (the API never stores
    one), the kind's own flag decides."""
    person, = await _people(db, "A")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person, None, ["report_ready"])

    event = await _event(db, "report_ready", _on(initiative))
    assert await matching_routes(db, event) == {}


async def test_watchers_false_gives_nothing(db):
    person, = await _people(db, "A")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person, _on(initiative))
    await _watch(db, person, None, [INITIATIVE_CHANGED])

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative), watchers=False)
    assert await matching_routes(db, event) == {}


async def test_nothing_watched_gives_nothing(db):
    initiative = await _initiative(db, "Initiative A")
    event = await _event(db, INITIATIVE_CHANGED, _on(initiative))
    assert await matching_routes(db, event) == {}


# ── groups ──────────────────────────────────────────────────────────

async def test_an_active_groups_watch_reaches_every_member(db):
    person_a, person_b, outsider = await _people(db, "A", "B", "C")
    group = await _group(db, "Group A", [person_a, person_b])
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, group, _on(initiative))

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative))
    route = f"group:{group.id}"
    assert await matching_routes(db, event) == {person_a.id: {route}, person_b.id: {route}}
    assert outsider.id not in await matching_routes(db, event)


async def test_a_paused_group_gives_nothing(db):
    person, = await _people(db, "A")
    group = await _group(db, "Group A", [person], enabled=False)
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, group, _on(initiative))
    await _watch(db, group, None, [INITIATIVE_CHANGED])

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative))
    assert await matching_routes(db, event) == {}

    # resuming it brings the watches back: nothing about them was stored with the pause
    group.enabled = True
    await db.commit()
    assert await matching_routes(db, event) == {person.id: {f"group:{group.id}"}}


async def test_a_person_in_two_matching_groups_gets_both_routes(db):
    person, other = await _people(db, "A", "B")
    group_a = await _group(db, "Group A", [person, other])
    group_b = await _group(db, "Group B", [person])
    initiative = await _initiative(db, "Initiative A")
    site = await _site(db, "Site A")
    await _watch(db, group_a, _on(initiative))
    await _watch(db, group_b, _on(site, "site"))
    await _watch(db, person, None, [INITIATIVE_CHANGED])

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative), _on(site, "site"))
    assert await matching_routes(db, event) == {
        person.id: {"watch", f"group:{group_a.id}", f"group:{group_b.id}"},
        other.id: {f"group:{group_a.id}"},
    }


async def test_a_group_matching_twice_is_one_route(db):
    """A group that watches both the subject and a thing it reaches hears the event once."""
    person, = await _people(db, "A")
    group = await _group(db, "Group A", [person])
    initiative = await _initiative(db, "Initiative A")
    site = await _site(db, "Site A")
    await _watch(db, group, _on(initiative))
    await _watch(db, group, _on(site, "site"))

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative), _on(site, "site"))
    assert await matching_routes(db, event) == {person.id: {f"group:{group.id}"}}


async def test_the_people_come_in_a_fixed_order(db):
    """The sweep caps its candidates, so which come first has to be the same every time:
    people with a watch of their own (oldest watch first), then the members of the matching
    groups (longest-standing first)."""
    first, second, early, late = await _people(db, "A", "B", "C", "D")
    initiative = await _initiative(db, "Initiative A")
    group = NotificationGroup(name="Group A")
    db.add(group)
    await db.flush()
    start = datetime(2026, 1, 1, tzinfo=UTC)
    day = timedelta(days=1)
    db.add_all([
        NotificationWatch(person_id=second.id, initiative_id=initiative.id, created_at=start),
        NotificationWatch(person_id=first.id, initiative_id=initiative.id, created_at=start - day),
        NotificationWatch(group_id=group.id, initiative_id=initiative.id, created_at=start),
        NotificationGroupMember(group_id=group.id, person_id=late.id, added_at=start + day),
        NotificationGroupMember(group_id=group.id, person_id=early.id, added_at=start - day),
    ])
    await db.commit()

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative))
    assert list(await matching_routes(db, event)) == [first.id, second.id, early.id, late.id]


# ── events as the app announces them ────────────────────────────────

async def test_a_thing_in_reaches_that_nobody_can_watch_is_ignored(db):
    person, = await _people(db, "A")
    initiative = await _initiative(db, "Initiative A")
    site = await _site(db, "Site A")
    await _watch(db, person, _on(site, "site"))

    event = await _event(db, INITIATIVE_CHANGED, _on(initiative),
                         Thing("asset", uuid.uuid4()), _on(site, "site"))
    assert await matching_routes(db, event) == {person.id: {"watch"}}


async def test_a_device_watch_matches_the_devices_event(db):
    """Device offline names the device as its subject and reaches its site and move: a watch of
    any of the three hears it, a watch of another device does not."""
    on_device, on_site, on_initiative, on_other = await _people(db, "A", "B", "C", "D")
    device, other = await _device(db, "Device A"), await _device(db, "Device B")
    site = await _site(db, "Site A")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, on_device, _on(device, "device"))
    await _watch(db, on_site, _on(site, "site"))
    await _watch(db, on_initiative, _on(initiative))
    await _watch(db, on_other, _on(other, "device"))

    event = await _event(db, DEVICE_OFFLINE, _on(device, "device"),
                         _on(site, "site"), _on(initiative))
    assert await matching_routes(db, event) == {
        on_device.id: {"watch"}, on_site.id: {"watch"}, on_initiative.id: {"watch"}}


async def test_status_changes_reach_the_watchers_of_the_things_around_them(db):
    (parent_watcher, site_watcher, start_watcher, truck_watcher, unrelated_watcher,
     everywhere_watcher) = await _people(db, "A", "B", "C", "D", "E", "F")
    parent = await _initiative(db, "Initiative B")
    site, start = await _site(db, "Site A"), await _site(db, "Site B")
    elsewhere = await _site(db, "Site C")
    child = await _initiative(db, "Initiative A", site_id=site.id)
    db.add(InitiativeLink(parent_id=parent.id, child_id=child.id))
    truck = Truck(name="Truck A", initiative_id=child.id, start_site_id=start.id)
    db.add(truck)
    await db.commit()
    await _watch(db, parent_watcher, _on(parent))
    await _watch(db, site_watcher, _on(site, "site"))
    await _watch(db, start_watcher, _on(start, "site"))
    await _watch(db, truck_watcher, _on(truck, "truck"))
    await _watch(db, unrelated_watcher, _on(elsewhere, "site"))
    await _watch(db, everywhere_watcher, None, [INITIATIVE_CHANGED, TRUCK_CHANGED])

    event = await announce_initiative_status_changed(
        db, child, old="planned", new="in_progress", actor_id=None)
    await db.commit()
    # the initiative: its parents and its sites, not the trucks on it
    assert set(await matching_routes(db, event)) == {
        parent_watcher.id, site_watcher.id, everywhere_watcher.id}

    event = await announce_truck_status_changed(
        db, truck, old="created", new="in_transit", actor_id=None)
    await db.commit()
    # the truck: its initiative's parents and its own sites, not the initiative's site
    assert set(await matching_routes(db, event)) == {
        parent_watcher.id, start_watcher.id, truck_watcher.id, everywhere_watcher.id}


# ── what a watch may name ───────────────────────────────────────────

def test_kinds_for():
    assert kinds_for("initiative") == [INITIATIVE_CHANGED, TRUCK_CHANGED, DEVICE_OFFLINE,
                                       RULE_MATCHED]
    assert kinds_for("site") == [INITIATIVE_CHANGED, TRUCK_CHANGED, DEVICE_OFFLINE, RULE_MATCHED]
    assert kinds_for("truck") == [TRUCK_CHANGED]
    assert kinds_for("device") == [DEVICE_OFFLINE]
    # a status rule's notice is about its own initiative: never everywhere
    assert kinds_for(EVERYTHING) == [INITIATIVE_CHANGED, TRUCK_CHANGED, DEVICE_OFFLINE]
    # nothing reaches a kind of thing no kind names
    assert kinds_for("wiki_node") == []


def test_clean_kinds_dedupes_into_registry_order():
    assert clean_kinds("site", [TRUCK_CHANGED, INITIATIVE_CHANGED, TRUCK_CHANGED]) == [
        INITIATIVE_CHANGED, TRUCK_CHANGED]
    assert clean_kinds(EVERYTHING, (TRUCK_CHANGED,)) == [TRUCK_CHANGED]
    # a thing's empty list means every event that applies
    assert clean_kinds("initiative", []) == []


@pytest.mark.parametrize(("thing", "kinds"), [
    ("truck", [INITIATIVE_CHANGED]),
    ("truck", [TRUCK_CHANGED, INITIATIVE_CHANGED]),
    ("device", [INITIATIVE_CHANGED]),
    ("device", [DEVICE_OFFLINE, TRUCK_CHANGED]),
    ("site", ["report_ready"]),                  # a real kind nobody can watch for
    ("initiative", ["nonsense"]),
    (EVERYTHING, ["report_ready"]),
])
def test_clean_kinds_refuses_a_kind_that_does_not_fit(thing, kinds):
    with pytest.raises(WatchError) as caught:
        clean_kinds(thing, kinds)
    assert (caught.value.status, caught.value.code) == (422, "invalid_kind")


def test_everything_must_name_its_events():
    with pytest.raises(WatchError) as caught:
        clean_kinds(EVERYTHING, [])
    assert (caught.value.status, caught.value.code) == (422, "kinds_required")


def test_the_thing_columns_are_every_column_the_table_has():
    """An Everything watch is one with none of them set, so the list has to name them all, and
    each names a kind of thing a watch can be on (the wiki's two included)."""
    foreign = {column.name for column in NotificationWatch.__table__.columns
               if column.foreign_keys}
    assert set(_THING_COLUMNS) == foreign - {"person_id", "group_id", "created_by"}
    assert {spec.column for spec in THINGS.values()} == set(_THING_COLUMNS)
    assert {"wiki_space", "wiki_node"} <= set(THINGS)
