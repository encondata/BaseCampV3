"""Kiosk Asset Lookup: GET /kiosk/assets/lookup finds a device by asset
tag, serial, RFID or part name, within the reach the kiosk's own move
and the person's rank give. Read-only. Design:
docs/superpowers/specs/2026-11-08-kiosk-asset-lookup-design.md"""

from decimal import Decimal

from sqlalchemy import select, update

from serversherpa.db.models import (
    Asset,
    Client,
    Container,
    ContainerAsset,
    Device,
    Initiative,
    InitiativeAsset,
    PermissionOverride,
    RawScan,
    Site,
    StatusValue,
    Truck,
    TruckContainer,
    UserAccount,
)
from tests.test_sites_api import login
from tests.test_status_values_write import _make

SERIAL = "kiosk-lookup-1"
CHECKPOINT = "lookup_test_checkpoint"
PW = "Crew-2026!"
WORKER = "w@test.example.com"
ADMIN = "adm@test.example.com"


async def _world(db, client):
    """Two clients, three moves (M and M2 for Atlas, Y for Other Co), a
    kiosk set up for M, five assets and a crate on a truck; worker, staff
    (needs the `seeded_user` fixture) and admin logins."""
    cx, cy = Client(name="Atlas"), Client(name="Other Co")
    atl1, atl2 = Site(name="ATL1"), Site(name="ATL2")
    db.add_all([cx, cy, atl1, atl2])
    await db.flush()
    m = Initiative(name="ATL1 Move", initiative_type="move", status="in_progress",
                   client_id=cx.id, origin_site_id=atl1.id, destination_site_id=atl2.id)
    m2 = Initiative(name="ATL1 Wave 2", initiative_type="move", status="in_progress",
                    client_id=cx.id)
    y = Initiative(name="Other Move", initiative_type="move", status="in_progress",
                   client_id=cy.id)
    db.add_all([m, m2, y, StatusValue(record_type="asset", key=CHECKPOINT, label="Lookup CP",
                                      color="#123456", sort_order=1, is_active=True)])
    await db.flush()
    for record_type, key, label in (("container", "available", "Available"),
                                    ("truck", "in_transit", "In Transit")):
        if await db.scalar(select(StatusValue).where(
                StatusValue.record_type == record_type, StatusValue.key == key)) is None:
            db.add(StatusValue(record_type=record_type, key=key, label=label,
                               color="#2e7d32", sort_order=0, is_active=True))

    web = Asset(name="atl1-web-001", legacy_id=102466, serial_number="SN-WEB-001",
                rfid_tag="0" * 12 + "E28011700000", client_id=cx.id)
    twin = Asset(name="atl1-db-002", legacy_id=102467, rfid_tag="0" * 18 + "102466",
                 client_id=cx.id)
    x_other = Asset(name="atl1-web-003", client_id=cx.id)
    x_loose = Asset(name="atl1-spare-004", location_detail="Cage 4", client_id=cx.id)
    y_asset = Asset(name="atl1-web-900", serial_number="SN-Y-900", client_id=cy.id)
    db.add_all([web, twin, x_other, x_loose, y_asset])
    await db.flush()
    db.add_all([
        InitiativeAsset(initiative_id=m.id, asset_id=web.id,
                        source_pod="P1", source_rack="R12", source_ru=Decimal(14),
                        destination_pod="P7", destination_rack="C03",
                        destination_ru=Decimal(22)),
        InitiativeAsset(initiative_id=m.id, asset_id=twin.id),
        InitiativeAsset(initiative_id=m2.id, asset_id=x_other.id),
        InitiativeAsset(initiative_id=y.id, asset_id=y_asset.id),
    ])
    crate = Container(name="ATL1-W1M-DC-01", status="available", initiative_id=m.id)
    truck = Truck(name="ATL1-T01", status="in_transit", initiative_id=m.id)
    db.add_all([crate, truck])
    await db.flush()
    db.add_all([ContainerAsset(container_id=crate.id, asset_id=web.id),
                TruckContainer(truck_id=truck.id, container_id=crate.id)])
    kiosk = Device(device_type="kiosk", name="Lookup kiosk", serial=SERIAL, site_id=atl1.id,
                   current_initiative_id=m.id, scan_status=CHECKPOINT)
    db.add(kiosk)
    await db.commit()

    worker = await _make(db, client, "worker", WORKER)
    admin = await _make(db, client, "admin", ADMIN)
    staff = await login(client)
    return {"cx": cx, "cy": cy, "atl1": atl1, "atl2": atl2, "m": m, "m2": m2, "y": y,
            "web": web, "twin": twin, "x_other": x_other, "x_loose": x_loose,
            "y_asset": y_asset, "crate": crate, "truck": truck, "kiosk": kiosk,
            "worker": worker, "admin": admin, "staff": staff}


async def _lookup(client, hdrs, q, serial=SERIAL, **params):
    return await client.get("/kiosk/assets/lookup", headers=hdrs,
                            params={"serial": serial, "q": q, **params})


async def _matches(client, hdrs, q, **kw):
    r = await _lookup(client, hdrs, q, **kw)
    assert r.status_code == 200, r.text
    return r.json()


def _pairs(body):
    return [(m["id"], m["matched"]) for m in body["matches"]]


def _code(r):
    return r.json()["detail"]["code"]


async def test_each_exact_key_finds_its_device(client, db, seeded_user):
    w = await _world(db, client)
    web, twin = str(w["web"].id), str(w["twin"].id)
    for q, expected in (("102467", [(twin, ["asset_tag"])]),
                        (" sn-web-001 ", [(web, ["serial"])]),
                        ("e28011700000", [(web, ["rfid"])]),
                        ("0" * 12 + "E28011700000", [(web, ["rfid"])])):
        body = await _matches(client, w["worker"], q)
        assert _pairs(body) == expected, q
        assert body["truncated"] is False
        match = body["matches"][0]
        assert match["asset_tag"] == ("102467" if match["id"] == twin else "102466")
    body = await _matches(client, w["worker"], "SN-WEB-001")
    assert body["matches"][0] == {"id": web, "name": "atl1-web-001", "asset_tag": "102466",
                                  "serial_number": "SN-WEB-001", "matched": ["serial"]}
    # read-only: no scan recorded, the kiosk's last_seen_at untouched
    assert await db.scalar(select(RawScan.id)) is None
    kiosk_id = w["kiosk"].id
    db.expire_all()
    assert (await db.get(Device, kiosk_id)).last_seen_at is None


async def test_asset_tag_and_rfid_on_different_devices_return_both(client, db, seeded_user):
    w = await _world(db, client)
    body = await _matches(client, w["worker"], "102466")
    assert _pairs(body) == [(str(w["web"].id), ["asset_tag"]),
                            (str(w["twin"].id), ["rfid"])]


async def test_rfid_never_matches_an_asset_tag(client, db, seeded_user):
    w = await _world(db, client)
    body = await _matches(client, w["worker"], "0" * 18 + "102466")
    assert _pairs(body) == [(str(w["twin"].id), ["rfid"])]


async def test_part_name_finds_several_in_reach(client, db, seeded_user):
    w = await _world(db, client)
    body = await _matches(client, w["worker"], "WEB")
    assert [m["name"] for m in body["matches"]] == ["atl1-web-001", "atl1-web-003"]
    assert all(m["matched"] == ["name"] for m in body["matches"])
    assert body["truncated"] is False


async def test_name_results_stop_at_25_with_truncated(client, db, seeded_user):
    w = await _world(db, client)
    bulk = [Asset(name=f"bulk-rack-{i:02d}", client_id=w["cx"].id) for i in range(1, 31)]
    db.add_all(bulk)
    await db.flush()
    db.add_all([InitiativeAsset(initiative_id=w["m"].id, asset_id=a.id) for a in bulk])
    await db.commit()
    body = await _matches(client, w["worker"], "bulk-rack")
    assert len(body["matches"]) == 25
    assert body["truncated"] is True
    assert body["matches"][0]["name"] == "bulk-rack-01"
    assert body["matches"][-1]["name"] == "bulk-rack-25"


async def test_no_match_is_empty(client, db, seeded_user):
    w = await _world(db, client)
    assert await _matches(client, w["worker"], "nothing-here") == {
        "matches": [], "truncated": False}


async def test_worker_reach_is_the_synced_set(client, db, seeded_user):
    w = await _world(db, client)
    body = await _matches(client, w["worker"], "atl1-spare")
    assert _pairs(body) == [(str(w["x_loose"].id), ["name"])]
    assert (await _matches(client, w["worker"], "SN-Y-900"))["matches"] == []
    # the device decides the move: a move id the screen sends is ignored
    body = await _matches(client, w["worker"], "SN-Y-900", initiative_id=str(w["y"].id))
    assert body["matches"] == []
    r = await _lookup(client, w["worker"], "SN-WEB-001", serial="nope")
    assert r.status_code == 404 and _code(r) == "device_not_found"


async def test_move_password_session_stays_on_its_move(client, db, seeded_user):
    w = await _world(db, client)
    r = await client.patch(f"/initiatives/{w['m'].id}", headers=w["admin"],
                           json={"kiosk_password": PW})
    assert r.status_code == 200, r.text
    r = await client.post("/kiosk/move-login", json={"password": PW})
    assert r.status_code == 200, r.text
    hdrs = {"Authorization": f"Bearer {r.json()['access_token']}"}
    body = await _matches(client, hdrs, "atl1")
    assert {m["id"] for m in body["matches"]} == {str(w["web"].id), str(w["twin"].id)}

    db.add(Device(device_type="kiosk", name="Lookup kiosk Y", serial="kiosk-lookup-y",
                  site_id=w["atl1"].id, current_initiative_id=w["y"].id,
                  scan_status=CHECKPOINT))
    await db.commit()
    r = await _lookup(client, hdrs, "atl1", serial="kiosk-lookup-y")
    assert r.status_code == 403 and _code(r) == "move_locked"


async def test_admin_follows_scope_plus_kiosk_move(client, db, seeded_user):
    w = await _world(db, client)
    body = await _matches(client, w["admin"], "SN-Y-900")
    assert _pairs(body) == [(str(w["y_asset"].id), ["serial"])]

    admin_id = await db.scalar(select(UserAccount.person_id).where(UserAccount.email == ADMIN))
    db.add(PermissionOverride(person_id=admin_id, resource="assets", action="view",
                              allow=False))
    await db.commit()
    assert (await _matches(client, w["admin"], "SN-Y-900"))["matches"] == []
    body = await _matches(client, w["admin"], "SN-WEB-001")
    assert _pairs(body) == [(str(w["web"].id), ["serial"])]


async def test_a_kiosk_without_a_move_gives_a_worker_nothing(client, db, seeded_user):
    w = await _world(db, client)
    await db.execute(update(Device).where(Device.serial == SERIAL)
                     .values(current_initiative_id=None))
    await db.commit()
    assert await _matches(client, w["worker"], "SN-WEB-001") == {
        "matches": [], "truncated": False}
    body = await _matches(client, w["admin"], "SN-WEB-001")
    assert _pairs(body) == [(str(w["web"].id), ["serial"])]


async def test_archived_asset_is_not_found(client, db, seeded_user):
    w = await _world(db, client)
    await db.execute(update(Asset).where(Asset.id == w["web"].id)
                     .values(archived_at=Asset.created_at))
    await db.commit()
    assert (await _matches(client, w["worker"], "SN-WEB-001"))["matches"] == []
    assert (await _matches(client, w["admin"], "SN-WEB-001"))["matches"] == []


async def test_odd_input_never_errors(client, db, seeded_user):
    w = await _world(db, client)
    for q in ("%", "_", "1" * 23, "A" * 30, "Ünïcode", "a\\b"):
        body = await _matches(client, w["worker"], q)
        if q in ("%", "_"):
            assert body["matches"] == [], q
