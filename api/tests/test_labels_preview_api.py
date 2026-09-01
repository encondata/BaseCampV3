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
