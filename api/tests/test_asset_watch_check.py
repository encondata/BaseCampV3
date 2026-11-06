"""The asset-watch check (notifications/asset_watch_check.py). Every minute, after the device check
and before the event sweep, notification-worker compares each asset watch's snapshot with the
asset as it is now. A watch that is due sends its person one `asset_watch` notice and ends: a Next
update watch once anything about the asset differs, a Status becomes watch once the status it
reads is the one it waits for (or the asset has left the initiative it was set on).

Watches are armed with the service (notifications/asset_watches.py), one change is made, the check
runs in its own session with a fixed `now`, and the results are read back in fresh sessions.
Email is off, so only inbox rows are written.

Spec: docs/superpowers/specs/2026-11-05-asset-watches-design.md (What counts, How it's checked,
When it fires, Notice wording)
Plan: docs/superpowers/plans/2026-11-05-asset-watches.md (Review Focus, Task 2)"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset,
    AssetWatch,
    Client,
    Container,
    ContainerAsset,
    Initiative,
    InitiativeAsset,
    Notification,
    Person,
    ProcessedScan,
    Site,
    Truck,
    TruckContainer,
    UserAccount,
)
from serversherpa.notifications import asset_watch_check
from serversherpa.notifications.asset_watch_check import run_asset_watches_once, watch_time
from serversherpa.notifications.asset_watches import add_asset_watch
from serversherpa.scans.manual import SOURCE_ASSET_EDIT, record_asset_status_edit
from tests.test_notification_event_sweep import _log, _notifications, _person

NOW = datetime(2026, 11, 5, 20, 5, tzinfo=UTC)          # Nov 5, 15:05 EST
SET_AT = datetime(2026, 11, 5, 19, 0, tzinfo=UTC)       # Nov 5, 14:00 EST
KIND = "asset_watch"
LOGGER = "serversherpa.notifications.asset_watch_check"


# ── the world ───────────────────────────────────────────────────────

async def _asset(db, serial="SN-1", status="active", **fields) -> Asset:
    asset = Asset(serial_number=serial, status=status, **fields)
    db.add(asset)
    await db.commit()
    return asset


async def _move(db, name="Move A", **fields) -> Initiative:
    move = Initiative(name=name, initiative_type="move", **fields)
    db.add(move)
    await db.commit()
    return move


async def _row(db, move, asset, status="loaded_in_system") -> InitiativeAsset:
    row = InitiativeAsset(initiative_id=move.id, asset_id=asset.id, status=status)
    db.add(row)
    await db.commit()
    return row


async def _site(db, name="Site A") -> Site:
    site = Site(name=name)
    db.add(site)
    await db.commit()
    return site


async def _crate(db, asset=None, name="Crate 1", truck=None) -> Container:
    """Container `name`, holding `asset` when one is given, on `truck` when one is given."""
    container = Container(name=name)
    db.add(container)
    await db.flush()
    if asset is not None:
        db.add(ContainerAsset(container_id=container.id, asset_id=asset.id))
    if truck is not None:
        db.add(TruckContainer(truck_id=truck.id, container_id=container.id))
    await db.commit()
    return container


async def _truck(db, name="Truck 7") -> Truck:
    truck = Truck(name=name)
    db.add(truck)
    await db.commit()
    return truck


async def _arm(db, person, asset, initiative=None, status=None, *, at=None) -> AssetWatch:
    """`person` watching `asset` (on `initiative` when one is given), for `status` when one is
    given, else for its next update. Set with the service and committed; `at` restamps when it
    was set."""
    watch = await add_asset_watch(
        db, person.id, asset_id=asset.id,
        initiative_id=initiative.id if initiative is not None else None,
        condition="status" if status is not None else "next_update", status=status)
    await db.commit()
    if at is not None:
        await db.execute(update(AssetWatch).where(AssetWatch.id == watch.id)
                         .values(created_at=at))
        await db.commit()
    return watch


async def _scan(db, asset, *, at=NOW - timedelta(minutes=4), site=None, raw=1, off_move=False,
                status=None, operator=None) -> ProcessedScan:
    """A processed scan of `asset`, shaped like the scan worker's (`raw` is its raw scan's id) or,
    with `raw` None, like a status edit's (scans/manual.py). Committed."""
    scan = ProcessedScan(
        scanned_value=asset.serial_number, scan_type="rfid" if raw is not None else "manual",
        status=status, scanned_at=at, processed_at=at,
        device_id="reader-1" if raw is not None else "portal",
        operator_id=operator.id if operator is not None else None,
        site_id=site.id if site is not None else None, location_detail="",
        source="kiosk" if raw is not None else SOURCE_ASSET_EDIT, raw_scan_id=raw,
        match_type="asset", asset_id=asset.id, off_move=off_move)
    db.add(scan)
    await db.commit()
    return scan


async def _set(db, row, **fields) -> None:
    """Change `row` (an asset or an initiative row) in SQL, as a writer that leaves no other
    trace would. Committed."""
    model = type(row)
    await db.execute(update(model).where(model.id == row.id).values(**fields))
    await db.commit()


# ── running it and reading it back ──────────────────────────────────

async def _check(now: datetime = NOW) -> int:
    return await run_asset_watches_once(get_sessionmaker(), now=now)


async def _watch_ids() -> set:
    async with get_sessionmaker()() as s:
        return set(await s.scalars(select(AssetWatch.id)))


async def _titles(person) -> list[str]:
    return [note.title for note in await _notifications(person)]


async def _fires_once(person, watch) -> Notification:
    """Run the check: `watch` ends with one notice to `person`."""
    assert await _check() == 1
    assert watch.id not in await _watch_ids()
    [note] = await _notifications(person)
    assert note.kind == KIND
    return note


# ── Next update ─────────────────────────────────────────────────────

async def test_next_update_quiet_without_changes(db):
    person = await _person(db, "A")
    asset = await _asset(db)
    move = await _move(db)
    await _row(db, move, asset)
    on_asset = await _arm(db, person, asset)
    on_move = await _arm(db, person, asset, move)

    assert await _check() == 0
    assert await _check(NOW + timedelta(minutes=1)) == 0
    assert await _notifications(person) == []
    assert await _watch_ids() == {on_asset.id, on_move.id}


async def test_next_update_fires_on_a_scan(db):
    person = await _person(db, "A")
    site = await _site(db, "Site A")
    asset = await _asset(db)
    watch = await _arm(db, person, asset)
    await _scan(db, asset, site=site)

    note = await _fires_once(person, watch)
    assert note.title == "SN-1: scanned at Site A"
    # it has ended: the next check has nothing to say
    assert await _check(NOW + timedelta(minutes=1)) == 0
    assert len(await _notifications(person)) == 1


async def test_next_update_fires_on_a_scan_dated_before_the_watch(db):
    """A long transaction commits a scan stamped before the watch was set, and before the latest
    scan the watch saw: no time tells, but the scan count does (Review Focus 2)."""
    person = await _person(db, "A")
    site = await _site(db, "Site A")
    asset = await _asset(db)
    await _scan(db, asset, site=site, at=datetime.now(UTC) - timedelta(seconds=30))
    watch = await _arm(db, person, asset)
    await _scan(db, asset, site=site, at=watch.created_at - timedelta(minutes=1))

    note = await _fires_once(person, watch)
    assert note.title == "SN-1: scanned at Site A"


async def test_manual_status_edit_title(db):
    person = await _person(db, "A")
    operator = Person(first_name="Pat", last_name="Tester", preferred_name="Patty")
    db.add(operator)
    await db.commit()
    asset = await _asset(db)
    watch = await _arm(db, person, asset)
    # a status edit as the asset page records it: no raw scan, the editor as its operator
    await record_asset_status_edit(db, asset=asset, status="received",
                                   actor_person_id=operator.id, source=SOURCE_ASSET_EDIT)
    asset.status = "received"
    await db.commit()

    note = await _fires_once(person, watch)
    assert note.title == "SN-1: status set to Received by Patty Tester"


async def test_status_edit_with_no_operator_and_scans_with_no_site(db):
    person = await _person(db, "A")
    assets = [await _asset(db, f"SN-{n}") for n in (1, 2, 3)]
    for asset in assets:
        await _arm(db, person, asset)
    await _scan(db, assets[0], raw=None, status="received")
    await _scan(db, assets[1], off_move=True)
    await _scan(db, assets[2])

    assert await _check() == 3
    assert sorted(await _titles(person)) == [
        "SN-1: status set to Received", "SN-2: seen off-move", "SN-3: scanned"]


async def test_off_move_sighting_title(db):
    person = await _person(db, "A")
    site = await _site(db, "Site B")
    asset = await _asset(db)
    watch = await _arm(db, person, asset)
    await _scan(db, asset, site=site, off_move=True)

    note = await _fires_once(person, watch)
    assert note.title == "SN-1: seen off-move at Site B"


async def test_packing_and_truck_titles(db):
    person = await _person(db, "A")
    truck = await _truck(db, "Truck 7")
    to_pack, packed = await _asset(db, "SN-1"), await _asset(db, "SN-2")
    to_load, loaded = await _asset(db, "SN-3"), await _asset(db, "SN-4")
    full = await _crate(db, packed, "Crate 2")
    waiting = await _crate(db, to_load, "Crate 3")
    on_truck = await _crate(db, loaded, "Crate 4", truck=truck)
    for asset in (to_pack, packed, to_load, loaded):
        await _arm(db, person, asset)

    await _crate(db, to_pack, "Crate 1")                              # packed
    await db.execute(delete(ContainerAsset).where(ContainerAsset.container_id == full.id))
    db.add(TruckContainer(truck_id=truck.id, container_id=waiting.id))  # loaded
    await db.execute(delete(TruckContainer).where(TruckContainer.container_id == on_truck.id))
    await db.commit()

    assert await _check() == 4
    assert sorted(await _titles(person)) == [
        "SN-1: packed into Crate 1", "SN-2: taken out of Crate 2", "SN-3: loaded on Truck 7",
        "SN-4: taken off Truck 7"]


async def test_the_container_comes_before_the_truck_and_a_scan_before_both(db):
    person = await _person(db, "A")
    truck = await _truck(db, "Truck 7")
    first, second = await _asset(db, "SN-1"), await _asset(db, "SN-2")
    await _arm(db, person, first)
    await _arm(db, person, second)
    # each goes into a crate that is on a truck; the second is scanned on the way too
    await _crate(db, first, "Crate 1", truck=truck)
    await _crate(db, second, "Crate 2", truck=truck)
    await _scan(db, second)

    assert await _check() == 2
    assert sorted(await _titles(person)) == ["SN-1: packed into Crate 1", "SN-2: scanned"]


async def test_the_truck_comes_before_the_initiatives_and_they_before_the_status(db):
    person = await _person(db, "A")
    truck = await _truck(db, "Truck 7")
    loaded, joined = await _asset(db, "SN-1"), await _asset(db, "SN-2")
    move_a, move_b = await _move(db, "Move A"), await _move(db, "Move B")
    crate = await _crate(db, loaded, "Crate 1")
    row = await _row(db, move_a, joined, status="racked")
    await _arm(db, person, loaded)
    await _arm(db, person, joined, move_a)
    # the first's crate goes onto a truck as it joins a move; the second joins another move as
    # its status on the watched one changes
    db.add(TruckContainer(truck_id=truck.id, container_id=crate.id))
    await db.commit()
    await _row(db, move_a, loaded)
    await _row(db, move_b, joined)
    await _set(db, row, status="on_truck")

    assert await _check() == 2
    assert sorted(await _titles(person)) == ["SN-1: loaded on Truck 7", "SN-2: added to Move B"]


async def test_roster_titles(db):
    person = await _person(db, "A")
    joining, leaving = await _asset(db, "SN-1"), await _asset(db, "SN-2")
    move = await _move(db, "Move A")
    row = await _row(db, move, leaving)
    await _arm(db, person, joining)
    await _arm(db, person, leaving)

    await _row(db, move, joining)
    await db.delete(row)
    await db.commit()

    assert await _check() == 2
    assert sorted(await _titles(person)) == ["SN-1: added to Move A", "SN-2: removed from Move A"]


async def test_record_edit_titles(db):
    person = await _person(db, "A")
    status_edit, location_edit = await _asset(db, "SN-1"), await _asset(db, "SN-2")
    on_move = await _asset(db, "SN-3")
    move = await _move(db, "Move A")
    row = await _row(db, move, on_move, status="racked")
    await _arm(db, person, status_edit)
    await _arm(db, person, location_edit)
    await _arm(db, person, on_move, move)

    await _set(db, status_edit, status="in_transit")                  # no scan behind it
    await _set(db, location_edit, location_detail="Cage 4, row 2")
    await _set(db, row, status="on_truck")                            # the watched row's status

    assert await _check() == 3
    assert sorted(await _titles(person)) == [
        "SN-1: status changed to In Transit", "SN-2: record updated",
        "SN-3: status changed to On Truck"]


async def test_on_an_initiative_the_asset_s_own_status_is_a_record_update(db):
    """A watch set on an initiative reads its row's status there: the asset's own status changing
    is news about its record, not a status change of the watched row."""
    person = await _person(db, "A")
    asset = await _asset(db, status="active")
    move = await _move(db, "Move A")
    await _row(db, move, asset, status="racked")
    watch = await _arm(db, person, asset, move)
    await _set(db, asset, status="in_transit")

    note = await _fires_once(person, watch)
    assert note.title == "SN-1: record updated"


# ── Status becomes ──────────────────────────────────────────────────

async def test_status_watch_on_asset_reads_asset_status(db):
    """Review Focus 1: a watch set on the asset reads the asset's own status, not a row's."""
    person = await _person(db, "A")
    asset = await _asset(db, status="active")
    move = await _move(db, "Move A")
    row = await _row(db, move, asset, status="racked")
    watch = await _arm(db, person, asset, status="in_transit")

    await _set(db, row, status="in_transit")
    assert await _check() == 0
    assert await _watch_ids() == {watch.id}

    await _set(db, asset, status="in_transit")
    note = await _fires_once(person, watch)
    assert note.title == "SN-1 is now In Transit"


async def test_status_watch_on_initiative_reads_row_status(db):
    """Review Focus 1: a watch set on an initiative reads the asset's status there."""
    person = await _person(db, "A")
    asset = await _asset(db, status="active")
    move = await _move(db, "Move A")
    row = await _row(db, move, asset, status="racked")
    watch = await _arm(db, person, asset, move, status="on_truck")

    await _set(db, asset, status="on_truck")
    assert await _check() == 0
    assert await _watch_ids() == {watch.id}

    await _set(db, row, status="on_truck")
    note = await _fires_once(person, watch)
    assert note.title == "SN-1 is now On Truck on Move A"


async def test_status_watch_waits_through_other_changes(db):
    person = await _person(db, "A")
    site = await _site(db, "Site A")
    asset = await _asset(db, status="active")
    watch = await _arm(db, person, asset, status="received")
    await _scan(db, asset, site=site)
    await _set(db, asset, status="in_transit", location_detail="Dock 2")

    assert await _check() == 0
    assert await _watch_ids() == {watch.id}
    assert await _notifications(person) == []


async def test_status_watch_ends_when_the_row_goes(db):
    person = await _person(db, "A")
    site = await _site(db, "Site A")
    asset = await _asset(db, status="active", site_id=site.id)
    move = await _move(db, "Move A")
    row = await _row(db, move, asset, status="racked")
    watch = await _arm(db, person, asset, move, status="on_truck")
    await db.delete(row)
    await db.commit()

    note = await _fires_once(person, watch)
    assert note.title == "SN-1 was removed from Move A"
    # with no row to read, it says the asset's own status
    assert note.body.split("\n") == ["Your watch for status On Truck on it has ended.",
                                     "Now: Active · Site A"]


# ── the notice's text and link ──────────────────────────────────────

async def test_body_lines_and_times(db):
    person = await _person(db, "A")
    site_a, site_b = await _site(db, "Site A"), await _site(db, "Site B")
    operator = Person(first_name="Pat", last_name="Tester")
    db.add(operator)
    await db.commit()
    truck = await _truck(db, "Truck 7")
    scanned = await _asset(db, "SN-1", status="in_transit", site_id=site_a.id,
                           location_detail="Dock 2")
    await _crate(db, scanned, "Crate 1", truck=truck)
    edited = await _asset(db, "SN-2")
    reached = await _asset(db, "SN-3", site_id=site_a.id)
    move = await _move(db, "Move A")
    await _row(db, move, edited, status="racked")
    await _arm(db, person, scanned, at=SET_AT)
    await _arm(db, person, edited, move, at=SET_AT)
    await _arm(db, person, reached, status="received", at=SET_AT)

    await _scan(db, scanned, site=site_b, at=datetime(2026, 11, 5, 20, 1, tzinfo=UTC))
    await _set(db, edited, location_detail="Dock 3")
    await _scan(db, reached, raw=None, status="received", operator=operator,
                at=datetime(2026, 11, 5, 20, 2, tzinfo=UTC))
    await _set(db, reached, status="received")

    assert await _check() == 3
    notices = {note.title: note.body.split("\n") for note in await _notifications(person)}
    assert notices == {
        # a scan is dated by its processed_at
        "SN-1: scanned at Site B": [
            "Scanned at Site B · Nov 5, 15:01 EST",
            "Now: In Transit · Site A · Crate 1 · on Truck 7",
            "You set this watch on Nov 5, 14:00 EST for its next update."],
        # anything else by the moment of the check; on an initiative, its status there
        "SN-2: record updated": [
            "Record updated · Nov 5, 15:05 EST",
            "Now: Racked · Dock 3",
            "On Move A",
            "You set this watch on Nov 5, 14:00 EST for its next update."],
        "SN-3 is now Received": [
            "Now: Received · Site A",
            "Last scan: status set to Received by Pat Tester · Nov 5, 15:02 EST",
            "You set this watch on Nov 5, 14:00 EST for status Received."],
    }


async def test_status_becomes_body_on_an_initiative(db):
    """A Status becomes watch set on an initiative, in full: the title names the initiative, "Now"
    reads the status there, and "Last scan" is there only when a scan came in after the watch
    was set."""
    person = await _person(db, "A")
    site_a, site_b = await _site(db, "Site A"), await _site(db, "Site B")
    truck = await _truck(db, "Truck 7")
    scanned = await _asset(db, "SN-1", site_id=site_a.id)
    await _crate(db, scanned, "Crate 1", truck=truck)
    quiet = await _asset(db, "SN-2", site_id=site_a.id, location_detail="Dock 2")
    await _scan(db, quiet, site=site_b, at=datetime(2026, 11, 5, 18, 30, tzinfo=UTC))
    move = await _move(db, "Move A")
    scanned_row = await _row(db, move, scanned, status="racked")
    quiet_row = await _row(db, move, quiet, status="racked")
    await _arm(db, person, scanned, move, status="on_truck", at=SET_AT)
    await _arm(db, person, quiet, move, status="on_truck", at=SET_AT)

    await _scan(db, scanned, site=site_b, at=datetime(2026, 11, 5, 20, 1, tzinfo=UTC))
    await _set(db, scanned_row, status="on_truck")
    await _set(db, quiet_row, status="on_truck")

    assert await _check() == 2
    notices = {note.title: note.body.split("\n") for note in await _notifications(person)}
    assert notices == {
        "SN-1 is now On Truck on Move A": [
            "Now: On Truck · Site A · Crate 1 · on Truck 7",
            "Last scan: scanned at Site B · Nov 5, 15:01 EST",
            "You set this watch on Nov 5, 14:00 EST for status On Truck."],
        # its only scan came before the watch was set: no Last scan line
        "SN-2 is now On Truck on Move A": [
            "Now: On Truck · Site A · Dock 2",
            "You set this watch on Nov 5, 14:00 EST for status On Truck."],
    }


def test_watch_time_is_24_hour_in_the_reference_zone():
    assert watch_time(datetime(2026, 11, 5, 20, 5, tzinfo=UTC)) == "Nov 5, 15:05 EST"
    assert watch_time(datetime(2026, 7, 1, 13, 7, tzinfo=UTC)) == "Jul 1, 09:07 EDT"
    assert watch_time(datetime(2026, 1, 2, 4, 30, tzinfo=UTC)) == "Jan 1, 23:30 EST"


async def test_links(db):
    person = await _person(db, "A")
    on_asset, on_move, leaving = (await _asset(db, "SN-1"), await _asset(db, "SN-2"),
                                  await _asset(db, "SN-3"))
    move = await _move(db, "Move A")
    row = await _row(db, move, on_move)
    gone = await _row(db, move, leaving)
    await _arm(db, person, on_asset)
    await _arm(db, person, on_move, move)
    await _arm(db, person, leaving, move)

    await _set(db, on_asset, location_detail="Dock 2")
    await _set(db, row, status="racked")
    await db.delete(gone)
    await db.commit()

    assert await _check() == 3
    assert {note.title: note.link for note in await _notifications(person)} == {
        "SN-1: record updated": f"/assets/{on_asset.id}",
        "SN-2: status changed to Racked": f"/initiatives/{move.id}/assets/{row.id}",
        # the row is gone: the asset's own page
        "SN-3: removed from Move A": f"/assets/{leaving.id}",
    }


async def test_the_notice_names_only_what_its_person_can_see(db):
    """A client's user is told what their Assets list shows them: no container or truck (only a
    global person sees those), and no initiative of another client."""
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    staff = await _person(db, "Staff")
    viewer = await _person(db, "Viewer", role="client_viewer", client_id=client_a.id)
    site = await _site(db, "Site A")
    asset = await _asset(db, site_id=site.id, location_detail="Dock 2", client_id=client_a.id)
    truck = await _truck(db, "Truck 7")
    for person in (staff, viewer):
        await _arm(db, person, asset, at=SET_AT)
    await _crate(db, asset, "Crate 1", truck=truck)

    assert await _check() == 2
    [told_staff], [told_viewer] = await _notifications(staff), await _notifications(viewer)
    assert told_staff.title == "SN-1: packed into Crate 1"
    assert told_staff.body.split("\n")[1] == "Now: Active · Site A · Crate 1 · on Truck 7"
    assert told_viewer.title == "SN-1: record updated"
    assert told_viewer.body.split("\n") == [
        "Record updated · Nov 5, 15:05 EST", "Now: Active · Site A · Dock 2",
        "You set this watch on Nov 5, 14:00 EST for its next update."]

    # another client's initiative isn't named to them; their own client's is
    theirs = await _move(db, "Move A", client_id=client_a.id)
    other = await _move(db, "Move B", client_id=client_b.id)
    for person in (staff, viewer):
        await _arm(db, person, asset)
    await _row(db, other, asset)
    assert await _check() == 2
    assert (await _titles(staff))[-1] == "SN-1: added to Move B"
    assert (await _titles(viewer))[-1] == "SN-1: record updated"

    for person in (staff, viewer):
        await _arm(db, person, asset)
    await _row(db, theirs, asset)
    assert await _check() == 2
    assert (await _titles(viewer))[-1] == "SN-1: added to Move A"


# ── who hears ───────────────────────────────────────────────────────

async def test_no_access_or_inactive_ends_silently(db):
    """Review Focus 4: someone whose account is no longer in use, or who can no longer open the
    asset, hears nothing, and the watch ends."""
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    disabled, archived = await _person(db, "A"), await _person(db, "B")
    viewer = await _person(db, "C", role="client_viewer", client_id=client_a.id)
    asset = await _asset(db, client_id=client_a.id)
    for person in (disabled, archived, viewer):
        await _arm(db, person, asset)

    await db.execute(update(UserAccount).where(UserAccount.person_id == disabled.id)
                     .values(disabled_at=NOW))
    await _set(db, archived, archived_at=NOW)
    await _set(db, asset, client_id=client_b.id)       # out of the viewer's client scope
    await _set(db, asset, location_detail="Dock 2")    # then the change

    assert await _check() == 3
    assert await _watch_ids() == set()
    for person in (disabled, archived, viewer):
        assert await _notifications(person) == []


async def test_a_watch_on_an_initiative_needs_its_asset_too(db):
    """When it fires, the person must still be able to open the asset, and the initiative too for
    a watch set there: once the asset is another client's, a watch on their own client's move
    ends without a notice."""
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    viewer = await _person(db, "Viewer", role="client_viewer", client_id=client_a.id)
    asset = await _asset(db, client_id=client_a.id)
    move = await _move(db, "Move A", client_id=client_a.id)
    row = await _row(db, move, asset, status="racked")
    await _arm(db, viewer, asset, move)
    await _set(db, asset, client_id=client_b.id)        # they can still open the move, not it
    await _set(db, row, status="on_truck")

    assert await _check() == 1
    assert await _watch_ids() == set()
    assert await _notifications(viewer) == []


async def test_a_watch_on_an_initiative_they_can_no_longer_open_ends_silently(db):
    """The other half: they can still open the asset, but the initiative the watch was set on is
    another client's now, so the watch ends without a notice."""
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    viewer = await _person(db, "Viewer", role="client_viewer", client_id=client_a.id)
    asset = await _asset(db, client_id=client_a.id)
    move = await _move(db, "Move A", client_id=client_a.id)
    row = await _row(db, move, asset, status="racked")
    await _arm(db, viewer, asset, move)
    await _set(db, move, client_id=client_b.id)         # they can still open the asset, not it
    await _set(db, row, status="on_truck")

    assert await _check() == 1
    assert await _watch_ids() == set()
    assert await _notifications(viewer) == []


async def test_inbox_switch_off_still_ends_the_watch(db):
    person = await _person(db, "A", prefs={"notif": {"switches": {"assets": {"inbox": False}}}})
    asset = await _asset(db)
    await _arm(db, person, asset)
    await _set(db, asset, location_detail="Dock 2")

    assert await _check() == 1
    assert await _watch_ids() == set()
    assert await _notifications(person) == []
    [suppressed] = await _log("inbox_suppressed")
    assert (suppressed.person_id, suppressed.kind, suppressed.category, suppressed.reason) == (
        person.id, KIND, "assets", "category_off")


async def test_two_runs_at_once_notify_once(db, monkeypatch):
    """Review Focus 3: production runs two notification workers on one database. Two checks that
    claim at the same moment tell each person once between them."""
    people = [await _person(db, name) for name in "ABC"]
    asset = await _asset(db)
    for person in people:
        await _arm(db, person, asset)
    await _set(db, asset, location_detail="Dock 2")
    # Left alone, one check can finish before the other has even connected; the barrier makes
    # both claim at once, which is the race the row locks are there for.
    real = asset_watch_check._claim
    barrier = asyncio.Barrier(2)

    async def together(session):
        await barrier.wait()
        return await real(session)

    monkeypatch.setattr(asset_watch_check, "_claim", together)
    maker = get_sessionmaker()

    ended = await asyncio.wait_for(asyncio.gather(
        run_asset_watches_once(maker, now=NOW), run_asset_watches_once(maker, now=NOW)),
        timeout=30)
    assert sum(ended) == len(people)
    for person in people:
        assert await _titles(person) == ["SN-1: record updated"]
    assert await _watch_ids() == set()

    later = NOW + timedelta(minutes=1)                  # and the next minute, nothing more
    assert await asyncio.wait_for(asyncio.gather(
        run_asset_watches_once(maker, now=later), run_asset_watches_once(maker, now=later)),
        timeout=30) == [0, 0]


async def test_a_watch_that_fails_is_kept_and_the_rest_go_on(db, monkeypatch, caplog):
    """One watch whose notice can't be sent is rolled back on its own and kept for the next
    check, logged once (its id and the error's class) until it ends; the others are told and
    end."""
    failing, fine = await _person(db, "A"), await _person(db, "B")
    asset = await _asset(db)
    stuck = await _arm(db, failing, asset)              # the older: claimed and tried first
    await _arm(db, fine, asset)
    await _set(db, asset, location_detail="Dock 2")
    real = asset_watch_check.notify

    async def breaks_for_one(session, person_id, *args, **kwargs):
        row = await real(session, person_id, *args, **kwargs)
        if person_id == failing.id:                     # written, then a failure
            raise RuntimeError("password=hunter2")
        return row

    monkeypatch.setattr(asset_watch_check, "notify", breaks_for_one)
    caplog.set_level(logging.WARNING, logger=LOGGER)

    assert await _check() == 1
    assert await _watch_ids() == {stuck.id}
    assert await _titles(fine) == ["SN-1: record updated"]
    assert await _notifications(failing) == []          # what it wrote went with its savepoint
    [warning] = [record.getMessage() for record in caplog.records if record.name == LOGGER]
    assert str(stuck.id) in warning and "RuntimeError" in warning
    assert "hunter2" not in caplog.text                 # the class only, never the text

    # still failing a minute later: kept, and not logged again
    assert await _check(NOW + timedelta(minutes=1)) == 0
    assert await _watch_ids() == {stuck.id}
    assert len([record for record in caplog.records if record.name == LOGGER]) == 1

    # once it goes through, it is told and ends as any other
    monkeypatch.setattr(asset_watch_check, "notify", real)
    assert await _check(NOW + timedelta(minutes=2)) == 1
    assert await _watch_ids() == set()
    assert await _titles(failing) == ["SN-1: record updated"]


async def test_now_must_be_timezone_aware(db):
    naive = datetime(2026, 11, 5, 15, 5)  # noqa: DTZ001
    with pytest.raises(ValueError, match="timezone-aware"):
        await run_asset_watches_once(get_sessionmaker(), now=naive)
