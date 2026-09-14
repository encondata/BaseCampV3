"""POST /kiosk/printer-events — a kiosk reporting printer maintenance it
performed over WebUSB (today only a factory reset). Nothing but an audit
row is written, so an admin can review in the portal that a printer was
wiped, by whom, and whether it worked. Gated on kiosk:view; deliberately
EXEMPT from read-only mode, unlike /kiosk/scans."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, Person, PersonRole
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login, make_login
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin

SERIAL = "kiosk-web-printer-events-1"
KIOSK_NAME = "Kiosk Printer Bench"


async def _seed_kiosk(db, *, serial=SERIAL, name=KIOSK_NAME, device_type="kiosk"):
    device = Device(device_type=device_type, name=name, serial=serial)
    db.add(device)
    await db.flush()
    return device


def _event(**kw):
    return {"serial": SERIAL, "event": "factory_reset", "outcome": "completed",
            "printer_model": "ZD421-203dpi ZPL", "printer_firmware": "V92.21.16Z",
            "calibrated": True, **kw}


async def _rows(db, action="kiosk_printer_factory_reset"):
    db.expire_all()
    return (await db.scalars(
        select(AuditLog).where(AuditLog.action == action))).all()


async def test_completed_reset_writes_one_audit_row(client, db, seeded_user):
    hdrs = await login(client)
    actor_id = seeded_user.id
    device = await _seed_kiosk(db)
    await db.commit()
    device_id = device.id

    resp = await client.post("/kiosk/printer-events", headers=hdrs, json=_event())
    assert resp.status_code == 204, resp.text

    rows = await _rows(db)
    assert len(rows) == 1
    row = rows[0]
    assert row.entity_type == "device"
    assert row.entity_id == str(device_id)
    assert row.actor_person_id == actor_id
    assert row.changes == {"outcome": "completed",
                           "printer_model": "ZD421-203dpi ZPL",
                           "printer_firmware": "V92.21.16Z",
                           "calibrated": True}
    # null-valued keys are omitted, not stored as nulls
    assert "failed_step" not in row.changes
    assert "error" not in row.changes

    db.expire_all()
    assert (await db.get(Device, device_id)).last_seen_at is not None


async def test_failed_reset_carries_the_step_and_error(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_kiosk(db)
    await db.commit()

    resp = await client.post("/kiosk/printer-events", headers=hdrs, json=_event(
        outcome="failed", calibrated=False, failed_step="restart",
        error="The printer did not come back. Power-cycle it, reconnect, and try again.",
        printer_firmware=None))
    assert resp.status_code == 204, resp.text

    row = (await _rows(db))[0]
    assert row.changes["outcome"] == "failed"
    assert row.changes["failed_step"] == "restart"
    assert row.changes["error"].startswith("The printer did not come back")
    assert row.changes["calibrated"] is False
    assert "printer_firmware" not in row.changes


async def test_unknown_serial_is_404(client, db, seeded_user):
    hdrs = await login(client)
    await db.commit()
    resp = await client.post("/kiosk/printer-events", headers=hdrs,
                             json=_event(serial="kiosk-web-nope"))
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "device_not_found"
    assert await _rows(db) == []


async def test_a_non_kiosk_device_is_404(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_kiosk(db, serial="router-printer-events", name="Dock Router",
                      device_type="router")
    await db.commit()
    resp = await client.post("/kiosk/printer-events", headers=hdrs,
                             json=_event(serial="router-printer-events"))
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "device_not_found"


async def test_permission(client, db, seeded_user):
    await _seed_kiosk(db)
    await db.commit()
    cv = await _client_viewer(db, client, "cv-printer-events@test.example.com")
    assert (await client.post("/kiosk/printer-events", headers=cv,
                              json=_event())).status_code == 403
    assert (await client.post("/kiosk/printer-events",
                              json=_event())).status_code == 401


async def test_worker_can_report_a_reset(client, db, seeded_user):
    """A worker — the persona a kiosk is actually signed into — holds
    kiosk:view, so the report is not admin-only."""
    hdrs = await _make(db, client, "worker", "w-printer-events@test.example.com")
    await _seed_kiosk(db)
    await db.commit()
    resp = await client.post("/kiosk/printer-events", headers=hdrs, json=_event())
    assert resp.status_code == 204, resp.text


async def test_read_only_mode_still_accepts_the_report(client, db, seeded_user):
    """The physical reset already happened. Refusing to record it during a
    maintenance freeze loses the very trail this endpoint exists to keep,
    and an append-only audit row is safe to write while frozen — so this
    path is read-only exempt. /kiosk/scans, whose writes are real data the
    kiosk can retry later, still returns 423."""
    hdrs = await login(client)
    await _seed_kiosk(db)
    await db.commit()
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200

    resp = await client.post("/kiosk/printer-events", headers=hdrs, json=_event())
    assert resp.status_code == 204, resp.text
    assert len(await _rows(db)) == 1

    frozen = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL,
        "scans": [{"client_scan_id": "11111111-1111-4111-8111-111111111111",
                   "scanned_value": "EPC-RO", "scan_type": "rfid",
                   "scanned_at": "2026-09-14T08:00:00+00:00"}]})
    assert frozen.status_code == 423, frozen.text


async def test_the_row_shows_up_on_the_audit_page(client, db, seeded_user):
    """An audit:view persona sees the reset with the kiosk's name in the
    Target column (entity_name resolution for `device` rows)."""
    hdrs = await login(client)
    device = await _seed_kiosk(db)
    admin_person = Person(first_name="Ada", last_name="Admin",
                          email="ada-printer-events@test.example.com")
    db.add(admin_person)
    await db.flush()
    db.add(PersonRole(person_id=admin_person.id, role="admin"))
    await db.commit()
    device_id = device.id
    admin_hdrs = await make_login(db, client, admin_person,
                                  "ada-printer-events@test.example.com")

    assert (await client.post("/kiosk/printer-events", headers=hdrs,
                              json=_event())).status_code == 204

    rows = (await client.get("/audit?action=kiosk_printer_factory_reset",
                             headers=admin_hdrs)).json()
    assert len(rows) == 1
    row = rows[0]
    assert row["entity_type"] == "device"
    assert row["entity_id"] == str(device_id)
    assert row["entity_name"] == KIOSK_NAME
    assert row["actor_name"] == "Alice Anderson"
    assert row["changes"]["outcome"] == "completed"


async def test_the_actor_sees_it_in_their_own_activity(client, db, seeded_user):
    """/auth/me/activity reads the same audit_log, so the person who ran
    the reset finds it in their own history."""
    hdrs = await login(client)
    await _seed_kiosk(db)
    await db.commit()
    assert (await client.post("/kiosk/printer-events", headers=hdrs,
                              json=_event())).status_code == 204

    rows = (await client.get("/auth/me/activity", headers=hdrs)).json()
    mine = next(r for r in rows if r["action"] == "kiosk_printer_factory_reset")
    assert mine["by_me"] is True
    assert mine["entity_name"] == KIOSK_NAME
    assert mine["changes"]["printer_model"] == "ZD421-203dpi ZPL"
