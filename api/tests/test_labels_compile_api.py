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
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.post("/labels/templates", headers=hdrs, json={
        "name": "bad-design", "label_type": "top", "size_key": "4x2",
        "dpi_key": "203", "language_key": "zpl", "kind": "design",
        "design": {"size": {"w": 4, "h": 2},
                   "elements": [{"id": "z", "type": "sticker"}]},
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_design"
