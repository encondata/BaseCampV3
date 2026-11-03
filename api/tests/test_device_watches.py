"""Watching devices: POST /auth/me/watches and POST /notifications/groups/{id}/watches on a device,
and the Device offline notice its watchers hear. Only the devices notifications check can be
watched, the covered ones (services/device_online.py): an RFID Station, a fixed reader and an
approved router. Any other device the asker can open is 422 `invalid_thing`; one they can't open
is 404 `thing_not_found` whatever kind it is, so the answer tells nothing about the device. A
device opens with `scanning_hardware:view`, which only global roles hold.

The rules every watch shares (the events that fit, a second watch, whose watch it is) are tested in
test_watches_api.py and test_group_watches_api.py; these tests cover what devices add. Notices are
made the way the app makes them, by the real device check and the real sweep.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 1, 3 and 5)
Plan: docs/superpowers/plans/2026-11-02-notifications-phase2-slice2.md (Task 3)"""

import uuid
from datetime import timedelta

from serversherpa.db.models import Client, NotificationWatch
from serversherpa.notifications.check import check_delivery
from tests.test_device_check import (
    NOW,
    OFFLINE,
    _check,
    _device,
    _reader,
    _router,
    _station,
    _sweep,
)
from tests.test_group_watches_api import _audits, _url
from tests.test_group_watches_api import _delete as _group_delete
from tests.test_group_watches_api import _patch as _group_patch
from tests.test_group_watches_api import _post as _group_post
from tests.test_notification_event_sweep import (
    TRUCK_CHANGED,
    _log,
    _notifications,
    _on,
    _person,
    _site,
)
from tests.test_notification_event_sweep import _group as _sweep_group
from tests.test_notification_event_sweep import _watch as _sweep_watch
from tests.test_watches_api import (
    WATCHES,
    _code,
    _count,
    _group,
    _group_watch,
    _list,
    _login,
    _post,
    _state,
)


def _you() -> dict:
    return {"type": "you", "id": None, "name": None}


# ── what can be watched ─────────────────────────────────────────────

async def test_watch_covered_devices(client, db):
    """An RFID Station, a fixed reader and an approved router can be watched, and each watch links
    where a notice about that device does. Any other device is 422 `invalid_thing`. Someone who
    can't open devices is told 404 `thing_not_found` for every one of them, covered or not: the
    answer a missing device gets."""
    me = await _login(db, client, "A")              # staff hold scanning_hardware:view
    station = await _station(db, "Device A")
    reader = await _reader(db, "Device B")
    router = await _router(db, "Device C")

    for device, link in (
        (station, f"/hardware/kiosks/{station.id}"),
        (reader, f"/hardware/fixed-readers?focus={reader.id}"),
        (router, f"/hardware/routers?focus={router.id}"),
    ):
        resp = await _post(client, me, "device", device.id)
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert (body["thing"], body["thing_id"], body["thing_name"], body["link"]) == (
            "device", str(device.id), device.name, link)
        assert (body["kinds"], body["via"]["type"]) == ([], "you")
        row = await db.get(NotificationWatch, uuid.UUID(body["id"]))
        assert (row.person_id, row.device_id) == (me.id, device.id)
        assert (row.initiative_id, row.site_id, row.truck_id, row.group_id) == (
            None, None, None, None)
    assert await _count(db) == 3

    # the devices that don't check in on their own, or aren't approved, have nothing to hear
    uncovered = [
        await _device(db, "kiosk", "Device D", sub_type="android"),
        await _device(db, "kiosk", "Device E", sub_type="laptop", station_type="label"),
        await _router(db, "Device F", approval_state="pending"),
        await _router(db, "Device G", approval_state="revoked"),
    ]
    for device in uncovered:
        resp = await _post(client, me, "device", device.id)
        assert (resp.status_code, _code(resp)) == (422, "invalid_thing"), device.name
    assert await _count(db) == 3

    # the same 404 for an id that is nowhere, so the answer says nothing about the device
    client_a = Client(name="Client A")
    db.add(client_a)
    await db.commit()
    outsider = await _login(db, client, "B", "client_viewer", client_id=client_a.id)
    missing = await _post(client, outsider, "device", uuid.uuid4())
    assert (missing.status_code, _code(missing)) == (404, "thing_not_found")
    for device in (station, reader, router, *uncovered):
        resp = await _post(client, outsider, "device", device.id)
        assert (resp.status_code, resp.json()) == (missing.status_code, missing.json()), device.name
        assert device.name not in resp.text
    assert await _count(db) == 3


async def test_a_device_watch_is_listed_and_can_name_its_event(client, db):
    me = await _login(db, client, "A")
    reader = await _reader(db, "Device A")

    watch = (await _post(client, me, "device", reader.id)).json()
    [listed] = await _list(client, me)
    assert (listed["id"], listed["thing"], listed["thing_name"], listed["link"]) == (
        watch["id"], "device", "Device A", f"/hardware/fixed-readers?focus={reader.id}")
    state = await _state(client, me, "device", reader.id)
    assert state.json() == {"watching": True, "watch_id": watch["id"], "kinds": []}
    resp = await _post(client, me, "device", reader.id)
    assert (resp.status_code, _code(resp)) == (409, "already_watching")

    resp = await client.patch(f"{WATCHES}/{watch['id']}", headers=me.headers,
                              json={"kinds": [OFFLINE]})
    assert (resp.status_code, resp.json()["kinds"]) == (200, [OFFLINE])
    resp = await client.patch(f"{WATCHES}/{watch['id']}", headers=me.headers,
                              json={"kinds": [TRUCK_CHANGED]})
    assert (resp.status_code, _code(resp)) == (422, "invalid_kind")

    assert (await client.delete(f"{WATCHES}/{watch['id']}", headers=me.headers)
            ).status_code == 204
    assert await _list(client, me) == []
    state = await _state(client, me, "device", reader.id)
    assert state.json() == {"watching": False, "watch_id": None, "kinds": []}


async def test_group_watches_a_device(client, db):
    """The group route takes a device on the same terms, and audits it as a device (not as
    "everything", which is what a watch on a thing the audit doesn't know would read as)."""
    admin = await _login(db, client, "A", "admin")
    group = await _group(db, "Group A")
    router = await _router(db, "Device A")
    label = await _device(db, "kiosk", "Device B", sub_type="laptop", station_type="label")
    where = {"thing": "device", "thing_id": str(router.id)}

    resp = await _group_post(client, admin, group.id, "device", router.id)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["thing"], body["thing_id"], body["thing_name"], body["link"], body["kinds"]) == (
        "device", str(router.id), "Device A", f"/hardware/routers?focus={router.id}", [])
    assert body["via"] == {"type": "group", "id": str(group.id), "name": "Group A"}
    [audit] = await _audits(db, group)
    assert (audit.action, audit.actor_person_id, audit.changes) == (
        "watch.add", admin.id, {**where, "kinds": []})

    # a device that is not covered is refused, and writes nothing
    resp = await _group_post(client, admin, group.id, "device", label.id)
    assert (resp.status_code, _code(resp)) == (422, "invalid_thing")
    assert await _count(db) == 1
    listed = (await client.get(_url(group.id), headers=admin.headers)).json()
    assert [(row["thing"], row["thing_name"], row["link"]) for row in listed] == [
        ("device", "Device A", f"/hardware/routers?focus={router.id}")]

    # choosing its event and removing the watch are audited the same way
    resp = await _group_patch(client, admin, group.id, body["id"], [OFFLINE])
    assert (resp.status_code, resp.json()["kinds"]) == (200, [OFFLINE])
    assert (await _group_delete(client, admin, group.id, body["id"])).status_code == 204
    assert [(row.action, row.changes) for row in await _audits(db, group)] == [
        ("watch.add", {**where, "kinds": []}),
        ("watch.update", {**where, "kinds": {"from": [], "to": [OFFLINE]}}),
        ("watch.remove", where),
    ]
    assert await _count(db) == 0


# ── what the watchers hear ──────────────────────────────────────────

async def test_device_watch_hears_its_offline_notice(db):
    """After the device check and the sweep, a watcher of the device has the notice, and so has a
    watcher of its site. A watcher of another device, and a person who watches nothing, do not."""
    on_device, on_site, on_other, nobody = [await _person(db, name) for name in "ABCD"]
    site = await _site(db, "Site A")
    station = await _station(db, "Device A", site_id=site.id)
    other = await _reader(db, "Device B", ago=timedelta(seconds=30))        # checking in fine
    await _sweep_watch(db, on_device, _on(station, "device"))
    await _sweep_watch(db, on_site, _on(site, "site"))
    await _sweep_watch(db, on_other, _on(other, "device"))

    assert await _check() == 1
    assert await _sweep() == 2
    for person in (on_device, on_site):
        [note] = await _notifications(person)
        assert (note.kind, note.title, note.body, note.link) == (
            OFFLINE, "Device A is offline", "RFID Station · last seen Nov 2, 3:50 PM EST",
            f"/hardware/kiosks/{station.id}")
        assert note.payload["via"] == ["watch"]
        assert note.payload["subjects"] == [{"type": "device", "id": str(station.id)}]
    assert await _notifications(on_other) == []
    assert await _notifications(nobody) == []


async def test_a_group_member_who_cannot_open_the_device_hears_nothing(client, db):
    """A group watches a device, and one of its members is a client's user, who can't open
    devices. Their watch list shows nothing of it and the sweep tells them nothing, logging
    `inbox_suppressed` `no_access`. Their staff colleague in the same group hears it."""
    client_a = Client(name="Client A")
    db.add(client_a)
    await db.commit()
    staff = await _login(db, client, "A")
    outsider = await _login(db, client, "B", "client_viewer", client_id=client_a.id)
    group = await _group(db, "Group A", staff, outsider)
    reader = await _reader(db, "Device A")
    await _group_watch(db, group, "device", reader.id)

    [mine] = await _list(client, staff)
    assert (mine["thing"], mine["thing_name"], mine["via"]["type"]) == (
        "device", "Device A", "group")
    resp = await client.get(WATCHES, headers=outsider.headers)
    assert (resp.status_code, resp.json()) == (200, [])
    assert "Device A" not in resp.text

    assert await _check() == 1
    assert await _sweep() == 1
    [note] = await _notifications(staff)
    assert (note.title, note.link, note.payload["via"]) == (
        "Device A is offline", f"/hardware/fixed-readers?focus={reader.id}",
        [f"group:{group.id}"])
    assert await _notifications(outsider) == []
    [suppressed] = await _log("inbox_suppressed")
    assert (suppressed.person_id, suppressed.kind, suppressed.reason) == (
        outsider.id, OFFLINE, "no_access")


async def test_check_delivery_lists_device_watches(db):
    """Check delivery for Device offline lists the person's own watch of the device and their
    group's watch of its site, as it does for any other kind. A site watch hears the other
    kinds too; a device watch hears only this one."""
    person = await _person(db, "A")
    group = await _sweep_group(db, "Group A", [person])
    site = await _site(db, "Site A")
    router = await _router(db, "Device A")
    await _sweep_watch(db, person, _on(router, "device"))
    await _sweep_watch(db, group, _on(site, "site"))
    via_group = {"type": "group", "id": group.id, "name": "Group A"}

    result = await check_delivery(db, person.id, OFFLINE, now=NOW)
    assert result["watches"] == [
        {"thing": "device", "thing_id": router.id, "thing_name": "Device A", "kinds": [],
         "via": _you()},
        {"thing": "site", "thing_id": site.id, "thing_name": "Site A", "kinds": [],
         "via": via_group},
    ]
    result = await check_delivery(db, person.id, TRUCK_CHANGED, now=NOW)
    assert [entry["thing"] for entry in result["watches"]] == ["site"]
