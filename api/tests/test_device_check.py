"""The device check (notifications/device_check.py). Every minute, just before the event sweep,
notification-worker looks for covered devices that have stopped checking in: an RFID Station, a
fixed reader or an approved router (services/device_online.py says which devices are covered and
when each one reads as offline). Each outage is announced once, as a `device_offline` event, and
the device keeps the time of that notice (`offline_notified_at`) until it is seen again. While
read-only maintenance refuses heartbeats, and for the longest threshold after, the check stays
quiet.

Devices are built as tests/test_devices_api.py builds them, each last seen a set time before NOW.
Every check runs in its own session with an explicit `now`, and results are read back in fresh
ones. Email is off, so the sweep only writes inbox rows.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 5, Device offline)
Plan: docs/superpowers/plans/2026-11-02-notifications-phase2-slice2.md (Review Focus, Task 2)"""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.exc import DBAPIError

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import Device, InitiativeLink, NotificationEvent, SystemConfig
from serversherpa.notifications import device_check
from serversherpa.notifications.device_check import run_device_check_once
from serversherpa.notifications.event_sweep import run_events_once
from tests.test_notification_event_sweep import (
    _initiative,
    _notifications,
    _on,
    _person,
    _site,
    _watch,
)

NOW = datetime(2026, 11, 2, 21, 0, tzinfo=UTC)         # 4:00 PM EST
OFFLINE = "device_offline"
QUIET = timedelta(minutes=10)                           # past every threshold


# ── the devices ─────────────────────────────────────────────────────

async def _device(db, device_type: str, name: str = "Device A", *,
                  ago: timedelta | None = QUIET, **fields) -> Device:
    """A device last seen `ago` before NOW, or never for None. Committed."""
    device = Device(device_type=device_type, name=name,
                    last_seen_at=NOW - ago if ago is not None else None, **fields)
    db.add(device)
    await db.commit()
    return device


async def _station(db, name: str = "Device A", **fields) -> Device:
    """An RFID Station: a laptop kiosk set up with station type rfid."""
    return await _device(db, "kiosk", name, sub_type="laptop", station_type="rfid", **fields)


async def _reader(db, name: str = "Device A", **fields) -> Device:
    return await _device(db, "fixed_reader", name, **fields)


async def _router(db, name: str = "Device A", **fields) -> Device:
    return await _device(db, "router", name, **{"approval_state": "approved", **fields})


async def _seen(device: Device, at: datetime) -> None:
    """The device checks in at `at`, as its heartbeat would, in a session of its own."""
    async with get_sessionmaker()() as s:
        await s.execute(update(Device).where(Device.id == device.id).values(last_seen_at=at))
        await s.commit()


async def _read_only(on: bool) -> None:
    """Read-only maintenance mode on or off (the admin section of system_config)."""
    async with get_sessionmaker()() as s:
        row = await s.get(SystemConfig, "admin")
        if row is None:
            s.add(SystemConfig(section="admin", data={"read_only": on}))
        else:
            row.data = {**row.data, "read_only": on}
        await s.commit()


# ── running it and reading it back ──────────────────────────────────

async def _check(now: datetime = NOW, state: dict | None = None) -> int:
    return await run_device_check_once(get_sessionmaker(), now=now, state=state)


async def _sweep(now: datetime = NOW) -> int:
    return await run_events_once(get_sessionmaker(), now=now)


async def _events() -> list[NotificationEvent]:
    async with get_sessionmaker()() as s:
        return list(await s.scalars(select(NotificationEvent).order_by(NotificationEvent.id)))


async def _notified_at(device: Device) -> datetime | None:
    async with get_sessionmaker()() as s:
        return await s.scalar(select(Device.offline_notified_at).where(Device.id == device.id))


def _ref(thing: str, row) -> dict:
    return {"type": thing, "id": str(row.id)}


async def _lockable(device: Device) -> bool:
    """Whether another connection can lock the device's row at once (FOR UPDATE NOWAIT), as a
    heartbeat's write would need to without waiting."""
    async with get_sessionmaker()() as other:
        try:
            await other.execute(select(Device.id).where(Device.id == device.id)
                                .with_for_update(nowait=True))
        except DBAPIError as exc:
            if getattr(exc.orig, "sqlstate", None) != "55P03":      # lock_not_available
                raise
            return False
        finally:
            await other.rollback()
    return True


# ── announcing an outage ────────────────────────────────────────────

async def test_an_offline_station_is_announced(db):
    site = await _site(db, "Site A")
    parent = await _initiative(db, "Initiative B")
    initiative = await _initiative(db, "Initiative A")
    db.add(InitiativeLink(parent_id=parent.id, child_id=initiative.id))
    await db.commit()
    station = await _station(db, site_id=site.id, current_initiative_id=initiative.id)

    assert await _check() == 1
    [event] = await _events()
    assert (event.kind, event.subject_type, event.subject_id) == (OFFLINE, "device", station.id)
    assert event.item == {
        "title": "Device A is offline", "line": "RFID Station · last seen Nov 2, 3:50 PM EST",
        "link": f"/hardware/kiosks/{station.id}", "initiative_id": str(initiative.id),
        "at": None, "list_link": "/hardware/kiosks"}
    # its site, then its move and the moves above it
    assert event.reaches == [_ref("site", site), _ref("initiative", initiative),
                             _ref("initiative", parent)]
    assert event.actor_id is None                      # nobody did this
    assert (event.person_ids, event.group_ids, event.watchers, event.sent_at) == (
        [], [], True, None)
    assert await _notified_at(station) == NOW


async def test_once_per_outage(db):
    """A second check announces nothing more. Once the device is seen again its notice clears,
    and when it goes quiet again that is a new outage with a notice of its own."""
    station = await _station(db)
    assert await _check() == 1

    later = NOW + timedelta(minutes=1)
    assert await _check(later) == 0                    # the same outage
    assert len(await _events()) == 1
    assert await _notified_at(station) == NOW          # still the first notice

    await _seen(station, later)                        # it checks in again
    assert await _check(later + timedelta(seconds=30)) == 0
    assert await _notified_at(station) is None
    assert len(await _events()) == 1

    again = later + timedelta(minutes=3, seconds=1)    # quiet for more than 3 minutes
    assert await _check(again) == 1
    _, second = await _events()
    assert (second.subject_id, second.item["line"]) == (
        station.id, "RFID Station · last seen Nov 2, 4:01 PM EST")
    assert await _notified_at(station) == again


async def test_boundaries_and_kinds(db):
    """Offline means what the screens say. At exactly its threshold a device is still online:
    3 minutes for a station, 4 for a router, which a second later is announced as a Router,
    linked to its row of the routers list. A reader its station reports unreachable is offline
    at once. A device that never checked in, and the devices the check doesn't cover, are never
    announced."""
    station = await _station(db, "Device A", ago=timedelta(minutes=3))
    router = await _router(db, "Device B", ago=timedelta(minutes=4))
    unreachable = await _reader(db, "Device C", ago=timedelta(0), raw_info={"reachable": False})
    never = await _reader(db, "Device D", ago=None, raw_info={"reachable": False})
    uncovered = [
        await _device(db, "kiosk", "Device E", sub_type="android"),
        await _device(db, "kiosk", "Device F", sub_type="laptop", station_type="label"),
        await _device(db, "kiosk", "Device G", sub_type="laptop", station_type="timeclock"),
        await _router(db, "Device H", approval_state="pending"),
        await _router(db, "Device I", approval_state="revoked"),
        await _router(db, "Device J", approval_state=None),
    ]

    assert await _check() == 1                         # the unreachable reader, at once
    [event] = await _events()
    assert event.subject_id == unreachable.id
    assert (event.item["title"], event.item["line"]) == (
        "Device C is offline", "Fixed Reader · last seen Nov 2, 4:00 PM EST")
    assert (event.item["link"], event.item["list_link"]) == (
        f"/hardware/fixed-readers?focus={unreachable.id}", "/hardware/fixed-readers")

    assert await _check(NOW + timedelta(seconds=1)) == 2      # a second past 3 and 4 minutes
    by_device = {event.subject_id: event for event in await _events()}
    assert by_device[station.id].item["line"] == "RFID Station · last seen Nov 2, 3:57 PM EST"
    item = by_device[router.id].item
    assert (item["title"], item["line"]) == (
        "Device B is offline", "Router · last seen Nov 2, 3:56 PM EST")
    assert (item["link"], item["list_link"]) == (
        f"/hardware/routers?focus={router.id}", "/hardware/routers")

    # an hour on, the never-seen reader and the devices that aren't covered are still not
    assert await _check(NOW + timedelta(hours=1)) == 0
    assert set(by_device) == {station.id, router.id, unreachable.id}
    assert len(await _events()) == 3
    for device in (never, *uncovered):
        assert await _notified_at(device) is None, device.name


async def test_a_router_is_named_as_on_the_routers_page(db):
    """A router's notice calls it what the Routers page calls it (device_online.display_name),
    not by its raw hostname, and so does the notification its watchers get."""
    person = await _person(db, "A")
    await _watch(db, person, None, [OFFLINE])            # Device offline, everywhere
    router = await _router(db, "csg_router_kit_19")

    assert await _check() == 1
    [event] = await _events()
    assert (event.subject_id, event.item["title"]) == (router.id, "CSG Router Kit 19 is offline")
    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.title, note.body) == (
        "CSG Router Kit 19 is offline", "Router · last seen Nov 2, 3:50 PM EST")


async def test_a_device_no_longer_covered_is_cleared(db):
    """A device that leaves coverage (a router revoked, a station set up as a Label Station) is
    cleared like one that is seen again, and nothing more is said about it."""
    router = await _router(db, "Device A")
    station = await _station(db, "Device B")
    assert await _check() == 2

    async with get_sessionmaker()() as s:
        await s.execute(update(Device).where(Device.id == router.id)
                        .values(approval_state="revoked"))
        await s.execute(update(Device).where(Device.id == station.id)
                        .values(station_type="label"))
        await s.commit()
    assert await _check(NOW + timedelta(minutes=1)) == 0
    assert (await _notified_at(router), await _notified_at(station)) == (None, None)
    assert len(await _events()) == 2


# ── maintenance and two workers ─────────────────────────────────────

async def test_quiet_during_and_after_read_only(db):
    """Read-only maintenance refuses heartbeats, so every station would look offline. The check
    announces nothing while read-only mode is on, nor for 4 minutes (the longest threshold) after
    the last check that saw it on. A station still offline after that is announced then.
    Clearing doesn't wait: a device seen again inside the window is cleared at once."""
    earlier = await _router(db, "Device B")
    assert await _check(NOW - timedelta(minutes=5)) == 1      # an outage from before it began
    station = await _station(db, "Device A")
    await _read_only(True)

    # with no state kept between checks (the CLI's --once), a check still holds its tongue
    assert await _check() == 0
    state: dict = {}
    assert await _check(NOW, state) == 0
    assert state["quiet_until"] == NOW + timedelta(minutes=4)
    last = NOW + timedelta(minutes=1)
    assert await _check(last, state) == 0              # still on: the window moves on with it
    assert state["quiet_until"] == last + timedelta(minutes=4)

    await _read_only(False)
    await _seen(earlier, last + timedelta(seconds=30))
    assert await _check(last + timedelta(minutes=1), state) == 0
    assert await _notified_at(earlier) is None          # cleared inside the window
    assert await _check(last + timedelta(minutes=3, seconds=59), state) == 0
    assert len(await _events()) == 1                    # only the outage from before
    assert await _notified_at(station) is None

    assert await _check(last + timedelta(minutes=4), state) == 1
    assert [event.subject_id for event in await _events()] == [earlier.id, station.id]


async def test_concurrent_checks_announce_once(db, monkeypatch):
    """Production runs two notification workers on one database. Two checks that claim at the
    same moment announce each outage once between them."""
    devices = [await _station(db, "Device A"), await _station(db, "Device B"),
               await _reader(db, "Device C"), await _router(db, "Device D")]
    # Left alone, one check can finish before the other has even connected; the barrier makes
    # both claim at once, which is the race the row locks are there for.
    real = device_check._announce_offline
    barrier = asyncio.Barrier(2)

    async def together(session, now):
        await barrier.wait()
        return await real(session, now)

    monkeypatch.setattr(device_check, "_announce_offline", together)
    maker = get_sessionmaker()

    announced = await asyncio.wait_for(asyncio.gather(
        run_device_check_once(maker, now=NOW, state={}),
        run_device_check_once(maker, now=NOW, state={})), timeout=30)
    assert sum(announced) == len(devices)
    assert sorted(event.subject_id for event in await _events()) == sorted(
        device.id for device in devices)

    later = NOW + timedelta(minutes=1)                  # and the next minute, nothing more
    assert await asyncio.wait_for(asyncio.gather(
        run_device_check_once(maker, now=later, state={}),
        run_device_check_once(maker, now=later, state={})), timeout=30) == [0, 0]
    assert len(await _events()) == len(devices)


async def test_the_claim_leaves_healthy_devices_unlocked(db, monkeypatch):
    """The check locks only the devices that could be offline: those quiet for longer than the
    shortest threshold (3 minutes), and readers their station reports unreachable. A device seen
    since is not locked, so its heartbeat never waits on the check. While the check holds its
    claim, another connection locks a healthy device at once, and can't lock a candidate.
    `is_offline` still decides: a router quiet for 3 minutes 30 seconds is claimed, but its
    threshold is 4, so it is not announced."""
    healthy = [await _station(db, "Device A", ago=timedelta(minutes=3)),     # exactly 3: online
               await _reader(db, "Device B", ago=timedelta(0)),
               await _router(db, "Device C", ago=timedelta(minutes=1))]
    candidates = [await _station(db, "Device D"),                              # quiet 10 minutes
                  await _reader(db, "Device E", ago=timedelta(0), raw_info={"reachable": False}),
                  await _router(db, "Device F", ago=timedelta(minutes=3, seconds=30))]
    # The barrier holds the check's transaction open right after its claim, while the row locks
    # are held, until the other connection has tried each device.
    real = device_check._announce_offline
    barrier = asyncio.Barrier(2)

    async def holding(session, now):
        announced = await real(session, now)
        await barrier.wait()                            # claimed
        await barrier.wait()                            # tried
        return announced

    monkeypatch.setattr(device_check, "_announce_offline", holding)
    check = asyncio.create_task(run_device_check_once(get_sessionmaker(), now=NOW, state={}))
    await asyncio.wait_for(barrier.wait(), timeout=30)
    try:
        lockable = {device.name: await _lockable(device) for device in (*healthy, *candidates)}
    finally:
        await asyncio.wait_for(barrier.wait(), timeout=30)
    assert await asyncio.wait_for(check, timeout=30) == 2
    assert lockable == {"Device A": True, "Device B": True, "Device C": True,
                        "Device D": False, "Device E": False, "Device F": False}
    assert sorted(event.subject_id for event in await _events()) == sorted(
        device.id for device in candidates[:2])
    assert await _notified_at(candidates[2]) is None


async def test_a_failed_check_keeps_nothing(db, monkeypatch):
    """The check commits once: when it fails partway, no notice and no mark is kept, and the
    next check announces every outage."""
    first = await _station(db, "Device A")
    second = await _reader(db, "Device B")
    real = device_check.announce
    calls = 0

    def failing_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("could not announce")
        return real(*args, **kwargs)

    monkeypatch.setattr(device_check, "announce", failing_second)
    with pytest.raises(RuntimeError):
        await _check()
    assert await _events() == []
    assert (await _notified_at(first), await _notified_at(second)) == (None, None)

    monkeypatch.setattr(device_check, "announce", real)
    assert await _check() == 2


async def test_a_naive_now_is_refused():
    naive = datetime(2026, 11, 2, 21, 0)  # noqa: DTZ001
    with pytest.raises(ValueError, match="timezone-aware"):
        await run_device_check_once(get_sessionmaker(), now=naive)


# ── what the watchers get ───────────────────────────────────────────

async def test_station_and_reader_group_into_one(db):
    """A station and its reader stop together. The watchers of their move get one notification
    for both, a line each in the order they went quiet, linked to the move."""
    person = await _person(db, "A")
    site = await _site(db, "Site A")
    initiative = await _initiative(db, "Initiative A")
    await _watch(db, person, _on(initiative))
    # a reader keeps its station's site and move
    where = {"site_id": site.id, "current_initiative_id": initiative.id}
    station = await _station(db, "Device A", **where)
    reader = await _reader(db, "Device B", ago=timedelta(minutes=9), **where)

    assert await _check() == 2
    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.kind, note.title, note.link) == (
        OFFLINE, "Device offline (2)", f"/initiatives/{initiative.id}")
    assert note.body.split("\n") == [
        "Device A is offline · RFID Station · last seen Nov 2, 3:50 PM EST",
        "Device B is offline · Fixed Reader · last seen Nov 2, 3:51 PM EST"]
    assert note.payload["subjects"] == [_ref("device", station), _ref("device", reader)]
    assert note.payload["via"] == ["watch"]


async def test_mixed_devices_link(db):
    """Several devices that don't share a move link to the list they share, and to nothing when
    they are on different lists."""
    person = await _person(db, "A")
    await _watch(db, person, None, [OFFLINE])            # Device offline, everywhere
    first, second = await _initiative(db, "Initiative A"), await _initiative(db, "Initiative B")
    await _reader(db, "Device A", current_initiative_id=first.id)
    await _reader(db, "Device B", current_initiative_id=second.id)

    assert await _check() == 2
    assert await _sweep() == 1
    [note] = await _notifications(person)
    assert (note.title, note.link) == ("Device offline (2)", "/hardware/fixed-readers")

    await _reader(db, "Device C")
    await _router(db, "Device D")
    later = NOW + timedelta(minutes=1)
    assert await _check(later) == 2
    assert await _sweep(later) == 1
    latest = (await _notifications(person))[-1]
    assert (latest.title, latest.link) == ("Device offline (2)", None)
