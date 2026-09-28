"""Password expiry policy (To-Do #32): security-config keys, expiry math,
the sign-in gate, reuse history and the reminder sweep."""

from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.models import AuditLog

from tests.test_status_values_write import _make


async def _admin(db, client):
    return await _make(db, client, "super_admin", "pw-admin@test.example.com")


# ── config ──────────────────────────────────────────────────────────

async def test_security_config_carries_policy_defaults(client, db, seeded_user):
    hdrs = await _admin(db, client)
    body = (await client.get("/system/security", headers=hdrs)).json()
    assert body["password_expiry_enabled"] is False
    assert body["password_expiry_days"] == 90
    assert body["password_history_count"] == 3
    assert body["password_expiry_since"] is None


async def test_policy_ranges_are_enforced(client, db, seeded_user):
    hdrs = await _admin(db, client)
    for patch, code in [
        ({"password_expiry_days": 0}, "password_expiry_days_out_of_range"),
        ({"password_expiry_days": 366}, "password_expiry_days_out_of_range"),
        ({"password_history_count": -1}, "password_history_count_out_of_range"),
        ({"password_history_count": 25}, "password_history_count_out_of_range"),
    ]:
        resp = await client.put("/system/security", headers=hdrs, json=patch)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == code
    ok = await client.put("/system/security", headers=hdrs,
                          json={"password_expiry_days": 60, "password_history_count": 0})
    assert ok.status_code == 200, ok.text
    assert ok.json()["password_expiry_days"] == 60
    assert ok.json()["password_history_count"] == 0


async def test_enabling_stamps_since_and_disabling_clears_it(client, db, seeded_user):
    hdrs = await _admin(db, client)
    before = datetime.now(UTC)
    on = await client.put("/system/security", headers=hdrs, json={"password_expiry_enabled": True})
    assert on.status_code == 200, on.text
    since = datetime.fromisoformat(on.json()["password_expiry_since"])
    assert since >= before
    # a plain number change keeps the stamp
    again = await client.put("/system/security", headers=hdrs, json={"password_expiry_days": 30})
    assert again.json()["password_expiry_since"] == on.json()["password_expiry_since"]
    off = await client.put("/system/security", headers=hdrs, json={"password_expiry_enabled": False})
    assert off.json()["password_expiry_since"] is None
    back = await client.put("/system/security", headers=hdrs, json={"password_expiry_enabled": True})
    assert datetime.fromisoformat(back.json()["password_expiry_since"]) >= since
    rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "security")))
    assert rows and all(r.action == "security_config_update" for r in rows)
    assert "password_expiry_since" in rows[0].changes
