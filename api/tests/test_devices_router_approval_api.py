"""Approve / revoke an agent router on Scanning Hardware › Routers, and the
approval fields GET /devices exposes. Spec:
docs/superpowers/specs/2026-10-01-router-agent-design.md."""

import hashlib

from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, Device, Notification, Person
from serversherpa.notifications.inbox import notify
from serversherpa.services.router_agent import resolve_router_copies
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff
from tests.test_status_values_write import _make

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


async def test_revoke_resets_the_mismatch_flag_and_drops_the_candidate(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, approval_state="pending", secret_mismatch=True,
                      pending_secret_hash=NEW)
    resp = await client.post(f"/devices/{d.id}/revoke", headers=hdrs)
    assert resp.status_code == 200 and resp.json()["secret_mismatch"] is False
    await db.refresh(d)
    assert d.secret_mismatch is False
    # a later Approve must never promote a secret nobody vetted
    assert d.pending_secret_hash is None and d.agent_secret_hash == OLD


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


async def _copies(db):
    """Every approver's router_approval copy as the database has it now (the
    decision is a raw UPDATE the session's already-loaded rows know nothing of)."""
    return list((await db.scalars(
        select(Notification).where(Notification.kind == "router_approval")
        .execution_options(populate_existing=True))).all())


async def _waiting_copies(db, device, *people):
    for person in people:
        await notify(db, person.id, "router_approval", "Router waiting for approval",
                     payload={"device_id": str(device.id), "mac": device.mac,
                              "state": "pending"})
    await db.commit()


async def test_approving_marks_router_copies_read(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _make(db, client, "admin", "bob@test.example.com")
    bob = await db.scalar(select(Person).where(Person.email == "bob@test.example.com"))
    d = await _router(db)
    await _waiting_copies(db, d, seeded_user, bob)
    assert all(c.read_at is None for c in await _copies(db))

    assert (await client.post(f"/devices/{d.id}/approve", headers=hdrs)).status_code == 200

    copies = await _copies(db)
    assert len(copies) == 2
    assert all(c.read_at is not None and c.payload["state"] == "approved" for c in copies)
    first_read = {c.id: c.read_at for c in copies}
    # a later revoke changes the state but never the time they were first read
    assert (await client.post(f"/devices/{d.id}/revoke", headers=hdrs)).status_code == 200
    again = await _copies(db)
    assert all(c.payload["state"] == "revoked" for c in again)
    assert {c.id: c.read_at for c in again} == first_read


async def test_revoking_marks_router_copies_read(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, approval_state="approved")
    await _waiting_copies(db, d, seeded_user)

    assert (await client.post(f"/devices/{d.id}/revoke", headers=hdrs)).status_code == 200

    (copy,) = await _copies(db)
    assert copy.payload["state"] == "revoked" and copy.read_at is not None


async def test_a_router_copy_set_back_to_pending_stays_unread(db, seeded_user):
    d = await _router(db)
    await _waiting_copies(db, d, seeded_user)

    await resolve_router_copies(db, d.id, "pending", None)
    await db.commit()

    (copy,) = await _copies(db)
    assert copy.payload["state"] == "pending" and copy.read_at is None


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


async def test_approve_on_an_approved_router_with_a_mismatch_dismisses_the_warning(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    d = await _router(db, pending_secret_hash=NEW, secret_mismatch=True)
    await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    await db.refresh(d)
    # the router auto-restored: approved again, flag still up, forger's candidate gone
    third = hashlib.sha256(b"c" * 64).hexdigest()
    await db.execute(text(
        "UPDATE devices SET secret_mismatch = true, pending_secret_hash = :n WHERE id = :i"),
        {"n": third, "i": d.id})
    await db.commit()
    await db.refresh(d)
    approved_at, approved_by, pinned = d.approved_at, d.approved_by, d.agent_secret_hash
    resp = await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    assert resp.status_code == 200 and resp.json()["secret_mismatch"] is False
    await db.refresh(d)
    assert d.secret_mismatch is False and d.pending_secret_hash is None
    assert pinned == NEW and d.agent_secret_hash == pinned != third  # no candidate promoted
    assert d.approved_at == approved_at and d.approved_by == approved_by
    assert d.approval_state == "approved"
    def dismissed():
        return select(AuditLog).where(AuditLog.action == "router_mismatch_dismissed",
                                      AuditLog.entity_id == str(d.id))
    assert len((await db.scalars(dismissed())).all()) == 1
    resp = await client.post(f"/devices/{d.id}/approve", headers=hdrs)
    assert resp.status_code == 200
    assert len((await db.scalars(dismissed())).all()) == 1
