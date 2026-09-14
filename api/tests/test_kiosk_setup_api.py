"""Kiosk Setup wizard: GET /kiosk/setup-options (move initiatives +
active asset status values, filtered exactly like the portal's kiosk
modal) and POST /kiosk/setup (stamps the kiosk Device's
current_initiative_id/scan_status, audited). Workers hold kiosk:view but
not initiatives:view, which is why setup-options exists instead of the
kiosk calling /initiatives directly. Gated on kiosk:view; blocked under
read-only mode (it writes)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, Initiative, StatusValue
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin

SERIAL = "kiosk-web-setup-1"


async def _seed_initiatives(db):
    now = datetime.now(UTC)
    planned = Initiative(name="NAP11 Hall Migration (demo)",
                         initiative_type="move", status="planned")
    in_progress = Initiative(name="NAP7 Rack Move", initiative_type="move",
                             status="in_progress")
    completed = Initiative(name="Old Move", initiative_type="move",
                           status="completed")
    archived = Initiative(name="Archived Move", initiative_type="move",
                          status="planned", archived_at=now)
    not_a_move = Initiative(name="Some Project", initiative_type="project",
                            status="planned")
    db.add_all([planned, in_progress, completed, archived, not_a_move])
    await db.flush()
    return planned, in_progress, completed, archived, not_a_move


async def _seed_scan_types(db):
    active = StatusValue(record_type="asset", key="setup_test_active",
                         label="Setup Test Active", color="#123456",
                         sort_order=1, is_active=True)
    inactive = StatusValue(record_type="asset", key="setup_test_inactive",
                           label="Setup Test Inactive", color="#654321",
                           sort_order=2, is_active=False)
    other_type = StatusValue(record_type="site", key="setup_test_site",
                             label="Setup Test Site", color="#abcdef",
                             sort_order=0, is_active=True)
    db.add_all([active, inactive, other_type])
    await db.flush()
    return active, inactive, other_type


async def test_setup_options_filters_initiatives_and_scan_types(client, db, seeded_user):
    hdrs = await login(client)
    planned, in_progress, completed, archived, not_a_move = await _seed_initiatives(db)
    active, inactive, other_type = await _seed_scan_types(db)
    await db.commit()

    resp = await client.get("/kiosk/setup-options", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    names = {i["name"] for i in body["initiatives"]}
    assert names == {planned.name, in_progress.name}
    assert completed.name not in names
    assert archived.name not in names
    assert not_a_move.name not in names
    # ordered by name
    assert [i["name"] for i in body["initiatives"]] == sorted(names)

    keys = {s["key"] for s in body["scan_types"]}
    assert active.key in keys
    assert inactive.key not in keys
    assert other_type.key not in keys


async def test_setup_options_permission(client, db, seeded_user):
    w = await _make(db, client, "worker", "w-setup@test.example.com")
    assert (await client.get("/kiosk/setup-options", headers=w)).status_code == 200
    cv = await _client_viewer(db, client, "cv-setup@test.example.com")
    assert (await client.get("/kiosk/setup-options", headers=cv)).status_code == 403
    assert (await client.get("/kiosk/setup-options")).status_code == 401


async def test_setup_stamps_the_device_and_audits(client, db, seeded_user):
    hdrs = await login(client)
    seeded_user_id = seeded_user.id
    device = Device(device_type="kiosk", name="Kiosk Setup Target", serial=SERIAL)
    db.add(device)
    planned, *_ = await _seed_initiatives(db)
    active, *_ = await _seed_scan_types(db)
    await db.commit()
    device_id = device.id
    initiative_id = planned.id
    initiative_name = planned.name
    scan_key = active.key
    scan_label = active.label

    resp = await client.post("/kiosk/setup", headers=hdrs, json={
        "serial": SERIAL, "initiative_id": str(initiative_id),
        "scan_status": scan_key,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["device_id"] == str(device_id)
    assert body["initiative_id"] == str(initiative_id)
    assert body["initiative_name"] == initiative_name
    assert body["scan_status"] == scan_key
    assert body["scan_status_label"] == scan_label

    db.expire_all()
    got = await db.scalar(select(Device).where(Device.id == device_id))
    assert got.current_initiative_id == initiative_id
    assert got.scan_status == scan_key
    assert got.updated_at is not None

    audit = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "kiosk_setup",
        AuditLog.entity_id == str(device_id)))
    assert audit is not None
    assert audit.changes == {"initiative_id": str(initiative_id), "scan_status": scan_key}
    assert audit.actor_person_id == seeded_user_id

    # the device list surfaces both names through the usual joined shape
    resp = await client.get("/devices", headers=hdrs, params={"device_type": "kiosk"})
    assert resp.status_code == 200, resp.text
    item = next(i for i in resp.json() if i["id"] == str(device_id))
    assert item["current_initiative_name"] == initiative_name
    assert item["scan_status_label"] == scan_label


async def test_setup_permission(client, db, seeded_user):
    device = Device(device_type="kiosk", name="Kiosk Setup Perm", serial=SERIAL)
    db.add(device)
    planned, *_ = await _seed_initiatives(db)
    active, *_ = await _seed_scan_types(db)
    await db.commit()
    body = {"serial": SERIAL, "initiative_id": str(planned.id), "scan_status": active.key}

    cv = await _client_viewer(db, client, "cv-setup2@test.example.com")
    assert (await client.post("/kiosk/setup", headers=cv, json=body)).status_code == 403
    assert (await client.post("/kiosk/setup", json=body)).status_code == 401


async def test_setup_unknown_serial_is_404(client, db, seeded_user):
    hdrs = await login(client)
    planned, *_ = await _seed_initiatives(db)
    active, *_ = await _seed_scan_types(db)
    await db.commit()

    resp = await client.post("/kiosk/setup", headers=hdrs, json={
        "serial": "kiosk-web-does-not-exist",
        "initiative_id": str(planned.id), "scan_status": active.key,
    })
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "device_not_found"


async def test_setup_rejects_completed_initiative(client, db, seeded_user):
    hdrs = await login(client)
    device = Device(device_type="kiosk", name="Kiosk Setup Bad Init", serial=SERIAL)
    db.add(device)
    _, _, completed, _, _ = await _seed_initiatives(db)
    active, *_ = await _seed_scan_types(db)
    await db.commit()

    resp = await client.post("/kiosk/setup", headers=hdrs, json={
        "serial": SERIAL, "initiative_id": str(completed.id), "scan_status": active.key,
    })
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_initiative"


async def test_setup_rejects_inactive_scan_status(client, db, seeded_user):
    hdrs = await login(client)
    device = Device(device_type="kiosk", name="Kiosk Setup Bad Status", serial=SERIAL)
    db.add(device)
    planned, *_ = await _seed_initiatives(db)
    _, inactive, _ = await _seed_scan_types(db)
    await db.commit()

    resp = await client.post("/kiosk/setup", headers=hdrs, json={
        "serial": SERIAL, "initiative_id": str(planned.id), "scan_status": inactive.key,
    })
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_scan_status"


async def test_setup_blocked_in_read_only_mode(client, db, seeded_user):
    hdrs = await login(client)
    device = Device(device_type="kiosk", name="Kiosk Setup RO", serial=SERIAL)
    db.add(device)
    planned, *_ = await _seed_initiatives(db)
    active, *_ = await _seed_scan_types(db)
    await db.commit()

    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200

    resp = await client.post("/kiosk/setup", headers=hdrs, json={
        "serial": SERIAL, "initiative_id": str(planned.id), "scan_status": active.key,
    })
    assert resp.status_code == 423, resp.text
