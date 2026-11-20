"""The saved environment (environment.json), the has-been-registered flag
(registered.json) and re-pointing the edge's cloud client while it runs."""

import json
from dataclasses import replace

import httpx

from edge import laptop_setup, outbox
from edge.app import create_app
from edge.environment_store import (Current, ever_registered, load_current, mark_registered,
                                    save_current)
from edge.environments import Env
from edge.rfid import reader_report, station_key
from edge.sync import sync_paths
from tests.conftest import make_session
from tests.test_laptop_setup import paired, ready, setup
from tests.test_rfid_checks import beat, run, sign_in

NEW = "https://api.rc1.serversherpa.com"


# ── resolving the current environment ──

def test_installer_url_maps_to_named(settings):
    s = replace(settings, cloud_api_url="https://api.uat.serversherpa.com", portal_url="")
    cur = load_current(s.data_dir, s)
    assert cur == Current(kind="named", id="uat", name="UAT", domain="uat.serversherpa.com",
                          api_url="https://api.uat.serversherpa.com",
                          portal_url="https://portal.uat.serversherpa.com")
    assert not cur.is_prod
    prod = load_current(s.data_dir, replace(s, cloud_api_url="https://api.serversherpa.com"))
    assert prod.id == "prod" and prod.is_prod
    assert not (s.data_dir / "environment.json").exists()  # nothing migrated


def test_installer_url_unknown_is_custom(settings):
    s = replace(settings, cloud_api_url="http://host.docker.internal:8001")
    cur = load_current(s.data_dir, s)
    assert cur == Current(kind="custom", id=None, name="Custom", domain=None,
                          api_url="http://host.docker.internal:8001",
                          portal_url="http://portal.test")
    assert not cur.is_prod


def test_saved_wins_over_env_and_survives_list_change(settings):
    settings.data_dir.mkdir(parents=True)
    save_current(settings.data_dir, Current.named(Env("rc1", "RC1", "rc1.serversherpa.com")))
    assert json.loads((settings.data_dir / "environment.json").read_text()) == {
        "kind": "named", "id": "rc1", "name": "RC1", "domain": "rc1.serversherpa.com"}
    # the list cache now maps rc1 elsewhere: the saved domain still wins
    (settings.data_dir / "environments-cache.json").write_text(json.dumps(
        {"version": 1, "environments": [{"id": "rc1", "name": "RC1",
                                         "domain": "rc1-new.serversherpa.com"}]}))
    cur = load_current(settings.data_dir, settings)
    assert (cur.kind, cur.id, cur.domain, cur.api_url) == (
        "named", "rc1", "rc1.serversherpa.com", NEW)
    assert cur.portal_url == "https://portal.rc1.serversherpa.com"


def test_saved_custom_round_trips(settings):
    settings.data_dir.mkdir(parents=True)
    custom = Current(kind="custom", id=None, name="Custom", domain=None,
                     api_url="http://10.10.48.103:8000", portal_url="http://10.10.48.103:5173")
    save_current(settings.data_dir, custom)
    assert json.loads((settings.data_dir / "environment.json").read_text()) == {
        "kind": "custom", "api_url": "http://10.10.48.103:8000",
        "portal_url": "http://10.10.48.103:5173"}
    assert load_current(settings.data_dir, settings) == custom


def test_corrupt_environment_json_falls_back_to_settings(settings):
    settings.data_dir.mkdir(parents=True)
    path = settings.data_dir / "environment.json"
    for raw in ("not json", "[1]", '{"kind": "named", "id": "rc1"}',
                '{"kind": "named", "id": "rc1", "name": "RC1", "domain": "evil.example.com"}',
                '{"kind": "custom", "api_url": "ftp://x", "portal_url": ""}',
                '{"kind": "other"}'):
        path.write_text(raw)
        cur = load_current(settings.data_dir, settings)
        assert (cur.kind, cur.api_url, cur.portal_url) == (
            "custom", "http://cloud.test", "http://portal.test"), raw


# ── the has-been-registered flag ──

def test_registered_flag(settings):
    settings.data_dir.mkdir(parents=True)
    assert not ever_registered(settings.data_dir)
    mark_registered(settings.data_dir)
    first = json.loads((settings.data_dir / "registered.json").read_text())
    assert first["registered_at"]
    assert ever_registered(settings.data_dir)
    mark_registered(settings.data_dir)  # the first time is kept
    assert json.loads((settings.data_dir / "registered.json").read_text()) == first


async def test_heartbeat_reply_marks_registered(app, client, cloud):
    data_dir = app.state.settings.data_dir
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    beat = cloud.post("/kiosk/heartbeat")
    beat.respond(200, json={"registration": "none"})
    r = await client.post("/kiosk/heartbeat", headers=make_session(app), json={"serial": "x"})
    assert r.status_code == 200 and not ever_registered(data_dir)
    beat.respond(200, json={"registration": None})
    await client.post("/kiosk/heartbeat", headers=make_session(app), json={"serial": "x"})
    assert not ever_registered(data_dir)
    beat.respond(200, json={"registration": "ok"})
    await client.post("/kiosk/heartbeat", headers=make_session(app), json={"serial": "x"})
    assert ever_registered(data_dir)


async def test_registration_check_marks_registered(app, client, cloud):
    route = cloud.post("/kiosk/heartbeat").respond(200, json=beat("none"))
    h = await sign_in(app)
    await run(client, app, "registration", headers=h)
    assert not ever_registered(app.state.settings.data_dir)
    route.respond(200, json=beat("expired"))  # registered once, lapsed since: still registered
    await run(client, app, "registration", headers=h)
    assert ever_registered(app.state.settings.data_dir)


async def test_station_heartbeat_reply_marks_registered(app, cloud):
    laptop_setup.save(app.state.store, {"initiative_id": "i-1"}, "rfid")
    station_key.store_key(app.state.store, app.state.keys, "the-station-key")
    cloud.post("/kiosk/station/heartbeat").respond(200, json={"registration": "soon"})
    await reader_report.send_station_heartbeat(app.state, None)
    assert ever_registered(app.state.settings.data_dir)


async def test_station_key_issue_marks_registered(app, client, cloud):
    await paired(app, client)
    ready(app, cloud)
    cloud.post("/kiosk/station-key").respond(200, json={"key": "stationkey-secret"})
    assert not ever_registered(app.state.settings.data_dir)
    assert (await setup(client, app, station_type="rfid")).status_code == 200
    assert station_key.has_key(app.state.store)
    assert ever_registered(app.state.settings.data_dir)


async def test_wipe_keeps_registered_flag(app, client):
    mark_registered(app.state.settings.data_dir)
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.json() == {"cleared_move_data": True}
    assert ever_registered(app.state.settings.data_dir)


# ── GET /edge/environment and /config.js ──

async def test_environment_route_is_anonymous(app, client):
    r = await client.get("/edge/environment")
    assert r.status_code == 200
    assert r.json() == {"kind": "custom", "id": None, "name": "Custom", "domain": None,
                        "api_url": "http://cloud.test", "portal_url": "http://portal.test",
                        "is_prod": False, "ever_registered": False}
    app.state.environment = Current.named(Env("prod", "Prod", "serversherpa.com"))
    mark_registered(app.state.settings.data_dir)
    r = await client.get("/edge/environment")
    assert r.json() == {"kind": "named", "id": "prod", "name": "Prod",
                        "domain": "serversherpa.com", "api_url": "https://api.serversherpa.com",
                        "portal_url": "https://portal.serversherpa.com", "is_prod": True,
                        "ever_registered": True}


async def test_config_js_serves_current_portal(app, client):
    r = await client.get("/config.js")
    assert 'portalUrl: "http://portal.test"' in r.text
    app.state.environment = Current.named(Env("uat", "UAT", "uat.serversherpa.com"))
    r = await client.get("/config.js")
    assert 'portalUrl: "https://portal.uat.serversherpa.com"' in r.text
    assert r.headers["cache-control"] == "no-store"


# ── startup and re-pointing ──

async def test_startup_connects_to_the_saved_environment(settings, cloud):
    settings.data_dir.mkdir(parents=True)
    save_current(settings.data_dir, Current.named(Env("rc1", "RC1", "rc1.serversherpa.com")))
    app = create_app(settings)
    assert app.state.settings.cloud_api_url == "http://cloud.test"  # the installer's value
    assert app.state.environment.id == "rc1"
    route = cloud.get(f"{NEW}/system/status").respond(200, json={})
    old = cloud.get("/system/status").respond(200, json={})
    assert await app.state.upstream.probe()
    assert route.called and not old.called
    await app.state.upstream.aclose()
    await app.state.env_list.aclose()
    app.state.store.close()


async def test_repoint_moves_calls_to_new_base(app, cloud):
    up = app.state.upstream
    assert app.state.outbox.upstream is up and app.state.syncer.upstream is up
    old_status = cloud.get("/system/status").respond(200, json={})
    assert await up.probe() and up.online and up.last_contact
    old_status.reset()
    old_client = up.client
    locks = up._locks

    await up.repoint(NEW)
    assert old_client.is_closed and up.client is not old_client
    assert up._locks is locks
    assert up.online is False and up.last_contact is None
    assert str(up.client.base_url) == NEW
    assert up.client.timeout == old_client.timeout

    new_status = cloud.get(f"{NEW}/system/status").respond(
        200, json={}, headers={"set-cookie": "leak=1; Path=/"})
    assert await up.probe()
    assert new_status.called and not old_status.called
    assert len(up.client.cookies.jar) == 0  # the new client keeps no cookies either

    # the outbox worker sends to the new server
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(app.state.store, "p-1", "Jane Doe", [{
        "client_scan_id": "00000000-0000-4000-8000-000000000001", "scanned_value": "A1",
        "scan_type": "barcode", "scanned_at": "2026-10-01T12:00:00Z"}])
    old_scans = cloud.post("/kiosk/scans").respond(200, json={})
    new_scans = cloud.post(f"{NEW}/kiosk/scans").mock(side_effect=lambda req: httpx.Response(
        200, json={"accepted": [s["client_scan_id"] for s in json.loads(req.content)["scans"]],
                   "rejected": []}))
    assert await app.state.outbox.drain_once() == 1
    assert new_scans.called and not old_scans.called

    # and so does the syncer
    app.state.syncer.set_target("m-1", "p-1")
    news = [cloud.get(f"{NEW}{p}").respond(200, json={}) for p in sync_paths("m-1")]
    news.append(cloud.get(scheme="https", host="api.rc1.serversherpa.com",
                          path="/kiosk/edge/move-passwords")
                .respond(200, json={"moves": [], "unchanged": True}))
    olds = [cloud.get(p).respond(200, json={}) for p in sync_paths("m-1")]
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    assert all(r.called for r in news) and not any(r.called for r in olds)
