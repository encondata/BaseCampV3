"""Status rule notices in the event sweep (notifications/event_sweep.py). What a rule's Notify
action announces (status_rules/notify.py) reaches the people and groups the rule names and, with
its watchers switch on, whoever watches the rule's initiative, the ones above it or the scan's
site. Each person gets one notification per rule per sweep, about the matched things they can
open, counted.

Events are made the way the app makes them: scans go through the rules (status_rules/engine)
in the test's session and are committed, so the Notify action announces them at commit. The
sweep runs in its own sessions with a fixed `now`, and the results are read back in fresh ones.
Email is off unless a test turns it on, and nothing is ever sent.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 4, 6 and 8)
Plan: docs/superpowers/plans/2026-11-03-notifications-phase2-slice4.md (Task 3; calls 5, 7, 8)"""

import uuid
from dataclasses import dataclass

import pytest
from sqlalchemy import delete, update

from serversherpa.db.models import (
    Asset,
    Client,
    Container,
    Initiative,
    InitiativeAsset,
    InitiativeLink,
    NotificationEvent,
    NotificationWatch,
    Partner,
    PermissionOverride,
    Person,
    PersonRole,
    Site,
    StatusRule,
    UserAccount,
    WorkerProfile,
)
from serversherpa.notifications import event_sweep
from serversherpa.notifications.events import Thing
from serversherpa.status_rules.engine import invalidate_cache
from serversherpa.status_rules.notify import rule_link
from tests.test_mail_delivery import _run
from tests.test_notification_event_sweep import (
    _attempts,
    _group,
    _log,
    _notifications,
    _person,
    _sent_at,
    _sweep,
    _watch,
)
from tests.test_status_rule_notify import _add_rule, _events, _match, _notify
from tests.test_watch_recheck import _mail_of, _recheck

RULE_MATCHED = "status_rule_matched"


@pytest.fixture(autouse=True)
def _fresh():
    """Rules are cached per process for 60 s: each test brings its own."""
    invalidate_cache()
    yield
    invalidate_cache()


@dataclass(frozen=True)
class World:
    """Initiative A (a move in progress) under Initiative B, and Site A, where the scans are
    read. Ids only."""

    parent: uuid.UUID
    initiative: uuid.UUID
    site: uuid.UUID


async def _world(db, *, client_id=None) -> World:
    """The world, Initiative A belonging to `client_id` when one is given. Committed."""
    parent = Initiative(name="Initiative B", initiative_type="project")
    initiative = Initiative(name="Initiative A", initiative_type="move", status="in_progress",
                            client_id=client_id)
    site = Site(name="Site A")
    db.add_all([parent, initiative, site])
    await db.flush()
    db.add(InitiativeLink(parent_id=parent.id, child_id=initiative.id))
    await db.commit()
    return World(parent.id, initiative.id, site.id)


async def _roster(db, initiative_id, *serials, client_id=None) -> list[uuid.UUID]:
    """Assets on an initiative's roster, owned by `client_id` when one is given; their ids, in
    order."""
    assets = [Asset(serial_number=serial, status="unknown", client_id=client_id)
              for serial in serials]
    db.add_all(assets)
    await db.flush()
    db.add_all([InitiativeAsset(initiative_id=initiative_id, asset_id=asset.id,
                                status="loaded_in_system") for asset in assets])
    await db.commit()
    return [asset.id for asset in assets]


async def _clients(db) -> tuple[Client, Client]:
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    return client_a, client_b


async def _vendor_admin(db, name, partner) -> Person:
    """Person `name`, with an account in use, a vendor admin of `partner`. Committed."""
    person = Person(first_name="Person", last_name=name, email=f"{name.lower()}@test.example.com")
    db.add(person)
    await db.flush()
    db.add_all([UserAccount(person_id=person.id,
                            email=f"acct-{person.id.hex[:8]}@test.example.com",
                            password_hash="x"),
                PersonRole(person_id=person.id, role="vendor_admin", partner_id=partner.id)])
    await db.commit()
    return person


def _ref(kind, thing_id) -> dict:
    return {"type": kind, "id": str(thing_id)}


def _on(initiative_id) -> Thing:
    return Thing("initiative", initiative_id)


# ── who hears it ────────────────────────────────────────────────────

async def test_rule_notice_reaches_named_people_groups_and_watchers(db):
    """Call 8: the people a rule names hear its notice by the rule ("rule:<id>"), and the
    members of the Active groups it names by the group and the rule. With watchers on, whoever
    watches its initiative or the one above it hears it by their watch, and the members of a
    group watching the scan's site by that group. The Delivery log names the rule and the
    groups. One match says what it matched and links to it."""
    w = await _world(db)
    [asset] = await _roster(db, w.initiative, "SN-A")
    operator = await _person(db, "A")
    named, member, named_member = (await _person(db, "B"), await _person(db, "C"),
                                   await _person(db, "D"))
    paused_member = await _person(db, "E")
    initiative_watcher, parent_watcher = await _person(db, "F"), await _person(db, "G")
    site_group_member = await _person(db, "H")
    group = await _group(db, "Group A", [member, named_member])
    paused = await _group(db, "Group B", [paused_member], enabled=False)
    site_group = await _group(db, "Group C", [site_group_member])
    await _watch(db, initiative_watcher, _on(w.initiative))
    await _watch(db, parent_watcher, _on(w.parent))
    await _watch(db, site_group, Thing("site", w.site))
    rule = await _add_rule(db, "Rule A", _notify(people=[named.id, named_member.id],
                                                 groups=[group.id, paused.id], watchers=True))
    await _match(db, asset=asset, site=w.site, operator=operator.id)
    await db.commit()
    [event] = await _events()

    assert await _sweep() == 6
    by_rule, by_group, by_site = f"rule:{rule}", f"group:{group.id}", f"group:{site_group.id}"
    via = {named: [by_rule], member: [by_group, by_rule], named_member: [by_group, by_rule],
           initiative_watcher: ["watch"], parent_watcher: ["watch"],
           site_group_member: [by_site]}
    for person, routes in via.items():
        [note] = await _notifications(person)
        assert (note.kind, note.title, note.body, note.link) == (
            RULE_MATCHED, "Rule A: SN-A", "Initiative A · Site A", f"/assets?open={asset}")
        assert note.payload == {"events": [event.id], "subjects": [_ref("asset", asset)],
                                "via": routes}, person.last_name
    assert await _notifications(paused_member) == []
    names = {by_rule: "Rule A", by_group: "Group A", by_site: "Group C"}
    assert {entry.person_id: entry.detail for entry in await _log("inbox_written")} == {
        person.id: {"via": routes, "events": [event.id],
                    "names": {route: names[route] for route in routes if route in names}}
        for person, routes in via.items()}


async def test_with_watchers_off_only_the_named_hear(db):
    w = await _world(db)
    [asset] = await _roster(db, w.initiative, "SN-A")
    named, watcher = await _person(db, "B"), await _person(db, "C")
    await _watch(db, watcher, _on(w.initiative))
    rule = await _add_rule(db, "Rule A", _notify(people=[named.id]))
    await _match(db, asset=asset, site=w.site)
    await db.commit()

    assert await _sweep() == 1
    assert [note.payload["via"] for note in await _notifications(named)] == [[f"rule:{rule}"]]
    assert await _notifications(watcher) == []


async def test_the_actor_is_not_notified(db):
    """Call 8: the scan's operator watches the initiative and belongs to the group the rule
    names, and hears nothing of their own scan, nor is anything logged about them. Named as a
    person, they hear it."""
    w = await _world(db)
    first, second = await _roster(db, w.initiative, "SN-A", "SN-B")
    operator, watcher = await _person(db, "A"), await _person(db, "B")
    group = await _group(db, "Group A", [operator])
    for person in (operator, watcher):
        await _watch(db, person, _on(w.initiative))
    await _add_rule(db, "Rule A", _notify(groups=[group.id], watchers=True))
    await _match(db, asset=first, site=w.site, operator=operator.id)
    await db.commit()

    assert await _sweep() == 1
    assert await _notifications(operator) == []
    assert len(await _notifications(watcher)) == 1
    assert {entry.person_id for entry in await _log()} == {watcher.id}

    # named as a person by another rule, the operator hears of their own scan by that rule
    named = await _add_rule(db, "Rule B", _notify(people=[operator.id]), priority=20)
    invalidate_cache()
    await _match(db, asset=second, site=w.site, operator=operator.id)
    await db.commit()
    assert await _sweep() == 2              # the operator's, and Rule A's to the watcher
    [note] = await _notifications(operator)
    assert (note.title, note.payload["via"]) == ("Rule B: SN-B", [f"rule:{named}"])


# ── what each person can see ────────────────────────────────────────

async def test_access_per_matched_thing(db):
    """Review Focus: three assets of Client A's move match one rule in one transaction, and
    Client A owns two of them. Client A's user, watching the move, hears of those two, counted;
    staff watching it hear of all three, as the event tells it. A person the rule names who can
    open none of them is dropped, logged `no_access`. A notification's subjects are the matched
    things that person can see, for the send-time re-check."""
    client_a, client_b = await _clients(db)
    w = await _world(db, client_id=client_a.id)
    [first] = await _roster(db, w.initiative, "SN-A", client_id=client_a.id)
    [other] = await _roster(db, w.initiative, "SN-B", client_id=client_b.id)
    [last] = await _roster(db, w.initiative, "SN-C", client_id=client_a.id)
    viewer = await _person(db, "B", role="client_viewer", client_id=client_a.id)
    staff = await _person(db, "C")
    outsider = await _person(db, "D", role="worker")            # can't open assets
    for person in (viewer, staff):
        await _watch(db, person, _on(w.initiative))
    rule = await _add_rule(db, "Rule A", _notify(people=[outsider.id], watchers=True))
    for asset in (first, other, last):
        await _match(db, asset=asset, site=w.site)
    await db.commit()
    [event] = await _events()
    assert event.item["count"] == 3

    assert await _sweep() == 2
    [some] = await _notifications(viewer)
    assert (some.kind, some.title, some.body, some.link) == (
        RULE_MATCHED, "Rule A (2)", "Initiative A · 2", rule_link(rule))
    assert some.payload == {"events": [event.id],
                            "subjects": [_ref("asset", first), _ref("asset", last)],
                            "via": ["watch"]}
    [every] = await _notifications(staff)
    assert (every.title, every.body, every.link) == (
        "Rule A (3)", "Initiative A · 3", rule_link(rule))
    assert every.payload["subjects"] == [_ref("asset", asset) for asset in (first, other, last)]

    assert await _notifications(outsider) == []
    [dropped] = await _log("inbox_suppressed")
    assert (dropped.person_id, dropped.channel, dropped.kind, dropped.category, dropped.reason,
            dropped.detail) == (outsider.id, "inbox", RULE_MATCHED, "status_rules", "no_access",
                                {"events": [event.id]})


async def test_one_seen_of_a_batch_is_counted_too(db):
    """Seeing one match of a batch is seeing part of it, so it is counted like any part: the
    event holds no text for that one match alone."""
    client_a, client_b = await _clients(db)
    w = await _world(db, client_id=client_a.id)
    [mine] = await _roster(db, w.initiative, "SN-A", client_id=client_a.id)
    theirs = await _roster(db, w.initiative, "SN-B", "SN-C", client_id=client_b.id)
    viewer = await _person(db, "B", role="client_viewer", client_id=client_a.id)
    await _watch(db, viewer, _on(w.initiative))
    rule = await _add_rule(db, "Rule A", _notify(watchers=True))
    for asset in (*theirs, mine):
        await _match(db, asset=asset, site=w.site)
    await db.commit()

    assert await _sweep() == 1
    [note] = await _notifications(viewer)
    assert (note.title, note.body, note.link) == ("Rule A (1)", "Initiative A · 1",
                                                  rule_link(rule))
    assert note.payload["subjects"] == [_ref("asset", mine)]


async def test_a_badge_notice_is_checked_on_the_worker(db):
    """A rule on worker badges: with no initiative, the notice is about the worker, and it
    reaches the people it names who can open that worker's page. Staff can, and so can the
    admin of the partner who supplies them; another partner's admin can't."""
    partner_a, partner_b = Partner(name="Partner A"), Partner(name="Partner B")
    db.add_all([partner_a, partner_b])
    await db.commit()
    worker = await _person(db, "W", role="worker")
    db.add(WorkerProfile(person_id=worker.id, partner_id=partner_a.id))
    await db.commit()
    staff = await _person(db, "B")
    supplier = await _vendor_admin(db, "C", partner_a)
    other_vendor = await _vendor_admin(db, "D", partner_b)
    rule = await _add_rule(db, "Rule P", _notify(people=[staff.id, supplier.id, other_vendor.id]),
                           match="person")
    await _match(db, person=worker.id)
    await db.commit()
    [event] = await _events()
    assert (event.subject_type, event.subject_id) == ("person", worker.id)

    assert await _sweep() == 2
    for person in (staff, supplier):
        [note] = await _notifications(person)
        assert (note.title, note.body, note.link) == (
            "Rule P: Person W", "", f"/people/workers/{worker.id}")
        assert note.payload == {"events": [event.id], "subjects": [_ref("person", worker.id)],
                                "via": [f"rule:{rule}"]}
    assert await _notifications(other_vendor) == []
    [dropped] = await _log("inbox_suppressed")
    assert (dropped.person_id, dropped.reason) == (other_vendor.id, "no_access")


# ── one notification per person per rule ───────────────────────────

async def test_grouped_per_rule(db):
    """One notification per person per rule in a sweep. Two rules matching are two
    notifications, though both are of one kind. One rule matching on two initiatives is one
    notification, a line per initiative with its count, oldest first, linked to the rule's
    executions (calls 5 and 7)."""
    w = await _world(db)
    other = Initiative(name="Initiative C", initiative_type="move", status="in_progress")
    db.add(other)
    await db.commit()
    first, second = await _roster(db, w.initiative, "SN-A", "SN-B")
    [elsewhere] = await _roster(db, other.id, "SN-C")
    person = await _person(db, "B")
    rule_a = await _add_rule(db, "Rule A", _notify(people=[person.id]), priority=10)
    rule_b = await _add_rule(db, "Rule B", _notify(people=[person.id]), priority=20)
    for asset in (first, second):           # one transaction: a batch per rule
        await _match(db, asset=asset, site=w.site)
    await db.commit()
    await _match(db, asset=elsewhere, site=w.site)
    await db.commit()
    events = await _events()
    assert [(event.rule_id, event.item["count"]) for event in events] == [
        (rule_a, 2), (rule_b, 2), (rule_a, 1), (rule_b, 1)]

    assert await _sweep() == 2
    notes = await _notifications(person)
    assert [(note.kind, note.title, note.body, note.link) for note in notes] == [
        (RULE_MATCHED, "Rule A (3)", "Initiative A · 2\nInitiative C · 1", rule_link(rule_a)),
        (RULE_MATCHED, "Rule B (3)", "Initiative A · 2\nInitiative C · 1", rule_link(rule_b))]
    by_rule = {rule_a: [events[0].id, events[2].id], rule_b: [events[1].id, events[3].id]}
    for note, rule in zip(notes, (rule_a, rule_b), strict=True):
        assert note.payload == {
            "events": by_rule[rule],
            "subjects": [_ref("asset", asset) for asset in (first, second, elsewhere)],
            "via": [f"rule:{rule}"]}
    assert [entry.detail["names"] for entry in await _log("inbox_written")] == [
        {f"rule:{rule_a}": "Rule A"}, {f"rule:{rule_b}": "Rule B"}]


async def test_matches_with_no_initiative_are_counted_alone(db):
    """Containers with no move are each an event of their own, about the container. Grouped
    with matches on an initiative, they are counted on a line of their own, last: the count
    alone (call 7). One of them on its own says what it matched and links to it."""
    w = await _world(db)
    person = await _person(db, "B")
    on_a_move = Container(name="Container A", initiative_id=w.initiative)
    loose = [Container(name="Container B"), Container(name="Container C")]
    db.add_all([on_a_move, *loose])
    await db.commit()
    rule = await _add_rule(db, "Rule C", _notify(people=[person.id]), match="container")
    for container in (loose[0], on_a_move, loose[1]):
        await _match(db, container=container.id, site=w.site)
        await db.commit()

    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.title, note.body, note.link) == ("Rule C (3)", "Initiative A · 1\n2",
                                                  rule_link(rule))
    assert note.payload["subjects"] == [_ref("container", container.id)
                                        for container in (loose[0], on_a_move, loose[1])]

    last = Container(name="Container D")
    db.add(last)
    await db.commit()
    await _match(db, container=last.id, site=w.site)
    await db.commit()
    assert await _sweep() == 1
    latest = (await _notifications(person))[-1]
    assert (latest.title, latest.body, latest.link) == (
        "Rule C: Container D", "Site A", f"/logistics/containers?open={last.id}")


async def test_a_rule_deleted_before_the_sweep(db):
    """A rule deleted after it matched: its events lose their rule but still reach the people
    it named (by "direct": there is no rule to name), counted under the kind's label with no
    link when there are several, and no rule name goes in the log."""
    w = await _world(db)
    first, second = await _roster(db, w.initiative, "SN-A", "SN-B")
    person = await _person(db, "B")
    rule = await _add_rule(db, "Rule A", _notify(people=[person.id]))
    for asset in (first, second):           # two transactions: two events
        await _match(db, asset=asset, site=w.site)
        await db.commit()
    await db.delete(await db.get(StatusRule, rule))
    await db.commit()
    invalidate_cache()
    assert [event.rule_id for event in await _events()] == [None, None]

    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.kind, note.title, note.body, note.link) == (
        RULE_MATCHED, "Status rule matched (2)", "Initiative A · 2", None)
    assert note.payload["via"] == ["direct"]
    [written] = await _log("inbox_written")
    assert written.detail["names"] == {}


async def test_a_malformed_rule_notice_fails_on_its_own(db, monkeypatch):
    """A rule's notice whose ids are not ids, its matched things' or its initiative's, waits to
    be tried again, and the rest of the sweep goes out."""
    monkeypatch.setattr(event_sweep, "_failing", set())
    w = await _world(db)
    [asset] = await _roster(db, w.initiative, "SN-A")
    person = await _person(db, "B")
    rule = await _add_rule(db, "Rule A", _notify(people=[person.id]))
    await _match(db, asset=asset, site=w.site)
    await db.commit()
    [good] = await _events()
    broken = [NotificationEvent(kind=RULE_MATCHED, subject_type="initiative",
                                subject_id=w.initiative, person_ids=[person.id], rule_id=rule,
                                item={**good.item, **fields})
              for fields in ({"matched_ids": ["SN-A"]}, {"initiative_id": "Initiative A"})]
    db.add_all(broken)
    await db.commit()

    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.title, note.payload["events"]) == ("Rule A: SN-A", [good.id])
    for event in broken:
        assert (await _attempts(event), await _sent_at(event)) == (1, None)


# ── the send-time re-check ──────────────────────────────────────────

async def test_the_send_time_recheck_judges_the_matched_things(db, email_on):
    """The email of a rule's notice goes while the person can still open one of the matched
    things they heard of. Client A's user heard of two assets; once Client A owns neither, it is
    dropped `no_access`, though the move is still theirs. With them back, no route left is
    `not_watching`."""
    client_a, client_b = await _clients(db)
    w = await _world(db, client_id=client_a.id)
    first, second = await _roster(db, w.initiative, "SN-A", "SN-B", client_id=client_a.id)
    viewer = await _person(db, "B", role="client_viewer", client_id=client_a.id)
    await _watch(db, viewer, _on(w.initiative))
    await _add_rule(db, "Rule A", _notify(watchers=True))
    for asset in (first, second):
        await _match(db, asset=asset, site=w.site)
    await db.commit()
    assert await _sweep() == 1
    mail = await _mail_of(viewer)
    assert (mail.status, mail.kind) == ("queued", RULE_MATCHED)
    assert await _recheck(mail) is None

    await _run(update(Asset).where(Asset.id == first).values(client_id=client_b.id))
    assert await _recheck(mail) is None             # the other one is still theirs
    await _run(update(Asset).where(Asset.id == second).values(client_id=client_b.id))
    assert await _recheck(mail) == "no_access"

    await _run(update(Asset).where(Asset.id.in_([first, second])).values(client_id=client_a.id))
    assert await _recheck(mail) is None
    await _run(delete(NotificationWatch).where(NotificationWatch.person_id == viewer.id))
    assert await _recheck(mail) == "not_watching"


async def test_the_recheck_asks_every_kind_of_thing(db, email_on):
    """Deleted rules' notices go together whatever each matched, so one notification can list an
    asset and a container. Its email goes while the person can open either."""
    w = await _world(db)
    [asset] = await _roster(db, w.initiative, "SN-A")
    container = Container(name="Container A")
    db.add(container)
    await db.commit()
    person = await _person(db, "B")
    rules = [await _add_rule(db, "Rule A", _notify(people=[person.id])),
             await _add_rule(db, "Rule C", _notify(people=[person.id]), match="container")]
    await _match(db, asset=asset, site=w.site)
    await _match(db, container=container.id, site=w.site)
    await db.commit()
    for rule in rules:
        await db.delete(await db.get(StatusRule, rule))
    await db.commit()
    invalidate_cache()

    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.title, note.body) == ("Status rule matched (2)", "Initiative A · 1\n1")
    assert note.payload["subjects"] == [_ref("asset", asset), _ref("container", container.id)]
    mail = await _mail_of(person)
    assert await _recheck(mail) is None

    for resource, expected in (("assets", None), ("containers", "no_access")):
        db.add(PermissionOverride(person_id=person.id, resource=resource, action="view",
                                  allow=False))
        await db.commit()
        assert await _recheck(mail) == expected, resource
