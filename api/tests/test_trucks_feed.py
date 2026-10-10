"""GET /trucks/feed — location, status, load and unload events merged
newest-first, move filter, compound-cursor paging, set-based queries."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import event, select

from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    Asset,
    AuditLog,
    Client,
    Container,
    ContainerAsset,
    Initiative,
    Person,
    PersonRole,
    StatusValue,
    Truck,
    TruckContainer,
    TruckUpdate,
)
from tests.test_initiatives_client_scope import client_login
from tests.test_sites_api import login, make_login

T0 = datetime(2026, 5, 1, 12, tzinfo=UTC)


def at(minutes):
    return T0 + timedelta(minutes=minutes)


async def _truck(db, name, status="in_transit", **kw):
    t = Truck(name=name, status=status, **kw)
    db.add(t)
    await db.flush()
    return t


def _loc(db, truck, minutes, address="", source="manual", lat=39.0, lng=-77.0, id=None):
    row = TruckUpdate(truck_id=truck.id, recorded_at=at(minutes),
                      location=f"{lat}, {lng}", lat=lat, lng=lng,
                      approximate_address=address, source=source)
    if id is not None:
        row.id = id
    db.add(row)
    return row


def _audit(db, truck_id, minutes, action, changes, actor=None, id=None,
           entity_id="same"):
    row = AuditLog(
        actor_person_id=actor, entity_type="truck",
        entity_id=str(truck_id) if entity_id == "same" else entity_id,
        action=action, changes=changes, at=at(minutes))
    if id is not None:
        row.id = id
    db.add(row)
    return row


async def _feed(client, hdrs, query=""):
    resp = await client.get(f"/trucks/feed{query}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _vocab(db):
    for key, label, color in (("active", "Loading", "#0a7"),
                              ("in_transit", "In Transit", "#05a"),
                              ("at_destination", "Delivered", "#2a2")):
        row = await db.scalar(select(StatusValue).where(
            StatusValue.record_type == "truck", StatusValue.key == key))
        if row is None:
            db.add(StatusValue(record_type="truck", key=key, label=label,
                               color=color, sort_order=0, is_active=True))
        else:
            row.label, row.color = label, color
    await db.flush()


# ── location events ───────────────────────────────────────────────

async def test_location_event_shape(client, db, seeded_user):
    hdrs = await login(client)
    move = Initiative(name="Feed Move", initiative_type="move")
    db.add(move)
    await db.flush()
    t = await _truck(db, "Rig 1", load_number="L-100", initiative_id=move.id)
    u = _loc(db, t, 5, address="Columbia, SC", source="tracker", lat=34.0, lng=-81.0)
    await db.commit()

    body = await _feed(client, hdrs)
    assert body["next_before"] is None
    [ev] = body["events"]
    assert ev["id"] == f"loc:{u.id}"
    assert ev["kind"] == "location"
    assert ev["at"].startswith("2026-05-01T12:05:00")
    assert (ev["truck_id"], ev["truck_name"], ev["load_number"]) == (
        str(t.id), "Rig 1", "L-100")
    assert (ev["initiative_id"], ev["initiative_name"]) == (str(move.id), "Feed Move")
    assert ev["address"] == "Columbia, SC"
    assert ev["source"] == "tracker"
    assert (ev["lat"], ev["lng"]) == (34.0, -81.0)
    assert ev["location"] == "34.0, -81.0"
    assert ev["via"] is None and ev["actor_name"] is None


async def test_empty_feed(client, db, seeded_user):
    hdrs = await login(client)
    assert await _feed(client, hdrs) == {"events": [], "next_before": None}


# ── status events ─────────────────────────────────────────────────

async def test_status_event_from_update_audit_row(client, db, seeded_user):
    hdrs = await login(client)
    await _vocab(db)
    t = await _truck(db, "Rig S")
    row = _audit(db, t.id, 3, "update",
                 {"status": {"from": "active", "to": "in_transit"},
                  "driver_name": {"from": None, "to": "Dee"}},
                 actor=seeded_user.id)
    await db.commit()
    actor_name = (await db.get(Person, seeded_user.id)).display_name

    [ev] = (await _feed(client, hdrs))["events"]
    assert ev["id"] == f"audit:{row.id}:status"
    assert ev["kind"] == "status"
    assert (ev["from_status"], ev["from_label"], ev["from_color"]) == (
        "active", "Loading", "#0a7")
    assert (ev["to_status"], ev["to_label"], ev["to_color"]) == (
        "in_transit", "In Transit", "#05a")
    assert ev["actor_name"] == actor_name


async def test_status_unknown_key_falls_back_to_the_key(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Rig U")
    _audit(db, t.id, 1, "update", {"status": {"from": "mystery", "to": "created"}})
    await db.commit()
    [ev] = (await _feed(client, hdrs))["events"]
    assert (ev["from_label"], ev["from_color"]) == ("mystery", "#51606f")


async def test_real_patch_status_change_appears(client, db, seeded_user):
    hdrs = await login(client)
    await _vocab(db)
    tid = (await client.post("/trucks", headers=hdrs, json={"name": "PatchRig"})).json()["id"]
    await client.patch(f"/trucks/{tid}", headers=hdrs, json={"status": "active"})
    await client.patch(f"/trucks/{tid}", headers=hdrs, json={"status": "in_transit"})
    events = (await _feed(client, hdrs))["events"]
    assert [(e["kind"], e["from_status"], e["to_status"]) for e in events] == [
        ("status", "active", "in_transit"), ("status", "created", "active")]
    assert all(e["truck_id"] == tid for e in events)


async def test_non_status_rows_make_no_events(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Quiet")
    _audit(db, t.id, 1, "update", {"driver_name": {"from": None, "to": "Dee"}})
    _audit(db, t.id, 2, "create", {"status": {"from": None, "to": "created"},
                                   "name": {"from": None, "to": "Quiet"}})
    _audit(db, t.id, 3, "update_location", {"location": {"from": None, "to": "1, 2"}})
    _audit(db, t.id, 4, "archive", {})
    _audit(db, None, 5, "bulk_import", {"created": 1}, entity_id=None)
    await db.commit()
    assert (await _feed(client, hdrs))["events"] == []


# ── load / unload events ──────────────────────────────────────────

async def test_kiosk_load_and_unload_events(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Rig K")
    cid = uuid.uuid4()
    load = _audit(db, t.id, 2, "kiosk_truck_load",
                  {"container_id": str(cid), "container_name": "CRATE-1",
                   "asset_count": 4, "from_truck": "Rig Old", "device": "Kiosk 7"},
                  actor=seeded_user.id)
    unload = _audit(db, t.id, 4, "kiosk_truck_unload",
                    {"container_id": str(cid), "container_name": "CRATE-1",
                     "asset_count": 4, "from_truck": "Rig K", "device": "Kiosk 7"})
    await db.commit()

    unl, ld = (await _feed(client, hdrs))["events"]
    assert (unl["id"], unl["kind"], unl["via"]) == (f"audit:{unload.id}", "unload", "kiosk")
    assert ld["id"] == f"audit:{load.id}"
    assert ld["kind"] == "load" and ld["via"] == "kiosk"
    assert (ld["container_id"], ld["container_name"], ld["asset_count"]) == (
        str(cid), "CRATE-1", 4)
    assert ld["from_truck"] == "Rig Old" and ld["device"] == "Kiosk 7"
    assert ld["actor_name"] == (await db.get(Person, seeded_user.id)).display_name


async def test_real_kiosk_endpoint_audit_row_is_picked_up(client, db, seeded_user):
    """The row shape written by /kiosk/trucks/... is what the feed reads."""
    from tests.test_kiosk_trucks_api import _post, _seed
    hdrs = await login(client)
    _site, _dest, _init, _cp, _dev, truck, _other, crate, *_ = await _seed(db)
    await db.commit()
    truck_id, crate_id = truck.id, crate.id
    assert (await _post(client, hdrs, truck_id, crate_id)).status_code == 200
    assert (await _post(client, hdrs, truck_id, crate_id,
                        action="unload")).status_code == 200
    events = (await _feed(client, hdrs))["events"]
    assert [(e["kind"], e["via"], e["container_name"], e["asset_count"])
            for e in events] == [("unload", "kiosk", "LOAD-CRATE-1", 1),
                                 ("load", "kiosk", "LOAD-CRATE-1", 1)]
    assert {e["truck_name"] for e in events} == {"TRUCK-1"}


async def test_portal_patch_container_changes_make_load_and_unload_events(
        client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Rig P")
    a, b, c = (Container(name=n) for n in ("Crate A", "Crate B", "Crate C"))
    db.add_all([a, b, c])
    await db.flush()
    asset = Asset(name="Thing", serial_number="SN-FEED-1", legacy_id=77001)
    db.add(asset)
    await db.flush()
    db.add(ContainerAsset(container_id=b.id, asset_id=asset.id))
    db.add(TruckContainer(truck_id=t.id, container_id=a.id))
    await db.commit()
    tid, aid, bid, cid = t.id, a.id, b.id, c.id

    resp = await client.patch(f"/trucks/{tid}", headers=hdrs,
                              json={"container_ids": [str(bid), str(cid)]})
    assert resp.status_code == 200, resp.text
    events = (await _feed(client, hdrs))["events"]
    got = {(e["kind"], e["container_name"], e["asset_count"], e["via"],
            e["container_id"]) for e in events}
    assert got == {("unload", "Crate A", 0, "portal", str(aid)),
                   ("load", "Crate B", 1, "portal", str(bid)),
                   ("load", "Crate C", 0, "portal", str(cid))}
    assert len({e["id"] for e in events}) == 3
    assert all(e["actor_name"] for e in events)


async def test_deleted_container_has_no_name_or_count(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Rig D")
    gone = uuid.uuid4()          # a container id that no longer exists
    _audit(db, t.id, 1, "update", {"container_ids": {"from": [], "to": [str(gone)]}})
    await db.commit()
    [ev] = (await _feed(client, hdrs))["events"]
    assert (ev["kind"], ev["via"], ev["container_id"]) == ("load", "portal", str(gone))
    assert ev["container_name"] is None and ev["asset_count"] is None


async def test_bulk_import_container_rows_make_import_events(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Rig I")
    created = _audit(db, t.id, 1, "create",
                     {"name": {"from": None, "to": "Rig I"},
                      "containers": {"from": [], "to": ["Crate X", "Crate Y"]}})
    updated = _audit(db, t.id, 2, "update",
                     {"containers": {"from": ["Crate X", "Crate Y"], "to": ["Crate Y", "Crate Z"]},
                      "status": {"from": "created", "to": "active"}})
    await db.commit()

    events = (await _feed(client, hdrs))["events"]
    summary = [(e["kind"], e.get("container_name"), e["via"]) for e in events
               if e["id"].startswith(f"audit:{updated.id}")]
    assert sorted(summary) == [("load", "Crate Z", "import"),
                               ("status", None, None),
                               ("unload", "Crate X", "import")]
    created_events = [e for e in events if e["id"].startswith(f"audit:{created.id}")]
    assert sorted((e["kind"], e["container_name"], e["via"]) for e in created_events) == [
        ("load", "Crate X", "import"), ("load", "Crate Y", "import")]
    assert all(e["asset_count"] is None and e["container_id"] is None
               for e in created_events)


async def test_real_bulk_import_commit_shapes_are_read(client, db, seeded_user):
    """Rows written by the importer (create with containers, update with
    status + containers) are what the feed's import branch reads."""
    admin = Person(first_name="Ada", last_name="Admin", email="ada.feed@test.example.com")
    db.add(admin)
    await db.flush()
    db.add(PersonRole(person_id=admin.id, role="admin"))
    crate_a, crate_b = Container(name="Imp A"), Container(name="Imp B")
    existing = Truck(name="Imp Existing", status="created")
    db.add_all([crate_a, crate_b, existing])
    await db.flush()
    db.add(TruckContainer(truck_id=existing.id, container_id=crate_a.id))
    await db.commit()
    hdrs = await make_login(db, client, admin, "ada.feed@test.example.com")

    rows = [{"name": "Imp Existing", "status": "active", "containers": "Imp B"},
            {"name": "Imp New", "containers": "Imp A"}]
    preview = (await client.post("/trucks/bulk-import/preview", headers=hdrs,
                                 json={"rows": rows})).json()
    resp = await client.post("/trucks/bulk-import/commit", headers=hdrs, json={
        "rows": [r["cells"] for r in preview["rows"]],
        "approved_updates": [str(existing.id)], "source": "fleet.csv"})
    assert resp.status_code == 200, resp.text

    events = (await _feed(client, hdrs))["events"]
    got = sorted((e["truck_name"], e["kind"], e["container_name"], e["via"])
                 for e in events if e["kind"] != "status")
    assert got == [("Imp Existing", "load", "Imp B", "import"),
                   ("Imp Existing", "unload", "Imp A", "import"),
                   ("Imp New", "load", "Imp A", "import")]
    [status] = [e for e in events if e["kind"] == "status"]
    assert (status["truck_name"], status["from_status"], status["to_status"]) == (
        "Imp Existing", "created", "active")
    assert status["actor_name"] == "Ada Admin"


# ── scope ─────────────────────────────────────────────────────────

async def test_filter_by_move(client, db, seeded_user):
    hdrs = await login(client)
    m1 = Initiative(name="M1", initiative_type="move")
    m2 = Initiative(name="M2", initiative_type="move")
    db.add_all([m1, m2])
    await db.flush()
    t1 = await _truck(db, "T1", initiative_id=m1.id)
    t2 = await _truck(db, "T2", initiative_id=m2.id)
    t3 = await _truck(db, "T3")
    for i, t in enumerate((t1, t2, t3)):
        _loc(db, t, i)
        _audit(db, t.id, i, "update", {"status": {"from": "active", "to": "in_transit"}})
        _audit(db, t.id, i, "kiosk_truck_load", {"container_name": "C", "asset_count": 0})
    await db.commit()
    body = await _feed(client, hdrs, f"?initiative_id={m1.id}")
    assert len(body["events"]) == 3
    assert {e["truck_name"] for e in body["events"]} == {"T1"}
    assert len((await _feed(client, hdrs))["events"]) == 9


async def test_archived_trucks_appear_deleted_trucks_do_not(client, db, seeded_user):
    hdrs = await login(client)
    archived = await _truck(db, "Old Rig", archived_at=at(50))
    _loc(db, archived, 1)
    _audit(db, archived.id, 2, "update", {"status": {"from": "active", "to": "historical"}})
    _audit(db, uuid.uuid4(), 3, "update", {"status": {"from": "active", "to": "historical"}})
    _audit(db, uuid.uuid4(), 4, "kiosk_truck_load", {"container_name": "Ghost"})
    _audit(db, None, 5, "update", {"status": {"from": "a", "to": "b"}},
           entity_id="not-a-uuid")
    await db.commit()
    events = (await _feed(client, hdrs))["events"]
    assert {e["truck_name"] for e in events} == {"Old Rig"}
    assert sorted(e["kind"] for e in events) == ["location", "status"]


async def test_merged_newest_first_across_kinds(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Mix")
    _loc(db, t, 1)
    _audit(db, t.id, 2, "update", {"status": {"from": "active", "to": "in_transit"}})
    _loc(db, t, 3)
    _audit(db, t.id, 4, "kiosk_truck_load", {"container_name": "C", "asset_count": 2})
    _audit(db, t.id, 5, "kiosk_truck_unload", {"container_name": "C", "asset_count": 2})
    await db.commit()
    kinds = [e["kind"] for e in (await _feed(client, hdrs))["events"]]
    assert kinds == ["unload", "load", "location", "status", "location"]


# ── paging ────────────────────────────────────────────────────────

async def _walk(client, hdrs, limit):
    """Follow next_before verbatim (as the portal does) to the end."""
    seen, pages, cursor = [], 0, None
    while True:
        params = {"limit": limit, **({"before": cursor} if cursor else {})}
        resp = await client.get("/trucks/feed", params=params, headers=hdrs)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        pages += 1
        seen += [e["id"] for e in body["events"]]
        assert len(body["events"]) <= limit
        cursor = body["next_before"]
        if cursor is None:
            return seen, pages
        assert pages < 100, seen[-6:]


async def test_paging_never_drops_or_repeats_events_tied_on_timestamp(
        client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Tie")
    a, b = Container(name="Tie A"), Container(name="Tie B")
    db.add_all([a, b])
    await db.flush()
    # 10 location rows at the same instant, 5 kiosk rows at that instant, one
    # patch row at that instant yielding two events, plus older/newer rows
    for i in range(10):
        _loc(db, t, 10, id=uuid.UUID(int=0xA000 + i))
    for i in range(5):
        _audit(db, t.id, 10, "kiosk_truck_load", {"container_name": f"K{i}"},
               id=uuid.UUID(int=0xB000 + i))
    _audit(db, t.id, 10, "update",
           {"container_ids": {"from": [str(a.id)], "to": [str(b.id)]},
            "status": {"from": "active", "to": "in_transit"}},
           id=uuid.UUID(int=0xC000))
    for i in range(4):
        _loc(db, t, 20 + i)
        _loc(db, t, i)
    await db.commit()

    everything = (await _feed(client, hdrs, "?limit=200"))["events"]
    assert len(everything) == 10 + 5 + 3 + 8
    expected = [e["id"] for e in everything]
    assert len(set(expected)) == len(expected)
    for limit in (1, 2, 3, 4, 7, 50):
        seen, pages = await _walk(client, hdrs, limit)
        assert seen == expected, limit
        assert limit >= 50 or pages > 1


async def test_next_before_is_null_when_exactly_exhausted(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Exact")
    for i in range(3):
        _loc(db, t, i)
    await db.commit()
    body = await _feed(client, hdrs, "?limit=3")
    assert len(body["events"]) == 3 and body["next_before"] is None
    body = await _feed(client, hdrs, "?limit=2")
    assert len(body["events"]) == 2 and body["next_before"]


async def test_before_accepts_a_plain_iso_timestamp_strictly_older(
        client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Iso")
    for i in (1, 2, 3):
        _loc(db, t, i)
    _audit(db, t.id, 2, "kiosk_truck_load", {"container_name": "C"})
    await db.commit()
    body = await _feed(client, hdrs, "?before=2026-05-01T12:02:00Z")
    assert [e["at"][:19] for e in body["events"]] == ["2026-05-01T12:01:00"]
    resp = await client.get("/trucks/feed", params={"before": "2026-05-01T12:02:00+00:00"},
                            headers=hdrs)
    assert resp.status_code == 200
    assert len(resp.json()["events"]) == 1


async def test_bad_cursor_and_limits_are_422(client, db, seeded_user):
    hdrs = await login(client)
    bad = ("?before=yesterday", "?before=~loc:x", "?limit=0", "?limit=201",
           "?before=2026-05-01T12:00:00Z~loc:%00x",         # NUL byte
           "?before=%00",
           "?before=0001-01-01T00:00:00%2B05:00",           # overflows converting to UTC
           "?before=9999-12-31T23:59:59-05:00",
           "?before=1969-12-31T23:59:59Z",                  # before 1970
           "?before=9000-01-01T00:00:01Z",                  # after 9000-01-01
           f"?before=2026-05-01T12:00:00Z~{'x' * 200}")     # over 200 characters
    for q in bad:
        resp = await client.get(f"/trucks/feed{q}", headers=hdrs)
        assert resp.status_code == 422, (q, resp.status_code)
    edge = ("?before=1970-01-01T00:00:00Z", "?before=9000-01-01T00:00:00Z",
            f"?before=2026-05-01T12:00:00Z~{'x' * 170}")
    for q in edge:
        assert (await client.get(f"/trucks/feed{q}", headers=hdrs)).status_code == 200, q
    assert (await client.get("/trucks/feed?limit=200", headers=hdrs)).status_code == 200


async def test_status_rows_without_events_do_not_starve_the_page(
        client, db, seeded_user):
    """Rows that carry no event (other field edits) are filtered in SQL, so
    they cannot eat the per-source row limit."""
    hdrs = await login(client)
    t = await _truck(db, "Starve")
    _loc(db, t, 1)
    for i in range(30):
        _audit(db, t.id, 10 + i, "update", {"driver_name": {"from": None, "to": f"D{i}"}})
    _audit(db, t.id, 2, "update", {"status": {"from": "active", "to": "in_transit"}})
    await db.commit()
    body = await _feed(client, hdrs, "?limit=2")
    assert [e["kind"] for e in body["events"]] == ["status", "location"]
    assert body["next_before"] is None


# ── gates, performance ────────────────────────────────────────────

async def test_feed_gates(client, db, seeded_user):
    org = Client(name="Feed Org")
    db.add(org)
    await db.commit()
    hdrs = await client_login(db, client, org.id)
    assert (await client.get("/trucks/feed", headers=hdrs)).status_code == 403
    assert (await client.get("/trucks/feed")).status_code == 401


async def test_feed_query_count_is_flat_as_events_grow(client, db, seeded_user):
    hdrs = await login(client)
    await _vocab(db)
    engine = get_engine().sync_engine
    statements = []

    def count(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async def add(n, prefix):
        for i in range(n):
            m = Initiative(name=f"{prefix}M{i}", initiative_type="move")
            db.add(m)
            await db.flush()
            t = await _truck(db, f"{prefix}{i}", initiative_id=m.id, load_number=f"L{i}")
            c = Container(name=f"{prefix}C{i}")
            db.add(c)
            await db.flush()
            _loc(db, t, i)
            _audit(db, t.id, i, "update",
                   {"status": {"from": "active", "to": "in_transit"},
                    "container_ids": {"from": [], "to": [str(c.id)]}},
                   actor=seeded_user.id)
            _audit(db, t.id, i, "kiosk_truck_unload", {"container_name": "C"},
                   actor=seeded_user.id)
        await db.commit()

    async def measure():
        statements.clear()
        event.listen(engine, "before_cursor_execute", count)
        try:
            body = await _feed(client, hdrs, "?limit=200")
        finally:
            event.remove(engine, "before_cursor_execute", count)
        return len(statements), len(body["events"])

    await add(2, "S")
    small = await measure()
    await add(15, "L")
    large = await measure()
    assert small[1] == 8 and large[1] == 68
    assert 0 < small[0] == large[0], (small, large)
