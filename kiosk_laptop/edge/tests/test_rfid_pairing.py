import json
import logging
from datetime import datetime, timezone

import pytest

from edge.rfid import pairing
from tests.conftest import make_session
from tests.fake_reader import FakeReader

READER_IP = "10.0.0.20"
SERIAL = "84248dee5721"


def write_host(app, ips=("10.0.0.5",), prefix=24):
    (app.state.settings.data_dir / "host-network.json").write_text(json.dumps(
        {"updated_at": datetime.now(timezone.utc).isoformat(),
         "interfaces": [{"name": "en0", "ipv4": i, "prefix": prefix} for i in ips]}))


def use_reader(app, **kw) -> FakeReader:
    reader = FakeReader(**kw)
    app.state.reader_transport = reader.transport()
    return reader


def set_connections(reader, conns):
    reader.config["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"] = conns


def reader_connections(reader):
    return reader.config["READER-GATEWAY"]["endpointConfig"]["data"]["event"]["connections"]


def other(name="Warehouse MQTT", url="http://10.0.0.9/x"):
    return {"type": "httpPost", "name": name, "options": {"URL": url}}


def own_name(app):
    ident = app.state.identity
    return f"ServerSherpa Kiosk {ident.serial[-4:]} ({ident.name})"


def stored(app, serial=SERIAL):
    return app.state.store.one("SELECT * FROM rfid_readers WHERE serial = ?", (serial,))


async def pair(client, app, **body):
    return await client.post("/edge/rfid/pair", headers=make_session(app),
                              json={"ip": READER_IP, **body})


def code(resp):
    return resp.json()["detail"]["code"]


# ── connect ──

async def test_endpoints_need_a_session(client):
    for method, path in (("POST", "/edge/rfid/connect"), ("POST", "/edge/rfid/pair"),
                         ("GET", "/edge/rfid/reader")):
        assert (await client.request(method, path, json={})).status_code == 401


async def test_connect_success_stores_password_index(app, client):
    reader = use_reader(app, password_index=2)
    r = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    assert r.status_code == 200
    body = r.json()
    assert (body["ip"], body["model"], body["serial"]) == (READER_IP, "FX9600", SERIAL)
    assert body["versions"]["readerApplication"] == "2.7.19.0"
    assert body["status"]["radioConnection"] == "connected"
    assert body["paired_with"] is None
    assert "password_index" not in body
    assert stored(app)["password_index"] == 2
    # a later call starts with the stored password
    reader.login_attempts.clear()
    await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    assert reader.login_attempts[0] == 2


@pytest.mark.parametrize("kw, expected", [
    ({"mode": "not_iotc"}, "reader_not_iotc"),
    ({"mode": "unreachable"}, "reader_unreachable"),
    ({"password": "nope"}, "reader_auth_failed"),
    ({"model": "MC3300"}, "reader_not_iotc"),
    ({"serial": ""}, "reader_not_iotc"),
])
async def test_connect_errors(app, client, kw, expected):
    use_reader(app, **kw)
    r = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    assert r.status_code >= 400 and code(r) == expected


async def test_connect_reader_error_carries_message(app, client):
    reader = use_reader(app)
    reader.fail_next["/cloud/status"] = (500, {"code": 1, "message": "radio busy"})
    r = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    assert code(r) == "reader_error" and r.json()["detail"]["message"] == "radio busy"


async def test_connect_rejects_a_bad_ip(app, client):
    use_reader(app)
    r = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": "nope"})
    assert r.status_code == 422 and code(r) == "bad_ip"


async def test_connect_reports_another_kiosk(app, client):
    reader = use_reader(app)
    set_connections(reader, [other("ServerSherpa Kiosk 9999 (Dock)", "http://10.0.0.7:8091/rfid/x/y")])
    r = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    assert r.json()["paired_with"] == "ServerSherpa Kiosk 9999 (Dock)"


# ── pair ──

async def test_pair_adds_our_connection(app, client):
    reader = use_reader(app)
    r = await pair(client, app, laptop_ip="10.0.0.5")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["paired"] is True
    assert body["endpoint_url"] == f"http://10.0.0.5:8091/rfid/{SERIAL}/…"
    assert {k: body["reader"][k] for k in ("ip", "serial", "model")} == {
        "ip": READER_IP, "serial": SERIAL, "model": "FX9600"}
    assert body["reader"]["paired_at"] and body["reader"]["versions"]["radioFirmware"] == "2.1.14.0"
    row = stored(app)
    token = row["token"]
    assert len(token) >= 43 and row["laptop_ip"] == "10.0.0.5" and row["password_index"] == 3
    conns = reader_connections(reader)
    assert conns == [{
        "type": "httpPost", "name": own_name(app),
        "description": f"ServerSherpa kiosk {app.state.identity.serial}",
        "options": {"URL": f"http://10.0.0.5:8091/rfid/{SERIAL}/{token}",
                    "security": {"verifyPeer": False, "verifyHost": False}}}]
    assert list(reader.puts[-1]) == ["READER-GATEWAY"]


async def test_pair_keeps_other_connections(app, client):
    reader = use_reader(app)
    set_connections(reader, [other()])
    assert (await pair(client, app, laptop_ip="10.0.0.5")).status_code == 200
    names = [c["name"] for c in reader_connections(reader)]
    assert names == ["Warehouse MQTT", own_name(app)]


async def test_pair_replaces_our_earlier_connection(app, client):
    reader = use_reader(app)
    set_connections(reader, [other()])
    assert (await pair(client, app, laptop_ip="10.0.0.5")).status_code == 200
    # the laptop moved to another address: our own connection is replaced, no takeover
    r = await pair(client, app, laptop_ip="10.0.0.6")
    assert r.status_code == 200, r.text
    conns = reader_connections(reader)
    assert [c["name"] for c in conns] == ["Warehouse MQTT", own_name(app)]
    assert conns[1]["options"]["URL"].startswith("http://10.0.0.6:8091/")


async def test_pair_refuses_a_third_connection(app, client):
    reader = use_reader(app)
    set_connections(reader, [other("A"), other("B")])
    r = await pair(client, app, laptop_ip="10.0.0.5")
    assert r.status_code == 409 and code(r) == "reader_endpoints_full"
    assert reader.puts == []
    assert app.state.store.one("SELECT * FROM rfid_pairing") is None


async def test_takeover_needs_confirmation(app, client):
    reader = use_reader(app)
    theirs = other("ServerSherpa Kiosk 9999 (Dock)", "http://10.0.0.7:8091/rfid/x/theirtoken")
    set_connections(reader, [theirs])
    r = await pair(client, app, laptop_ip="10.0.0.5")
    assert r.status_code == 409 and code(r) == "reader_paired_elsewhere"
    assert r.json()["detail"]["name"] == "ServerSherpa Kiosk 9999 (Dock)"
    assert reader.puts == []
    r = await pair(client, app, laptop_ip="10.0.0.5", confirm_takeover=True)
    assert r.status_code == 200
    assert [c["name"] for c in reader_connections(reader)] == [own_name(app)]


async def test_same_last4_with_another_token_is_a_takeover(app, client):
    # two kiosks can share the last 4 serial characters: the name alone isn't enough
    reader = use_reader(app)
    twin = other(own_name(app), f"http://10.0.0.7:8091/rfid/{SERIAL}/someoneelse")
    set_connections(reader, [twin])
    r = await pair(client, app, laptop_ip="10.0.0.5")
    assert r.status_code == 409 and code(r) == "reader_paired_elsewhere"


async def test_verify_mismatch(app, client):
    use_reader(app, mode="verify_mismatch")
    r = await pair(client, app, laptop_ip="10.0.0.5")
    assert code(r) == "reader_verify_failed"
    assert app.state.store.one("SELECT * FROM rfid_pairing") is None


async def test_token_is_redacted_in_responses_and_logs(app, client, caplog):
    caplog.set_level(logging.DEBUG)
    reader = use_reader(app)
    r1 = await pair(client, app, laptop_ip="10.0.0.5")
    token = stored(app)["token"]
    r2 = await client.get("/edge/rfid/reader", headers=make_session(app))
    r3 = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    for r in (r1, r2, r3):
        assert r.status_code == 200 and token not in r.text
    assert "…" in r2.json()["endpoint_url"]
    # a verify failure on a second pair must not leak it either
    reader.mode = "verify_mismatch"
    r4 = await pair(client, app, laptop_ip="10.0.0.6")
    assert token not in r4.text
    assert caplog.records and token not in caplog.text
    assert all(token not in str(rec.args) for rec in caplog.records)


async def test_no_laptop_ip_is_host_network_unknown(app, client):
    reader = use_reader(app)
    r = await pair(client, app)
    assert r.status_code == 409 and code(r) == "host_network_unknown"
    assert reader.login_attempts == []
    write_host(app, ips=("192.168.1.5",))  # fresh, but not on the reader's subnet
    assert code(await pair(client, app)) == "host_network_unknown"


async def test_laptop_ip_from_the_host_network(app, client):
    reader = use_reader(app)
    write_host(app, ips=("192.168.1.5", "10.0.0.5"))
    r = await pair(client, app)
    assert r.status_code == 200
    assert reader_connections(reader)[0]["options"]["URL"].startswith("http://10.0.0.5:8091/")


async def test_pair_rejects_a_bad_laptop_ip(app, client):
    use_reader(app)
    r = await pair(client, app, laptop_ip="10.0.0.5:80")
    assert r.status_code == 422 and code(r) == "bad_ip"


async def test_current_reader(app, client):
    use_reader(app)
    h = make_session(app)
    assert (await client.get("/edge/rfid/reader", headers=h)).json() is None
    await pair(client, app, laptop_ip="10.0.0.5")
    body = (await client.get("/edge/rfid/reader", headers=h)).json()
    assert (body["ip"], body["serial"], body["model"]) == (READER_IP, SERIAL, "FX9600")
    assert body["endpoint_url"] == f"http://10.0.0.5:8091/rfid/{SERIAL}/…"


def test_connection_helpers_shared_with_discovery():
    from edge.rfid import discovery
    config = {"READER-GATEWAY": {"endpointConfig": {"data": {"event": {
        "connections": [{"name": "x"}]}}}}}
    assert pairing.get_connections(config) == [{"name": "x"}]
    assert pairing.get_connections({}) == []
    assert pairing.get_connections({"READER-GATEWAY": {"endpointConfig": None}}) == []
    edited = pairing.with_connections({"READER-GATEWAY": {"other": 1}}, [{"name": "y"}])
    assert edited == {"other": 1, "endpointConfig": {"data": {"event": {
        "connections": [{"name": "y"}]}}}}
    assert discovery.PAIR_PREFIX == pairing.PAIR_PREFIX
    assert pairing.redact_url("http://1.2.3.4:8091/rfid/S/tok") == "http://1.2.3.4:8091/rfid/S/…"


# ── /kiosk/setup pass-through ──

SETUP = {"serial": "browser", "initiative_id": "m-1", "site_id": "s", "scan_status": "x"}


async def test_setup_rfid_adds_the_reader(app, client, cloud):
    use_reader(app)
    await pair(client, app, laptop_ip="10.0.0.5")
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    route = cloud.post("/kiosk/setup").respond(400, json={"detail": "stop here"})
    r = await client.post("/kiosk/setup", headers=make_session(app),
                          json={**SETUP, "station_type": "rfid",
                                "reader": {"ip": "6.6.6.6", "serial": "fake"}})
    assert r.status_code == 400
    sent = json.loads(route.calls[0].request.content)
    assert sent["station_type"] == "rfid"
    assert sent["reader"] == {"ip": READER_IP, "serial": SERIAL, "model": "FX9600",
                              "versions": {"readerApplication": "2.7.19.0",
                                           "radioFirmware": "2.1.14.0",
                                           "cloudAgentApplication": "1.0.0"}}
    assert sent["serial"] == app.state.identity.serial


async def test_setup_rfid_without_a_pairing(app, client, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    route = cloud.post("/kiosk/setup").respond(200, json={"initiative_id": "m-1"})
    r = await client.post("/kiosk/setup", headers=make_session(app),
                          json={**SETUP, "station_type": "rfid"})
    assert r.status_code == 409 and code(r) == "reader_required"
    assert not route.called


async def test_setup_label_forwards_station_type_only(app, client, cloud):
    use_reader(app)
    await pair(client, app, laptop_ip="10.0.0.5")
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    route = cloud.post("/kiosk/setup").respond(400, json={"detail": "stop here"})
    await client.post("/kiosk/setup", headers=make_session(app),
                      json={**SETUP, "station_type": "label", "reader": {"ip": "6.6.6.6"}})
    sent = json.loads(route.calls[0].request.content)
    assert sent["station_type"] == "label" and "reader" not in sent
