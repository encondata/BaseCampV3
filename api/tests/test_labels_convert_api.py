"""Convert-to-code: one-way design->code flip using the stored design."""

from tests.test_status_values_write import _make

DESIGN = {"size": {"w": 4, "h": 2}, "elements": [
    {"id": "t1", "type": "text", "x": 0.25, "y": 0.5, "w": 2, "h": 0.3,
     "rotation": 0, "content": "SN: {serial_number}", "fontSizePt": 12,
     "bold": False, "align": "left"}]}


async def _admin(db, client):
    return await _make(db, client, "admin", "adm@test.example.com")


async def _make_template(client, hdrs, **over):
    body = {"name": "conv", "label_type": "top", "size_key": "4x2",
            "dpi_key": "203", "language_key": "zpl", "kind": "design",
            "design": DESIGN}
    body.update(over)
    resp = await client.post("/labels/templates", headers=hdrs, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_convert_matches_compile_output(client, db, seeded_user):
    hdrs = await _admin(db, client)
    t = await _make_template(client, hdrs)
    expected = (await client.post("/labels/templates/compile", headers=hdrs,
                                  json={"kind": "design", "design": DESIGN,
                                        "size_key": "4x2", "dpi_key": "203",
                                        "language_key": "zpl",
                                        "mode": "placeholders"})).json()["code"]
    resp = await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                             headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "code" and body["design"] is None
    assert body["code"] == expected
    assert "{serial_number}" in body["code"]  # tokens intact
    assert body["version"] == t["version"] + 1


async def test_convert_persists(client, db, seeded_user):
    hdrs = await _admin(db, client)
    t = await _make_template(client, hdrs, name="conv2")
    await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                      headers=hdrs)
    got = (await client.get(f"/labels/templates/{t['id']}",
                            headers=hdrs)).json()
    assert got["kind"] == "code" and got["design"] is None
    assert got["code"].startswith("^XA")


async def test_convert_code_template_409(client, db, seeded_user):
    hdrs = await _admin(db, client)
    t = await _make_template(client, hdrs, name="raw", kind="code",
                             design=None, code="^XA^XZ")
    resp = await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                             headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_a_design_template"


async def test_convert_brother_language(client, db, seeded_user):
    hdrs = await _admin(db, client)
    t = await _make_template(client, hdrs, name="br", language_key="escp")
    resp = await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                             headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["code"].startswith("\x1b@")


async def test_convert_unknown_404_and_staff_403(client, db, seeded_user):
    hdrs = await _admin(db, client)
    import uuid as _uuid
    resp = await client.post(
        f"/labels/templates/{_uuid.uuid4()}/convert-to-code", headers=hdrs)
    assert resp.status_code == 404
    from tests.test_sites_api import login
    staff = await login(client)
    t = await _make_template(client, hdrs, name="gate")
    resp = await client.post(f"/labels/templates/{t['id']}/convert-to-code",
                             headers=staff)
    assert resp.status_code == 403
