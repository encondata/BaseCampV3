import json
import logging

import httpx
import pytest

from edge.rfid import ingest, pairing, tagreads
from tests.fake_reader import tag_batch, tag_event

SERIAL = "84248dee5721"
TOKEN = "tok-secret-0123456789abcdef"
MB5 = 5 * 1024 * 1024


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def pair_reader(app, token=TOKEN, serial=SERIAL):
    store = app.state.store
    pairing.remember(store, serial=serial, ip="10.0.0.20", model="FX9600", versions={},
                     password_index=1, token=token)
    store.run("INSERT INTO rfid_pairing (id, serial) VALUES (1, ?) "
              "ON CONFLICT (id) DO UPDATE SET serial = excluded.serial", (serial,))


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
async def ingest_client(app, clock):
    pair_reader(app)
    transport = httpx.ASGITransport(app=ingest.create_ingest_app(app.state, clock=clock))
    async with httpx.AsyncClient(transport=transport, base_url="http://edge.test") as c:
        yield c


def rows(app):
    return app.state.store.all("SELECT * FROM raw_tag_reads")


def path(serial=SERIAL, token=TOKEN):
    return f"/rfid/{serial}/{token}"


async def test_accepts_single_and_batch(app, ingest_client):
    r = await ingest_client.post(path(), json=tag_event("E280AA"))
    assert r.status_code == 200 and r.json() == {"stored": 1, "skipped": 0}
    r = await ingest_client.post(path(), json=tag_batch(3))
    assert r.json() == {"stored": 3, "skipped": 0}
    stored = rows(app)
    assert len(stored) == 4 and {x["reader_serial"] for x in stored} == {SERIAL}


async def test_wrong_token_wrong_serial_or_unpaired_is_404(app, ingest_client):
    for p in (path(token="nope"), path(serial="other")):
        r = await ingest_client.post(p, json=tag_event("E280AA"))
        assert r.status_code == 404 and r.content == b""
    app.state.store.run("DELETE FROM rfid_pairing")
    r = await ingest_client.post(path(), json=tag_event("E280AA"))
    assert r.status_code == 404 and r.content == b""
    assert rows(app) == []


async def test_other_paths_are_404(ingest_client):
    for method, p in (("GET", path()), ("POST", "/"), ("POST", f"/rfid/{SERIAL}")):
        r = await ingest_client.request(method, p, json=tag_event("E280AA"))
        assert r.status_code == 404 and r.content == b"", (method, p)


async def test_bad_json_is_400(app, ingest_client):
    r = await ingest_client.post(path(), content=b"{nope")
    assert r.status_code == 400 and r.json() == {"error": "bad_json"}
    r = await ingest_client.post(path(), content=b"\xff\xfe")
    assert r.status_code == 400
    assert rows(app) == []


async def test_scalar_json_is_400(app, ingest_client):
    r = await ingest_client.post(path(), content=b"5")
    assert r.status_code == 400 and r.json() == {"error": "bad_json"}


async def test_oversized_body_is_413(app, ingest_client):
    r = await ingest_client.post(path(), content=b" " * (MB5 + 10))
    assert r.status_code == 413
    assert rows(app) == []


async def test_oversized_streamed_body_is_413(app, ingest_client):
    async def chunks():  # no Content-Length
        for _ in range(6):
            yield b" " * (1024 * 1024)
    r = await ingest_client.post(path(), content=chunks())
    assert r.status_code == 413 and rows(app) == []


async def test_write_failure_rolls_back_and_returns_500(app, ingest_client, monkeypatch):
    # the first insert succeeds, then the summary upsert fails mid-transaction
    monkeypatch.setattr(tagreads, "_UPSERT", "INSERT INTO no_such_table VALUES (1)")
    r = await ingest_client.post(path(), json=tag_batch(3))
    assert r.status_code == 500
    assert rows(app) == []
    assert app.state.store.all("SELECT * FROM rfid_tags_seen") == []


async def test_event_record_failure_still_returns_200_once(app, ingest_client, monkeypatch, caplog):
    def boom(*a, **k):
        raise RuntimeError("store closed")
    monkeypatch.setattr(ingest.events, "record", boom)
    r = await ingest_client.post(path(), json=tag_batch(2))
    assert r.status_code == 200 and r.json() == {"stored": 2, "skipped": 0}
    assert len(rows(app)) == 2
    assert any("RuntimeError" in m.getMessage() and m.levelno == logging.WARNING
               for m in caplog.records)


async def test_debug_line_has_duration_not_token(app, ingest_client, caplog):
    caplog.set_level(logging.DEBUG, logger="edge.rfid.ingest")
    await ingest_client.post(path(), json=tag_event("E280AA"))
    msgs = [r.getMessage() for r in caplog.records if r.name == "edge.rfid.ingest"]
    assert any(" ms" in m and "stored 1" in m for m in msgs)
    assert all(TOKEN not in m for m in msgs)


async def test_token_never_logged(app, ingest_client, caplog):
    caplog.set_level(logging.DEBUG)
    await ingest_client.post(path(), json=tag_event("E280AA"))
    await ingest_client.post(path(token=TOKEN + "x"), json=tag_event("E280AA"))
    await ingest_client.post(path(serial="other"), json=tag_event("E280AA"))
    # the test client's own httpx request log necessarily shows the URL; ours must not
    ours = [r.getMessage() for r in caplog.records if r.name.startswith("edge")]
    assert ours and all(TOKEN not in m for m in ours)


async def test_tag_data_receiving_event_once_then_after_quiet(app, ingest_client, clock):
    def events():
        return app.state.store.all(
            "SELECT * FROM rfid_events WHERE kind = 'tag_data_receiving'")

    await ingest_client.post(path(), json=tag_event("E280AA"))
    assert len(events()) == 1
    assert events()[0]["detail"] == "FX9600 · 1 reads"
    assert events()[0]["title"] == "Tag data receiving"
    clock.now = 100
    await ingest_client.post(path(), json=tag_event("E280AB"))
    assert len(events()) == 1
    clock.now = 401
    await ingest_client.post(path(), json=tag_event("E280AC"))
    assert len(events()) == 2


async def test_put_on_the_real_path_is_404(app, ingest_client):
    r = await ingest_client.put(path(), json=tag_event("E280AA"))
    assert r.status_code == 404 and r.content == b""
    assert rows(app) == []


async def test_rejected_serial_never_forges_a_log_line(app, ingest_client, caplog):
    caplog.set_level(logging.DEBUG)
    r = await ingest_client.post(path(serial="evil%0aFAKE%20LINE" + "a" * 500),
                                 json=tag_event("E280AA"))
    assert r.status_code == 404
    ours = [x.getMessage() for x in caplog.records if x.name.startswith("edge")]
    assert ours and all("\n" not in m and len(m) < 200 for m in ours)
