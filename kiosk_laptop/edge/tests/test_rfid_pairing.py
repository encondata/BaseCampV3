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


SECURITY = {"verifyPeer": False, "verifyHost": False, "authenticationType": "NONE"}


def other(name="Warehouse MQTT", url="http://10.0.0.9/x"):
    return {"type": "httpPost", "name": name, "options": {"URL": url, "security": SECURITY}}


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
                    "security": {"verifyPeer": False, "verifyHost": False,
                                 "authenticationType": "NONE"}}}]
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
    r = await pair(client, app)
    assert r.status_code == 409 and code(r) == "reader_not_on_subnet"
    assert reader.login_attempts == []


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
    assert discovery.pairing is pairing  # discovery reads connections through the same helpers
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
    assert r.status_code == 422 and code(r) == "reader_required"
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


# ── fix round 1 ──

async def test_pair_leaves_the_rest_of_the_config_alone(app, client):
    import copy
    reader = use_reader(app)
    before = copy.deepcopy(reader.config)
    assert before["READER-GATEWAY"]["endpointConfig"]["management"]  # non-empty in the fake
    assert (await pair(client, app, laptop_ip="10.0.0.5")).status_code == 200
    after = reader.config
    gw_before, gw_after = before["READER-GATEWAY"], after["READER-GATEWAY"]
    for key in ("management", "control"):
        assert gw_after["endpointConfig"][key] == gw_before["endpointConfig"][key]
    assert gw_after["endpointConfig"]["data"]["batching"] == \
        gw_before["endpointConfig"]["data"]["batching"]
    assert {k: v for k, v in after.items() if k != "READER-GATEWAY"} == \
        {k: v for k, v in before.items() if k != "READER-GATEWAY"}


async def test_reader_message_never_carries_the_token(app, client):
    reader = use_reader(app)
    token = "secret-token-" + "x" * 30
    pairing.remember(app.state.store, serial=SERIAL, ip=READER_IP, model="FX9600",
                     versions={}, password_index=3, token=token)
    reader.fail_next["PUT /cloud/config"] = (
        422, {"code": 1, "message": f"Bad URL http://10.0.0.5:8091/rfid/{SERIAL}/{token}"})
    r = await pair(client, app, laptop_ip="10.0.0.5")
    assert code(r) == "reader_error" and token not in r.text
    assert r.json()["detail"]["message"] == f"Bad URL http://10.0.0.5:8091/rfid/{SERIAL}/…"


async def test_a_renamed_own_connection_is_replaced_not_duplicated(app, client):
    reader = use_reader(app)
    assert (await pair(client, app, laptop_ip="10.0.0.5")).status_code == 200
    reader_connections(reader)[0]["name"] = "Someone renamed it"
    r = await pair(client, app, laptop_ip="10.0.0.5")
    assert r.status_code == 200, r.text
    assert [c["name"] for c in reader_connections(reader)] == [own_name(app)]


async def test_connect_and_pair_treat_a_stale_own_connection_as_foreign(app, client):
    # our name prefix, but no stored token for this reader: another kiosk may hold it
    reader = use_reader(app)
    set_connections(reader, [other(own_name(app), f"http://10.0.0.5:8091/rfid/{SERIAL}/lost")])
    r = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    assert r.json()["paired_with"] == own_name(app)
    assert code(await pair(client, app, laptop_ip="10.0.0.5")) == "reader_paired_elsewhere"


async def test_our_token_under_another_kiosks_name_is_not_ours(app, client):
    # ours needs BOTH our name prefix and our token
    reader = use_reader(app)
    pairing.remember(app.state.store, serial=SERIAL, ip=READER_IP, model="FX9600",
                     versions={}, password_index=3, token="ourtoken")
    set_connections(reader, [other("ServerSherpa Kiosk 9999 (Dock)",
                                   f"http://10.0.0.5:8091/rfid/{SERIAL}/ourtoken")])
    r = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    assert r.json()["paired_with"] == "ServerSherpa Kiosk 9999 (Dock)"


# ── final fix round: either port ──

async def test_a_manual_ip_tries_443_then_80(app, client):
    reader = use_reader(app, ports=(80,))
    r = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    assert r.status_code == 200, r.text
    row = stored(app)
    assert (row["scheme"], row["port"], row["password_index"], row["token"]) == ("http", 80, 3, None)
    schemes = [req.url.scheme for req in app.state.reader_transport.requests]
    assert schemes[0] == "https" and set(schemes[1:]) == {"http"}
    # pair reuses where it answered: no https attempt this time
    app.state.reader_transport.requests.clear()
    assert (await pair(client, app, laptop_ip="10.0.0.5")).status_code == 200
    assert {req.url.scheme for req in app.state.reader_transport.requests} == {"http"}
    assert reader_connections(reader)[0]["name"] == own_name(app)


async def test_pair_on_a_fresh_manual_http_reader(app, client):
    reader = use_reader(app, ports=(80,))
    r = await pair(client, app, laptop_ip="10.0.0.5")
    assert r.status_code == 200, r.text
    assert (stored(app)["scheme"], stored(app)["port"]) == ("http", 80)
    assert len(reader_connections(reader)) == 1


async def test_a_closed_reader_is_unreachable_on_both_ports(app, client):
    use_reader(app, ports=())
    r = await client.post("/edge/rfid/connect", headers=make_session(app), json={"ip": READER_IP})
    assert code(r) == "reader_unreachable"
    schemes = [req.url.scheme for req in app.state.reader_transport.requests]
    assert schemes == ["https", "http"]


# ── final fix round: offline sessions can't connect or pair ──

async def test_offline_sessions_cannot_connect_or_pair(app, client):
    reader = use_reader(app)
    write_host(app)
    offline = make_session(app, offline=True)
    for path in ("/edge/rfid/connect", "/edge/rfid/pair"):
        r = await client.post(path, headers=offline, json={"ip": READER_IP, "laptop_ip": "10.0.0.5"})
        assert r.status_code == 503 and code(r) == "edge_offline", path
    assert reader.login_attempts == [] and reader.puts == []
    # scanning stays open offline
    assert (await client.post("/edge/rfid/scan", headers=offline)).status_code == 200
    assert (await client.get("/edge/rfid/scan", headers=offline)).status_code == 200


# ── final fix round: pairing a new reader releases the old one ──

from tests.fake_reader import RoutingTransport  # noqa: E402

OLD_IP, NEW_IP = "10.0.0.30", "10.0.0.31"


async def pair_at(client, app, ip):
    return await client.post("/edge/rfid/pair", headers=make_session(app),
                              json={"ip": ip, "laptop_ip": "10.0.0.5"})


async def test_pairing_a_new_reader_removes_ours_from_the_old_one(app, client, caplog):
    caplog.set_level(logging.DEBUG)
    old, new = FakeReader(serial="OLD1"), FakeReader(serial="NEW2")
    app.state.reader_transport = RoutingTransport({OLD_IP: old, NEW_IP: new})
    assert (await pair_at(client, app, OLD_IP)).status_code == 200
    old_token = stored(app, "OLD1")["token"]
    # someone else's connection and a twin kiosk's share the old reader
    set_connections(old, [other(), *reader_connections(old)])
    r = await pair_at(client, app, NEW_IP)
    assert r.status_code == 200, r.text
    assert [c["name"] for c in reader_connections(old)] == ["Warehouse MQTT"]
    assert [c["name"] for c in reader_connections(new)] == [own_name(app)]
    assert app.state.store.one("SELECT serial FROM rfid_pairing")["serial"] == "NEW2"
    assert old_token not in caplog.text


async def test_the_old_reader_keeps_connections_that_are_not_ours(app, client):
    old, new = FakeReader(serial="OLD1"), FakeReader(serial="NEW2")
    app.state.reader_transport = RoutingTransport({OLD_IP: old, NEW_IP: new})
    assert (await pair_at(client, app, OLD_IP)).status_code == 200
    # another kiosk took the old reader over since: nothing of ours is left there
    twin = other(own_name(app), "http://10.0.0.7:8091/rfid/OLD1/theirs")
    set_connections(old, [twin])
    puts_before = len(old.puts)
    assert (await pair_at(client, app, NEW_IP)).status_code == 200
    assert reader_connections(old) == [twin]
    assert len(old.puts) == puts_before  # no write when there's nothing to remove


async def test_an_unreachable_old_reader_never_fails_the_new_pairing(app, client, caplog):
    caplog.set_level(logging.DEBUG)
    old, new = FakeReader(serial="OLD1"), FakeReader(serial="NEW2")
    routing = RoutingTransport({OLD_IP: old, NEW_IP: new})
    app.state.reader_transport = routing
    assert (await pair_at(client, app, OLD_IP)).status_code == 200
    old_token = stored(app, "OLD1")["token"]
    old.mode = "unreachable"
    r = await pair_at(client, app, NEW_IP)
    assert r.status_code == 200, r.text
    assert app.state.store.one("SELECT serial FROM rfid_pairing")["serial"] == "NEW2"
    assert "OLD1" in caplog.text and old_token not in caplog.text
    # an old reader that refuses the write is no different
    old.mode = "normal"
    assert (await pair_at(client, app, OLD_IP)).status_code == 200
    old.fail_next["PUT /cloud/config"] = (500, {"code": 1, "message": "busy"})
    assert (await pair_at(client, app, NEW_IP)).status_code == 200
    assert not old.fail_next  # the write was tried, and refused


async def test_re_pairing_the_same_reader_touches_no_other(app, client):
    reader = use_reader(app)
    assert (await pair(client, app, laptop_ip="10.0.0.5")).status_code == 200
    puts = len(reader.puts)
    assert (await pair(client, app, laptop_ip="10.0.0.6")).status_code == 200
    assert len(reader.puts) == puts + 1  # just the new pairing's write
