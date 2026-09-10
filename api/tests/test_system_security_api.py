"""System › Security: 2FA policy flags + revoke-all-sessions."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, AuthSession

from tests.test_status_values_write import _make
from tests.test_sites_api import login


async def _admin(db, client):
    return await _make(db, client, "super_admin", "sec-admin@test.example.com")


async def test_security_defaults_and_view_gate(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.get("/system/security", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"two_factor_enabled": False, "two_factor_required": False}
    worker = await _make(db, client, "worker", "sec-worker@test.example.com")
    assert (await client.get("/system/security", headers=worker)).status_code == 403


async def test_required_implies_enabled_and_disable_clears_required(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/security", headers=hdrs, json={"two_factor_required": True})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"two_factor_enabled": True, "two_factor_required": True}
    resp = await client.put("/system/security", headers=hdrs, json={"two_factor_enabled": False})
    assert resp.json() == {"two_factor_enabled": False, "two_factor_required": False}
    assert (await client.put("/system/security", headers=hdrs, json={"bogus": 1})).status_code == 422
    rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "security")))
    assert len(rows) == 2 and rows[0].action == "security_config_update"


async def test_revoke_all_keeps_the_callers_session(client, db, seeded_user):
    admin = await _admin(db, client)
    other = await login(client)                      # alice, a second live family
    resp = await client.post("/system/sessions/revoke-all", headers=admin)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["revoked_sessions"] >= 1 and body["revoked_people"] >= 1
    # the admin still works; alice's token is dead
    assert (await client.get("/system/security", headers=admin)).status_code == 200
    assert (await client.get("/auth/me/profile", headers=other)).status_code == 401
    live = list(await db.scalars(select(AuthSession).where(AuthSession.revoked_at.is_(None))))
    assert len(live) == 1
    worker = await _make(db, client, "worker", "sec-worker2@test.example.com")
    assert (await client.post("/system/sessions/revoke-all", headers=worker)).status_code == 403
