from tests.conftest import make_session
from tests.test_rfid_pairing import READER_IP, code, pair, stored, use_reader, write_host

PATHS = (("POST", "/edge/rfid/start"), ("POST", "/edge/rfid/stop"), ("GET", "/edge/rfid/status"))


async def paired(app, client):
    write_host(app)
    reader = use_reader(app)
    assert (await pair(client, app)).status_code == 200
    return reader


async def test_need_a_session(client):
    for method, path in PATHS:
        assert (await client.request(method, path)).status_code == 401, path


async def test_no_pairing(app, client):
    use_reader(app)
    h = make_session(app)
    for path in ("/edge/rfid/start", "/edge/rfid/stop"):
        r = await client.post(path, headers=h)
        assert r.status_code == 409 and code(r) == "reader_required", path
    r = await client.get("/edge/rfid/status", headers=h)
    assert r.status_code == 200 and r.json() == {"reader": None}


async def test_start_status_stop(app, client):
    reader = await paired(app, client)
    h = make_session(app)
    token = stored(app)["token"]
    r = await client.post("/edge/rfid/start", headers=h)
    assert r.status_code == 200 and r.json() == {"reading": True}
    assert reader.starts == [{"doNotPersistState": False}]
    assert token not in r.text
    r = await client.get("/edge/rfid/status", headers=h)
    body = r.json()
    assert (body["reachable"], body["reading"], body["radio"]) == (True, True, "connected")
    assert body["reader"]["ip"] == READER_IP and token not in r.text
    before = reader.stops
    r = await client.post("/edge/rfid/stop", headers=h)
    assert r.status_code == 200 and r.json() == {"reading": False}
    assert reader.stops == before + 1 and token not in r.text
    r = await client.get("/edge/rfid/status", headers=h)
    assert r.json()["reading"] is False


async def test_offline_session(app, client):
    reader = await paired(app, client)
    offline = make_session(app, offline=True)
    r = await client.post("/edge/rfid/start", headers=offline)
    assert r.status_code == 503 and code(r) == "edge_offline"
    assert reader.starts == []
    r = await client.post("/edge/rfid/stop", headers=offline)
    assert r.status_code == 200 and r.json() == {"reading": False}


async def test_status_when_unreachable(app, client):
    reader = await paired(app, client)
    reader.mode = "unreachable"
    r = await client.get("/edge/rfid/status", headers=make_session(app))
    body = r.json()
    assert r.status_code == 200
    assert (body["reachable"], body["reading"], body["radio"]) == (False, False, None)
    assert body["reader"]["ip"] == READER_IP and stored(app)["token"] not in r.text
