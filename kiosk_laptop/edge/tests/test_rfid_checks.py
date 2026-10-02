import json
from datetime import datetime, timezone

import httpx

from edge import laptop_setup
from edge.rfid import pairing
from tests.conftest import make_session
from tests.test_rfid_pairing import (READER_IP, SERIAL, pair, reader_connections, stored,
                                     use_reader, write_host)

URL = "/edge/rfid/checks/"


async def paired(app, client):
    write_host(app)
    reader = use_reader(app)
    assert (await pair(client, app)).status_code == 200
    return reader


async def run(client, app, name, **kw):
    r = await client.get(URL + name, headers=kw.pop("headers", None) or make_session(app))
    assert r.status_code == 200, r.text
    return r.json()


def write_gateway(app, gateway="10.0.0.1", ips=("10.0.0.5", "192.168.9.9")):
    (app.state.settings.data_dir / "host-network.json").write_text(json.dumps(
        {"updated_at": datetime.now(timezone.utc).isoformat(), "gateway": gateway,
         "interfaces": [{"name": "en0", "ipv4": i, "prefix": 24} for i in ips]}))


def fake_knock(app, open_ports=()):
    calls = []

    async def knock(ip, port):
        calls.append((ip, port))
        return port in open_ports
    app.state.gateway_knock = knock
    return calls


async def test_unknown_and_unauthenticated(app, client):
    r = await client.get(URL + "bogus", headers=make_session(app))
    assert r.status_code == 404 and r.json()["detail"]["code"] == "unknown_check"
    assert (await client.get(URL + "reader")).status_code == 401


# ── reader ──

async def test_reader_no_pairing(app, client):
    body = await run(client, app, "reader")
    assert (body["ok"], body["state"], body["detail"]) == (False, "fail", "Pair a reader first")


async def test_reader_ok(app, client):
    await paired(app, client)
    body = await run(client, app, "reader")
    assert body["ok"] is True and body["state"] == "ok"
    assert "radio connected" in body["detail"] and SERIAL in body["detail"]
    info = body["info"]
    assert info["endpoint_ip"] == "10.0.0.5" and info["reader_ip"] == READER_IP
    assert info["endpoint_url"].endswith("/…") and info["reading"] is False
    assert stored(app)["token"] not in json.dumps(body)


async def test_reader_ours_removed(app, client):
    reader = await paired(app, client)
    reader_connections(reader).clear()
    body = await run(client, app, "reader")
    assert body["state"] == "fail" and "pair it again" in body["detail"]


async def test_reader_radio_disconnected(app, client):
    reader = await paired(app, client)
    reader.status["radioConnection"] = "disconnected"
    body = await run(client, app, "reader")
    assert body["state"] == "fail" and body["detail"] == "Reader radio is disconnected"


async def test_reader_unreachable(app, client):
    reader = await paired(app, client)
    token = stored(app)["token"]
    reader.mode = "unreachable"
    body = await run(client, app, "reader")
    assert body["state"] == "fail" and token not in json.dumps(body)


async def test_reader_reading_after_start(app, client):
    reader = await paired(app, client)
    reader.reading = True
    assert (await run(client, app, "reader"))["info"]["reading"] is True


# ── router ──

async def test_router_no_file(app, client):
    body = await run(client, app, "router")
    assert body["state"] == "unknown" and not body["ok"]
    assert "Re-run the install command" in body["detail"]


async def test_router_answers(app, client):
    write_gateway(app)
    calls = fake_knock(app, open_ports=(443,))
    body = await run(client, app, "router")
    assert body["state"] == "ok" and body["detail"] == "Router 10.0.0.1 answered"
    assert sorted(calls) == [("10.0.0.1", 53), ("10.0.0.1", 80), ("10.0.0.1", 443)]
    assert body["info"]["gateway"] == "10.0.0.1"


async def test_router_silent(app, client):
    write_gateway(app)
    fake_knock(app)
    body = await run(client, app, "router")
    assert body["state"] == "fail" and body["detail"] == "Router 10.0.0.1 didn't answer"


async def test_router_lan_ip_is_on_the_readers_subnet(app, client):
    write_gateway(app, ips=("192.168.9.9", "10.0.0.5"))
    use_reader(app)
    assert (await pair(client, app)).status_code == 200
    write_gateway(app, ips=("192.168.9.9", "10.0.0.5"))
    fake_knock(app, open_ports=(80,))
    assert (await run(client, app, "router"))["info"]["lan_ip"] == "10.0.0.5"


# ── portal ──

async def test_portal_ok(app, client, cloud):
    cloud.get("/system/status").respond(200, json={})
    body = await run(client, app, "portal")
    assert body["state"] == "ok" and body["detail"] == "Portal responded"


async def test_portal_unreachable(app, client, cloud):
    cloud.get("/system/status").mock(side_effect=httpx.ConnectError("down"))
    body = await run(client, app, "portal")
    assert body["state"] == "fail" and body["detail"] == "Can't reach the portal"


async def test_portal_offline_session(app, client):
    body = await run(client, app, "portal", headers=make_session(app, offline=True))
    assert body["state"] == "fail" and body["detail"] == "Can't reach the portal"


# ── registration ──

def beat(registration="ok"):
    return {"device_id": "d-1", "name": "Kiosk 28A8", "registration": registration,
            "token_expires_at": None, "client_ip": "203.0.113.7"}


async def sign_in(app):
    h = make_session(app)
    app.state.upstream.save_session("p-1", refresh_token="r", access_token="a", expires_in=900)
    return h


async def test_registration_ok(app, client, cloud):
    h = await sign_in(app)
    route = cloud.post("/kiosk/heartbeat").respond(200, json=beat())
    body = await run(client, app, "registration", headers=h)
    assert body["state"] == "ok" and body["detail"] == "Registered as Kiosk 28A8"
    assert body["info"] == {"wan_ip": "203.0.113.7", "registration": "ok",
                            "device_name": "Kiosk 28A8"}
    sent = json.loads(route.calls.last.request.content)
    assert sent["mode"] == "laptop" and sent["serial"] == app.state.identity.serial
    assert "version" not in sent


async def test_registration_expired(app, client, cloud):
    h = await sign_in(app)
    cloud.post("/kiosk/heartbeat").respond(200, json=beat("expired"))
    body = await run(client, app, "registration", headers=h)
    assert body["state"] == "fail" and "expired" in body["detail"]


async def test_registration_none_and_errors(app, client, cloud):
    h = await sign_in(app)
    cloud.post("/kiosk/heartbeat").respond(200, json=beat("none"))
    assert "isn't registered yet" in (await run(client, app, "registration", headers=h))["detail"]


async def test_registration_portal_error(app, client, cloud):
    h = await sign_in(app)
    cloud.post("/kiosk/heartbeat").respond(422, json={})
    assert (await run(client, app, "registration", headers=h))["detail"] == "Portal answered 422"


async def test_registration_no_cloud_session(app, client):
    body = await run(client, app, "registration")
    assert body["state"] == "fail" and body["detail"] == "Sign in again"


# ── setup ──

def portal_setup(**over):
    out = {"device_id": "d-1", "initiative_id": "i-1", "initiative_name": "Move A",
           "site_id": "s-1", "site_name": "HQ", "scan_status": "st-1",
           "scan_status_label": "RFID check-in", "station_type": "rfid",
           "reader": {"ip": READER_IP, "serial": SERIAL, "model": "FX9600"}}
    out.update(over)
    return out


async def seed_setup(app):
    laptop_setup.save(app.state.store, {"initiative_id": "i-1", "initiative_name": "Move A",
                                        "site_id": "s-1", "site_name": "HQ", "site_role": "x",
                                        "scan_status": "st-1",
                                        "scan_status_label": "RFID check-in"}, "rfid")


async def test_setup_matches(app, client, cloud):
    await paired(app, client)
    await seed_setup(app)
    h = await sign_in(app)
    cloud.get("/kiosk/setup").respond(200, json=portal_setup())
    body = await run(client, app, "setup", headers=h)
    assert body["state"] == "ok" and body["detail"] == "Portal has this kiosk's setup"
    assert body["info"] == {"initiative_name": "Move A", "site_name": "HQ",
                            "scan_status_label": "RFID check-in", "reader_serial": SERIAL}


async def test_setup_scan_type_differs(app, client, cloud):
    await paired(app, client)
    await seed_setup(app)
    h = await sign_in(app)
    cloud.get("/kiosk/setup").respond(200, json=portal_setup(scan_status="st-2"))
    body = await run(client, app, "setup", headers=h)
    assert body["state"] == "fail"
    assert body["detail"] == "Scan type on the portal doesn't match this laptop"


async def test_setup_reader_differs(app, client, cloud):
    await paired(app, client)
    await seed_setup(app)
    h = await sign_in(app)
    cloud.get("/kiosk/setup").respond(200, json=portal_setup(reader=None))
    body = await run(client, app, "setup", headers=h)
    assert body["detail"] == "Reader on the portal doesn't match this laptop"


async def test_setup_404(app, client, cloud):
    await paired(app, client)
    await seed_setup(app)
    h = await sign_in(app)
    cloud.get("/kiosk/setup").respond(404, json={"detail": {"code": "device_not_found"}})
    body = await run(client, app, "setup", headers=h)
    assert body["state"] == "fail" and body["detail"] == "The portal has no setup for this kiosk"


async def test_setup_none_saved(app, client):
    body = await run(client, app, "setup")
    assert body["state"] == "fail" and body["detail"] == "Finish Kiosk Setup first"


async def test_setup_offline(app, client):
    body = await run(client, app, "setup", headers=make_session(app, offline=True))
    assert body["detail"] == "Can't reach the portal"
