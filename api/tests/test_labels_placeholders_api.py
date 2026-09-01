"""Placeholder catalog CRUD + token usage counts."""

from serversherpa.db.models import LabelTemplate

from tests.test_sites_api import login
from tests.test_status_values_write import _make


async def test_list_placeholders(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/labels/placeholders", headers=hdrs)
    assert resp.status_code == 200
    keys = {r["key"] for r in resp.json()}
    assert {"asset_id", "serial_number", "container_name"} <= keys


async def test_usage_count_scans_design_and_code(client, db, seeded_user):
    db.add(LabelTemplate(name="ph-1", label_type="top", size_key="4x2",
                         dpi_key="203", language_key="zpl", kind="code",
                         code="^XA^FD{serial_number}^FS^XZ"))
    db.add(LabelTemplate(
        name="ph-2", label_type="top", size_key="4x2", dpi_key="203",
        language_key="zpl", kind="design",
        design={"size": {"w": 4, "h": 2}, "elements": [
            {"id": "e1", "type": "text", "x": 0, "y": 0, "w": 1, "h": 0.3,
             "rotation": 0, "content": "SN {serial_number}",
             "fontSizePt": 10, "bold": False, "align": "left"}]}))
    await db.commit()
    hdrs = await login(client)
    rows = (await client.get("/labels/placeholders", headers=hdrs)).json()
    by_key = {r["key"]: r for r in rows}
    assert by_key["serial_number"]["usage_count"] == 2
    assert by_key["asset_id"]["usage_count"] == 0


async def test_create_validates_applies_to(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/labels/placeholders", headers=hdrs, json={
        "key": "rack_name", "label": "Rack name", "applies_to": ["nope"],
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_applies_to"
    resp = await client.post("/labels/placeholders", headers=hdrs, json={
        "key": "rack_name", "label": "Rack name", "sample_value": "A12",
        "applies_to": ["rail"],
    })
    assert resp.status_code == 201


async def test_duplicate_409_and_admin_403(client, db, seeded_user):
    dev = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/labels/placeholders", headers=dev, json={
        "key": "asset_id", "label": "dupe",
    })
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "label_placeholder_exists"
    adm = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.post("/labels/placeholders", headers=adm, json={
        "key": "x1", "label": "x",
    })
    assert resp.status_code == 403


async def test_patch_placeholder(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.patch("/labels/placeholders/asset_id", headers=hdrs,
                              json={"sample_value": "99999"})
    assert resp.status_code == 200
    assert resp.json()["sample_value"] == "99999"
    resp = await client.patch("/labels/placeholders/nope", headers=hdrs,
                              json={"label": "x"})
    assert resp.status_code == 404
