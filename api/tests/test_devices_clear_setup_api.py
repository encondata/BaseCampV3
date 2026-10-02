"""Clear Setup on a kiosk row: request (fresh id each time), cancel,
404/409/403, audit, and the list fields the portal's pending chip reads."""

from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, Device
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff


async def _kiosk(db, name="kiosk-dock-1", device_type="kiosk") -> Device:
    d = Device(device_type=device_type, name=name)
    db.add(d)
    await db.commit()
    return d


async def test_request_sets_a_pending_clear_and_audits(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _kiosk(db)
    resp = await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["setup_clear_requested_at"] is not None
    assert body["setup_clear_requested_by_name"]          # the admin's display name
    await db.refresh(d)
    assert d.setup_clear_id is not None
    assert d.setup_clear_requested_by == seeded_user.id
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "clear_setup_requested",
        AuditLog.entity_id == str(d.id)))
    assert row is not None and row.changes["request_id"] == str(d.setup_clear_id)


async def test_re_request_replaces_the_id(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _kiosk(db)
    await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    await db.refresh(d)
    first = d.setup_clear_id
    await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    await db.refresh(d)
    assert d.setup_clear_id is not None and d.setup_clear_id != first


async def test_cancel_clears_it_and_audits_once(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _kiosk(db)
    await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    await db.refresh(d)
    pending = d.setup_clear_id
    resp = await client.post(f"/devices/{d.id}/clear-setup/cancel", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["setup_clear_requested_at"] is None
    assert resp.json()["setup_clear_requested_by_name"] is None
    await db.refresh(d)
    assert (d.setup_clear_id, d.setup_clear_requested_at, d.setup_clear_requested_by) == (None, None, None)
    # cancelling again is a quiet no-op
    resp = await client.post(f"/devices/{d.id}/clear-setup/cancel", headers=hdrs)
    assert resp.status_code == 200
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "clear_setup_cancelled", AuditLog.entity_id == str(d.id)))).all()
    assert len(rows) == 1 and rows[0].changes["request_id"] == str(pending)


async def test_unknown_device_404_and_non_kiosk_409(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/devices/00000000-0000-0000-0000-000000000000/clear-setup", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "device_not_found"
    router = await _kiosk(db, name="dock-router", device_type="router")
    for path in ("clear-setup", "clear-setup/cancel"):
        resp = await client.post(f"/devices/{router.id}/{path}", headers=hdrs)
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_a_kiosk"


async def test_needs_scanning_hardware_change(client, db, seeded_user):
    await db.execute(text("UPDATE person_roles SET role='external' WHERE person_id=:p"),
                     {"p": seeded_user.id})
    await db.commit()
    hdrs = await login_staff(client, seeded_user)
    d = await _kiosk(db)
    for path in ("clear-setup", "clear-setup/cancel"):
        resp = await client.post(f"/devices/{d.id}/{path}", headers=hdrs)
        assert resp.status_code == 403


async def test_list_exposes_the_pending_fields(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _kiosk(db)
    resp = await client.get("/devices?device_type=kiosk", headers=hdrs)
    row = next(r for r in resp.json() if r["id"] == str(d.id))
    assert row["setup_clear_requested_at"] is None and row["setup_clear_requested_by_name"] is None
    await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    resp = await client.get("/devices?device_type=kiosk", headers=hdrs)
    row = next(r for r in resp.json() if r["id"] == str(d.id))
    assert row["setup_clear_requested_at"] is not None and row["setup_clear_requested_by_name"]
    assert "setup_clear_id" not in row
