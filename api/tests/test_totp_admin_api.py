"""Admin 2FA: reset, per-user requirement, group/role flags, detail fields,
trusted browsers revoked with sessions, CLI reset."""

import pyotp
from sqlalchemy import select

from serversherpa.db.models import AccessGroup, AuditLog, TrustedDevice, UserAccount
from serversherpa.services import totp as totp_service
from tests.test_sites_api import login
from tests.test_status_values_write import _make


async def _admin(db, client):
    return await _make(db, client, "super_admin", "totp-admin@test.example.com")


async def _enroll(db, person_id):
    account = await db.get(UserAccount, person_id)
    secret, _ = await totp_service.begin_enrollment(db, account, actor_id=None, ip=None)
    await totp_service.confirm_enrollment(
        db, account, pyotp.TOTP(secret).now(), actor_id=None, ip=None)
    await totp_service.issue_trust(db, account, user_agent=None, ip=None)
    return account


async def test_detail_reports_totp_fields(client, db, seeded_user):
    hdrs = await _admin(db, client)
    body = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert body["account"]["totp_enrolled"] is False
    assert body["account"]["totp_required"] is False
    assert body["account"]["totp_effective_required"] is False
    await _enroll(db, seeded_user.id)
    body = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert body["account"]["totp_enrolled"] is True and body["account"]["totp_enrolled_at"]


async def test_require_flag_and_reset(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put(f"/users/{seeded_user.id}/totp-required", headers=hdrs,
                            json={"required": True})
    assert resp.status_code == 204, resp.text
    account = await db.get(UserAccount, seeded_user.id)
    await db.refresh(account)
    assert account.totp_required is True

    await _enroll(db, seeded_user.id)
    resp = await client.post(f"/users/{seeded_user.id}/totp/reset", headers=hdrs)
    assert resp.status_code == 204, resp.text
    await db.refresh(account)
    assert account.totp_secret_enc is None and account.totp_confirmed_at is None
    live = list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == seeded_user.id, TrustedDevice.revoked_at.is_(None))))
    assert live == []
    actions = [r.action for r in await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "user_account", AuditLog.entity_id == str(seeded_user.id)))]
    assert "totp.required_set" in actions and "totp.reset" in actions


async def test_reset_and_require_respect_permission_and_rank(client, db, seeded_user):
    staff = await login(client)  # alice: staff, no users:change
    assert (await client.post(f"/users/{seeded_user.id}/totp/reset", headers=staff)).status_code == 403
    admin = await _make(db, client, "admin", "totp-admin2@test.example.com")
    boss = await _make(db, client, "super_admin", "totp-boss@test.example.com")
    boss_id = (await client.get("/auth/me", headers=boss)).json()["person"]["id"]
    resp = await client.post(f"/users/{boss_id}/totp/reset", headers=admin)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "rank_too_low"


async def test_revoke_all_sessions_also_forgets_trusted_browsers(client, db, seeded_user):
    hdrs = await _admin(db, client)
    await _enroll(db, seeded_user.id)
    resp = await client.post(f"/users/{seeded_user.id}/sessions/revoke-all", headers=hdrs)
    assert resp.status_code == 204
    live = list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == seeded_user.id, TrustedDevice.revoked_at.is_(None))))
    assert live == []


async def test_group_and_role_flags_flow_into_policy(client, db, seeded_user):
    hdrs = await _admin(db, client)
    from serversherpa.db.models import SystemConfig
    db.add(SystemConfig(section="security", data={"two_factor_enabled": True,
                                                   "two_factor_required": False}))
    group = AccessGroup(name="Finance")
    db.add(group)
    await db.commit()

    resp = await client.patch(f"/access/groups/{group.id}", headers=hdrs,
                              json={"totp_required": True})
    assert resp.status_code == 200 and resp.json()["totp_required"] is True
    resp = await client.put(f"/access/groups/{group.id}/members", headers=hdrs,
                            json={"person_ids": [str(seeded_user.id)]})
    assert resp.status_code == 200, resp.text
    detail = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert detail["account"]["totp_effective_required"] is True

    summary = (await client.get("/access/summary", headers=hdrs)).json()
    assert next(g for g in summary["groups"] if g["name"] == "Finance")["totp_required"] is True
    assert all("totp_required" in r for r in summary["roles"])

    resp = await client.patch(f"/access/groups/{group.id}", headers=hdrs,
                              json={"totp_required": False})
    assert resp.json()["totp_required"] is False
    resp = await client.patch("/access/roles/staff", headers=hdrs, json={"totp_required": True})
    assert resp.status_code == 200 and resp.json() == {"name": "staff", "totp_required": True}
    detail = (await client.get(f"/users/{seeded_user.id}", headers=hdrs)).json()
    assert detail["account"]["totp_effective_required"] is True

    # rank rule: an admin cannot flag a role at or above their rank
    admin = await _make(db, client, "admin", "totp-admin3@test.example.com")
    resp = await client.patch("/access/roles/super_admin", headers=admin, json={"totp_required": True})
    assert resp.status_code == 403


# typer's CliRunner would call asyncio.run() inside the already-running test
# loop, so the command is checked by registration and the service call it
# wraps is exercised directly.
async def test_cli_reset_totp_command_exists_and_service_resets(db, seeded_user):
    from serversherpa.cli import app

    names = {c.name for c in app.registered_commands}
    assert "reset-totp" in names or "reset_totp" in names
    account = await _enroll(db, seeded_user.id)
    await totp_service.reset(db, account, actor_id=None, ip=None)
    await db.commit()
    await db.refresh(account)
    assert account.totp_confirmed_at is None
