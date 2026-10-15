"""Asset placement — the container an asset is in and the truck that
container is on: the helper, and the three responses that carry it."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import event, select

from serversherpa.access.resolver import AccessInfo, resolve_access
from serversherpa.assets.placement import Placement, asset_placements
from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    Asset,
    Container,
    ContainerAsset,
    InitiativeAsset,
    PersonRole,
    Site,
    Truck,
    TruckContainer,
)

from .test_assets_api import _client_contact, login

T0 = datetime(2026, 5, 1, 12, tzinfo=UTC)
PID = uuid.uuid4()


def _staff(**perms):
    """A global actor holding exactly the given (resource, action) cells."""
    info = AccessInfo(is_global=True, anchors={"global"})
    info.perms = {r: {"view": True} for r in perms}
    return info


async def _asset(db, name="srv"):
    a = Asset(name=name)
    db.add(a)
    await db.flush()
    return a


async def _box(db, asset, name="Crate 1", **kw):
    c = Container(name=name, **kw)
    db.add(c)
    await db.flush()
    db.add(ContainerAsset(container_id=c.id, asset_id=asset.id))
    await db.flush()
    return c


async def _truck(db, container, name="Truck 1", minutes=0, **kw):
    t = Truck(name=name, **kw)
    db.add(t)
    await db.flush()
    db.add(TruckContainer(truck_id=t.id, container_id=container.id,
                          added_at=T0 + timedelta(minutes=minutes)))
    await db.flush()
    return t


FULL = _staff(containers=1, trucks=1)


# ── the helper ────────────────────────────────────────────────────

async def test_container_on_a_truck(db):
    a = await _asset(db)
    box = await _box(db, a)
    truck = await _truck(db, box)
    got = await asset_placements(db, [a.id], FULL, PID)
    assert got == {a.id: Placement(box.id, "Crate 1", truck.id, "Truck 1")}


async def test_container_only_and_unplaced(db):
    a, loose = await _asset(db, "a"), await _asset(db, "loose")
    box = await _box(db, a)
    got = await asset_placements(db, [a.id, loose.id], FULL, PID)
    assert got == {a.id: Placement(box.id, "Crate 1")}
    assert loose.id not in got


async def test_archived_container_is_skipped(db):
    a = await _asset(db)
    box = await _box(db, a, archived_at=T0)
    await _truck(db, box)
    assert await asset_placements(db, [a.id], FULL, PID) == {}


async def test_archived_truck_is_skipped(db):
    a = await _asset(db)
    box = await _box(db, a)
    await _truck(db, box, archived_at=T0)
    got = await asset_placements(db, [a.id], FULL, PID)
    assert got == {a.id: Placement(box.id, "Crate 1")}


async def test_two_trucks_latest_added_wins(db):
    a = await _asset(db)
    box = await _box(db, a)
    await _truck(db, box, "Old", minutes=0)
    newest = await _truck(db, box, "New", minutes=30)
    await _truck(db, box, "Mid", minutes=10)
    got = await asset_placements(db, [a.id], FULL, PID)
    assert (got[a.id].truck_id, got[a.id].truck_name) == (newest.id, "New")


async def test_same_added_at_is_deterministic_by_truck_id(db):
    a = await _asset(db)
    box = await _box(db, a)
    t1 = await _truck(db, box, "A", minutes=5)
    t2 = await _truck(db, box, "B", minutes=5)
    got = await asset_placements(db, [a.id], FULL, PID)
    assert got[a.id].truck_id == min(t1.id, t2.id)


async def test_client_actor_gets_nothing(db, client):
    a = await _asset(db)
    box = await _box(db, a)
    await _truck(db, box)
    org, _ = await _client_contact(db, client, "Acme", "c@test.example.com")
    pid = (await db.scalars(select(PersonRole.person_id).where(
        PersonRole.client_id == org.id))).one()
    access = await resolve_access(db, pid)
    assert await asset_placements(db, [a.id], access, pid) == {}
    # even if the matrix said yes, containers carry no client scope column
    forced = AccessInfo(client_ids={org.id}, anchors={"client"},
                        perms={"containers": {"view": True},
                               "trucks": {"view": True}})
    assert await asset_placements(db, [a.id], forced, pid) == {}


async def test_without_trucks_view_container_only(db):
    a = await _asset(db)
    box = await _box(db, a)
    await _truck(db, box)
    got = await asset_placements(db, [a.id], _staff(containers=1), PID)
    assert got == {a.id: Placement(box.id, "Crate 1")}


async def test_without_containers_view_nothing(db):
    a = await _asset(db)
    box = await _box(db, a)
    await _truck(db, box)
    assert await asset_placements(db, [a.id], _staff(trucks=1), PID) == {}


async def test_empty_ids_runs_no_query(db):
    engine = get_engine().sync_engine
    statements: list[str] = []

    def record(conn, cursor, statement, *rest):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        assert await asset_placements(db, [], FULL, PID) == {}
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert statements == []


async def test_query_count_is_flat_as_assets_grow(db):
    engine = get_engine().sync_engine
    statements: list[str] = []

    def count(conn, cursor, statement, *rest):
        statements.append(statement)

    async def add(n, tag):
        ids = []
        for i in range(n):
            a = await _asset(db, f"{tag}{i}")
            box = await _box(db, a, f"{tag}-box{i}")
            await _truck(db, box, f"{tag}-truck{i}")
            ids.append(a.id)
        await db.commit()
        return ids

    async def measure(ids):
        statements.clear()
        event.listen(engine, "before_cursor_execute", count)
        try:
            got = await asset_placements(db, ids, FULL, PID)
        finally:
            event.remove(engine, "before_cursor_execute", count)
        return len(statements), len(got)

    small_ids = await add(2, "s")
    small = await measure(small_ids)
    large_ids = await add(12, "l")
    large = await measure(small_ids + large_ids)
    assert (small[1], large[1]) == (2, 14)
    assert 0 < small[0] == large[0] <= 2, (small, large)


# ── the responses ─────────────────────────────────────────────────

FIELDS = ("container_id", "container_name", "truck_id", "truck_name")


async def _placed(db):
    a = await _asset(db, "placed")
    box = await _box(db, a, "Crate 9")
    truck = await _truck(db, box, "Truck 9")
    await db.commit()
    return a, box, truck


async def test_assets_list_and_detail_carry_placement(client, db, seeded_user):
    hdrs = await login(client)
    a, box, truck = await _placed(db)
    loose = await _asset(db, "loose")
    await db.commit()
    expect = {"container_id": str(box.id), "container_name": "Crate 9",
              "truck_id": str(truck.id), "truck_name": "Truck 9"}

    rows = {r["id"]: r for r in (await client.get("/assets", headers=hdrs)).json()}
    assert {k: rows[str(a.id)][k] for k in FIELDS} == expect
    assert {k: rows[str(loose.id)][k] for k in FIELDS} == dict.fromkeys(FIELDS)

    one = (await client.get(f"/assets/{a.id}", headers=hdrs)).json()
    assert {k: one[k] for k in FIELDS} == expect

    patched = await client.patch(f"/assets/{a.id}", headers=hdrs,
                                 json={"location_detail": "Bay 2"})
    assert patched.status_code == 200, patched.text
    assert {k: patched.json()[k] for k in FIELDS} == expect

    created = await client.post("/assets", headers=hdrs, json={"name": "fresh"})
    assert created.status_code == 201, created.text
    assert {k: created.json()[k] for k in FIELDS} == dict.fromkeys(FIELDS)


async def test_client_user_assets_carry_no_placement(client, db, seeded_user):
    a = (await _placed(db))[0]
    org, hdrs = await _client_contact(db, client, "Acme", "c@test.example.com")
    a.client_id = org.id
    await db.commit()
    rows = (await client.get("/assets", headers=hdrs)).json()
    assert [r["id"] for r in rows] == [str(a.id)]
    assert {k: rows[0][k] for k in FIELDS} == dict.fromkeys(FIELDS)
    one = (await client.get(f"/assets/{a.id}", headers=hdrs)).json()
    assert {k: one[k] for k in FIELDS} == dict.fromkeys(FIELDS)


async def test_initiative_assets_carry_placement(client, db, seeded_user):
    hdrs = await login(client)
    a, box, truck = await _placed(db)
    mid = (await client.post("/initiatives", headers=hdrs, json={
        "name": "Move A", "initiative_type": "move"})).json()["id"]
    resp = await client.post(f"/initiatives/{mid}/assets", headers=hdrs,
                             json={"asset_ids": [str(a.id)]})
    assert resp.status_code in (200, 201), resp.text
    expect = {"container_id": str(box.id), "container_name": "Crate 9",
              "truck_id": str(truck.id), "truck_name": "Truck 9"}
    assert {k: resp.json()[0]["asset"][k] for k in FIELDS} == expect
    rows = (await client.get(f"/initiatives/{mid}/assets", headers=hdrs)).json()
    assert {k: rows[0]["asset"][k] for k in FIELDS} == expect
    assoc = (await db.scalars(select(InitiativeAsset))).one()
    patched = await client.patch(f"/initiatives/assets/{assoc.id}", headers=hdrs,
                                 json={"owner": "Dee"})
    assert patched.status_code == 200, patched.text
    assert {k: patched.json()["asset"][k] for k in FIELDS} == expect


async def test_warehouse_inventory_carries_placement(client, db, seeded_user):
    hdrs = await login(client)
    wh = Site(name="WH", site_type="warehouse")
    db.add(wh)
    await db.flush()
    a = await _asset(db, "in-box")
    a.site_id = wh.id
    box = await _box(db, a, "Crate W", site_id=wh.id)
    truck = await _truck(db, box, "Truck W")
    # a loose warehouse asset that sits in a container elsewhere, on a truck
    b = await _asset(db, "elsewhere")
    b.site_id = wh.id
    far = await _box(db, b, "Far crate")
    await _truck(db, far, "Truck F")
    free = await _asset(db, "free")
    free.site_id = wh.id
    await db.commit()

    inv = (await client.get(f"/warehouse/{wh.id}/inventory", headers=hdrs)).json()
    inside = inv["containers"][0]["assets"][0]
    assert {k: inside[k] for k in FIELDS} == {
        "container_id": str(box.id), "container_name": "Crate W",
        "truck_id": str(truck.id), "truck_name": "Truck W"}
    loose = {r["name"]: r for r in inv["loose_assets"]}
    assert loose["elsewhere"]["container_name"] == "Far crate"
    assert loose["elsewhere"]["truck_name"] == "Truck F"
    assert {k: loose["free"][k] for k in FIELDS} == dict.fromkeys(FIELDS)
