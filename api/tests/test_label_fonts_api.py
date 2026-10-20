"""Label font library: upload TrueType fonts (Zebra 8.3 object names), list
them with the templates that reference them, stream their bytes for the
browser to push to a printer, soft-delete. Storage is the real dev MinIO,
like test_attachments.py."""

import uuid

import pytest
from serversherpa.api.routes import labels as labels_module
from serversherpa.db.models import AuditLog, LabelFont
from sqlalchemy import select

from tests.test_label_generate_api import _template
from tests.test_sites_api import login
from tests.test_status_values_write import _make

TTF = b"\x00\x01\x00\x00" + bytes(range(256)) * 4   # TrueType magic + payload
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _upload(client, hdrs, filename, data=TTF, name=None):
    files = {"file": (filename, data, "font/ttf")}
    form = {"name": name} if name else {}
    return client.post("/labels/fonts", headers=hdrs, files=files, data=form)


async def test_upload_list_content_delete(client, db, seeded_user):
    admin = await _make(db, client, "admin", "adm-fonts@test.example.com")
    tpl = await _template(db, "front", code="^XA^A@N,25,,E:85620388.TTF^FD{asset_id}^FS^XZ")

    resp = await _upload(client, admin, "85620388.ttf")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "85620388.TTF"
    assert body["display_name"] == "85620388.ttf"
    assert body["size_bytes"] == len(TTF)
    assert body["content_type"] == "font/ttf"
    assert body["uploaded_by_name"]
    assert body["used_by"] == [{"template_id": str(tpl.id), "template_name": tpl.name}]
    font_id = body["id"]

    rows = (await client.get("/labels/fonts", headers=await login(client))).json()
    assert [r["id"] for r in rows] == [font_id]

    content = await client.get(f"/labels/fonts/{font_id}/content", headers=await login(client))
    assert content.status_code == 200
    assert content.content == TTF
    assert content.headers["content-type"].startswith("font/ttf")
    assert 'filename="85620388.TTF"' in content.headers["content-disposition"]

    assert (await client.delete(f"/labels/fonts/{font_id}", headers=admin)).status_code == 204
    assert (await client.get("/labels/fonts", headers=admin)).json() == []
    assert (await client.get(f"/labels/fonts/{font_id}/content", headers=admin)).status_code == 404
    row = await db.get(LabelFont, uuid.UUID(font_id))
    assert row is not None and row.deleted_at is not None
    actions = (await db.execute(select(AuditLog.action).where(
        AuditLog.entity_type == "label_font", AuditLog.entity_id == font_id))).scalars().all()
    assert sorted(actions) == ["create", "delete"]


async def test_upload_validation(client, db, seeded_user):
    admin = await _make(db, client, "admin", "adm-fonts2@test.example.com")
    assert (await _upload(client, admin, "longername.ttf")).json()["detail"]["code"] == "invalid_font_name"
    assert (await _upload(client, admin, "swiss.otf")).json()["detail"]["code"] == "invalid_font_name"
    assert (await _upload(client, admin, "x.ttf", name="bad name.ttf")).json()["detail"]["code"] == "invalid_font_name"
    # Python's `$` matches just before a trailing newline under `re.match`;
    # `fullmatch` must reject a name smuggling one in.
    assert (await _upload(client, admin, "x.ttf", name="AB.TTF\n")).json()["detail"]["code"] == "invalid_font_name"
    assert (await _upload(client, admin, "logo.ttf", data=PNG)).json()["detail"]["code"] == "not_a_truetype_font"
    assert (await _upload(client, admin, "empty.ttf", data=b"")).json()["detail"]["code"] == "empty_file"
    big = b"\x00\x01\x00\x00" + b"\x00" * (2 * 1024 * 1024)
    assert (await _upload(client, admin, "big.ttf", data=big)).status_code == 413
    # explicit name overrides the filename and is upper-cased
    ok = await _upload(client, admin, "whatever.ttf", name="tt0003m_.ttf")
    assert ok.status_code == 201 and ok.json()["name"] == "TT0003M_.TTF"
    dup = await _upload(client, admin, "TT0003M_.TTF")
    assert dup.status_code == 409 and dup.json()["detail"]["code"] == "font_name_taken"
    # after deleting, the name is free again
    await client.delete(f"/labels/fonts/{ok.json()['id']}", headers=admin)
    assert (await _upload(client, admin, "TT0003M_.TTF")).status_code == 201


async def test_upload_race_reports_font_name_taken(client, db, seeded_user, monkeypatch):
    """Simulate the duplicate-name race deterministically: force the
    pre-check to see nothing (as if a concurrent upload hadn't committed
    yet when this request checked), so the second upload reaches the
    INSERT and trips label_fonts_name_active_idx. That must map to the
    same clean 409 as the pre-check, and must leave exactly one
    non-deleted row for the name — not a 500, and not a duplicate row."""
    admin = await _make(db, client, "admin", "adm-fonts4@test.example.com")
    first = await _upload(client, admin, "RACE.TTF")
    assert first.status_code == 201, first.text

    async def _sees_nothing(db, name):
        return None

    monkeypatch.setattr(labels_module, "_active_font_id", _sees_nothing)

    second = await _upload(client, admin, "RACE.TTF")
    assert second.status_code == 409, second.text
    assert second.json()["detail"]["code"] == "font_name_taken"

    rows = (await db.execute(select(LabelFont).where(
        LabelFont.name == "RACE.TTF", LabelFont.deleted_at.is_(None)))).scalars().all()
    assert len(rows) == 1


async def test_font_permissions(client, db, seeded_user):
    worker = await _make(db, client, "worker", "w-fonts@test.example.com")
    assert (await client.get("/labels/fonts", headers=worker)).status_code == 403
    assert (await _upload(client, worker, "a.ttf")).status_code == 403
    staff = await login(client)   # labels:view only
    assert (await _upload(client, staff, "b.ttf")).status_code == 403
    assert (await client.delete(f"/labels/fonts/{uuid.uuid4()}", headers=staff)).status_code == 403
    admin = await _make(db, client, "admin", "adm-fonts3@test.example.com")
    assert (await client.delete(f"/labels/fonts/{uuid.uuid4()}", headers=admin)).status_code == 404


# ── builder families: metrics, the resident font ─────────────────────

def _tiny_ttf(upem: int = 1000) -> bytes:
    """A real TrueType file: 1000 units per em, ascent 800, descent 200,
    glyphs for space, A and 0; every other character falls to .notdef."""
    import io

    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    def box():
        pen = TTGlyphPen(None)
        pen.moveTo((0, 0))
        pen.lineTo((0, 500))
        pen.lineTo((400, 500))
        pen.lineTo((400, 0))
        pen.closePath()
        return pen.glyph()

    fb = FontBuilder(upem, isTTF=True)
    fb.setupGlyphOrder([".notdef", "space", "A", "zero"])
    fb.setupCharacterMap({32: "space", 65: "A", 48: "zero"})
    fb.setupGlyf({".notdef": box(), "space": TTGlyphPen(None).glyph(), "A": box(),
                  "zero": box()})
    fb.setupHorizontalMetrics({".notdef": (500, 0), "space": (250, 0), "A": (600, 0),
                               "zero": (550, 0)})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "Tiny", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    out = io.BytesIO()
    fb.save(out)
    return out.getvalue()


async def _resident(db, **over) -> LabelFont:
    font = LabelFont(name="TT0003M_.TTF", display_name="Swiss 721 (printer built-in)",
                     storage_key=None, size_bytes=0, family="swiss721-cond-bold",
                     weight="regular", resident=True, **over)
    db.add(font)
    await db.commit()
    return font


async def test_metrics_route_returns_advances(client, db, seeded_user, monkeypatch):
    admin = await _make(db, client, "admin", "adm-fonts5@test.example.com")
    data = _tiny_ttf()
    up = await _upload(client, admin, "TINY.TTF", data=data)
    assert up.status_code == 201, up.text
    font_id = up.json()["id"]

    reads = []
    real_get = labels_module.get_object

    async def counting_get(key):
        reads.append(key)
        return await real_get(key)

    # ledger B10: fontTools parses off the event loop
    threaded = []
    real_to_thread = labels_module.asyncio.to_thread

    async def recording_to_thread(func, *args, **kwargs):
        threaded.append(func)
        return await real_to_thread(func, *args, **kwargs)

    monkeypatch.setattr(labels_module, "get_object", counting_get)
    monkeypatch.setattr(labels_module.asyncio, "to_thread", recording_to_thread)
    staff = await login(client)   # labels:view
    r = await client.get(f"/labels/fonts/{font_id}/metrics", headers=staff)
    assert r.status_code == 200, r.text
    assert threaded.count(labels_module.font_metrics) == 1
    m = r.json()
    assert (m["unitsPerEm"], m["ascent"], m["descent"]) == (1000, 800, 200)
    assert sorted(m["advances"]) == sorted(chr(c) for c in range(32, 127))
    assert (m["advances"][" "], m["advances"]["A"], m["advances"]["0"]) == (250, 600, 550)
    assert m["advances"]["B"] == 500   # no glyph: the printer draws .notdef

    again = await client.get(f"/labels/fonts/{font_id}/metrics", headers=staff)
    assert again.json() == m
    assert len(reads) == 1             # cached per font file

    junk = await _upload(client, admin, "JUNK.TTF")   # TrueType magic, not a font
    r = await client.get(f"/labels/fonts/{junk.json()['id']}/metrics", headers=staff)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unreadable_font"
    r = await client.get(f"/labels/fonts/{uuid.uuid4()}/metrics", headers=staff)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "font_not_found"
    worker = await _make(db, client, "worker", "w-fonts5@test.example.com")
    assert (await client.get(f"/labels/fonts/{font_id}/metrics", headers=worker)).status_code == 403


async def test_resident_font_content_is_refused(client, db, seeded_user):
    """The resident Swiss 721 file is Zebra's commercial cut: the browser
    never receives it. Its metrics come from the library copy once one is
    uploaded; uploading it fills the resident row instead of a 409."""
    admin = await _make(db, client, "admin", "adm-fonts6@test.example.com")
    swiss = await _resident(db)
    staff = await login(client)

    rows = (await client.get("/labels/fonts", headers=staff)).json()
    assert [(r["name"], r["family"], r["weight"], r["resident"], r["source_url"], r["size_bytes"])
            for r in rows] == [("TT0003M_.TTF", "swiss721-cond-bold", "regular", True, None, 0)]

    r = await client.get(f"/labels/fonts/{swiss.id}/metrics", headers=staff)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "no_font_file"
    r = await client.get(f"/labels/fonts/{swiss.id}/content", headers=staff)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "font_not_servable"

    up = await _upload(client, admin, "tt0003m_.ttf", data=_tiny_ttf())
    assert up.status_code == 201, up.text
    body = up.json()
    assert (body["id"], body["resident"], body["family"], body["size_bytes"]) == (
        str(swiss.id), True, "swiss721-cond-bold", len(_tiny_ttf()))
    assert body["display_name"] == "Swiss 721 (printer built-in)"
    assert (await _upload(client, admin, "TT0003M_.TTF")).status_code == 409   # has its file now

    r = await client.get(f"/labels/fonts/{swiss.id}/metrics", headers=staff)
    assert r.status_code == 200 and r.json()["advances"]["A"] == 600
    r = await client.get(f"/labels/fonts/{swiss.id}/content", headers=admin)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "font_not_servable"


async def test_upload_under_a_builder_name_takes_its_family(client, db, seeded_user):
    """A file uploaded under one of the builder's object names joins that
    family; the resident name stays resident even with no seeded row."""
    admin = await _make(db, client, "admin", "adm-fonts7@test.example.com")
    body = (await _upload(client, admin, "roboto_b.ttf")).json()
    assert (body["family"], body["weight"], body["resident"]) == ("roboto", "bold", False)
    body = (await _upload(client, admin, "85620388.TTF")).json()
    assert (body["family"], body["weight"], body["resident"]) == (None, None, False)
    body = (await _upload(client, admin, "TT0003M_.TTF")).json()
    assert (body["family"], body["weight"], body["resident"]) == (
        "swiss721-cond-bold", "regular", True)
    r = await client.get(f"/labels/fonts/{body['id']}/content", headers=admin)
    assert r.status_code == 403


async def test_kiosk_fonts_list_marks_resident(client, db, seeded_user, monkeypatch):
    from tests.test_kiosk_label_station_api import TTF as KIOSK_TTF
    from tests.test_kiosk_label_station_api import _content, _fake_storage, _font, _fonts
    from tests.test_kiosk_label_templates_sync import _move, _tpl

    hdrs = await login(client)
    move, *_ = await _move(db)
    db.add(_tpl("Front Fonts", label_type="front",
                code="^XA^CWK,E:TT0003M_.TTF^AKN,50^FDx^FS^A@N,25,,E:AAA.TTF^FDy^FS^XZ"))
    aaa = await _font(db, "AAA.TTF")
    await db.commit()
    swiss = await _resident(db)
    _fake_storage(monkeypatch, {"label-fonts/AAA.TTF": KIOSK_TTF})

    r = await _fonts(client, hdrs, move.id)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "fonts": [{"id": str(aaa.id), "name": "AAA.TTF", "size": len(KIOSK_TTF),
                   "resident": False},
                  {"id": str(swiss.id), "name": "TT0003M_.TTF", "size": 0, "resident": True}],
        "missing": [],
    }
    assert (await _content(client, hdrs, aaa.id, move.id)).status_code == 200
    r = await _content(client, hdrs, swiss.id, move.id)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "font_not_servable"


def test_metrics_refuse_an_out_of_range_units_per_em():
    from serversherpa.labels.font_metrics import UnreadableFont, metrics

    assert metrics(_tiny_ttf(16))["unitsPerEm"] == 16
    for upem in (8, 15):
        with pytest.raises(UnreadableFont, match="unitsPerEm"):
            metrics(_tiny_ttf(upem))


async def test_a_legacy_swiss_row_is_never_served(client, db, seeded_user, monkeypatch):
    """A TT0003M_.TTF uploaded before the builder (resident false, with a
    file) is refused by name on both content routes."""
    from tests.test_kiosk_label_station_api import _content, _fake_storage
    from tests.test_kiosk_label_templates_sync import _move, _tpl

    hdrs = await login(client)
    move, *_ = await _move(db)
    db.add(_tpl("Front Fonts", label_type="front",
                code="^XA^CWK,E:TT0003M_.TTF^AKN,50^FDx^FS^XZ"))
    legacy = LabelFont(name="tt0003m_.ttf", display_name="tt0003m_.ttf",
                       storage_key="label-fonts/legacy.ttf", size_bytes=10)
    db.add(legacy)
    await db.commit()
    assert legacy.resident is False
    _fake_storage(monkeypatch, {"label-fonts/legacy.ttf": TTF})

    r = await client.get(f"/labels/fonts/{legacy.id}/content", headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "font_not_servable"
    r = await _content(client, hdrs, legacy.id, move.id)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "font_not_servable"


async def test_a_failed_fill_removes_the_stored_file(client, db, seeded_user, monkeypatch):
    """Filling the resident row: if the write fails after the file is
    stored, the file is removed again and the row stays fileless."""
    admin = await _make(db, client, "admin", "adm-fonts8@test.example.com")
    swiss = await _resident(db)
    stored, removed = [], []

    async def fake_put(key, data, content_type):
        stored.append(key)

    async def fake_delete(key):
        removed.append(key)

    def broken_audit(*args, **kwargs):
        raise RuntimeError("audit down")

    monkeypatch.setattr(labels_module, "put_object", fake_put)
    monkeypatch.setattr(labels_module, "delete_object", fake_delete)
    monkeypatch.setattr(labels_module, "audit", broken_audit)

    with pytest.raises(RuntimeError, match="audit down"):
        await _upload(client, admin, "TT0003M_.TTF", data=_tiny_ttf())
    assert len(stored) == 1 and removed == stored
    await db.refresh(swiss)
    assert swiss.storage_key is None and swiss.size_bytes == 0
