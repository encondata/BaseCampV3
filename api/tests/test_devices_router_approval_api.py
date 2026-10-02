"""Approve / revoke an agent router on Scanning Hardware › Routers, and the
approval fields GET /devices exposes. Spec:
docs/superpowers/specs/2026-10-01-router-agent-design.md."""

import hashlib

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, Notification
from serversherpa.notifications.inbox import notify
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff

OLD = hashlib.sha256(b"a" * 64).hexdigest()
NEW = hashlib.sha256(b"b" * 64).hexdigest()


async def _router(db, **over) -> Device:
    fields = {"device_type": "router", "name": "dock-router", "mac": "94:83:c4:aa:bb:cc",
              "approval_state": "pending", "agent_secret_hash": OLD,
              "agent_source_ip": "203.0.113.7"}
    d = Device(**{**fields, **over})
    db.add(d)
    await db.commit()
    return d


async def test_approve_sets_state_promotes_the_candidate_secret_and_audits(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, pending_secret_hash=NEW, secret_mismatch=True)
    resp = await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["approval_state"] == "approved"
    assert body["approved_at"] is not None and body["approved_by_name"]
    assert body["secret_mismatch"] is False
    await db.refresh(d)
    assert d.agent_secret_hash == NEW and d.pending_secret_hash is None
    assert d.approved_by == seeded_user.id
    assert await db.scalar(select(AuditLog).where(
        AuditLog.action == "router_approve", AuditLog.entity_id == str(d.id))) is not None


async def test_approving_twice_is_a_quiet_no_op(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db)
    await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    resp = await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    assert resp.status_code == 200 and resp.json()["approval_state"] == "approved"
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "router_approve", AuditLog.entity_id == str(d.id)))).all()
    assert len(rows) == 1


async def test_approve_keeps_the_pinned_secret_when_no_candidate(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db)
    await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    await db.refresh(d)
    assert d.agent_secret_hash == OLD


async def test_revoke_and_its_audit(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, approval_state="approved", wan_ip="203.0.113.7")
    resp = await client.post(f"/devices/{d.id}/revoke", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["approval_state"] == "revoked"
    assert resp.json()["wan_ip"] == "203.0.113.7"  # snapshot kept for reference
    assert await db.scalar(select(AuditLog).where(
        AuditLog.action == "router_revoke", AuditLog.entity_id == str(d.id))) is not None


async def test_revoke_resets_the_secret_mismatch_flag(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, approval_state="pending", secret_mismatch=True,
                      pending_secret_hash=NEW)
    resp = await client.post(f"/devices/{d.id}/revoke", headers=hdrs)
    assert resp.status_code == 200 and resp.json()["secret_mismatch"] is False
    await db.refresh(d)
    assert d.secret_mismatch is False


async def test_decisions_resolve_every_approver_copy(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db)
    await notify(db, seeded_user.id, "router_approval", "Router waiting for approval",
                 payload={"device_id": str(d.id), "mac": d.mac, "state": "pending"})
    await db.commit()
    await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    n = await db.scalar(select(Notification).where(Notification.kind == "router_approval"))
    await db.refresh(n)
    assert n.payload["state"] == "approved" and n.payload["decided_by"]
    await client.post(f"/devices/{d.id}/revoke", headers=hdrs)
    await db.refresh(n)
    assert n.payload["state"] == "revoked"


async def test_errors(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/devices/00000000-0000-0000-0000-000000000000/approve", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "device_not_found"
    kiosk = Device(device_type="kiosk", name="k1")
    hand_made = Device(device_type="router", name="r-by-hand")
    db.add_all([kiosk, hand_made])
    await db.commit()
    for path in ("approve", "revoke"):
        resp = await client.post(f"/devices/{kiosk.id}/{path}", headers=hdrs)
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_a_router"
        resp = await client.post(f"/devices/{hand_made.id}/{path}", headers=hdrs)
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_an_agent_router"


async def test_needs_scanning_hardware_change(client, db, seeded_user):
    hdrs = await login_staff(client, seeded_user)  # staff: scanning_hardware view only
    d = await _router(db)
    for path in ("approve", "revoke"):
        assert (await client.post(f"/devices/{d.id}/{path}", headers=hdrs)).status_code == 403


async def test_list_exposes_approval_fields_but_never_hashes(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, secret_mismatch=True)
    rows = (await client.get("/devices?device_type=router", headers=hdrs)).json()
    row = next(r for r in rows if r["id"] == str(d.id))
    assert row["approval_state"] == "pending" and row["secret_mismatch"] is True
    assert row["agent_source_ip"] == "203.0.113.7" and row["approved_by_name"] is None
    assert "agent_secret_hash" not in row and "pending_secret_hash" not in row
    kiosk = Device(device_type="kiosk", name="k1")
    db.add(kiosk)
    await db.commit()
    rows = (await client.get("/devices?device_type=kiosk", headers=hdrs)).json()
    assert rows[0]["approval_state"] is None and rows[0]["secret_mismatch"] is False
