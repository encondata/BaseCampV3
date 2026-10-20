"""Label Station setup routes (spec
docs/superpowers/specs/2026-10-19-label-station-printing-design.md):

- GET /kiosk/labels/fonts: the printer fonts the move's label template set
  references, split into library fonts and missing names;
- GET /kiosk/labels/fonts/{id}/content: a font's TTF bytes, only when the
  move's templates use it (Review Focus 2: fonts are scoped to the move);
- POST /kiosk/labels/test-render: one mock-data test label rendered by the
  portal's own render_label (Review Focus 5).

Same access as /kiosk/sync/label-templates: kiosk:view, move lock, 422 for a
non-move."""

import uuid

from serversherpa.api.routes import kiosk as kiosk_routes
from serversherpa.db.models import Initiative, LabelFont, LabelTemplate
from serversherpa.labels.generate.engine import render_label
from serversherpa.labels.template_fonts import fonts_used
from serversherpa.services import move_password as mp_svc
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_kiosk_label_templates_sync import DESIGN, SIZE_META, _link, _move, _tpl
from tests.test_kiosk_station_key import PW
from tests.test_sites_api import login

FONTS_URL = "/kiosk/labels/fonts"
RENDER_URL = "/kiosk/labels/test-render"
TTF = b"\x00\x01\x00\x00" + bytes(range(256)) * 2


# ── fonts_used ──────────────────────────────────────────────────────

def test_fonts_used_parses_a_at_and_cw_variants():
    code = ("^XA"
            "^A@N,25,,E:85620388.TTF^FD{asset_id}^FS"
            "^A@R,30,30E:ARIALBD.TTF^FDx^FS"
            "^a@n,20,20,e:lower_1.ttf^FDy^FS"
            "^CWQ,E:SWISS.TTF"
            "^cw1,e:cwlow.ttf"
            "^XZ")
    assert fonts_used(code) == {"85620388.TTF", "ARIALBD.TTF", "LOWER_1.TTF",
                                "SWISS.TTF", "CWLOW.TTF"}


def test_fonts_used_ignores_built_in_fonts():
    code = ("^XA^A0N,30,30^FDa^FS^ADN,18,10^FDb^FS"
            "^A@N,30,30,Z:0.FNT^FDc^FS^A@N,30,30,R:TT0003M_.TTF^FDd^FS"
            "^CWA,R:MYFONT.FNT^CW1,Z:0.FNT"
            "^FDE:NOTAFONT.TTF^FS^XZ")
    assert fonts_used(code) == set()
    assert fonts_used("") == set()


# ── helpers ─────────────────────────────────────────────────────────

async def _font(db, name, data=TTF, *, deleted=False):
    from datetime import UTC, datetime
    font = LabelFont(name=name, display_name=name.lower(), storage_key=f"label-fonts/{name}",
                     size_bytes=len(data), content_type="font/ttf",
                     deleted_at=datetime.now(UTC) if deleted else None)
    db.add(font)
    await db.flush()
    return font


def _fake_storage(monkeypatch, blobs):
    async def fake_get(key):
        return blobs[key]
    monkeypatch.setattr(kiosk_routes, "get_object", fake_get)


async def _fonts(client, hdrs, initiative_id):
    return await client.get(FONTS_URL, headers=hdrs,
                            params={"initiative_id": str(initiative_id)})


async def _content(client, hdrs, font_id, initiative_id):
    return await client.get(f"{FONTS_URL}/{font_id}/content", headers=hdrs,
                            params={"initiative_id": str(initiative_id)})


# ── font list ───────────────────────────────────────────────────────

async def test_font_list_returns_library_fonts_and_missing_names(client, db, seeded_user):
    hdrs = await login(client)
    move, _src, _dst, other = await _move(db)
    db.add_all([
        _tpl("Front Fonts", label_type="front",
             code="^XA^A@N,25,,E:AAA.TTF^FDx^FS^CWQ,E:BBB.TTF^A@N,9,9,E:GONE.TTF^XZ"),
        _tpl("Generic Missing", code="^XA^A@N,25,,E:NOPE.TTF^FDx^FS^XZ"),
        # outside the move's set: its font never shows up
        unlinked := _tpl("Unlinked Top", code="^XA^A@N,25,,E:OTHER.TTF^XZ"),
        _tpl("Inactive Front", label_type="front", is_active=False,
             code="^XA^A@N,25,,E:INACT.TTF^XZ"),
    ])
    aaa = await _font(db, "AAA.TTF")
    bbb = await _font(db, "BBB.TTF", TTF + b"xx")
    await _font(db, "GONE.TTF", deleted=True)
    await _font(db, "OTHER.TTF")
    await _font(db, "INACT.TTF")
    await db.flush()
    await _link(db, unlinked, other)
    await db.commit()

    r = await _fonts(client, hdrs, move.id)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "fonts": [{"id": str(aaa.id), "name": "AAA.TTF", "size": len(TTF), "resident": False},
                  {"id": str(bbb.id), "name": "BBB.TTF", "size": len(TTF) + 2,
                   "resident": False}],
        "missing": ["GONE.TTF", "NOPE.TTF"],
    }


async def test_font_list_for_a_move_without_fonts_is_empty(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    db.add(_tpl("Front Plain", label_type="front"))
    await db.commit()
    r = await _fonts(client, hdrs, move.id)
    assert r.status_code == 200, r.text
    assert r.json() == {"fonts": [], "missing": []}


# ── font content ────────────────────────────────────────────────────

async def test_content_streams_a_move_font_and_404s_any_other(
        client, db, seeded_user, monkeypatch):
    hdrs = await login(client)
    move, _src, _dst, away = await _move(db)
    db.add_all([
        _tpl("Front Fonts", label_type="front", code="^XA^A@N,25,,E:AAA.TTF^XZ"),
        unlinked := _tpl("Unlinked Top", code="^XA^A@N,25,,E:OTHER.TTF^XZ"),
    ])
    aaa = await _font(db, "AAA.TTF")
    other = await _font(db, "OTHER.TTF", b"other-bytes")
    gone = await _font(db, "AAA.TTF", b"old", deleted=True)
    await db.flush()
    await _link(db, unlinked, away)
    await db.commit()
    _fake_storage(monkeypatch, {"label-fonts/AAA.TTF": TTF,
                                "label-fonts/OTHER.TTF": b"other-bytes"})

    ok = await _content(client, hdrs, aaa.id, move.id)
    assert ok.status_code == 200, ok.text
    assert ok.content == TTF
    assert ok.headers["content-type"].startswith("font/ttf")
    assert 'filename="AAA.TTF"' in ok.headers["content-disposition"]

    for font_id in (other.id, gone.id, uuid.uuid4()):
        r = await _content(client, hdrs, font_id, move.id)
        assert r.status_code == 404, r.text
        assert r.json()["detail"]["code"] == "font_not_found"


async def test_content_without_a_stored_type_is_served_as_font_ttf(
        client, db, seeded_user, monkeypatch):
    hdrs = await login(client)
    move, *_ = await _move(db)
    db.add(_tpl("Front Fonts", label_type="front", code="^XA^A@N,25,,E:AAA.TTF^XZ"))
    aaa = await _font(db, "AAA.TTF")
    aaa.content_type = ""   # the column is NOT NULL; null and empty both fall back
    await db.commit()
    _fake_storage(monkeypatch, {"label-fonts/AAA.TTF": TTF})

    r = await _content(client, hdrs, aaa.id, move.id)
    assert r.status_code == 200, r.text
    assert r.content == TTF
    assert r.headers["content-type"].startswith("font/ttf")


async def test_move_password_session_is_locked_to_its_move(
        client, db, seeded_user, monkeypatch):
    move, *_ = await _move(db)
    other = Initiative(name="Other Move", initiative_type="move", status="in_progress")
    db.add(other)
    db.add(_tpl("Front Fonts", label_type="front", code="^XA^A@N,25,,E:AAA.TTF^XZ"))
    await db.flush()
    font = await _font(db, "AAA.TTF")
    await mp_svc.set_password(db, move, PW, actor_id=seeded_user.id)
    await db.commit()
    move_id, other_id, font_id = move.id, other.id, font.id
    _fake_storage(monkeypatch, {"label-fonts/AAA.TTF": TTF})
    lr = await client.post("/kiosk/move-login", json={"password": PW})
    assert lr.status_code == 200, lr.text
    hdrs = {"Authorization": f"Bearer {lr.json()['access_token']}"}

    assert (await _fonts(client, hdrs, move_id)).status_code == 200
    assert (await _content(client, hdrs, font_id, move_id)).status_code == 200
    for r in (await _fonts(client, hdrs, other_id),
              await _content(client, hdrs, font_id, other_id),
              await client.post(RENDER_URL, headers=hdrs, json={
                  "initiative_id": str(other_id), "template_id": str(uuid.uuid4()),
                  "dpi_key": "203"})):
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["code"] == "move_locked"


async def test_unknown_move_404_non_move_422_and_permission(client, db, seeded_user):
    hdrs = await login(client)
    project = Initiative(name="A Project", initiative_type="project", status="planned")
    db.add(project)
    move, *_ = await _move(db)
    await db.commit()
    project_id, move_id = project.id, move.id
    font_id = uuid.uuid4()
    body = {"template_id": str(uuid.uuid4()), "dpi_key": "203"}

    r = await _fonts(client, hdrs, uuid.uuid4())
    assert r.status_code == 404 and r.json()["detail"]["code"] == "initiative_not_found"
    for r in (await _fonts(client, hdrs, project_id),
              await _content(client, hdrs, font_id, project_id),
              await client.post(RENDER_URL, headers=hdrs,
                                json={**body, "initiative_id": str(project_id)})):
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["code"] == "bad_initiative"

    cv = await _client_viewer(db, client, "cv-label-station@test.example.com")
    assert (await _fonts(client, cv, move_id)).status_code == 403
    assert (await _content(client, cv, font_id, move_id)).status_code == 403
    assert (await client.post(RENDER_URL, headers=cv,
                              json={**body, "initiative_id": str(move_id)})).status_code == 403
    assert (await client.get(FONTS_URL, params={"initiative_id": str(move_id)})).status_code == 401


# ── test render ─────────────────────────────────────────────────────

RULES = {"destination": {"1": "dest_hall", "2": "dest_rack", "3": "dest_u"},
         "source": {"2": "src_rack"},
         "length_limits": {"asset_name": 6}}


def _expected_values():
    values = {k: v for k, v in kiosk_routes.MOCK_VALUES.items()}
    dest = values["destination_raw"].split(".")
    values.update(dest_hall=dest[0], dest_rack=dest[1], dest_u=dest[2],
                  src_rack=values["source_raw"].split(".")[1])
    values["asset_name"] = values["asset_name"][:6]
    return values


def test_mock_values_cover_the_placeholder_catalog():
    import re

    from tests.conftest import LABEL_PLACEHOLDER_SEEDS
    keys = set(re.findall(r"\('([a-z_]+)','", LABEL_PLACEHOLDER_SEEDS))
    assert keys and keys <= set(kiosk_routes.MOCK_VALUES)
    mv = kiosk_routes.MOCK_VALUES
    assert mv["asset_id"] == "100000"
    assert mv["asset_name"] == "SAMPLE-SERVER-01"
    assert mv["serial_number"] == "SN0000001"
    assert (mv["make"], mv["model"]) == ("Dell", "PowerEdge R740")
    assert mv["make_model"] == "Dell PowerEdge R740"
    assert (mv["source_site"], mv["destination_site"]) == ("Sample Site A", "Sample Site B")
    assert mv["source_raw"].count(".") == 2 and mv["destination_raw"].count(".") == 2
    assert (mv["source_ru"], mv["destination_ru"]) == ("U12", "U12")
    assert mv["move_name"] == "Sample Move"
    assert mv["move_date"] and mv["move_date_long"]


async def test_test_render_matches_render_label_with_rules(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    design = {**DESIGN, "elements": [*DESIGN["elements"], {
        "id": "t2", "type": "text", "x": 0.1, "y": 1.5, "w": 3.8, "h": 0.4, "rotation": 0,
        "content": "{dest_hall}/{dest_rack}/{dest_u} {src_rack} {move_name} {move_date}",
        "fontSizePt": 10, "align": "left"}]}
    tpl = LabelTemplate(name="Generic Rack and RU", label_type="top", size_key="4x2",
                        dpi_key="203", language_key="zpl", kind="design", design=design,
                        generation_rules=RULES)
    db.add(tpl)
    await db.commit()
    tpl_id = tpl.id

    r = await client.post(RENDER_URL, headers=hdrs, json={
        "initiative_id": str(move.id), "template_id": str(tpl_id), "dpi_key": "203"})
    assert r.status_code == 200, r.text
    expected, _ = render_label(tpl, _expected_values(), size_meta=SIZE_META,
                               dpi_meta={"dots": 203}, language_key="zpl")
    assert r.json() == {"zpl": expected, "template_name": "Generic Rack and RU"}
    assert "SAMPLE" in r.json()["zpl"] and "SAMPLE-SERVER-01" not in r.json()["zpl"]
    assert "{" not in r.json()["zpl"]


async def test_test_render_code_template(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    tpl = _tpl("Front Code", label_type="front",
               code="^XA^FD{asset_name} {serial_number} {destination_ru}^FS^XZ")
    db.add(tpl)
    await db.commit()
    r = await client.post(RENDER_URL, headers=hdrs, json={
        "initiative_id": str(move.id), "template_id": str(tpl.id), "dpi_key": "203"})
    assert r.status_code == 200, r.text
    assert r.json()["zpl"] == "^XA^FDSAMPLE-SERVER-01 SN0000001 U12^FS^XZ"


async def test_test_render_dpi_mismatch_is_422(client, db, seeded_user):
    hdrs = await login(client)
    move, *_ = await _move(db)
    tpl = _tpl("Front 300", label_type="front", dpi_key="300")
    db.add(tpl)
    await db.commit()
    r = await client.post(RENDER_URL, headers=hdrs, json={
        "initiative_id": str(move.id), "template_id": str(tpl.id), "dpi_key": "203"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "dpi_mismatch"


async def test_test_render_inactive_or_outside_template_is_404(client, db, seeded_user):
    hdrs = await login(client)
    move, _src, _dst, other = await _move(db)
    inactive = _tpl("Front Inactive", label_type="front", is_active=False)
    outside = _tpl("Unlinked Top")
    db.add_all([inactive, outside])
    await db.flush()
    await _link(db, outside, other)
    await db.commit()
    for template_id in (inactive.id, outside.id, uuid.uuid4()):
        r = await client.post(RENDER_URL, headers=hdrs, json={
            "initiative_id": str(move.id), "template_id": str(template_id),
            "dpi_key": "203"})
        assert r.status_code == 404, r.text
        assert r.json()["detail"]["code"] == "template_not_found"


async def test_test_render_works_during_read_only_mode(client, db, seeded_user):
    """A read made through POST: a freeze must not stop a setup test print."""
    from tests.test_system_admin_api import _freeze
    move, *_ = await _move(db)
    tpl = _tpl("Front Code", label_type="front", code="^XA^FD{asset_id}^FS^XZ")
    db.add(tpl)
    await db.commit()
    hdrs = await _freeze(db, client)
    r = await client.post(RENDER_URL, headers=hdrs, json={
        "initiative_id": str(move.id), "template_id": str(tpl.id), "dpi_key": "203"})
    assert r.status_code == 200, r.text
    assert r.json()["zpl"] == "^XA^FD100000^FS^XZ"
