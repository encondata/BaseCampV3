"""Compile endpoint: both kinds, both modes, vocab/size override, errors."""

from tests.test_sites_api import login

DESIGN = {"size": {"w": 9, "h": 9}, "elements": [  # size overridden by vocab
    {"id": "t1", "type": "text", "x": 0.25, "y": 0.5, "w": 2, "h": 0.3,
     "rotation": 0, "content": "SN: {serial_number}", "fontSizePt": 12,
     "bold": False, "align": "left"}]}


def _body(**over):
    base = {"kind": "design", "design": DESIGN, "size_key": "4x2",
            "dpi_key": "203", "language_key": "zpl",
            "mode": "placeholders"}
    base.update(over)
    return base


async def test_design_placeholders_mode(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/labels/templates/compile", headers=hdrs,
                             json=_body())
    assert resp.status_code == 200, resp.text
    code = resp.json()["code"]
    assert code.startswith("^XA")
    assert "^PW812" in code and "^LL406" in code  # vocab size won, not 9x9
    assert "{serial_number}" in code


async def test_design_sample_mode_uses_catalog(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/labels/templates/compile", headers=hdrs,
                             json=_body(mode="sample"))
    code = resp.json()["code"]
    assert "C7X-00412-A" in code           # seeded sample_value
    assert "{serial_number}" not in code


async def test_code_kind_modes(client, db, seeded_user):
    hdrs = await login(client)
    raw = "^XA^FD{serial_number}^FS^XZ"
    resp = await client.post("/labels/templates/compile", headers=hdrs,
                             json=_body(kind="code", code=raw, design=None))
    assert resp.json()["code"] == raw      # placeholders mode = identity
    resp = await client.post(
        "/labels/templates/compile", headers=hdrs,
        json=_body(kind="code", code=raw, design=None, mode="sample"))
    assert resp.json()["code"] == "^XA^FDC7X-00412-A^FS^XZ"


async def test_brother_languages_compile(client, db, seeded_user):
    hdrs = await login(client)
    for lang, marker in (("escp", "\x1b@"), ("ptouch", "^II^TS001")):
        resp = await client.post("/labels/templates/compile", headers=hdrs,
                                 json=_body(language_key=lang))
        assert resp.status_code == 200
        assert resp.json()["code"].startswith(marker)


async def test_errors(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/labels/templates/compile", headers=hdrs,
                             json=_body(size_key="9x9"))
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "unknown_vocab"
    resp = await client.post("/labels/templates/compile", headers=hdrs,
                             json=_body(design=None))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_payload"
    bad = {"size": {"w": 4, "h": 2}, "elements": [
        {"id": "t1", "type": "sticker"}]}
    resp = await client.post("/labels/templates/compile", headers=hdrs,
                             json=_body(design=bad))
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "bad_design" and detail["problems"]


async def test_template_create_now_validates_design(client, db, seeded_user):
    from tests.test_status_values_write import _make
    hdrs = await _make(db, client, "super_admin", "adm@test.example.com")
    resp = await client.post("/labels/templates", headers=hdrs, json={
        "name": "bad-design", "label_type": "top", "size_key": "4x2",
        "dpi_key": "203", "language_key": "zpl", "kind": "design",
        "design": {"size": {"w": 4, "h": 2},
                   "elements": [{"id": "z", "type": "sticker"}]},
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_design"


# ── a schema 2 design compiles with the builder's values: the portal's
# mock values with the template's samples over them (spec §4.7) ──

SWISS = {"family": "swiss721-cond-bold", "weight": "regular"}
V2 = {"schema": 2, "size": {"w": 4, "h": 2}, "elements": [
    {"id": "f1", "type": "field", "field": "asset_id", "x": 0.1, "y": 0.1, "w": 1.5, "h": 0.3,
     "rotation": 0, "display": "text", "font": SWISS, "sizePt": 24, "baselineIn": 0.24},
    {"id": "f2", "type": "field", "field": "serial_number", "x": 0.1, "y": 0.6, "w": 1.5,
     "h": 0.3, "rotation": 0, "display": "text", "font": SWISS, "sizePt": 12, "baselineIn": 0.12},
    {"id": "f3", "type": "field", "field": "ft:Notes", "x": 0.1, "y": 1.1, "w": 1.5, "h": 0.3,
     "rotation": 0, "display": "text", "font": SWISS, "sizePt": 12, "baselineIn": 0.12},
]}


async def test_v2_design_compiles_with_samples_over_the_mock_values(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/labels/templates/compile", headers=hdrs, json=_body(
        design=V2, dpi_key="300", mode="sample", samples={"asset_id": "10482"}))
    assert resp.status_code == 200, resp.text
    code = resp.json()["code"]
    assert "^FD10482^FS" in code            # the template's sample
    assert "^FDSN0000001^FS" in code        # fields.MOCK_VALUES, not the placeholder catalog
    assert "C7X-00412-A" not in code
    assert "^FDNotes^FS" in code            # a From-To column prints its header
    assert "E:TT0003M_.TTF" in code


async def test_v2_design_compiles_without_samples(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/labels/templates/compile", headers=hdrs,
                             json=_body(design=V2, dpi_key="600"))
    assert resp.status_code == 200, resp.text
    assert "^FD100000^FS" in resp.json()["code"]


async def test_samples_belong_to_builder_designs(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/labels/templates/compile", headers=hdrs,
                             json=_body(samples={"serial_number": "X"}))
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "bad_field", "field": "samples",
                                     "message": "sample values belong to builder templates"}
