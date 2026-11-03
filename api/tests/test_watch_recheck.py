"""The send-time re-check of an email the event sweep wrote (event_sweep.watch_recheck, asked by
email.recheck_notification for a queued email and for a held one), and the watches Check delivery
lists. Worlds are built the way the app builds them: through the status-change helpers, the real
device check and the real sweep, so the notification's payload is genuine. What happens meanwhile
(a watch deleted, a group paused, access taken away, a device seen again) is done in a session of
its own, as another request would do it, and the re-check is asked in yet another, as the delivery
worker asks it. Nothing is ever sent to a real server.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 4, 5 and 8)"""

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import delete, select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Client,
    Device,
    EmailOutbox,
    Initiative,
    Notification,
    NotificationEvent,
    NotificationGroup,
    NotificationGroupMember,
    NotificationHeld,
    NotificationLog,
    NotificationWatch,
    PermissionOverride,
    Person,
    UserAccount,
)
from serversherpa.mail import outbox as outbox_mod
from serversherpa.mail.delivery import deliver_once
from serversherpa.notifications import email as email_mod
from serversherpa.notifications.check import check_delivery
from serversherpa.notifications.company import load_company_settings
from serversherpa.notifications.email import recheck_before_send, recheck_notification
from serversherpa.notifications.event_sweep import run_events_once, watch_recheck
from serversherpa.notifications.events import EventItem, announce
from serversherpa.notifications.kinds import kind_info
from serversherpa.notifications.summary import run_summaries_once
from tests.test_device_check import _check as _device_check
from tests.test_device_check import _notified_at, _reader, _seen, _station
from tests.test_mail_delivery import FakeSend, _assert_dropped, _get, _run
from tests.test_notification_event_sweep import (
    INITIATIVE_CHANGED,
    NOW,
    TRUCK_CHANGED,
    _group,
    _initiative,
    _initiative_changed,
    _notifications,
    _on,
    _person,
    _site,
    _truck,
    _watch,
)

OFFLINE = "device_offline"
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


# ── the world ───────────────────────────────────────────────────────

async def _sweep() -> int:
    return await run_events_once(get_sessionmaker(), now=NOW)


async def _mail_of(person) -> EmailOutbox:
    """The one email queued for `person`."""
    async with get_sessionmaker()() as s:
        return await s.scalar(select(EmailOutbox).where(EmailOutbox.person_id == person.id))


async def _recheck(mail) -> str | None:
    """What the delivery worker asks just before it sends: in a session of its own."""
    async with get_sessionmaker()() as s:
        return await recheck_before_send(s, mail)


async def _queued(db):
    """Person A watches Initiative A, whose status change the sweep has turned into a
    notification and a queued email. Returns the person, the initiative and the email."""
    person = await _person(db, "A")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person, _on(initiative))
    await _initiative_changed(db, initiative)
    assert await _sweep() == 1
    mail = await _mail_of(person)
    assert (mail.status, mail.kind) == ("queued", INITIATIVE_CHANGED)
    return person, initiative, mail


async def _devices_offline(db, count=1, *, prefs=None):
    """Person A watches each of `count` devices (an RFID Station, then a fixed reader), all of
    which have stopped checking in. The device check has announced them and the sweep has turned
    that into one notification. Returns the person and the devices."""
    person = await _person(db, "A", prefs=prefs)
    devices = [await _station(db, "Device A")]
    if count == 2:      # the reader went quiet a minute after the station: that is their order
        devices.append(await _reader(db, "Device B", ago=timedelta(minutes=9)))
    for device in devices:
        await _watch(db, person, _on(device, "device"))
    assert await _device_check() == count
    assert await _sweep() == 1
    return person, devices


async def _back(*devices) -> None:
    """The devices check in again, and the next device check clears their notices."""
    later = NOW + timedelta(minutes=1)
    for device in devices:
        await _seen(device, later)
    assert await _device_check(later + timedelta(seconds=30)) == 0
    for device in devices:
        assert await _notified_at(device) is None


async def _pause(group, enabled=False) -> None:
    await _run(update(NotificationGroup).where(NotificationGroup.id == group.id)
               .values(enabled=enabled))


async def _outbox() -> list[EmailOutbox]:
    async with get_sessionmaker()() as s:
        return list(await s.scalars(select(EmailOutbox).order_by(EmailOutbox.created_at)))


async def _held() -> list[NotificationHeld]:
    async with get_sessionmaker()() as s:
        return list(await s.scalars(select(NotificationHeld).order_by(NotificationHeld.id)))


async def _skipped() -> list[NotificationLog]:
    async with get_sessionmaker()() as s:
        return list(await s.scalars(select(NotificationLog)
                                    .where(NotificationLog.event == "email_skipped")
                                    .order_by(NotificationLog.id)))


# ── the re-check ────────────────────────────────────────────────────

async def test_recheck_not_watching_after_unwatch(db, email_on):
    """The person stops watching after the email was queued: the worker drops it, and the
    delivery log says so."""
    person, _, mail = await _queued(db)
    assert await _recheck(mail) is None             # still watching

    await _run(delete(NotificationWatch).where(NotificationWatch.person_id == person.id))
    assert await _recheck(mail) == "not_watching"

    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    log = await _assert_dropped(mail.id, "not_watching")
    assert (log.person_id, log.notification_id, log.outbox_id) == (
        person.id, mail.notification_id, mail.id)
    assert (log.kind, log.category) == (INITIATIVE_CHANGED, "initiatives")


async def test_recheck_not_watching_after_pause(db, email_on):
    """The route was Group A. Pausing the group stops its watches at once, for email already
    queued as for new events; resuming it brings the person back."""
    person = await _person(db, "A")
    group = await _group(db, "Group A", [person])
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, group, _on(initiative))
    await _initiative_changed(db, initiative)
    assert await _sweep() == 1
    mail = await _mail_of(person)
    assert await _recheck(mail) is None

    await _pause(group)
    assert await _recheck(mail) == "not_watching"
    await _pause(group, enabled=True)
    assert await _recheck(mail) is None

    # a member who leaves the group is no longer reached through it
    await _run(delete(NotificationGroupMember)
               .where(NotificationGroupMember.group_id == group.id))
    assert await _recheck(mail) == "not_watching"


async def test_a_held_email_is_dropped_when_its_group_is_paused(db, email_on, clock):
    """Review Focus: an email already held from a group's watch is dropped at send time. The
    other group's member, who was held the same way, still gets the summary."""
    person_a = await _person(db, "A", prefs=QUIET)
    person_b = await _person(db, "B", prefs=QUIET)
    group_a = await _group(db, "Group A", [person_a])
    group_b = await _group(db, "Group B", [person_b])
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, group_a, _on(initiative))
    await _watch(db, group_b, _on(initiative))
    await _initiative_changed(db, initiative)
    clock(EVENING)
    assert await _sweep() == 2
    held = {row.person_id: row for row in await _held()}
    assert set(held) == {person_a.id, person_b.id}

    await _pause(group_a)
    clock(MORNING)
    assert await run_summaries_once(get_sessionmaker(), now=MORNING) == 1       # B's summary
    assert await _held() == []
    [dropped] = await _skipped()
    assert (dropped.person_id, dropped.notification_id, dropped.reason) == (
        person_a.id, held[person_a.id].notification_id, "not_watching")
    [summary] = await _outbox()
    assert (summary.template, summary.person_id) == ("notification_summary", person_b.id)


async def test_recheck_no_access(db, email_on):
    """Taking `initiatives:view` away (a deny override) drops the email of an initiative's
    change the person can no longer open."""
    person, _, mail = await _queued(db)
    assert await _recheck(mail) is None

    db.add(PermissionOverride(person_id=person.id, resource="initiatives", action="view",
                              allow=False))
    await db.commit()
    assert await _recheck(mail) == "no_access"

    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    await _assert_dropped(mail.id, "no_access")


async def test_recheck_no_access_needs_every_subject_out_of_reach(db, email_on):
    """A burst lists several initiatives: the email goes while the person can open any of
    them. Row scope decides here: a client's user sees that client's initiatives only."""
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    person = await _person(db, "A", role="client_viewer", client_id=client_a.id)
    await _watch(db, person, None, [INITIATIVE_CHANGED])            # an Everything watch
    first = await _initiative(db, "Initiative A", client_id=client_a.id)
    second = await _initiative(db, "Initiative B", client_id=client_a.id)
    await _initiative_changed(db, first)
    await _initiative_changed(db, second)
    assert await _sweep() == 1
    mail = await _mail_of(person)
    assert await _recheck(mail) is None

    await _run(update(Initiative).where(Initiative.id == first.id).values(client_id=client_b.id))
    assert await _recheck(mail) is None             # Initiative B is still theirs to open
    await _run(update(Initiative).where(Initiative.id == second.id)
               .values(client_id=client_b.id))
    assert await _recheck(mail) == "no_access"

    # a subject that is gone has no viewers either
    await _run(update(Initiative).where(Initiative.id.in_([first.id, second.id]))
               .values(client_id=client_a.id))
    assert await _recheck(mail) is None
    await _run(delete(Initiative).where(Initiative.id.in_([first.id, second.id])))
    assert await _recheck(mail) == "no_access"


async def test_recheck_keeps_a_still_watched_email(db, email_on):
    _, _, mail = await _queued(db)
    assert await _recheck(mail) is None

    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert [call["to"] for call in send.calls] == ["a@test.example.com"]
    row = await _get(mail.id)
    assert (row.status, row.skip_reason, row.attempts) == ("sent", None, 1)
    assert await _skipped() == []


async def test_recheck_order(db, email_on):
    """The first reason that applies decides. Everything is wrong here at once; each fix
    shows the next reason: an inactive person, lost access, no route, the Email switch."""
    person, initiative, mail = await _queued(db)
    await _run(delete(NotificationWatch).where(NotificationWatch.person_id == person.id))
    db.add(PermissionOverride(person_id=person.id, resource="initiatives", action="view",
                              allow=False))
    await db.commit()
    await _run(update(UserAccount).where(UserAccount.person_id == person.id)
               .values(ui_prefs={"notif": {"switches": {"initiatives": {"email": False}}}}))
    await _run(update(Person).where(Person.id == person.id).values(archived_at=NOW))

    # the new reasons come after what the inbox row itself says
    await _run(update(Notification).where(Notification.id == mail.notification_id)
               .values(read_at=NOW))
    assert await _recheck(mail) == "read"
    await _run(update(Notification).where(Notification.id == mail.notification_id)
               .values(read_at=None))

    assert await _recheck(mail) == "recipient_inactive"
    await _run(update(Person).where(Person.id == person.id).values(archived_at=None))
    assert await _recheck(mail) == "no_access"
    await _run(delete(PermissionOverride).where(PermissionOverride.person_id == person.id))
    assert await _recheck(mail) == "not_watching"
    await _watch(db, person, _on(initiative))
    assert await _recheck(mail) == "category_turned_down"
    await _run(update(UserAccount).where(UserAccount.person_id == person.id).values(ui_prefs={}))
    assert await _recheck(mail) is None


@pytest.mark.parametrize("first_to_go", ["A", "B"])
async def test_recheck_any_event_that_still_reaches_is_enough(db, email_on, first_to_go):
    """A notification stands for every event of its burst: it is dropped only when none of
    them reaches the person, whichever order the watches go in."""
    person = await _person(db, "A")
    initiatives = {name: await _initiative(db, f"Initiative {name}") for name in "AB"}
    for initiative in initiatives.values():
        await _watch(db, person, _on(initiative))
    for initiative in initiatives.values():
        await _initiative_changed(db, initiative)
    assert await _sweep() == 1
    mail = await _mail_of(person)
    assert await _recheck(mail) is None

    last = "B" if first_to_go == "A" else "A"
    for name, expected in ((first_to_go, None), (last, "not_watching")):
        await _run(delete(NotificationWatch)
                   .where(NotificationWatch.initiative_id == initiatives[name].id))
        assert await _recheck(mail) == expected


async def test_recheck_a_named_route_holds_without_a_watch(db, email_on):
    """A person the code named is always reached; a member of a group it named is reached
    while that group is Active. Neither needs a watch."""
    named, member = await _person(db, "A"), await _person(db, "B")
    group = await _group(db, "Group A", [member])
    initiative = await _initiative(db, "Initiative A")
    announce(db, INITIATIVE_CHANGED, subject=_on(initiative),
             item=EventItem("Initiative A: Planned → In progress",
                            link=f"/initiatives/{initiative.id}", initiative_id=initiative.id),
             watchers=False, person_ids=[named.id], group_ids=[group.id])
    await db.commit()
    assert await _sweep() == 2
    named_mail, member_mail = await _mail_of(named), await _mail_of(member)
    assert await _recheck(named_mail) is None
    assert await _recheck(member_mail) is None

    await _pause(group)
    assert await _recheck(member_mail) == "not_watching"
    assert await _recheck(named_mail) is None
    await _pause(group, enabled=True)
    assert await _recheck(member_mail) is None


async def test_recheck_lets_it_through_when_the_events_are_gone(db, email_on):
    """The Logging retention removes old events. With none left there is nothing to check the
    person against, so the checks that need them are skipped."""
    person, _, mail = await _queued(db)
    await _run(delete(NotificationWatch).where(NotificationWatch.person_id == person.id))
    assert await _recheck(mail) == "not_watching"

    await _run(delete(NotificationEvent))
    assert await _recheck(mail) is None


async def test_a_notification_that_names_no_events_is_not_asked(db):
    for payload in ({}, {"state": "pending"}, {"events": [], "subjects": []}):
        note = Notification(person_id=uuid.uuid4(), kind="report_ready", title="Ready",
                            payload=payload)
        assert await watch_recheck(db, note) is None


# ── a Device offline email whose devices are back ───────────────────

async def test_held_email_dropped_when_back_online(db, email_on, clock):
    """Review Focus: a Device offline email held for the summary is dropped at send time once its
    device has been seen again. The delivery log says `back_online`, and the inbox row stays as
    it was."""
    person = await _person(db, "A", prefs=QUIET)
    station = await _station(db, "Device A")
    await _watch(db, person, _on(station, "device"))
    assert await _device_check() == 1
    clock(EVENING)
    assert await _sweep() == 1
    [held] = await _held()
    assert (held.person_id, held.kind, held.category) == (person.id, OFFLINE, "devices")

    await _back(station)
    clock(MORNING)
    assert await run_summaries_once(get_sessionmaker(), now=MORNING) == 0      # nothing to say
    assert await _held() == []
    assert await _outbox() == []
    [dropped] = await _skipped()
    assert (dropped.person_id, dropped.notification_id, dropped.reason) == (
        person.id, held.notification_id, "back_online")
    assert (dropped.kind, dropped.category) == (OFFLINE, "devices")

    # the notice itself is still in their inbox, unread and visible
    [note] = await _notifications(person)
    assert (note.id, note.title) == (held.notification_id, "Device A is offline")
    assert (note.read_at, note.dismissed_at) == (None, None)


async def test_held_email_of_a_device_still_offline_is_summarized(db, email_on, clock):
    """The same world with the device still down: the summary goes."""
    person = await _person(db, "A", prefs=QUIET)
    station = await _station(db, "Device A")
    await _watch(db, person, _on(station, "device"))
    assert await _device_check() == 1
    clock(EVENING)
    assert await _sweep() == 1

    clock(MORNING)
    assert await run_summaries_once(get_sessionmaker(), now=MORNING) == 1
    [summary] = await _outbox()
    assert (summary.template, summary.person_id) == ("notification_summary", person.id)
    assert await _skipped() == []


async def test_one_device_still_offline_keeps_the_email(db, email_on):
    """A burst names several devices, and the email goes while any of them is still offline."""
    person, [station, reader] = await _devices_offline(db, 2)
    mail = await _mail_of(person)
    assert (mail.status, mail.kind) == ("queued", OFFLINE)
    [note] = await _notifications(person)
    assert note.title == "Device offline (2)"
    assert note.payload["subjects"] == [{"type": "device", "id": str(station.id)},
                                        {"type": "device", "id": str(reader.id)}]
    assert await _recheck(mail) is None

    await _back(station)
    assert await _recheck(mail) is None             # the reader has not come back

    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert [call["to"] for call in send.calls] == ["a@test.example.com"]
    row = await _get(mail.id)
    assert (row.status, row.skip_reason, row.attempts) == ("sent", None, 1)
    assert await _skipped() == []


async def test_queued_email_dropped_once_every_device_is_back_or_gone(db, email_on):
    """The delivery worker drops a queued email when the last device in it is seen again, and a
    device that has been deleted counts as back."""
    person, [station, reader] = await _devices_offline(db, 2)
    mail = await _mail_of(person)
    assert await _recheck(mail) is None

    await _back(station)
    assert await _recheck(mail) is None             # one is back, the reader is not
    await _run(delete(Device).where(Device.id == reader.id))
    assert await _recheck(mail) == "back_online"    # its watch went with it; that is no matter

    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    log = await _assert_dropped(mail.id, "back_online")
    assert (log.person_id, log.notification_id, log.outbox_id) == (
        person.id, mail.notification_id, mail.id)
    assert (log.kind, log.category) == (OFFLINE, "devices")


async def test_a_device_that_went_quiet_again_keeps_the_email(db, email_on):
    """Back online is the device's state now. One that has gone quiet again since (a new outage,
    with a notice of its own) is offline, so an older email about it still goes."""
    person, [station] = await _devices_offline(db, 1)
    mail = await _mail_of(person)
    await _back(station)
    assert await _recheck(mail) == "back_online"

    await _run(update(Device).where(Device.id == station.id).values(offline_notified_at=NOW))
    assert await _recheck(mail) is None


async def test_back_online_runs_before_category_turned_down(db, email_on):
    """The first reason that applies decides, and `back_online` comes right after `resolved`:
    ahead of the inbox row's own state, the person, their access and watches, and their Email
    switch. All of those are wrong here at once. While the device is down the first of them
    shows; once it is back, `back_online` does."""
    person, [station] = await _devices_offline(db, 1)
    mail = await _mail_of(person)
    await _run(delete(NotificationWatch).where(NotificationWatch.person_id == person.id))
    db.add(PermissionOverride(person_id=person.id, resource="scanning_hardware", action="view",
                              allow=False))
    await db.commit()
    await _run(update(UserAccount).where(UserAccount.person_id == person.id)
               .values(ui_prefs={"notif": {"switches": {"devices": {"email": False}}}}))
    await _run(update(Person).where(Person.id == person.id).values(archived_at=NOW))
    await _run(update(Notification).where(Notification.id == mail.notification_id)
               .values(read_at=NOW, dismissed_at=NOW))

    assert await _recheck(mail) == "hidden"
    await _back(station)
    assert await _recheck(mail) == "back_online"

    # with the device down again, the reasons come in their usual order
    await _run(update(Device).where(Device.id == station.id).values(offline_notified_at=NOW))
    assert await _recheck(mail) == "hidden"
    await _run(update(Notification).where(Notification.id == mail.notification_id)
               .values(dismissed_at=None))
    assert await _recheck(mail) == "read"
    await _run(update(Notification).where(Notification.id == mail.notification_id)
               .values(read_at=None))
    assert await _recheck(mail) == "recipient_inactive"
    await _run(update(Person).where(Person.id == person.id).values(archived_at=None))
    assert await _recheck(mail) == "no_access"
    await _run(delete(PermissionOverride).where(PermissionOverride.person_id == person.id))
    assert await _recheck(mail) == "not_watching"
    await _watch(db, person, _on(station, "device"))
    assert await _recheck(mail) == "category_turned_down"


async def test_back_online_is_for_device_offline_alone(db):
    """Only a Device offline notification is asked whether its devices are back, and only when it
    names one: a notification of another kind that lists a device is not judged by it, and one
    that names no device has nothing to judge. A person nobody knows ends at `recipient_inactive`,
    the first reason after `back_online`, so that is what "not back" reads as here."""
    station = await _station(db, "Device A")        # never announced: its notice is clear
    named = {"type": "device", "id": str(station.id)}
    gone = {"type": "device", "id": str(uuid.uuid4())}
    company = await load_company_settings(db)

    async def reason(kind, payload):
        note = Notification(person_id=uuid.uuid4(), kind=kind, title="Title", payload=payload)
        return await recheck_notification(db, note, kind_info(kind), None, company)

    for subjects in ([named], [gone], [named, gone]):
        assert await reason(OFFLINE, {"subjects": subjects}) == "back_online", subjects
    assert await reason(INITIATIVE_CHANGED, {"subjects": [named]}) == "recipient_inactive"
    for payload in ({}, {"subjects": []},
                    {"subjects": [{"type": "site", "id": str(uuid.uuid4())}]}):
        assert await reason(OFFLINE, payload) == "recipient_inactive", payload

    # one device still carrying its notice is enough to keep the email, deleted ones aside
    station.offline_notified_at = NOW
    await db.commit()
    for subjects in ([named], [named, gone]):
        assert await reason(OFFLINE, {"subjects": subjects}) == "recipient_inactive", subjects
    assert await reason(OFFLINE, {"subjects": [gone]}) == "back_online"


# ── Check delivery ──────────────────────────────────────────────────

def _you() -> dict:
    return {"type": "you", "id": None, "name": None}


def _via(group) -> dict:
    return {"type": "group", "id": group.id, "name": group.name}


async def test_check_lists_the_watches_that_would_hear_the_kind(db):
    """For Truck status changed: the person's own truck watch and their group's site watch.
    An initiative watch narrowed to the other event would not hear it, and a Paused group's
    watch gives nothing."""
    person = await _person(db, "A")
    group = await _group(db, "Group A", [person])
    paused = await _group(db, "Group B", [person], enabled=False)
    initiative = await _initiative(db, "Initiative A")
    site = await _site(db, "Site A")
    truck = await _truck(db, "Truck A")
    await _watch(db, person, _on(truck, "truck"))
    await _watch(db, group, _on(site, "site"))
    await _watch(db, person, _on(initiative), [INITIATIVE_CHANGED])
    await _watch(db, paused, _on(truck, "truck"))

    result = await check_delivery(db, person.id, TRUCK_CHANGED, now=NOW)
    assert result["watches"] == [
        {"thing": "truck", "thing_id": truck.id, "thing_name": "Truck A", "kinds": [],
         "via": _you()},
        {"thing": "site", "thing_id": site.id, "thing_name": "Site A", "kinds": [],
         "via": _via(group)},
    ]
    assert not db.new and not db.dirty             # reads only

    # the other kind: the narrowed initiative watch hears it, a truck watch can't
    result = await check_delivery(db, person.id, INITIATIVE_CHANGED, now=NOW)
    assert result["watches"] == [
        {"thing": "initiative", "thing_id": initiative.id, "thing_name": "Initiative A",
         "kinds": [INITIATIVE_CHANGED], "via": _you()},
        {"thing": "site", "thing_id": site.id, "thing_name": "Site A", "kinds": [],
         "via": _via(group)},
    ]


async def test_check_a_kind_nobody_can_watch_has_no_watches(db):
    person = await _person(db, "A")
    await _watch(db, person, None, [INITIATIVE_CHANGED])
    result = await check_delivery(db, person.id, "report_ready", now=NOW)
    assert result["watches"] is None

    # a watchable kind nobody watches for is an empty list, not null
    nobody = await _person(db, "B")
    assert (await check_delivery(db, nobody.id, TRUCK_CHANGED, now=NOW))["watches"] == []


async def test_check_lists_everything_watches_by_their_events_and_ignores_access(db):
    """An Everything watch hears the kinds it names. Whether the person can open the thing is
    not asked: that is for the sweep to decide, per thing."""
    person = await _person(db, "A")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person, None, [INITIATIVE_CHANGED])
    await _watch(db, person, _on(initiative))
    db.add(PermissionOverride(person_id=person.id, resource="initiatives", action="view",
                              allow=False))
    await db.commit()

    result = await check_delivery(db, person.id, INITIATIVE_CHANGED, now=NOW)
    assert [(entry["thing"], entry["thing_id"], entry["thing_name"], entry["kinds"])
            for entry in result["watches"]] == [
        ("initiative", initiative.id, "Initiative A", []),
        ("everything", None, None, [INITIATIVE_CHANGED])]

    result = await check_delivery(db, person.id, TRUCK_CHANGED, now=NOW)
    assert [(entry["thing"], entry["kinds"]) for entry in result["watches"]] == [
        ("initiative", [])]                         # the Everything watch names the other event
