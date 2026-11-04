"""POST /labels/test-render: one mock-data test label for any active ZPL
template, for the portal's printer tools (spec
docs/superpowers/specs/2026-11-03-portal-printer-tools-design.md §3). The
portal twin of POST /kiosk/labels/test-render: no move, no template set,
the same shared fill (labels/mock_render.py), so the two print the same
label for the same template."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import LabelTemplate
from serversherpa.labels.fields import (
    MOCK_VALUES,
    PLACEHOLDER_MOCK_VALUES,
    catalog_keys,
    mock_field_values,
)
from serversherpa.labels.generate.engine import render_label
from serversherpa.labels.render import render_template
from tests.test_kiosk_label_templates_sync import DESIGN, SIZE_META, _tpl, make_tree
from tests.test_sites_api import login
from tests.test_status_values_write import _make

URL = "/labels/test-render"

RULES = {"destination": {"1": "dest_hall", "2": "dest_rack", "3": "dest_u"},
         "source": {"2": "src_rack"},
         "length_limits": {"asset_name": 6}}

BADGE = {"schema": 2, "size": {"w": 4, "h": 2}, "elements": [
    {"id": "n", "type": "field", "field": "person_name", "x": 0.1, "y": 0.1, "w": 3,
     "h": 0.4, "rotation": 0, "display": "text",
     "font": {"family": "swiss721-cond-bold", "weight": "regular"}, "sizePt": 18,
     "baselineIn": 0.3, "align": "left"}]}


def _body(template, dpi="203"):
    return {"template_id": str(template.id), "dpi_key": dpi}


def _expected_values():
    values = dict(PLACEHOLDER_MOCK_VALUES)
    dest = values["destination_raw"].split(".")
    values.update(dest_hall=dest[0], dest_rack=dest[1], dest_u=dest[2],
                  src_rack=values["source_raw"].split(".")[1])
    values["asset_name"] = values["asset_name"][:6]
    return values


async def _child(db, parent, dpi="203"):
    return await db.scalar(select(LabelTemplate).where(
        LabelTemplate.parent_id == parent.id, LabelTemplate.dpi_key == dpi))


async def test_code_template_renders_mock_values(client, db, seeded_user):
    hdrs = await login(client)
    tpl = _tpl("Front Code", label_type="top",
               code="^XA^FD{asset_name} {serial_number} {destination_ru}^FS^XZ")
    db.add(tpl)
    await db.commit()
    r = await client.post(URL, headers=hdrs, json=_body(tpl))
    assert r.status_code == 200, r.text
    assert r.json() == {"zpl": "^XA^FDSAMPLE-SERVER-01 SN0000001 U12^FS^XZ",
                        "template_name": "Front Code"}


async def test_design_with_rules_matches_render_label(client, db, seeded_user):
    hdrs = await login(client)
    design = {**DESIGN, "elements": [*DESIGN["elements"], {
        "id": "t2", "type": "text", "x": 0.1, "y": 1.5, "w": 3.8, "h": 0.4, "rotation": 0,
        "content": "{dest_hall}/{dest_rack}/{dest_u} {src_rack} {move_name} {move_date}",
        "fontSizePt": 10, "align": "left"}]}
    tpl = LabelTemplate(name="Generic Rack and RU", label_type="top", size_key="4x2",
                        dpi_key="203", language_key="zpl", kind="design", design=design,
                        generation_rules=RULES)
    db.add(tpl)
    await db.commit()

    r = await client.post(URL, headers=hdrs, json=_body(tpl))
    assert r.status_code == 200, r.text
    expected, _ = render_label(tpl, _expected_values(), size_meta=SIZE_META,
                               dpi_meta={"dots": 203}, language_key="zpl")
    assert r.json() == {"zpl": expected, "template_name": "Generic Rack and RU"}
    assert "SAMPLE" in r.json()["zpl"] and "SAMPLE-SERVER-01" not in r.json()["zpl"]
    assert "{" not in r.json()["zpl"]


async def test_v2_child_uses_builder_mock_values(client, db, seeded_user):
    hdrs = await login(client)
    parent = await make_tree(db, "Front Tag", label_type="front",
                             samples={"asset_id": "SAMPLE-ONLY-777"})
    child = await _child(db, parent)
    r = await client.post(URL, headers=hdrs, json=_body(child))
    assert r.status_code == 200, r.text
    # the builder's mock values, shaped like field_values: every catalog key
    # of the type, and each From-To column the design places printing its header
    values = {**{k: MOCK_VALUES[k] for k in catalog_keys("front")}, "ft:Notes": "Notes"}
    expected, unknown = render_template(child, values, width_in=4, height_in=2, dots=203)
    assert unknown == set()
    assert r.json() == {"zpl": expected, "template_name": "Front Tag · 203"}
    zpl = r.json()["zpl"]
    assert "^FD100000^FS" in zpl and "^FDNotes^FS" in zpl
    # the template's own sample values never reach a label, not even here
    assert "SAMPLE-ONLY" not in zpl


async def test_badge_child_renders(client, db, seeded_user):
    hdrs = await login(client)
    parent = await make_tree(db, "Plain Badge", label_type="id_badge", design=BADGE)
    child = await _child(db, parent)
    r = await client.post(URL, headers=hdrs, json=_body(child))
    assert r.status_code == 200, r.text
    zpl = r.json()["zpl"]
    assert "{" not in zpl
    expected, _ = render_template(child, mock_field_values("id_badge"),
                                  width_in=4, height_in=2, dots=203)
    assert zpl == expected
    assert "Jordan Rivera" in zpl


async def test_refusals(client, db, seeded_user):
    hdrs = await login(client)
    inactive = _tpl("Top Inactive", is_active=False)
    ptouch = _tpl("Top Ptouch", language_key="ptouch")
    at_300 = _tpl("Top 300", dpi_key="300")
    parent = await make_tree(db, "Tagged", label_type="front")
    old = await _child(db, parent, "300")
    old.is_old = True
    db.add_all([inactive, ptouch, at_300])
    await db.commit()

    # every row the picker would never list is "not found", whatever its
    # language or DPI
    for template_id in (uuid.uuid4(), inactive.id, old.id, parent.id):
        r = await client.post(URL, headers=hdrs, json={
            "template_id": str(template_id), "dpi_key": "203"})
        assert r.status_code == 404, r.text
        assert r.json()["detail"]["code"] == "template_not_found"
    # an Old child that is still active is refused for being Old
    assert old.is_active
    r = await client.post(URL, headers=hdrs, json=_body(old, "300"))
    assert (r.status_code, r.json()["detail"]["code"]) == (404, "template_not_found")

    r = await client.post(URL, headers=hdrs, json=_body(ptouch))
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "not_zpl"
    # the language is checked before the DPI
    r = await client.post(URL, headers=hdrs, json=_body(ptouch, "300"))
    assert r.json()["detail"]["code"] == "not_zpl"

    r = await client.post(URL, headers=hdrs, json=_body(at_300, "203"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == {"code": "dpi_mismatch", "template_dpi_key": "300"}
    r = await client.post(URL, headers=hdrs, json=_body(at_300, "300"))
    assert r.status_code == 200, r.text

    r = await client.post(URL, headers=hdrs, json={"template_id": str(at_300.id)})
    assert r.status_code == 422, r.text


async def test_unconvertible_is_422(client, db, seeded_user):
    hdrs = await login(client)
    tpl = LabelTemplate(name="Odd Size", label_type="top", size_key="9x9", dpi_key="203",
                        language_key="zpl", kind="design", design=DESIGN)
    db.add(tpl)
    await db.commit()
    r = await client.post(URL, headers=hdrs, json=_body(tpl))
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "template_unconvertible"


async def test_needs_labels_view(client, db, seeded_user):
    tpl = _tpl("Top Code")
    db.add(tpl)
    await db.commit()
    worker = await _make(db, client, "worker", "w-test-render@test.example.com")
    r = await client.post(URL, headers=worker, json=_body(tpl))
    assert r.status_code == 403, r.text
    assert (await client.post(URL, json=_body(tpl))).status_code == 401
    # labels:view alone is enough: no designer rank, no kiosk access
    r = await client.post(URL, headers=await login(client), json=_body(tpl))
    assert r.status_code == 200, r.text


async def test_works_during_read_only_mode(client, db, seeded_user):
    """A read made through POST: a freeze must not stop a test print."""
    from tests.test_system_admin_api import _freeze
    tpl = _tpl("Top Code", code="^XA^FD{asset_id}^FS^XZ")
    db.add(tpl)
    await db.commit()
    hdrs = await _freeze(db, client)
    r = await client.post(URL, headers=hdrs, json=_body(tpl))
    assert r.status_code == 200, r.text
    assert r.json()["zpl"] == "^XA^FD100000^FS^XZ"


async def test_a_password_change_owed_blocks_it(client, db, seeded_user):
    """Exempt from the freeze is not exempt from signing in: a session that
    owes a password change gets nothing but the change."""
    from sqlalchemy import update

    from serversherpa.db.models import UserAccount

    tpl = _tpl("Top Code")
    db.add(tpl)
    await db.execute(update(UserAccount).where(UserAccount.email == "alice@test.example.com")
                     .values(must_change_password=True))
    await db.commit()
    owes = await login(client)
    r = await client.post(URL, headers=owes, json=_body(tpl))
    assert (r.status_code, r.json()["detail"]["code"]) == (403, "password_change_required")
