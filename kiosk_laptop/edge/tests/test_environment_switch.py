"""Switching the laptop to another server: the environment password, the
live access gates, the unsent-work check, and what a switch clears, keeps
and re-points (edge/environment_switch.py)."""

import asyncio
import json

import httpx
import pytest

from edge import outbox
from edge.environment_store import ever_registered, mark_registered
from edge.environments import STATUS_LIST_URL
from edge.rfid import station_key
from edge.sync import sync_paths
from edge.upstream import ServerChanged
from tests.conftest import make_session

UAT = "https://api.uat.serversherpa.com"
UAT_BODY = {"kind": "named", "id": "uat", "name": "UAT", "domain": "uat.serversherpa.com",
            "api_url": UAT, "portal_url": "https://portal.uat.serversherpa.com",
            "is_prod": False}
CUSTOM = {"api_url": "http://10.10.48.103:8000/", "portal_url": " http://10.10.48.103:5173 "}


@pytest.fixture(autouse=True)
def old_server(cloud):
    """No status site in tests (the chooser's list is the built-in one), and
    the old server takes the caller's sign-out."""
    cloud.get(STATUS_LIST_URL).mock(side_effect=httpx.ConnectTimeout("slow"))
    cloud.post("/auth/logout").respond(204)


async def switch(client, headers=None, password="cumulus", **body):
    body.setdefault("target", {"id": "uat"})
    return await client.post("/edge/environment", json={"password": password, **body},
                             headers=headers or {})


def code(r) -> str:
    return r.json()["detail"]["code"]


def signed_in(app, **kw) -> dict:
    """A person signed in here online, with a cloud session the edge can use."""
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1",
                                    expires_in=900)
    return make_session(app, **kw)


def me(cloud, max_rank: int, is_global: bool = False):
    return cloud.get("/auth/me").respond(200, json={
        "roles": ["x"], "max_rank": max_rank,
        "scope": {"global": is_global, "client_ids": [], "partner_ids": []}})


def count(app, table: str) -> int:
    return app.state.store.one(f"SELECT COUNT(*) AS n FROM {table}")["n"]


def saved(app) -> dict:
    return json.loads((app.state.settings.data_dir / "environment.json").read_text())


async def test_unlock_wrong_and_right(client):
    r = await client.post("/edge/environment/unlock", json={"password": "nope"})
    assert r.status_code == 403 and code(r) == "wrong_password"
    r = await client.post("/edge/environment/unlock", json={})
    assert r.status_code == 403 and code(r) == "wrong_password"
    r = await client.post("/edge/environment/unlock", content=b"[1]",
                          headers={"content-type": "application/json"})
    assert r.status_code == 422 and code(r) == "bad_request"
    r = await client.post("/edge/environment/unlock", json={"password": "cumulus"})
    assert r.status_code == 204 and r.content == b""


async def test_switch_wrong_password_comes_first(app, client):
    r = await switch(client, password="Cumulus", target={"id": "nope"})
    assert r.status_code == 403 and code(r) == "wrong_password"
    r = await switch(client, password=None)
    assert r.status_code == 403 and code(r) == "wrong_password"
    assert not (app.state.settings.data_dir / "environment.json").exists()


async def test_named_switch_no_pending_needs_only_password(app, client, cloud):
    store, data_dir = app.state.store, app.state.settings.data_dir
    mark_registered(data_dir)  # a named switch never needs a sign-in
    identity = (data_dir / "identity.json").read_text()
    registered = (data_dir / "registered.json").read_text()
    store.run("INSERT INTO cache VALUES ('/kiosk/sync/people', 200, '{}', 'now')")
    store.run("INSERT INTO laptop_setup (id, setup_json, updated_at) VALUES (1, '{}', 'now')")
    store.run("INSERT INTO device_config (id, doc, version) VALUES (1, '{}', 4)")
    store.run("INSERT INTO alarm_settings (id, mode, timed_seconds) VALUES (1, 'timed', 30)")
    station_key.store_key(store, app.state.keys, "old-station-key")
    store.run("INSERT INTO station_status (id, paused) VALUES (1, 'kiosk_not_registered') "
              "ON CONFLICT (id) DO UPDATE SET paused = excluded.paused")
    store.run("INSERT INTO rfid_readers (serial, ip, token) VALUES ('R1', '10.0.0.9', 't')")
    store.run("INSERT INTO rfid_pairing (id, serial) VALUES (1, 'R1')")
    store.run("UPDATE sync_meta SET initiative_id = 'm-1', actor_person_id = 'p-1' WHERE id = 1")
    outbox.enqueue_scans(store, "p-1", "Jane", [{"client_scan_id": "s0"}])
    store.run("UPDATE outbox SET status = 'sent'")  # sent already: not unsent work

    r = await switch(client)
    assert r.status_code == 200, r.text
    assert r.json() == {**UAT_BODY, "ever_registered": True}
    assert saved(app) == {"kind": "named", "id": "uat", "name": "UAT",
                          "domain": "uat.serversherpa.com"}
    assert app.state.environment.id == "uat"

    for table in ("cache", "outbox", "laptop_setup", "device_config", "alarm_settings",
                  "station_key", "cloud_sessions", "edge_sessions"):
        assert count(app, table) == 0, table
    assert not station_key.is_paused(store)
    assert app.state.syncer.meta()["initiative_id"] is None
    # the LAN reader's hardware pairing stays
    assert count(app, "rfid_readers") == 1 and count(app, "rfid_pairing") == 1
    cookies = r.headers.get_list("set-cookie")
    assert any(c.startswith('ss_refresh=""') and "Path=/auth" in c for c in cookies)
    assert (data_dir / "identity.json").read_text() == identity
    assert (data_dir / "registered.json").read_text() == registered

    new = cloud.get(f"{UAT}/system/status").respond(200, json={})
    old = cloud.get("/system/status").respond(200, json={})
    assert await app.state.upstream.probe()
    assert new.called and not old.called
    r = await client.get("/edge/environment")
    assert r.json() == {**UAT_BODY, "ever_registered": True}


async def test_switch_signs_the_caller_out_best_effort(app, client, cloud):
    headers = signed_in(app)
    logout = cloud.post("/auth/logout").respond(204)
    r = await switch(client, headers)
    assert r.status_code == 200
    assert logout.called
    assert logout.calls.last.request.headers["cookie"] == "ss_refresh=r1"

    # a dead old server never blocks a switch with nothing unsent (Review Focus 2)
    headers = signed_in(app)
    logout.mock(side_effect=httpx.ConnectError("down"))
    r = await switch(client, headers, target={"id": "prod"})
    assert r.status_code == 200 and r.json()["id"] == "prod"
    assert count(app, "cloud_sessions") == 0


async def test_pending_returns_409_with_count(app, client):
    outbox.enqueue_scans(app.state.store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    r = await switch(client)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "outbox_not_empty", "pending": 1}
    assert count(app, "outbox") == 1
    assert not (app.state.settings.data_dir / "environment.json").exists()


async def test_pending_counts_rfid_uploads_and_dock_passes(app, client):
    store = app.state.store
    store.run("INSERT INTO pending_rfid_scans (client_scan_id, epc, matched_kind, matched_id, "
              "scanned_at, created_at) VALUES ('c1', 'E1', 'asset', 'a1', 'now', 'now')")
    store.run("INSERT INTO dock_passes (pass_id, initiative_id, opened_at, last_new_at, "
              "last_new_received_at, last_received_at, send_state, created_at) "
              "VALUES ('d1', 'm-1', 'now', 'now', 'now', 'now', 'pending', 'now')")
    r = await switch(client)
    assert r.status_code == 409 and r.json()["detail"]["pending"] == 2


async def test_discard_needs_live_admin(app, client, cloud):
    outbox.enqueue_scans(app.state.store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    r = await switch(client, discard=True)
    assert r.status_code == 403 and code(r) == "discard_needs_admin"

    # an offline sign-in never counts, whatever its rank
    r = await switch(client, make_session(app, offline=True, max_rank=60), discard=True)
    assert r.status_code == 403 and code(r) == "discard_needs_admin"

    # the rank comes from the server, not the edge session
    headers = signed_in(app, max_rank=60)
    route = me(cloud, 50)
    r = await switch(client, headers, discard=True)
    assert r.status_code == 403 and code(r) == "discard_needs_admin"
    assert route.calls.last.request.headers["authorization"] == "Bearer a1"
    assert count(app, "outbox") == 1

    headers = signed_in(app)
    me(cloud, 60)
    r = await switch(client, headers, discard=True)
    assert r.status_code == 200, r.text
    assert count(app, "outbox") == 0


async def test_discard_with_nothing_pending_needs_no_sign_in(client):
    r = await switch(client, discard=True)
    assert r.status_code == 200


async def test_custom_fresh_kiosk_password_only(app, client, cloud):
    assert not ever_registered(app.state.settings.data_dir)
    r = await switch(client, target={"custom": CUSTOM})
    assert r.status_code == 200, r.text
    assert r.json() == {"kind": "custom", "id": None, "name": "Custom", "domain": None,
                        "api_url": "http://10.10.48.103:8000",
                        "portal_url": "http://10.10.48.103:5173", "is_prod": False,
                        "ever_registered": False}
    assert saved(app) == {"kind": "custom", "api_url": "http://10.10.48.103:8000",
                          "portal_url": "http://10.10.48.103:5173"}
    new = cloud.get("http://10.10.48.103:8000/system/status").respond(200, json={})
    assert await app.state.upstream.probe() and new.called


async def test_custom_registered_needs_global_80(app, client, cloud):
    mark_registered(app.state.settings.data_dir)
    target = {"custom": CUSTOM}
    r = await switch(client, target=target)
    assert r.status_code == 403 and code(r) == "custom_needs_super_admin"

    headers = signed_in(app, max_rank=100)
    route = me(cloud, 100, is_global=False)
    r = await switch(client, headers, target=target)
    assert r.status_code == 403 and code(r) == "custom_needs_super_admin"
    route.respond(200, json={"max_rank": 60, "scope": {"global": True}})
    r = await switch(client, headers, target=target)
    assert r.status_code == 403 and code(r) == "custom_needs_super_admin"
    route.respond(401, json={"detail": {"code": "not_authenticated"}})
    cloud.post("/auth/refresh").respond(401, json={"detail": {"code": "session_expired"}})
    r = await switch(client, headers, target=target)
    assert r.status_code == 403 and code(r) == "custom_needs_super_admin"
    assert not (app.state.settings.data_dir / "environment.json").exists()

    headers = signed_in(app)
    route.respond(200, json={"max_rank": 80, "scope": {"global": True}})
    r = await switch(client, headers, target=target)
    assert r.status_code == 200, r.text
    assert saved(app)["kind"] == "custom"


async def test_custom_with_pending_checks_both_gates_with_one_call(app, client, cloud):
    mark_registered(app.state.settings.data_dir)
    outbox.enqueue_scans(app.state.store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    headers = signed_in(app)
    route = me(cloud, 80, is_global=True)
    r = await switch(client, headers, target={"custom": CUSTOM})
    assert r.status_code == 409 and r.json()["detail"]["pending"] == 1
    r = await switch(client, headers, target={"custom": CUSTOM}, discard=True)
    assert r.status_code == 200
    assert route.call_count == 2  # once per request, not once per gate


async def test_named_then_custom_cannot_skip_gate(app, client):
    mark_registered(app.state.settings.data_dir)
    r = await switch(client, target={"id": "prod"})
    assert r.status_code == 200 and r.json()["ever_registered"] is True
    r = await switch(client, target={"custom": CUSTOM})
    assert r.status_code == 403 and code(r) == "custom_needs_super_admin"
    assert saved(app)["id"] == "prod"


async def test_access_check_offline(app, client, cloud):
    mark_registered(app.state.settings.data_dir)
    headers = signed_in(app)
    cloud.get("/auth/me").mock(side_effect=httpx.ConnectError("down"))
    r = await switch(client, headers, target={"custom": CUSTOM})
    assert r.status_code == 503 and code(r) == "access_check_offline"
    outbox.enqueue_scans(app.state.store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    r = await switch(client, headers, discard=True)
    assert r.status_code == 503 and code(r) == "access_check_offline"
    assert count(app, "outbox") == 1


async def test_unknown_id_422(client):
    for target in ({"id": "nope"}, {"id": 7}, {"id": "UAT"}):
        r = await switch(client, target=target)
        assert r.status_code == 422 and code(r) == "unknown_environment", target


async def test_named_switch_uses_the_downloaded_list(app, client, cloud):
    cloud.get(STATUS_LIST_URL).mock(side_effect=None).respond(200, json={
        "version": 1, "environments": [{"id": "qa1", "name": "QA 1",
                                        "domain": "qa1.serversherpa.com"}]})
    r = await switch(client, target={"id": "qa1"})
    assert r.status_code == 200 and r.json()["api_url"] == "https://api.qa1.serversherpa.com"
    r = await switch(client, target={"id": "uat"})  # not in the downloaded list
    assert r.status_code == 422 and code(r) == "unknown_environment"


async def test_bad_custom_url_422(client):
    bad = [{"api_url": "ftp://x.test", "portal_url": "http://p.test"},
           {"api_url": "http://", "portal_url": "http://p.test"},
           {"api_url": "http://a.test", "portal_url": ""},
           {"api_url": "http://a.test"},
           {"api_url": 5, "portal_url": "http://p.test"},
           "http://a.test"]
    for custom in bad:
        r = await switch(client, target={"custom": custom})
        assert r.status_code == 422 and code(r) == "bad_url", custom


async def test_bad_target_or_body_422(client):
    for body in ({"target": None}, {"target": {}}, {"target": {"id": "uat", "custom": CUSTOM}},
                 {"target": {"id": "uat"}, "discard": "yes"}):
        r = await client.post("/edge/environment", json={"password": "cumulus", **body})
        assert r.status_code == 422 and code(r) == "bad_request", body


# ── work in flight while the switch runs ──

async def test_sync_in_flight_during_a_switch_does_not_repopulate_the_cache(app, client, cloud):
    store = app.state.store
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1",
                                    expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    started, release = asyncio.Event(), asyncio.Event()

    async def slow(request):  # the sync's last read: every other answer is in hand
        started.set()
        await release.wait()
        return httpx.Response(200, json={"moves": [{
            "initiative_id": "m-1", "name": "M", "argon2_hash": "h", "session": {},
            "version": "v1"}]})

    for path in sync_paths("m-1"):
        cloud.get(path).respond(200, json={"from": "old"})
    cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").mock(side_effect=slow)
    running = asyncio.create_task(app.state.syncer.run())
    await asyncio.wait_for(started.wait(), 5)

    r = await switch(client)
    assert r.status_code == 200
    release.set()  # the old server answers only now
    meta = await asyncio.wait_for(running, 5)

    assert count(app, "cache") == 0 and count(app, "move_passwords") == 0
    assert meta["synced_at"] is None and meta["last_error"] is None
    assert store.one("SELECT initiative_id FROM sync_meta WHERE id = 1")["initiative_id"] is None


async def test_outbox_drain_in_flight_during_a_switch_sends_nothing_to_the_new_server(
        app, client, cloud):
    store = app.state.store
    headers = signed_in(app)
    outbox.enqueue_scans(store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    started, release = asyncio.Event(), asyncio.Event()

    async def slow(request):
        started.set()
        await release.wait()
        return httpx.Response(401, json={"detail": {"code": "not_authenticated"}})

    old_scans = cloud.post("/kiosk/scans").mock(side_effect=slow)
    old_refresh = cloud.post("/auth/refresh").respond(200, json={})
    new_any = cloud.route(host="api.uat.serversherpa.com").respond(200, json={})
    me(cloud, 60)
    draining = asyncio.create_task(app.state.outbox.drain_once())
    await asyncio.wait_for(started.wait(), 5)

    r = await switch(client, headers, discard=True)
    assert r.status_code == 200, r.text
    release.set()  # the old server's 401 lands after the switch: no refresh, no retry
    await asyncio.wait_for(draining, 5)

    assert old_scans.call_count == 1
    assert not old_refresh.called and not new_any.called
    assert count(app, "outbox") == 0 and count(app, "cloud_sessions") == 0


async def test_a_call_pinned_to_the_old_server_never_reaches_the_new_one(app, cloud):
    up = app.state.upstream
    old_gen = up.generation
    await up.repoint(UAT)
    new = cloud.get(f"{UAT}/system/status").respond(200, json={})
    with pytest.raises(ServerChanged):
        await up.request("GET", "/system/status", generation=old_gen)
    assert not new.called
    assert (await up.request("GET", "/system/status")).status_code == 200


# ── work queued while the switch waits on the old server ──

async def test_work_queued_during_the_sign_out_is_not_wiped(app, client, cloud):
    store = app.state.store
    headers = signed_in(app)

    def queue_a_scan(request):  # a LAN browser's scan lands mid round-trip
        outbox.enqueue_scans(store, "p-2", "Sam", [{"client_scan_id": "late"}])
        return httpx.Response(204)

    cloud.post("/auth/logout").mock(side_effect=queue_a_scan)
    r = await switch(client, headers)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "outbox_not_empty", "pending": 1}
    assert count(app, "outbox") == 1
    assert app.state.environment.kind == "custom"  # still the installer's server
    assert not (app.state.settings.data_dir / "environment.json").exists()
    assert str(app.state.upstream.client.base_url) == "http://cloud.test"


async def test_discard_covers_only_the_work_it_was_approved_for(app, client, cloud):
    store = app.state.store
    outbox.enqueue_scans(store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    headers = signed_in(app)
    me(cloud, 60)

    def queue_a_scan(request):
        outbox.enqueue_scans(store, "p-2", "Sam", [{"client_scan_id": "late"}])
        return httpx.Response(204)

    cloud.post("/auth/logout").mock(side_effect=queue_a_scan)
    r = await switch(client, headers, discard=True)
    assert r.status_code == 409 and r.json()["detail"]["pending"] == 2
    assert count(app, "outbox") == 2


# ── cross-origin requests ──

@pytest.mark.parametrize("path", ["/edge/environment/unlock", "/edge/environment"])
async def test_only_a_same_origin_json_request_is_taken(app, client, path):
    body = json.dumps({"password": "cumulus", "target": {"id": "uat"}})
    r = await client.post(path, content=body, headers={"content-type": "text/plain"})
    assert r.status_code == 415 and code(r) == "json_required"
    r = await client.post(path, content=body)  # no content type at all
    assert r.status_code == 415 and code(r) == "json_required"
    json_type = {"content-type": "application/json"}
    for bad in ({"origin": "http://evil.test"}, {"origin": "null"},
                {"origin": "http://edge.test:8443"}, {"sec-fetch-site": "cross-site"},
                {"sec-fetch-site": "same-site"},
                {"origin": "http://edge.test", "sec-fetch-site": "cross-site"}):
        r = await client.post(path, content=body, headers={**json_type, **bad})
        assert r.status_code == 403 and code(r) == "cross_origin", bad
    assert not (app.state.settings.data_dir / "environment.json").exists()

    ok = 204 if path.endswith("unlock") else 200
    for good in ({"origin": "http://edge.test", "sec-fetch-site": "same-origin"},
                 {"origin": "https://EDGE.test"},  # a TLS proxy in front: same host
                 {"sec-fetch-site": "none"},
                 {"content-type": "application/json; charset=utf-8"}):
        r = await client.post(path, content=body, headers={**json_type, **good})
        assert r.status_code == ok, (good, r.text)
