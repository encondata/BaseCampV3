"""Trip start rule, /trucks/map params (move, statuses, trip window, cap,
order, end_site, flat query count) and /trucks/summary."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, select

from serversherpa.api.routes import trucks as trucks_routes
from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    Client, Container, Initiative, Person, PersonRole, Site, Truck,
    TruckContainer, TruckUpdate,
)
from serversherpa.trucks.trip import apply_status_change
from tests.test_initiatives_client_scope import client_login
from tests.test_sites_api import login, make_login

NOW = datetime(2026, 5, 1, 12, tzinfo=UTC)


@pytest.fixture
async def admin_hdrs(db, client):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, "ada@test.example.com")


async def _truck(db, name, status="in_transit", trip=None, **kw):
    t = Truck(name=name, status=status, trip_started_at=trip, **kw)
    db.add(t)
    await db.flush()
    return t


def _pt(db, truck, minutes, lat=39.0, lng=-77.0, address=""):
    db.add(TruckUpdate(
        truck_id=truck.id, recorded_at=NOW + timedelta(minutes=minutes),
        location=f"{lat}, {lng}", lat=lat, lng=lng, approximate_address=address))


# ── the trip rule ─────────────────────────────────────────────────

def test_apply_status_change_rule():
    t = Truck(name="r", status="created")
    assert apply_status_change(t, "active", NOW) is True
    assert (t.status, t.trip_started_at) == ("active", NOW)
    later = NOW + timedelta(hours=1)
    assert apply_status_change(t, "in_transit", later) is False   # same trip
    assert (t.status, t.trip_started_at) == ("in_transit", NOW)
    assert apply_status_change(t, "in_transit", later) is False
    assert apply_status_change(t, "at_destination", later) is False
    assert t.trip_started_at == NOW                                # kept
    assert apply_status_change(t, "in_transit", later) is True     # new trip
    assert t.trip_started_at == later
    assert apply_status_change(t, "historical", later) is False
    assert t.trip_started_at == later


async def test_patch_sets_and_keeps_trip_start(client, db, seeded_user):
    hdrs = await login(client)
    tid = (await client.post("/trucks", headers=hdrs, json={"name": "P"})).json()["id"]

    async def trip():
        db.expire_all()
        return (await db.get(Truck, uuid.UUID(tid))).trip_started_at

    assert await trip() is None
    await client.patch(f"/trucks/{tid}", headers=hdrs, json={"driver_name": "Dee"})
    assert await trip() is None                          # not a status change
    assert (await client.patch(f"/trucks/{tid}", headers=hdrs,
                               json={"status": "active"})).status_code == 200
    started = await trip()
    assert started is not None
    await client.patch(f"/trucks/{tid}", headers=hdrs, json={"status": "in_transit"})
    assert await trip() == started                       # Active -> In transit
    await client.patch(f"/trucks/{tid}", headers=hdrs, json={"status": "at_destination"})
    assert await trip() == started
    await client.patch(f"/trucks/{tid}", headers=hdrs, json={"status": "in_transit"})
    restarted = await trip()
    assert restarted > started                           # new trip


async def test_create_in_a_trip_status_starts_the_trip(client, db, seeded_user):
    hdrs = await login(client)
    rows = {}
    for status in ("created", "active", "in_transit", "at_destination"):
        tid = (await client.post("/trucks", headers=hdrs,
                                 json={"name": f"C-{status}", "status": status})).json()["id"]
        rows[status] = await db.scalar(select(Truck.trip_started_at).where(Truck.id == tid))
    assert rows["created"] is None and rows["at_destination"] is None
    assert rows["active"] is not None and rows["in_transit"] is not None


async def test_bulk_import_applies_the_trip_rule(client, db, seeded_user, admin_hdrs):
    moved = await _truck(db, "Mover", status="created")
    steady = await _truck(db, "Steady", status="active", trip=NOW)
    await db.commit()
    rows = [{"name": "Mover", "status": "in_transit"},
            {"name": "Steady", "status": "in_transit"},
            {"name": "Newbie", "status": "active"},
            {"name": "Idle", "status": "created"}]
    preview = (await client.post("/trucks/bulk-import/preview", headers=admin_hdrs,
                                 json={"rows": rows})).json()
    resp = await client.post("/trucks/bulk-import/commit", headers=admin_hdrs, json={
        "rows": [r["cells"] for r in preview["rows"]],
        "approved_updates": [str(moved.id), str(steady.id)]})
    assert resp.status_code == 200, resp.text
    trips = dict((await db.execute(select(Truck.name, Truck.trip_started_at))).all())
    assert trips["Mover"] is not None
    assert trips["Steady"] == NOW                  # Active -> In transit: same trip
    assert trips["Newbie"] is not None
    assert trips["Idle"] is None


# ── /trucks/map params ────────────────────────────────────────────

async def _ids(client, hdrs, query=""):
    resp = await client.get(f"/trucks/map{query}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    return [p["name"] for p in resp.json()]


async def test_map_filters_by_move_and_statuses(client, db, seeded_user):
    hdrs = await login(client)
    a = Initiative(name="Move A", initiative_type="move")
    b = Initiative(name="Move B", initiative_type="move")
    db.add_all([a, b])
    await db.flush()
    for name, status, move in (("T1", "in_transit", a), ("T2", "active", a),
                               ("T3", "at_destination", b), ("T4", "historical", a)):
        t = await _truck(db, name, status, initiative_id=move.id)
        _pt(db, t, 0)
    await db.commit()

    assert await _ids(client, hdrs) == ["T1", "T2", "T3"]      # unchanged default
    assert await _ids(client, hdrs, f"?initiative_id={a.id}") == ["T1", "T2"]
    assert await _ids(client, hdrs, "?statuses=active&statuses=at_destination") == ["T2", "T3"]
    assert await _ids(client, hdrs, "?statuses=active,in_transit") == ["T1", "T2"]
    assert await _ids(client, hdrs, f"?initiative_id={b.id}&statuses=active") == []
    assert await _ids(client, hdrs, "?statuses=historical") == ["T4"]


async def test_map_trip_window_and_order(client, db, seeded_user):
    hdrs = await login(client)
    trip = await _truck(db, "Trip", trip=NOW + timedelta(minutes=10))
    legacy = await _truck(db, "NoTrip", status="at_destination", trip=None)
    for m in range(20):
        _pt(db, trip, m, lat=30.0 + m)
        _pt(db, legacy, m, lat=50.0 + m)
    # an unparsable report never becomes a trail point
    db.add(TruckUpdate(truck_id=trip.id, recorded_at=NOW + timedelta(minutes=15),
                       location="??", lat=None, lng=None))
    await db.commit()

    # trip=true alone returns trails, limited to the current trip
    resp = await client.get("/trucks/map?trip=true", headers=hdrs)
    pts = {p["name"]: p for p in resp.json()}
    assert [p["lat"] for p in pts["Trip"]["trail"]] == [30.0 + m for m in range(10, 20)]
    # no trip start recorded: every point, oldest -> newest
    assert [p["lat"] for p in pts["NoTrip"]["trail"]] == [50.0 + m for m in range(20)]

    plain = {p["name"]: p for p in (await client.get("/trucks/map", headers=hdrs)).json()}
    assert plain["Trip"]["trail"] == []
    full = {p["name"]: p for p in
            (await client.get("/trucks/map?trails=true", headers=hdrs)).json()}
    assert len(full["Trip"]["trail"]) == 20      # trails=true ignores the trip window


async def test_map_cap_is_500(db):
    assert trucks_routes.TRAIL_POINT_CAP == 500


async def test_map_cap_keeps_newest_oldest_first(client, db, seeded_user, monkeypatch):
    hdrs = await login(client)
    t = await _truck(db, "Cap", trip=None)
    for m in range(12):
        _pt(db, t, m, lat=20.0 + m)
    await db.commit()
    monkeypatch.setattr(trucks_routes, "TRAIL_POINT_CAP", 5)
    pts = (await client.get("/trucks/map?trip=true", headers=hdrs)).json()
    assert [p["lat"] for p in pts[0]["trail"]] == [27.0, 28.0, 29.0, 30.0, 31.0]
    assert pts[0]["last_update"]["lat"] == 31.0


async def test_map_end_site(client, db, seeded_user):
    hdrs = await login(client)
    dest = Site(name="Dest DC", latitude=41.5, longitude=-87.25)
    nocoords = Site(name="No Coords")
    db.add_all([dest, nocoords])
    await db.flush()
    for name, site in (("WithDest", dest), ("NoCoords", nocoords), ("NoSite", None)):
        t = await _truck(db, name, end_site_id=site.id if site else None)
        _pt(db, t, 0)
    await db.commit()
    pts = {p["name"]: p for p in (await client.get("/trucks/map", headers=hdrs)).json()}
    assert pts["WithDest"]["end_site"] == {
        "name": "Dest DC", "latitude": 41.5, "longitude": -87.25}
    assert pts["NoCoords"]["end_site"] is None
    assert pts["NoSite"]["end_site"] is None


async def test_map_query_count_is_flat_as_trucks_grow(client, db, seeded_user):
    hdrs = await login(client)
    dest = Site(name="Flat DC", latitude=40.0, longitude=-80.0)
    db.add(dest)
    await db.flush()

    async def add(n, prefix):
        for i in range(n):
            t = await _truck(db, f"{prefix}{i}", end_site_id=dest.id,
                             trip=NOW - timedelta(hours=1))
            for m in range(5):
                _pt(db, t, m, lat=39.0 + m / 10)
        await db.commit()

    statements = []

    def count(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    engine = get_engine().sync_engine

    async def measure(query):
        statements.clear()
        event.listen(engine, "before_cursor_execute", count)
        try:
            resp = await client.get(f"/trucks/map{query}", headers=hdrs)
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert resp.status_code == 200
        return len(statements), len(resp.json())

    await add(2, "S")
    small = {q: await measure(q) for q in ("?trip=true", "?trails=true")}
    await add(12, "L")
    large = {q: await measure(q) for q in ("?trip=true", "?trails=true")}
    for q in small:
        assert (small[q][1], large[q][1]) == (2, 14)
        assert 0 < small[q][0] == large[q][0], (q, small[q], large[q])


async def test_trail_ties_break_on_id_for_order_and_cap(client, db, seeded_user, monkeypatch):
    hdrs = await login(client)
    t = await _truck(db, "Tie", trip=None)
    for i in range(6):          # six reports with the very same timestamp
        db.add(TruckUpdate(truck_id=t.id, recorded_at=NOW, location=f"{i}", lat=10.0 + i,
                           lng=1.0, id=uuid.UUID(int=i + 1)))
    await db.commit()
    monkeypatch.setattr(trucks_routes, "TRAIL_POINT_CAP", 4)
    for query in ("?trip=true", "?trails=true"):
        pts = (await client.get(f"/trucks/map{query}", headers=hdrs)).json()
        # the cap keeps the four highest ids; output is ascending (recorded_at, id)
        assert [p["lat"] for p in pts[0]["trail"]] == [12.0, 13.0, 14.0, 15.0]


# ── /trucks/summary ───────────────────────────────────────────────

async def test_summary_counts(client, db, seeded_user):
    hdrs = await login(client)
    move = Initiative(name="Sum Move", initiative_type="move")
    db.add(move)
    await db.flush()
    c1, c2, c3, c4 = (Container(name=f"crate-{i}") for i in range(4))
    db.add_all([c1, c2, c3, c4])
    await db.flush()
    t1 = await _truck(db, "S1", "in_transit", initiative_id=move.id)
    t2 = await _truck(db, "S2", "in_transit")
    t3 = await _truck(db, "S3", "active")
    t4 = await _truck(db, "S4", "at_destination", initiative_id=move.id)
    t5 = await _truck(db, "S5", "in_transit", archived_at=NOW)
    t6 = await _truck(db, "S6", "historical")
    for t, c in ((t1, c1), (t1, c2), (t3, c3), (t2, c1), (t5, c4), (t6, c4)):
        db.add(TruckContainer(truck_id=t.id, container_id=c.id))
    del t4
    await db.commit()

    resp = await client.get("/trucks/summary", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"in_transit": 2, "active": 1, "at_destination": 1,
                           "containers_on_board": 3}
    resp = await client.get(f"/trucks/summary?initiative_id={move.id}", headers=hdrs)
    assert resp.json() == {"in_transit": 1, "active": 0, "at_destination": 1,
                           "containers_on_board": 2}


async def test_summary_empty(client, db, seeded_user):
    hdrs = await login(client)
    assert (await client.get("/trucks/summary", headers=hdrs)).json() == {
        "in_transit": 0, "active": 0, "at_destination": 0, "containers_on_board": 0}


# ── gates ─────────────────────────────────────────────────────────

async def test_map_and_summary_are_403_for_non_staff(client, db, seeded_user):
    org = Client(name="Gate Org")
    db.add(org)
    await db.commit()
    hdrs = await client_login(db, client, org.id)
    for path in ("/trucks/map", "/trucks/map?trip=true", "/trucks/summary"):
        assert (await client.get(path, headers=hdrs)).status_code == 403, path
