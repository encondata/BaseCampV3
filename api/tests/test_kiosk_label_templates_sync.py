"""GET /kiosk/sync/label-templates and its /kiosk/station/sync twin — the
move's label template set for an offline kiosk (spec
docs/superpowers/specs/2026-10-19-kiosk-label-templates-sync-design.md).

Selection: active templates only; included when Front, linked to the
move's destination or source site, "generic" in the name, Container /
Container Info, or the "Generic Rack and RU" fallback when no active
template is linked to the destination. Each template once, with every
reason it matched. Design templates come down as printer code with their
{placeholder} tokens intact."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    Device, Initiative, LabelTemplate, LabelTemplateSite, Site,
)
from serversherpa.db.ordering import natural_key
from serversherpa.labels.generate.engine import render_label
from serversherpa.labels.tokens import apply_placeholders
from serversherpa.services import move_password as mp_svc
from serversherpa.services import station_keys
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_kiosk_station_key import PW, SERIAL, _device
from tests.test_sites_api import login

URL = "/kiosk/sync/label-templates"

DESIGN = {"size": {"w": 4, "h": 2}, "elements": [
    {"id": "t1", "type": "text", "x": 0.1, "y": 0.1, "w": 3.8, "h": 0.4,
     "rotation": 0, "content": "Name: {asset_name}", "fontSizePt": 14,
     "align": "left"},
    {"id": "b1", "type": "barcode", "x": 0.1, "y": 0.8, "w": 3, "h": 0.6,
     "rotation": 0, "symbology": "code128", "data": "{asset_id}",
     "showText": True},
    {"id": "q1", "type": "qr", "x": 3.0, "y": 0.8, "w": 0.8, "h": 0.8,
     "rotation": 0, "data": "{asset_id}-{destination_rack}"},
]}

SIZE_META = {"width_in": 4, "height_in": 2, "has_tab": False}


def _tpl(name, label_type="top", **over):
    base = {"name": name, "label_type": label_type, "size_key": "4x2", "dpi_key": "203",
                "language_key": "zpl", "kind": "code", "code": "^XA^FD{asset_name}^FS^XZ"}
    base.update(over)
    return LabelTemplate(**base)


async def _link(db, template, site):
    db.add(LabelTemplateSite(template_id=template.id, site_id=site.id))


async def _move(db, *, origin=True, destination=True):
    src = Site(name="Src Hall")
    dst = Site(name="Dst Hall")
    other = Site(name="Elsewhere Hall")
    db.add_all([src, dst, other])
    await db.flush()
    move = Initiative(name="Label Move", initiative_type="move", status="in_progress",
                      origin_site_id=src.id if origin else None,
                      destination_site_id=dst.id if destination else None)
    db.add(move)
    await db.flush()
    return move, src, dst, other


async def _get(client, hdrs, initiative_id):
    return await client.get(URL, headers=hdrs, params={"initiative_id": str(initiative_id)})


def _by_name(body):
    return {t["name"]: t for t in body["templates"]}


# ── selection rules ─────────────────────────────────────────────────

async def test_selection_rules_reasons_and_order(client, db, seeded_user):
    hdrs = await login(client)
    move, src, dst, other = await _move(db)
    t = {n: _tpl(n, **kw) for n, kw in {
        "Front 4x2 203dpi": {"label_type": "front"},
        "Front Elsewhere": {"label_type": "front"},
        "Front At Destination": {"label_type": "front"},
        "Dest Top": {"label_type": "top"},
        "Src Rail": {"label_type": "rail"},
        "Other Top": {"label_type": "top"},
        "Unlinked Top": {"label_type": "top"},
        "my GENERIC rail": {"label_type": "rail"},
        "Container Label 4x6 203dpi": {"label_type": "container", "size_key": "4x6"},
        "Container Info 4x6 203dpi": {"label_type": "container_info", "size_key": "4x6"},
        "Inactive Front": {"label_type": "front", "is_active": False},
        "Inactive Dest Top": {"label_type": "top", "is_active": False},
        "Inactive Generic": {"label_type": "top", "is_active": False},
        "Inactive Container": {"label_type": "container", "is_active": False},
        "Inactive Src Rail": {"label_type": "rail", "is_active": False},
    }.items()}
    db.add_all(t.values())
    await db.flush()
    await _link(db, t["Front Elsewhere"], other)
    await _link(db, t["Front At Destination"], dst)
    await _link(db, t["Dest Top"], dst)
    await _link(db, t["Src Rail"], src)
    await _link(db, t["Other Top"], other)
    await _link(db, t["Inactive Dest Top"], dst)
    await _link(db, t["Inactive Src Rail"], src)
    await db.commit()

    r = await _get(client, hdrs, move.id)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["initiative_id"] == str(move.id)
    assert body["generated_at"]
    names = [x["name"] for x in body["templates"]]
    assert names == sorted(names, key=natural_key)
    got = {x["name"]: x["reasons"] for x in body["templates"]}
    assert got == {
        "Front 4x2 203dpi": ["front"],
        "Front Elsewhere": ["front"],
        "Front At Destination": ["destination_site", "front"],
        "Dest Top": ["destination_site"],
        "Src Rail": ["source_site"],
        "my GENERIC rail": ["generic"],
        "Container Label 4x6 203dpi": ["container"],
        "Container Info 4x6 203dpi": ["container"],
    }
    rows = _by_name(body)
    assert rows["Dest Top"]["move_site_names"] == ["Dst Hall"]
    assert rows["Src Rail"]["move_site_names"] == ["Src Hall"]
    # linked only to another site: still sent (Front rule), but that
    # site's name never reaches the kiosk
    assert rows["Front Elsewhere"]["move_site_names"] == []
    assert "Elsewhere Hall" not in r.text
    assert rows["my GENERIC rail"]["move_site_names"] == []


async def test_template_linked_to_both_sites_lists_both_reasons(client, db, seeded_user):
    hdrs = await login(client)
    move, src, dst, _ = await _move(db)
    both = _tpl("Both Ends Top")
    db.add(both)
    await db.flush()
    await _link(db, both, src)
    await _link(db, both, dst)
    await db.commit()
    rows = _by_name((await _get(client, hdrs, move.id)).json())
    assert rows["Both Ends Top"]["reasons"] == ["destination_site", "source_site"]
    assert rows["Both Ends Top"]["move_site_names"] == ["Dst Hall", "Src Hall"]


async def test_move_site_names_leave_out_other_sites(client, db, seeded_user):
    """A template linked to the destination AND an unrelated site lists
    only the destination; the unrelated site's name is never sent."""
    hdrs = await login(client)
    move, _src, dst, other = await _move(db)
    shared = _tpl("Shared Front", label_type="front")
    generic = _tpl("Generic Elsewhere")
    db.add_all([shared, generic])
    await db.flush()
    await _link(db, shared, dst)
    await _link(db, shared, other)
    await _link(db, generic, other)
    await db.commit()
    r = await _get(client, hdrs, move.id)
    rows = _by_name(r.json())
    assert rows["Shared Front"]["move_site_names"] == ["Dst Hall"]
    assert rows["Generic Elsewhere"]["move_site_names"] == []
    assert rows["Generic Elsewhere"]["reasons"] == ["generic"]
    assert "Elsewhere Hall" not in r.text


async def test_unexpected_conversion_failure_never_fails_the_sync(
        client, db, seeded_user, monkeypatch, caplog):
    from serversherpa.api.routes import kiosk as kiosk_routes
    hdrs = await login(client)
    move, *_ = await _move(db)
    boom = _tpl("Front Boom", label_type="front")
    db.add_all([boom, _tpl("Front Fine", label_type="front")])
    await db.commit()
    boom_id = boom.id
    real = kiosk_routes.template_code

    def flaky(template, size_meta, dpi_meta):
        if template.name == "Front Boom":
            raise KeyError("secret detail")
        return real(template, size_meta, dpi_meta)

    monkeypatch.setattr(kiosk_routes, "template_code", flaky)
    with caplog.at_level("WARNING"):
        r = await _get(client, hdrs, move.id)
    assert r.status_code == 200, r.text
    rows = _by_name(r.json())
    assert rows["Front Boom"]["code"] == ""
    assert rows["Front Boom"]["error"] == "KeyError"      # class name, never the message
    assert "secret detail" not in r.text
    assert rows["Front Fine"]["error"] is None
    assert str(boom_id) in caplog.text and "KeyError" in caplog.text


async def test_fallback_when_destination_has_no_template(client, db, seeded_user):
    hdrs = await login(client)
    move, _src, dst, _ = await _move(db)
    rack = _tpl("Generic Rack and RU", label_type="rail")
    inactive_dest = _tpl("Retired Dest Top", is_active=False)
    db.add_all([rack, inactive_dest])
    await db.flush()
    await _link(db, inactive_dest, dst)   # an inactive link does not count
    await db.commit()
    rows = _by_name((await _get(client, hdrs, move.id)).json())
    assert rows["Generic Rack and RU"]["reasons"] == ["fallback", "generic"]
    assert "Retired Dest Top" not in rows


async def test_fallback_name_match_ignores_case(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    db.add(_tpl("GENERIC RACK AND ru", label_type="rail"))
    await db.commit()
    rows = _by_name((await _get(client, hdrs, move.id)).json())
    assert rows["GENERIC RACK AND ru"]["reasons"] == ["fallback", "generic"]


async def test_no_fallback_when_destination_has_a_template(client, db, seeded_user):
    hdrs = await login(client)
    move, _src, dst, _ = await _move(db)
    rack = _tpl("Generic Rack and RU", label_type="rail")
    dest_front = _tpl("Dest Front", label_type="front")
    db.add_all([rack, dest_front])
    await db.flush()
    await _link(db, dest_front, dst)
    await db.commit()
    rows = _by_name((await _get(client, hdrs, move.id)).json())
    assert rows["Generic Rack and RU"]["reasons"] == ["generic"]


async def test_fallback_applies_when_move_has_no_destination(client, db, seeded_user):
    hdrs = await login(client)
    move, src, _dst, _ = await _move(db, destination=False)
    rack = _tpl("Generic Rack and RU", label_type="rail")
    src_top = _tpl("Src Top")
    db.add_all([rack, src_top])
    await db.flush()
    await _link(db, src_top, src)
    await db.commit()
    rows = _by_name((await _get(client, hdrs, move.id)).json())
    assert rows["Generic Rack and RU"]["reasons"] == ["fallback", "generic"]
    assert rows["Src Top"]["reasons"] == ["source_site"]


async def test_no_source_site_matches_nothing_for_rule_three(client, db, seeded_user):
    hdrs = await login(client)
    move, src, _dst, _ = await _move(db, origin=False)
    src_top = _tpl("Src Top")
    db.add(src_top)
    await db.flush()
    await _link(db, src_top, src)
    await db.commit()
    rows = _by_name((await _get(client, hdrs, move.id)).json())
    assert "Src Top" not in rows


async def test_inactive_fallback_template_is_never_sent(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    db.add(_tpl("Generic Rack and RU", label_type="rail", is_active=False))
    await db.commit()
    body = (await _get(client, hdrs, move.id)).json()
    assert body["templates"] == []


async def test_both_dpi_versions_are_listed(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    db.add_all([
        _tpl("Container Label 4x6 203dpi", label_type="container", size_key="4x6",
             dpi_key="203"),
        _tpl("Container Label 4x6 300dpi", label_type="container", size_key="4x6",
             dpi_key="300"),
    ])
    await db.commit()
    rows = _by_name((await _get(client, hdrs, move.id)).json())
    lo, hi = rows["Container Label 4x6 203dpi"], rows["Container Label 4x6 300dpi"]
    assert (lo["dpi_key"], lo["dots"]) == ("203", 203)
    assert (hi["dpi_key"], hi["dots"]) == ("300", 300)
    assert (lo["width_in"], lo["height_in"]) == (4, 6)


# ── what each template carries ─────────────────────────────────────

async def test_code_template_is_returned_verbatim(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    code = "^XA\n^FO10,10^FH_^FD{asset_name} _5e ~x^FS\n^XZ"
    db.add(_tpl("Front Raw", label_type="front", code=code,
                generation_rules={"length_limits": {"asset_name": 20}}))
    await db.commit()
    row = _by_name((await _get(client, hdrs, move.id)).json())["Front Raw"]
    assert row["code"] == code
    assert row["error"] is None
    assert row["generation_rules"] == {"length_limits": {"asset_name": 20}}
    assert set(row) == {
        "id", "name", "label_type", "size_key", "dpi_key", "language_key", "version",
        "updated_at", "move_site_names", "reasons", "code", "generation_rules",
        "width_in", "height_in", "dots", "error"}
    assert (row["size_key"], row["language_key"], row["version"]) == ("4x2", "zpl", 1)


async def test_design_template_keeps_tokens_and_fills_like_render_label(
        client, db, seeded_user):
    """Review Focus 1: the token-intact code, filled with
    apply_placeholders, equals the portal generator's render_label output
    for simple values."""
    hdrs = await login(client)
    move, *_ = await _move(db)
    rules = {"destination": {"1": "nap"}}
    db.add(_tpl("Front Design", label_type="front", kind="design", code=None,
                design=DESIGN, generation_rules=rules))
    await db.commit()
    row = _by_name((await _get(client, hdrs, move.id)).json())["Front Design"]
    assert row["error"] is None
    code = row["code"]
    assert "{asset_name}" in code and "{asset_id}" in code and "{destination_rack}" in code
    assert code.startswith("^XA") and "^PW812" in code and "^LL406" in code
    assert row["generation_rules"] == rules

    template = (await db.scalars(select(LabelTemplate).where(
        LabelTemplate.name == "Front Design"))).one()
    values = {"asset_name": "Server 42", "asset_id": "10482", "destination_rack": "R12"}
    portal, _unknown = render_label(template, values, size_meta=SIZE_META,
                                    dpi_meta={"dots": 203}, language_key="zpl")
    assert apply_placeholders(code, values) == portal


async def test_design_template_converts_at_its_own_dpi(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    db.add(_tpl("Front Design 300dpi", label_type="front", kind="design", code=None,
                design=DESIGN, dpi_key="300"))
    await db.commit()
    row = _by_name((await _get(client, hdrs, move.id)).json())["Front Design 300dpi"]
    assert "^PW1200" in row["code"] and "^LL600" in row["code"]
    assert row["dots"] == 300


async def test_design_that_cannot_convert_is_listed_with_an_error(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    db.add_all([
        _tpl("Front Broken", label_type="front", kind="design", code=None,
             design={"size": {"w": 4, "h": 2}, "elements": "nope"}),
        _tpl("Front Unknown Size", label_type="front", kind="design", code=None,
             design=DESIGN, size_key="no-such-size"),
        _tpl("Front Fine", label_type="front"),
    ])
    await db.commit()
    r = await _get(client, hdrs, move.id)
    assert r.status_code == 200, r.text
    rows = _by_name(r.json())
    assert rows["Front Broken"]["code"] == "" and rows["Front Broken"]["error"]
    unknown = rows["Front Unknown Size"]
    assert unknown["code"] == "" and unknown["error"]
    assert unknown["width_in"] is None and unknown["height_in"] is None
    assert rows["Front Fine"]["error"] is None


# ── access ──────────────────────────────────────────────────────────

async def test_unknown_move_is_404_and_a_non_move_is_422(client, db, seeded_user):
    hdrs = await login(client)
    project = Initiative(name="A Project", initiative_type="project", status="planned")
    db.add(project)
    await db.commit()
    r = await _get(client, hdrs, uuid.uuid4())
    assert r.status_code == 404 and r.json()["detail"]["code"] == "initiative_not_found"
    r = await _get(client, hdrs, project.id)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_initiative"


async def test_permission(client, db, seeded_user):
    move, *_ = await _move(db)
    await db.commit()
    move_id = move.id
    cv = await _client_viewer(db, client, "cv-sync-label-templates@test.example.com")
    assert (await _get(client, cv, move_id)).status_code == 403
    assert (await client.get(URL, params={"initiative_id": str(move_id)})).status_code == 401


async def test_move_password_session_is_locked_to_its_move(client, db, seeded_user):
    move, *_ = await _move(db)
    other = Initiative(name="Other Move", initiative_type="move", status="in_progress")
    db.add(other)
    await db.flush()
    await mp_svc.set_password(db, move, PW, actor_id=seeded_user.id)
    await db.commit()
    move_id, other_id = move.id, other.id
    lr = await client.post("/kiosk/move-login", json={"password": PW})
    assert lr.status_code == 200, lr.text
    hdrs = {"Authorization": f"Bearer {lr.json()['access_token']}"}
    assert (await _get(client, hdrs, move_id)).status_code == 200
    bad = await _get(client, hdrs, other_id)
    assert bad.status_code == 403 and bad.json()["detail"]["code"] == "move_locked"


async def test_station_twin_serves_the_key_move_only(client, db, seeded_user):
    move, *_ = await _move(db)
    db.add(_tpl("Front Station", label_type="front"))
    project = Initiative(name="Station Project", initiative_type="project",
                         status="planned")
    db.add(project)
    await db.commit()
    move_id, project_id = move.id, project.id
    device, key_a = await _device(db, current_initiative_id=move_id)
    live = await db.get(Device, device.id)
    key = await station_keys.issue(db, live, actor_id=None, via="password")
    await db.commit()
    auth = {"Authorization": f"Station {key}"}

    r = await client.get("/kiosk/station/sync/label-templates", headers=auth,
                         params={"serial": SERIAL, "initiative_id": str(move_id)})
    assert r.status_code == 200, r.text
    assert [t["name"] for t in r.json()["templates"]] == ["Front Station"]

    for wrong in (key_a.id, project_id, uuid.uuid4()):
        r = await client.get("/kiosk/station/sync/label-templates", headers=auth,
                             params={"serial": SERIAL, "initiative_id": str(wrong)})
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["code"] == "move_locked"

    anon = await client.get("/kiosk/station/sync/label-templates",
                            params={"serial": SERIAL, "initiative_id": str(move_id)})
    assert anon.status_code in (401, 403)


# ── Review Focus 1: where filling the token-intact code differs ─────
# The portal compiles a design WITH its values (subs=values); the kiosk
# fills the token-intact code afterward with apply_placeholders. These pin
# exactly where the two agree and where they don't (spec §7 — the next
# step must close the gaps before a kiosk prints).

def _design_template(language_key):
    return LabelTemplate(name=f"rf1-{language_key}", label_type="front", size_key="4x2",
                         dpi_key="203", language_key=language_key, kind="design",
                         design=DESIGN)


def _both(language_key, values):
    from serversherpa.labels.kiosk_templates import template_code
    template = _design_template(language_key)
    kiosk = apply_placeholders(template_code(template, SIZE_META, {"dots": 203}), values)
    portal, _ = render_label(template, values, size_meta=SIZE_META,
                             dpi_meta={"dots": 203}, language_key=language_key)
    return kiosk, portal


SIMPLE = {"asset_name": "Server 42", "asset_id": "10482", "destination_rack": "R12"}


def test_rf1_zpl_and_escp_match_for_simple_values():
    for language_key in ("zpl", "escp"):
        kiosk, portal = _both(language_key, SIMPLE)
        assert kiosk == portal, language_key


def test_rf1_zpl_differs_when_a_value_needs_fh_escaping():
    """ZPL fields ride behind ^FH_; the portal hex-escapes ^ ~ _ \\ and
    non-ASCII in each VALUE (zpl._esc), a plain fill does not."""
    values = {**SIMPLE, "asset_name": "web_01"}
    kiosk, portal = _both("zpl", values)
    assert "^FDName: web_5f01^FS" in portal
    assert "^FDName: web_01^FS" in kiosk
    assert kiosk.replace("web_01", "web_5f01") == portal


def test_rf1_ptouch_differs_in_the_length_prefix():
    """P-touch prefixes each object's data with its UTF-8 byte length; the
    token-intact code carries the TOKEN's length, not the value's."""
    kiosk, portal = _both("ptouch", SIMPLE)
    assert kiosk != portal
    assert "^DI" + chr(len("Name: Server 42")) in portal
    assert "^DI" + chr(len("Name: {asset_name}")) in kiosk
