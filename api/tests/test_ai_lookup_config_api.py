"""System settings › AI lookup: defaults, partial PUT, audit, permissions."""
from sqlalchemy import select

from serversherpa.db.models import AuditLog
from tests.test_assets_api import login
from tests.test_system_api import _super_admin_headers

DEFAULTS = {"background_enabled": False, "auto_apply": False, "fields_specs": True,
            "fields_mounting": False, "fields_knowledge": False, "retry_after_days": 90}


async def test_defaults(client, db, seeded_user):
    hdrs = await login(client)                      # staff: settings view
    resp = await client.get("/system/ai-lookup", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == DEFAULTS


async def test_staff_cannot_change(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.put("/system/ai-lookup", headers=hdrs, json={"auto_apply": True})
    assert resp.status_code == 403


async def test_partial_put_and_audit(client, db, seeded_user):
    hdrs = await _super_admin_headers(db, client)
    resp = await client.put("/system/ai-lookup", headers=hdrs,
                            json={"background_enabled": True, "retry_after_days": 30})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {**DEFAULTS, "background_enabled": True, "retry_after_days": 30}
    assert (await client.get("/system/ai-lookup", headers=hdrs)).json()["retry_after_days"] == 30
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "ai_lookup_config_update"))
    assert row.changes["background_enabled"] == {"from": False, "to": True}


async def test_rejects_bad_values(client, db, seeded_user):
    hdrs = await _super_admin_headers(db, client)
    assert (await client.put("/system/ai-lookup", headers=hdrs,
                             json={"retry_after_days": -1})).status_code == 422
    assert (await client.put("/system/ai-lookup", headers=hdrs,
                             json={"nope": True})).status_code == 422
