"""The event sweep (notifications/event_sweep.py): waiting notification_events rows become
inbox notifications for the people they reach, one per person per type per sweep. Events are
built the way the app builds them, through the two status-change helpers (announce() for the
people and groups a piece of code names), and committed; the sweep runs in its own sessions
with a fixed `now`, and the results are read back in fresh ones. Email is off, so nothing is
ever queued.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 4, Anti-goals)"""

import asyncio
import logging
from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Client,
    Initiative,
    InitiativeLink,
    Notification,
    NotificationEvent,
    NotificationGroup,
    NotificationGroupMember,
    NotificationLog,
    NotificationWatch,
    Person,
    PersonRole,
    Site,
    StatusRule,
    Truck,
    UserAccount,
)
from serversherpa.notifications import event_sweep
from serversherpa.notifications.event_sweep import run_events_once
from serversherpa.notifications.events import EventItem, Thing, announce
from serversherpa.notifications.status_changes import (
    announce_initiative_status_changed,
    announce_truck_status_changed,
)
from serversherpa.notifications.watches import THINGS

NOW = datetime(2026, 11, 2, 21, 0, tzinfo=UTC)
INITIATIVE_CHANGED = "initiative_status_changed"
TRUCK_CHANGED = "truck_status_changed"
SWEEP_LOGGER = "serversherpa.notifications.event_sweep"


# ── the world ───────────────────────────────────────────────────────

async def _person(db, name, *, role="staff", client_id=None, prefs=None) -> Person:
    """Person `name` with an account in use and `role` (anchored to a client when one is
    given). Staff can open every initiative, site and truck. Committed."""
    person = Person(first_name="Person", last_name=name, email=f"{name.lower()}@test.example.com")
    db.add(person)
    await db.flush()
    db.add(UserAccount(person_id=person.id, email=f"acct-{person.id.hex[:8]}@test.example.com",
                       password_hash="x", ui_prefs=prefs or {}))
    db.add(PersonRole(person_id=person.id, role=role, client_id=client_id))
    await db.commit()
    return person


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


async def _truck(db, name, initiative=None, **fields) -> Truck:
    row = Truck(name=name, initiative_id=initiative.id if initiative else None, **fields)
    db.add(row)
    await db.commit()
    return row


def _on(row, kind="initiative") -> Thing:
    return Thing(kind, row.id)


async def _watch(db, subscriber, thing=None, kinds=()) -> None:
    """A watch for `subscriber` (a Person or a NotificationGroup) on `thing`, or an Everything
    watch when `thing` is None. Committed on its own, so watches made in turn are oldest
    first."""
    fields = ({"person_id": subscriber.id} if isinstance(subscriber, Person)
              else {"group_id": subscriber.id})
    if thing is not None:
        fields[THINGS[thing.type].column] = thing.id
    db.add(NotificationWatch(kinds=list(kinds), **fields))
    await db.commit()


async def _initiative_changed(db, initiative, *, actor=None) -> NotificationEvent:
    """`initiative` moved from Planned to In progress, announced and committed."""
    event = await announce_initiative_status_changed(
        db, initiative, old="planned", new="in_progress",
        actor_id=actor.id if actor is not None else None)
    await db.commit()
    return event


async def _truck_changed(db, truck, old="created", new="active", *, at=None) -> NotificationEvent:
    event = await announce_truck_status_changed(db, truck, old=old, new=new, actor_id=None, at=at)
    await db.commit()
    return event


# ── reading it back ─────────────────────────────────────────────────

async def _sweep() -> int:
    return await run_events_once(get_sessionmaker(), now=NOW)


async def _notifications(person) -> list[Notification]:
    async with get_sessionmaker()() as s:
        return list(await s.scalars(select(Notification)
                                    .where(Notification.person_id == person.id)
                                    .order_by(Notification.created_at)))


async def _log(*events) -> list[NotificationLog]:
    q = select(NotificationLog).order_by(NotificationLog.id)
    if events:
        q = q.where(NotificationLog.event.in_(events))
    async with get_sessionmaker()() as s:
        return list(await s.scalars(q))


async def _sent_at(event) -> datetime | None:
    async with get_sessionmaker()() as s:
        return await s.scalar(select(NotificationEvent.sent_at)
                              .where(NotificationEvent.id == event.id))


def _sweep_lines(caplog) -> list[str]:
    return [record.getMessage() for record in caplog.records if record.name == SWEEP_LOGGER]


# ── who hears it ────────────────────────────────────────────────────

async def test_watcher_gets_one_notification(db):
    person = await _person(db, "A")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person, _on(initiative))
    event = await _initiative_changed(db, initiative)

    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.kind, note.title, note.body, note.link) == (
        INITIATIVE_CHANGED, "Initiative A: Planned → In progress", "",
        f"/initiatives/{initiative.id}")
    assert note.payload == {"events": [event.id],
                            "subjects": [{"type": "initiative", "id": str(initiative.id)}],
                            "via": ["watch"]}
    [written] = await _log("inbox_written")
    assert (written.person_id, written.notification_id, written.kind, written.category) == (
        person.id, note.id, INITIATIVE_CHANGED, "initiatives")
    assert written.detail == {"via": ["watch"], "events": [event.id], "names": {}}
    assert await _sent_at(event) == NOW

    # sent once: nothing is waiting any more
    assert await _sweep() == 0
    assert len(await _notifications(person)) == 1


async def test_parent_watch_hears_the_child(db):
    person = await _person(db, "A")
    parent = await _initiative(db, "Initiative B")
    child = await _initiative(db, "Initiative A")
    db.add(InitiativeLink(parent_id=parent.id, child_id=child.id))
    await db.commit()
    await _watch(db, person, _on(parent))
    await _initiative_changed(db, child)

    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.title, note.link) == ("Initiative A: Planned → In progress",
                                       f"/initiatives/{child.id}")
    assert note.payload["via"] == ["watch"]


async def test_site_watch_hears_through_reaches(db):
    """An initiative's change reaches its sites, and a truck's its start and end sites."""
    person = await _person(db, "A")
    site = await _site(db, "Site A")
    initiative = await _initiative(db, "Initiative A", site_id=site.id)
    truck = await _truck(db, "Truck A", end_site_id=site.id)
    await _watch(db, person, _on(site, "site"))
    await _initiative_changed(db, initiative)
    await _truck_changed(db, truck)

    assert await _sweep() == 2
    assert [(note.kind, note.title) for note in await _notifications(person)] == [
        (INITIATIVE_CHANGED, "Initiative A: Planned → In progress"),
        (TRUCK_CHANGED, "Truck A: Created → Active")]


async def test_kinds_filter(db):
    """A watch narrowed to truck changes hears no initiative change, only its trucks'."""
    person = await _person(db, "A")
    initiative = await _initiative(db, "Initiative A")
    truck = await _truck(db, "Truck A", initiative)
    await _watch(db, person, _on(initiative), [TRUCK_CHANGED])
    await _initiative_changed(db, initiative)

    assert await _sweep() == 0
    assert await _notifications(person) == []

    await _truck_changed(db, truck)
    assert await _sweep() == 1
    assert [note.kind for note in await _notifications(person)] == [TRUCK_CHANGED]


async def test_everything_watch_respects_client_scope(db):
    """A client's user with an Everything watch hears their own client's initiatives only.
    Another client's change is logged no_access for them and never reaches their inbox."""
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    person = await _person(db, "A", role="client_viewer", client_id=client_a.id)
    await _watch(db, person, None, [INITIATIVE_CHANGED])
    initiative_a = await _initiative(db, "Initiative A", client_id=client_a.id)
    initiative_b = await _initiative(db, "Initiative B", client_id=client_b.id)
    event_a = await _initiative_changed(db, initiative_a)
    event_b = await _initiative_changed(db, initiative_b)

    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.title, note.body, note.link) == (
        "Initiative A: Planned → In progress", "", f"/initiatives/{initiative_a.id}")
    assert note.payload["events"] == [event_a.id]
    [dropped] = await _log("inbox_suppressed")
    assert (dropped.person_id, dropped.channel, dropped.kind, dropped.category,
            dropped.reason, dropped.detail) == (
        person.id, "inbox", INITIATIVE_CHANGED, "initiatives", "no_access",
        {"events": [event_b.id]})
    assert await _sent_at(event_b) == NOW


async def test_paused_group_hears_nothing(db):
    member = await _person(db, "A")
    group = await _group(db, "Group A", [member], enabled=False)
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, group, _on(initiative))
    await _watch(db, group, None, [INITIATIVE_CHANGED])
    event = await _initiative_changed(db, initiative)

    assert await _sweep() == 0
    assert await _notifications(member) == []
    assert await _log() == []
    assert await _sent_at(event) == NOW             # handled all the same


async def test_enabled_group_members_hear(db):
    member_a, member_b = await _person(db, "A"), await _person(db, "B")
    outsider = await _person(db, "C")
    group = await _group(db, "Group A", [member_a, member_b])
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, group, _on(initiative))
    event = await _initiative_changed(db, initiative)

    assert await _sweep() == 2
    route = f"group:{group.id}"
    for member in (member_a, member_b):
        [note] = await _notifications(member)
        assert note.payload["via"] == [route]
    assert await _notifications(outsider) == []
    assert [entry.detail for entry in await _log("inbox_written")] == [
        {"via": [route], "events": [event.id], "names": {route: "Group A"}}] * 2


async def test_actor_never_notified(db):
    """The editor watches the initiative directly, through a group and through Everything,
    and still hears nothing of their own change; nothing is logged about them either."""
    editor, watcher = await _person(db, "A"), await _person(db, "B")
    group = await _group(db, "Group A", [editor])
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, editor, _on(initiative))
    await _watch(db, group, _on(initiative))
    await _watch(db, editor, None, [INITIATIVE_CHANGED])
    await _watch(db, watcher, _on(initiative))
    await _initiative_changed(db, initiative, actor=editor)

    assert await _sweep() == 1
    assert await _notifications(editor) == []
    assert len(await _notifications(watcher)) == 1
    assert {entry.person_id for entry in await _log()} == {watcher.id}


async def test_inactive_people_skipped(db):
    active, disabled, archived = (await _person(db, "A"), await _person(db, "B"),
                                  await _person(db, "C"))
    await db.execute(update(UserAccount).where(UserAccount.person_id == disabled.id)
                     .values(disabled_at=NOW))
    await db.execute(update(Person).where(Person.id == archived.id).values(archived_at=NOW))
    await db.commit()
    initiative = await _initiative(db, "Initiative A")
    for person in (active, disabled, archived):
        await _watch(db, person, _on(initiative))
    await _initiative_changed(db, initiative)

    assert await _sweep() == 1
    assert len(await _notifications(active)) == 1
    assert await _notifications(disabled) == []
    assert await _notifications(archived) == []
    assert {entry.person_id for entry in await _log()} == {active.id}


async def test_two_routes_one_notification(db):
    person = await _person(db, "A")
    group = await _group(db, "Group A", [person])
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person, _on(initiative))
    await _watch(db, group, _on(initiative))
    event = await _initiative_changed(db, initiative)

    assert await _sweep() == 1
    route = f"group:{group.id}"
    [note] = await _notifications(person)
    assert note.payload["via"] == [route, "watch"]
    [written] = await _log("inbox_written")
    assert written.detail == {"via": [route, "watch"], "events": [event.id],
                              "names": {route: "Group A"}}


async def test_named_people_and_groups_hear_without_watches(db):
    """The people and the Active groups a piece of code names hear the event even when
    watches are off for it, the actor too when named; a rule's names arrive by the rule."""
    actor, named = await _person(db, "A"), await _person(db, "B")
    member, paused_member = await _person(db, "C"), await _person(db, "D")
    watcher = await _person(db, "E")
    group = await _group(db, "Group A", [member])
    paused = await _group(db, "Group B", [paused_member], enabled=False)
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, watcher, _on(initiative))
    rule = StatusRule(name="Rule A", trigger_status="rfid_4_into_cage", trigger_match_type="asset")
    db.add(rule)
    await db.commit()

    def named_event(**fields) -> NotificationEvent:
        return announce(db, INITIATIVE_CHANGED, subject=_on(initiative),
                        item=EventItem("Initiative A: Planned → In progress",
                                       link=f"/initiatives/{initiative.id}",
                                       initiative_id=initiative.id),
                        watchers=False, **fields)

    named_event(actor_id=actor.id, person_ids=[actor.id, named.id],
                group_ids=[group.id, paused.id])
    await db.commit()
    assert await _sweep() == 3
    assert [note.payload["via"] for note in await _notifications(actor)] == [["direct"]]
    assert [note.payload["via"] for note in await _notifications(named)] == [["direct"]]
    assert [note.payload["via"] for note in await _notifications(member)] == [
        [f"group:{group.id}"]]
    assert await _notifications(paused_member) == []
    assert await _notifications(watcher) == []      # watches are off for these events

    named_event(person_ids=[named.id], rule_id=rule.id)
    await db.commit()
    assert await _sweep() == 1
    assert [note.payload["via"] for note in await _notifications(named)] == [
        ["direct"], [f"rule:{rule.id}"]]


# ── one notification per person per type ───────────────────────────

async def test_burst_groups_into_one_notification(db):
    """A MacroPoint apply moves three trucks of one initiative, one of them twice: each of
    the initiative's watchers gets one notification, a line per change, oldest first, linked
    to the initiative. Changes on different initiatives link to the trucks list."""
    watchers = [await _person(db, "A"), await _person(db, "B")]
    initiative = await _initiative(db, "Initiative A")
    trucks = [await _truck(db, f"Truck {name}", initiative) for name in "ABC"]
    for person in watchers:
        await _watch(db, person, _on(initiative))
    at = datetime(2026, 11, 2, 20, 4, tzinfo=UTC)       # the message's own time
    events = [await _truck_changed(db, trucks[0]),
              await _truck_changed(db, trucks[1]),
              await _truck_changed(db, trucks[0], "active", "in_transit", at=at),
              await _truck_changed(db, trucks[2])]

    assert await _sweep() == 2
    for person in watchers:
        [note] = await _notifications(person)
        assert note.title == "Truck status changed (4)"
        assert note.body.split("\n") == ["Truck A: Created → Active",
                                         "Truck B: Created → Active",
                                         "Truck A: Active → In Transit · Nov 2, 3:04 PM EST",
                                         "Truck C: Created → Active"]
        assert note.link == f"/initiatives/{initiative.id}"
        assert note.payload == {
            "events": [event.id for event in events],
            "subjects": [{"type": "truck", "id": str(truck.id)} for truck in trucks],
            "via": ["watch"]}
    [entry, _] = await _log("inbox_written")
    assert entry.detail["events"] == [event.id for event in events]

    # trucks of two initiatives, and one of none: the trucks list
    everywhere = await _person(db, "C")
    await _watch(db, everywhere, None, [TRUCK_CHANGED])
    other = await _truck(db, "Truck D", await _initiative(db, "Initiative B"))
    loose = await _truck(db, "Truck E")
    await _truck_changed(db, trucks[2], "active", "in_transit")
    await _truck_changed(db, other)
    await _truck_changed(db, loose)
    assert await _sweep() == 3          # Person C's three, and A's and B's one each
    [note] = await _notifications(everywhere)
    assert (note.title, note.link) == ("Truck status changed (3)", "/logistics/trucks")
    assert note.body.split("\n") == ["Truck C: Active → In Transit", "Truck D: Created → Active",
                                     "Truck E: Created → Active"]
    for person in watchers:            # one item of their initiative: its own title and link
        latest = (await _notifications(person))[-1]
        assert (latest.title, latest.link) == ("Truck C: Active → In Transit",
                                               f"/logistics/trucks/{trucks[2].id}")


async def test_category_off_is_still_respected(db):
    """A watch never overrides a switch: with Trucks off in the inbox, nothing is written,
    and the log row says by which route it would have come."""
    person = await _person(db, "A", prefs={
        "notif": {"switches": {"trucks": {"inbox": False, "email": False}}}})
    truck = await _truck(db, "Truck A")
    await _watch(db, person, _on(truck, "truck"))
    event = await _truck_changed(db, truck)

    assert await _sweep() == 0
    assert await _notifications(person) == []
    [entry] = await _log()
    assert (entry.event, entry.person_id, entry.kind, entry.category, entry.reason) == (
        "inbox_suppressed", person.id, TRUCK_CHANGED, "trucks", "category_off")
    assert entry.detail == {"source": "own", "via": ["watch"], "events": [event.id],
                            "names": {}}
    assert await _sent_at(event) == NOW


# ── limits and failures ─────────────────────────────────────────────

async def test_cap(db, monkeypatch, caplog):
    """At most MAX_RECIPIENTS candidates per event, in route order and before any filter."""
    monkeypatch.setattr(event_sweep, "MAX_RECIPIENTS", 2)
    first, second, third = await _person(db, "A"), await _person(db, "B"), await _person(db, "C")
    initiative = await _initiative(db, "Initiative A")
    for person in (first, second, third):           # oldest watch first
        await _watch(db, person, _on(initiative))
    event = await _initiative_changed(db, initiative)
    caplog.set_level(logging.WARNING, logger=SWEEP_LOGGER)

    assert await _sweep() == 2
    assert [len(await _notifications(person)) for person in (first, second, third)] == [1, 1, 0]
    assert _sweep_lines(caplog) == [f"notification event {event.id} capped at 2 of 3 candidates"]

    # the cap comes first: with the first watcher archived, only the second hears it
    await db.execute(update(Person).where(Person.id == first.id).values(archived_at=NOW))
    await db.commit()
    await _initiative_changed(db, initiative)
    assert await _sweep() == 1
    assert [len(await _notifications(person)) for person in (first, second, third)] == [1, 2, 0]


async def test_deleted_subject_is_dropped(db):
    """An initiative deleted before the sweep: the event is marked sent, and nobody hears of
    it or is logged about it, the watchers of what it reached and of Everything included."""
    person = await _person(db, "A")
    site = await _site(db, "Site A")
    initiative = await _initiative(db, "Initiative A", site_id=site.id)
    await _watch(db, person, _on(site, "site"))
    await _watch(db, person, None, [INITIATIVE_CHANGED])
    event = await _initiative_changed(db, initiative)
    await db.execute(delete(Initiative).where(Initiative.id == initiative.id))
    await db.commit()

    assert await _sweep() == 0
    assert await _sent_at(event) == NOW
    assert await _notifications(person) == []
    assert await _log() == []


async def test_concurrent_sweeps_do_not_double_send(db):
    """Two workers sweeping at once: each event is claimed by one of them."""
    watchers = [await _person(db, name) for name in "ABC"]
    initiative = await _initiative(db, "Initiative A")
    truck = await _truck(db, "Truck A", initiative)
    for person in watchers:
        await _watch(db, person, _on(initiative))
    await _initiative_changed(db, initiative)
    await _truck_changed(db, truck)

    maker = get_sessionmaker()
    written = await asyncio.wait_for(asyncio.gather(run_events_once(maker, now=NOW),
                                                    run_events_once(maker, now=NOW)),
                                     timeout=30)
    assert sum(written) == 6
    for person in watchers:
        assert sorted(note.kind for note in await _notifications(person)) == [
            INITIATIVE_CHANGED, TRUCK_CHANGED]


async def test_events_another_sweep_holds_are_skipped(db):
    person = await _person(db, "A")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person, _on(initiative))
    event = await _initiative_changed(db, initiative)

    async with get_sessionmaker()() as other:       # another sweep is handling it
        await other.execute(select(NotificationEvent).with_for_update())
        # skipped, not waited for: a claim that blocks fails here instead of hanging
        assert await asyncio.wait_for(_sweep(), timeout=10) == 0
        await other.rollback()
    assert await _sent_at(event) is None
    assert await _log() == []

    assert await _sweep() == 1


async def test_failed_event_stays_waiting(db, monkeypatch, caplog):
    monkeypatch.setattr(event_sweep, "_failing", set())
    person_a, person_b = await _person(db, "A"), await _person(db, "B")
    initiative_a = await _initiative(db, "Initiative A")
    initiative_b = await _initiative(db, "Initiative B")
    await _watch(db, person_a, _on(initiative_a))
    await _watch(db, person_b, _on(initiative_b))
    stuck = await _initiative_changed(db, initiative_a)
    sent = await _initiative_changed(db, initiative_b)
    real = event_sweep.matching_routes

    async def failing_for_one(session, event):
        if event.id == stuck.id:
            raise RuntimeError("could not read person-a@test.example.com")
        return await real(session, event)

    monkeypatch.setattr(event_sweep, "matching_routes", failing_for_one)
    caplog.set_level(logging.WARNING, logger=SWEEP_LOGGER)
    assert await _sweep() == 1                      # the other event still goes out
    assert await _notifications(person_a) == []
    assert len(await _notifications(person_b)) == 1
    assert await _sent_at(stuck) is None
    assert await _sent_at(sent) == NOW
    assert _sweep_lines(caplog) == [
        f"could not send notification event {stuck.id} — retrying (RuntimeError)"]
    assert "person-a@test.example.com" not in caplog.text     # the class only, never the text

    assert await _sweep() == 0                      # still failing: logged once
    assert len(_sweep_lines(caplog)) == 1

    monkeypatch.setattr(event_sweep, "matching_routes", real)
    assert await _sweep() == 1                      # the next sweep sends it
    assert len(await _notifications(person_a)) == 1
    assert await _sent_at(stuck) == NOW


async def test_a_failed_write_rolls_the_whole_sweep_back(db, monkeypatch):
    """A notification that can't be written undoes the sweep, its log rows included, and
    every event waits for the next one."""
    person = await _person(db, "A")
    outsider = await _person(db, "B", role="worker")      # can't open initiatives
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person, _on(initiative))
    await _watch(db, outsider, None, [INITIATIVE_CHANGED])
    event = await _initiative_changed(db, initiative)
    real = event_sweep.notify

    async def failing(*args, **kwargs):
        raise RuntimeError("write failed")

    monkeypatch.setattr(event_sweep, "notify", failing)
    with pytest.raises(RuntimeError):
        await _sweep()
    assert await _sent_at(event) is None
    assert await _log() == []

    monkeypatch.setattr(event_sweep, "notify", real)
    assert await _sweep() == 1
    assert [entry.reason for entry in await _log("inbox_suppressed")] == ["no_access"]
    assert await _sent_at(event) == NOW
