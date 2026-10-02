import asyncio

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


async def test_status_while_the_lock_is_held_answers_busy(app, client):
    await paired(app, client)
    transport = app.state.reader_transport
    seen = len(transport.requests)
    async with app.state.pair_lock:
        r = await asyncio.wait_for(client.get("/edge/rfid/status", headers=make_session(app)), 2)
    body = r.json()
    assert r.status_code == 200
    assert body["busy"] is True and body["reachable"] is False
    assert (body["reading"], body["radio"], body["antennas"]) == (False, None, [])
    assert body["reader"]["ip"] == READER_IP and stored(app)["token"] not in r.text
    assert len(transport.requests) == seen
    free = (await client.get("/edge/rfid/status", headers=make_session(app))).json()
    assert free["reachable"] is True and "busy" not in free


async def test_start_and_stop_redact_the_token_in_reader_errors(app, client):
    reader = await paired(app, client)
    h = make_session(app)
    token = stored(app)["token"]
    leak = f"bad endpoint http://10.0.0.5:8091/rfid/SER/{token}"
    for method, path in (("PUT /cloud/start", "/edge/rfid/start"),
                         ("PUT /cloud/stop", "/edge/rfid/stop")):
        reader.fail_next[method] = (500, {"code": 1, "message": leak})
        r = await client.post(path, headers=h)
        assert r.status_code >= 400, path
        assert token not in r.text, path


async def test_start_and_checks_wait_for_the_pair_lock(app, client):
    await paired(app, client)
    transport = app.state.reader_transport
    h = make_session(app)
    seen = len(transport.requests)
    async with app.state.pair_lock:
        tasks = [asyncio.create_task(client.get("/edge/rfid/checks/reader", headers=h)),
                 asyncio.create_task(client.post("/edge/rfid/start", headers=h))]
        await asyncio.sleep(0.1)
        assert len(transport.requests) == seen
        assert not any(t.done() for t in tasks)
    results = await asyncio.wait_for(asyncio.gather(*tasks), 5)
    assert [r.status_code for r in results] == [200, 200]
    assert len(transport.requests) > seen
