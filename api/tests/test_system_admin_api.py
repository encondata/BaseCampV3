"""Admin controls: public status, gated admin config get/put, audit."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, SystemConfig

from tests.test_status_values_write import _make


async def _admin(db, client):
    return await _make(db, client, "super_admin", "sa@test.example.com")


async def test_status_is_public_and_defaults_off(client):
    resp = await client.get("/system/status")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "read_only": False, "read_only_message": "",
        "workers_paused": False, "banner": None,
    }


async def test_admin_get_requires_settings_change(client, db, seeded_user):
    staff = await _make(db, client, "staff", "st@test.example.com")
    assert (await client.get("/system/admin", headers=staff)).status_code == 403
    hdrs = await _admin(db, client)
    resp = await client.get("/system/admin", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json() == {
        "read_only": False, "read_only_message": "", "pause_workers": False,
        "banner_enabled": False, "banner_message": "",
    }


async def test_put_merges_trims_and_audits(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs, json={
        "read_only": True, "read_only_message": "  Cutover until 14:00  ",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["read_only"] is True
    assert body["read_only_message"] == "Cutover until 14:00"
    assert body["banner_enabled"] is False          # untouched fields keep defaults

    # second patch only touches the banner; read-only survives the merge
    resp = await client.put("/system/admin", headers=hdrs, json={
        "banner_enabled": True, "banner_message": "Hello all",
    })
    assert resp.status_code == 200
    assert resp.json()["read_only"] is True
    assert resp.json()["banner_message"] == "Hello all"

    row = await db.get(SystemConfig, "admin")
    assert row is not None and row.data["banner_message"] == "Hello all"
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "admin",
        AuditLog.action == "admin_config_update"))).all()
    assert len(audits) == 2
    assert audits[0].changes["read_only"] == {"from": False, "to": True}
    assert "banner_enabled" not in audits[0].changes   # unchanged fields omitted

    status = (await client.get("/system/status")).json()
    assert status == {"read_only": True, "read_only_message": "Cutover until 14:00",
                      "workers_paused": False, "banner": "Hello all"}


async def test_put_rejects_blank_banner_and_unknown_fields(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs,
                            json={"banner_enabled": True, "banner_message": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "banner_message_required"
    resp = await client.put("/system/admin", headers=hdrs, json={"bogus": 1})
    assert resp.status_code == 422
    # disabling a banner with a blank message is fine
    resp = await client.put("/system/admin", headers=hdrs,
                            json={"banner_enabled": False})
    assert resp.status_code == 200


async def test_status_hides_banner_when_disabled_and_reports_pause(client, db, seeded_user):
    hdrs = await _admin(db, client)
    await client.put("/system/admin", headers=hdrs, json={
        "banner_enabled": True, "banner_message": "Up soon", "pause_workers": True,
    })
    status = (await client.get("/system/status")).json()
    assert status["banner"] == "Up soon"
    assert status["workers_paused"] is False       # pause needs read_only too
    await client.put("/system/admin", headers=hdrs,
                     json={"banner_enabled": False, "read_only": True})
    status = (await client.get("/system/status")).json()
    assert status["banner"] is None
    assert status["workers_paused"] is True


STATUS_PAYLOAD = {
    "record_type": "site", "key": "mothballed", "label": "Mothballed",
    "description": "Shut down, retained.", "color": "#8e44ad", "sort_order": 5,
}


async def _freeze(db, client, message="Cutover in progress"):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs,
                            json={"read_only": True, "read_only_message": message})
    assert resp.status_code == 200, resp.text
    return hdrs


async def test_read_only_blocks_non_developer_writes(client, db, seeded_user):
    sa = await _freeze(db, client)
    resp = await client.post("/status-values", headers=sa, json=STATUS_PAYLOAD)
    assert resp.status_code == 423, resp.text
    assert resp.json()["detail"] == {"code": "read_only_mode",
                                     "message": "Cutover in progress"}
    # reads are untouched (record_type=site follows sites:view, which
    # super_admin holds; the unfiltered listing is devtools-gated and
    # super_admin can never see it, freeze or no freeze)
    assert (await client.get("/status-values?record_type=site",
                             headers=sa)).status_code == 200


async def test_read_only_exempts_developers(client, db, seeded_user):
    await _freeze(db, client)
    dev = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/status-values", headers=dev, json=STATUS_PAYLOAD)
    assert resp.status_code == 201, resp.text


async def test_read_only_allowlists_auth_and_the_toggle(client, db, seeded_user):
    sa = await _freeze(db, client)
    # the admin who froze the portal can always lift it
    resp = await client.put("/system/admin", headers=sa, json={"read_only": False})
    assert resp.status_code == 200
    # ...and writes flow again (status-values is devtools-gated, so a
    # developer is the actor that can actually reach 201 here)
    dev = await _make(db, client, "developer", "dev2@test.example.com")
    resp = await client.post("/status-values", headers=dev, json=STATUS_PAYLOAD)
    assert resp.status_code == 201
    # freeze again, reusing the same admin (calling _freeze again would
    # re-create sa@test.example.com and trip the email-uniqueness constraint)
    resp = await client.put("/system/admin", headers=sa, json={
        "read_only": True, "read_only_message": "Cutover in progress"})
    assert resp.status_code == 200
    # auth routes are never frozen (logout is a POST)
    resp = await client.post("/auth/logout", headers=sa)
    assert resp.status_code != 423


async def test_read_only_off_is_transparent(client, db, seeded_user):
    # baseline: with read_only untouched (default off), a developer's
    # ordinary write is unaffected by the enforce_read_only dependency
    dev = await _make(db, client, "developer", "dev5@test.example.com")
    resp = await client.post("/status-values", headers=dev, json=STATUS_PAYLOAD)
    assert resp.status_code == 201
