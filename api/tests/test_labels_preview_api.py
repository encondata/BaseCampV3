"""Labelary proxy: URL building, happy path (sender monkeypatched),
graceful 502. Never calls the real Labelary in tests."""

import pytest

from serversherpa.labels.labelary import render_url

from tests.test_sites_api import login


def test_render_url_shape():
    url = render_url(4, 2, 8)
    assert url.endswith("/v1/printers/8dpmm/labels/4x2/0/")
    assert render_url(3.375, 2.125, 12).endswith(
        "/v1/printers/12dpmm/labels/3.375x2.125/0/")


async def test_preview_returns_png(client, db, seeded_user, monkeypatch):
    calls = {}

    async def fake_render(zpl, width_in, height_in, dpmm):
        calls.update(zpl=zpl, w=width_in, h=height_in, dpmm=dpmm)
        return b"\x89PNG-fake"

    import serversherpa.api.routes.labels as labels_routes
    monkeypatch.setattr(labels_routes.labelary, "render_png", fake_render)
    hdrs = await login(client)
    resp = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": "^XA^XZ", "size_key": "4x2", "dpi_key": "203"})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.content == b"\x89PNG-fake"
    assert calls == {"zpl": "^XA^XZ", "w": 4, "h": 2, "dpmm": 8}


async def test_preview_502_when_labelary_down(client, db, seeded_user,
                                              monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("labelary: HTTP 503")

    import serversherpa.api.routes.labels as labels_routes
    monkeypatch.setattr(labels_routes.labelary, "render_png", boom)
    hdrs = await login(client)
    resp = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": "^XA^XZ", "size_key": "4x2", "dpi_key": "203"})
    assert resp.status_code == 502
    assert resp.json()["detail"]["code"] == "labelary_unavailable"


async def test_preview_unknown_vocab(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": "^XA^XZ", "size_key": "9x9", "dpi_key": "203"})
    assert resp.status_code == 404


# ── the builder's printer preview (spec §4.7): open fonts embedded with ~DY,
# the resident Swiss cut drawn with the printer's font 0, and 600 DPI ──

ROBOTO = b"\x00\x01\x00\x00" + b"roboto-bytes"
ROBOTO_B = b"\x00\x01\x00\x00" + b"roboto-bold-bytes"


async def _font(db, name, family, weight, *, resident=False, key="fonts/x"):
    from serversherpa.db.models import LabelFont
    row = LabelFont(name=name, display_name=name, storage_key=key, size_bytes=99,
                    family=family, weight=weight, resident=resident)
    db.add(row)
    await db.commit()
    return row


def _capture(monkeypatch, stored: dict[str, bytes]):
    """Fakes Labelary and the font storage; returns what Labelary got."""
    import serversherpa.api.routes.labels as labels_routes
    calls = {}
    reads = []

    async def fake_render(zpl, width_in, height_in, dpmm):
        calls.update(zpl=zpl, w=width_in, h=height_in, dpmm=dpmm)
        return b"\x89PNG-fake"

    async def fake_get(key):
        reads.append(key)
        return stored[key]

    monkeypatch.setattr(labels_routes.labelary, "render_png", fake_render)
    monkeypatch.setattr(labels_routes, "get_object", fake_get)
    labels_routes._FONT_BYTES_CACHE.clear()
    return calls, reads


async def test_preview_embeds_open_fonts_and_draws_the_resident_one_with_font_0(
        client, db, seeded_user, monkeypatch):
    roboto = await _font(db, "ROBOTO_R.TTF", "roboto", "regular", key="fonts/r")
    bold = await _font(db, "ROBOTO_B.TTF", "roboto", "bold", key="fonts/b")
    calls, reads = _capture(monkeypatch, {"fonts/r": ROBOTO, "fonts/b": ROBOTO_B})
    hdrs = await login(client)
    zpl = ("^XA^FT10,40^A@N,50,50,E:TT0003M_.TTF^FH_^FD14^FS"
           "^FT10,90^A@R,25,29,E:tt0003m_.ttf^FH_^FDLVN^FS"
           "^FT10,140^A@N,30,30,E:ROBOTO_R.TTF^FH_^FDName^FS^XZ")
    resp = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": zpl, "size_key": "4x2", "dpi_key": "300",
        "font_ids": [str(roboto.id), str(bold.id), str(roboto.id)]})
    assert resp.status_code == 200, resp.text
    body = calls["zpl"]
    assert isinstance(body, bytes)
    expected_fonts = (b"~DYE:ROBOTO_R.TTF,B,T,%d,," % len(ROBOTO) + ROBOTO
                      + b"~DYE:ROBOTO_B.TTF,B,T,%d,," % len(ROBOTO_B) + ROBOTO_B)
    assert body.startswith(expected_fonts)
    label = body[len(expected_fonts):].decode()
    assert label == ("^XA^FT10,40^A0N,50,50^FH_^FD14^FS"
                     "^FT10,90^A0R,25,29^FH_^FDLVN^FS"
                     "^FT10,140^A@N,30,30,E:ROBOTO_R.TTF^FH_^FDName^FS^XZ")
    assert calls["dpmm"] == 12
    assert reads == ["fonts/r", "fonts/b"]

    # the bytes are cached per font: a second preview reads nothing
    resp = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": "^XA^XZ", "size_key": "4x2", "dpi_key": "300", "font_ids": [str(roboto.id)]})
    assert resp.status_code == 200
    assert reads == ["fonts/r", "fonts/b"]


async def test_preview_without_fonts_still_rewrites_the_resident_font(
        client, db, seeded_user, monkeypatch):
    calls, _reads = _capture(monkeypatch, {})
    hdrs = await login(client)
    resp = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": "^XA^FT1,2^A@I,20,20,E:TT0003M_.TTF^FDx^FS^XZ", "size_key": "2x1",
        "dpi_key": "203"})
    assert resp.status_code == 200
    assert calls["zpl"] == "^XA^FT1,2^A0I,20,20^FDx^FS^XZ"
    assert calls["dpmm"] == 8


async def test_preview_600_dpi_maps_to_24_dpmm(client, db, seeded_user, monkeypatch):
    calls, _reads = _capture(monkeypatch, {})
    hdrs = await login(client)
    resp = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": "^XA^XZ", "size_key": "4x2", "dpi_key": "600"})
    assert resp.status_code == 200, resp.text
    assert calls["dpmm"] == 24


async def test_preview_refuses_unknown_and_resident_fonts(client, db, seeded_user, monkeypatch):
    swiss = await _font(db, "TT0003M_.TTF", "swiss721-cond-bold", "regular", resident=True,
                        key="fonts/s")
    calls, reads = _capture(monkeypatch, {"fonts/s": b"commercial"})
    hdrs = await login(client)
    resp = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": "^XA^XZ", "size_key": "4x2", "dpi_key": "300", "font_ids": [str(swiss.id)]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "font_not_servable"
    resp = await client.post("/labels/preview/zpl", headers=hdrs, json={
        "zpl": "^XA^XZ", "size_key": "4x2", "dpi_key": "300",
        "font_ids": ["00000000-0000-0000-0000-000000000000"]})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "font_not_found"
    assert calls == {} and reads == []
