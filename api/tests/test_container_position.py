"""Where a container is on a map: the truck's newest GPS report, else the
site's pin, else nothing — and the route that serves it."""

import uuid
from datetime import timedelta

from serversherpa.assets.placement import Position, container_position
from serversherpa.db.models import Site, TruckUpdate

from .test_asset_placement import PID, T0, _asset, _box, _staff, _truck
from .test_assets_api import _client_contact, login

FULL = _staff(containers=1, trucks=1, sites=1)


async def _site(db, name="ATL1", lat=33.75, lng=-84.39):
    s = Site(name=name, latitude=lat, longitude=lng)
    db.add(s)
    await db.flush()
    return s


async def _report(db, truck, minutes, lat, lng, address=""):
    db.add(TruckUpdate(
        truck_id=truck.id, recorded_at=T0 + timedelta(minutes=minutes),
        location=f"{lat}, {lng}", lat=lat, lng=lng,
        approximate_address=address))
    await db.flush()


async def test_truck_with_report(db):
    box = await _box(db, await _asset(db))
    truck = await _truck(db, box)
    await _report(db, truck, 1, 33.1, -84.2, "I-85 N")
    got = await container_position(db, box, FULL, PID)
    assert got == Position("truck", "Truck 1", 33.1, -84.2,
                           T0 + timedelta(minutes=1), "I-85 N")


async def test_truck_uses_newest_report_with_coordinates(db):
    box = await _box(db, await _asset(db))
    truck = await _truck(db, box)
    await _report(db, truck, 1, 33.1, -84.2)
    await _report(db, truck, 5, None, None)
    got = await container_position(db, box, FULL, PID)
    assert (got.lat, got.lng) == (33.1, -84.2)
    assert got.recorded_at == T0 + timedelta(minutes=1)


async def test_truck_without_report_does_not_fall_back_to_site(db):
    site = await _site(db)
    box = await _box(db, await _asset(db), site_id=site.id)
    await _truck(db, box)
    assert await container_position(db, box, FULL, PID) == \
        Position("truck", "Truck 1")


async def test_latest_truck_wins(db):
    box = await _box(db, await _asset(db))
    await _truck(db, box, "Old", 0)
    await _truck(db, box, "New", 10)
    got = await container_position(db, box, FULL, PID)
    assert got.name == "New"


async def test_archived_truck_falls_to_site(db):
    site = await _site(db)
    box = await _box(db, await _asset(db), site_id=site.id)
    await _truck(db, box, archived_at=T0)
    got = await container_position(db, box, FULL, PID)
    assert (got.kind, got.name) == ("site", "ATL1")


async def test_without_trucks_view_falls_to_site(db):
    site = await _site(db)
    box = await _box(db, await _asset(db), site_id=site.id)
    truck = await _truck(db, box)
    await _report(db, truck, 1, 33.1, -84.2)
    got = await container_position(
        db, box, _staff(containers=1, sites=1), PID)
    assert got.kind == "site"
    assert "Truck 1" not in repr(got)


async def test_site_pin(db):
    site = await _site(db)
    box = await _box(db, await _asset(db), site_id=site.id)
    assert await container_position(db, box, FULL, PID) == \
        Position("site", "ATL1", 33.75, -84.39)


async def test_site_without_pin_is_none(db):
    site = await _site(db, lat=None, lng=None)
    box = await _box(db, await _asset(db), site_id=site.id)
    assert await container_position(db, box, FULL, PID) == Position("none")


async def test_archived_site_is_none(db):
    site = await _site(db)
    site.archived_at = T0
    box = await _box(db, await _asset(db), site_id=site.id)
    assert await container_position(db, box, FULL, PID) == Position("none")


async def test_without_sites_view_is_none(db):
    site = await _site(db)
    box = await _box(db, await _asset(db), site_id=site.id)
    got = await container_position(
        db, box, _staff(containers=1, trucks=1), PID)
    assert got == Position("none")


async def test_no_truck_no_site_is_none(db):
    box = await _box(db, await _asset(db))
    assert await container_position(db, box, FULL, PID) == Position("none")


async def test_route_returns_position(client, db, seeded_user):
    hdrs = await login(client)
    site = await _site(db)
    box = await _box(db, await _asset(db), site_id=site.id)
    await db.commit()
    resp = await client.get(f"/containers/{box.id}/position", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json() == {
        "kind": "site", "name": "ATL1", "lat": 33.75, "lng": -84.39,
        "recorded_at": None, "approximate_address": ""}


async def test_route_404_for_missing_and_archived(client, db, seeded_user):
    hdrs = await login(client)
    box = await _box(db, await _asset(db))
    box.archived_at = T0
    await db.commit()
    for cid in (uuid.uuid4(), box.id):
        resp = await client.get(f"/containers/{cid}/position", headers=hdrs)
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "container_not_found"


async def test_route_client_user_forbidden(client, db, seeded_user):
    box = await _box(db, await _asset(db))
    _, hdrs = await _client_contact(db, client, "Acme", "c@test.example.com")
    await db.commit()
    resp = await client.get(f"/containers/{box.id}/position", headers=hdrs)
    assert resp.status_code in (403, 404)
