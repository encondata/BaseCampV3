"""Heartbeat side of Clear Setup: the reply repeats the pending id until a
later beat acknowledges that exact id; stale acks are ignored."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device
from tests.test_access_roles_api import login_admin

BODY = {"serial": "kiosk-web-clr1", "name": "Dock 9", "mode": "web", "version": "0.1.0"}


async def _beat(client, hdrs, **extra):
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={**BODY, **extra})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _request(client, db, hdrs) -> str:
    d = await db.scalar(select(Device).where(Device.serial == BODY["serial"]))
    resp = await client.post(f"/devices/{d.id}/clear-setup", headers=hdrs)
    assert resp.status_code == 200, resp.text
    await db.refresh(d)
    return str(d.setup_clear_id)


async def test_reply_is_null_when_nothing_pending(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    assert (await _beat(client, hdrs))["clear_setup"] is None


async def test_reply_repeats_the_pending_id_until_acked(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _beat(client, hdrs)                       # creates the kiosk row
    pending = await _request(client, db, hdrs)
    assert (await _beat(client, hdrs))["clear_setup"] == pending
    assert (await _beat(client, hdrs))["clear_setup"] == pending
    # the ack closes it, and that same reply no longer asks
    assert (await _beat(client, hdrs, setup_cleared=pending))["clear_setup"] is None
    d = await db.scalar(select(Device).where(Device.serial == BODY["serial"]))
    await db.refresh(d)
    assert (d.setup_clear_id, d.setup_clear_requested_at, d.setup_clear_requested_by) == (None, None, None)
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "setup_cleared", AuditLog.entity_id == str(d.id)))
    assert row is not None
    assert row.changes["request_id"] == pending
    assert row.changes["requested_by"] == str(seeded_user.id)


async def test_stale_ack_is_ignored(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _beat(client, hdrs)
    old = await _request(client, db, hdrs)
    new = await _request(client, db, hdrs)            # re-request → new id
    assert old != new
    assert (await _beat(client, hdrs, setup_cleared=old))["clear_setup"] == new
    assert (await db.scalar(select(AuditLog).where(AuditLog.action == "setup_cleared"))) is None


async def test_ack_after_cancel_is_ignored(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _beat(client, hdrs)
    pending = await _request(client, db, hdrs)
    d = await db.scalar(select(Device).where(Device.serial == BODY["serial"]))
    await client.post(f"/devices/{d.id}/clear-setup/cancel", headers=hdrs)
    assert (await _beat(client, hdrs, setup_cleared=pending))["clear_setup"] is None
    assert (await db.scalar(select(AuditLog).where(AuditLog.action == "setup_cleared"))) is None


async def test_first_beat_ack_on_a_new_row_is_harmless(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    body = await _beat(client, hdrs, setup_cleared="00000000-0000-0000-0000-000000000001")
    assert body["clear_setup"] is None


async def test_sign_in_beat_also_carries_the_request(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _beat(client, hdrs)
    pending = await _request(client, db, hdrs)
    body = await _beat(client, hdrs, sign_in=True, login_method="password")
    assert body["clear_setup"] == pending


async def test_ack_never_wipes_a_request_made_after_the_beat_read_the_row(
        client, db, seeded_user):
    """The close is a guarded UPDATE: if another request lands between the
    heartbeat reading the row and writing it, the ack must not wipe it."""
    import uuid

    from sqlalchemy import event, text

    from serversherpa.db.engine import get_engine

    hdrs = await login_admin(client, db, seeded_user)
    await _beat(client, hdrs)
    old = await _request(client, db, hdrs)
    d = await db.scalar(select(Device).where(Device.serial == BODY["serial"]))
    newer = uuid.uuid4()
    fired = []

    def _concurrent_request(conn, cursor, statement, parameters, context, executemany):
        # Just before the heartbeat's own close runs, an admin re-requests
        # (same connection, so no lock wait; the DBAPI cursor bypasses events;
        # asyncpg numbered placeholders).
        if statement.startswith("UPDATE devices SET setup_clear_id") and not fired:
            fired.append(True)
            cursor.execute(
                "UPDATE devices SET setup_clear_id = $1::uuid WHERE id = $2::uuid",
                (str(newer), str(d.id)))

    sync_engine = get_engine().sync_engine
    event.listen(sync_engine, "before_cursor_execute", _concurrent_request)
    try:
        body = await _beat(client, hdrs, setup_cleared=old)
    finally:
        event.remove(sync_engine, "before_cursor_execute", _concurrent_request)

    assert fired
    assert body["clear_setup"] == str(newer)
    stored = (await db.execute(
        text("SELECT setup_clear_id FROM devices WHERE id = :i"), {"i": d.id})).scalar_one()
    assert stored == newer
    assert (await db.scalar(select(AuditLog).where(AuditLog.action == "setup_cleared"))) is None
