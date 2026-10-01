import json

import httpx

from tests.conftest import make_session

ASSETS = "/kiosk/sync/assets?initiative_id=m-1"


def _online_as(app):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)


async def test_get_forwarded_as_person_and_cached(app, client, cloud):
    _online_as(app)
    route = cloud.get(ASSETS).respond(200, json={"assets": [1]})
    r = await client.get(ASSETS, headers=make_session(app))
    assert r.json() == {"assets": [1]}
    assert route.calls[0].request.headers["authorization"] == "Bearer a1"
    assert app.state.store.one("SELECT 1 FROM cache WHERE key=?", (ASSETS,))


async def test_offline_serves_cache_with_marker(app, client, cloud):
    _online_as(app)
    cloud.get(ASSETS).respond(200, json={"assets": [1]})
    hdrs = make_session(app)
    await client.get(ASSETS, headers=hdrs)
    cloud.get(ASSETS).mock(side_effect=httpx.ConnectError("down"))
    r = await client.get(ASSETS, headers=hdrs)
    assert r.status_code == 200 and r.json() == {"assets": [1]}
    assert r.headers["x-edge-cache"] == "hit"


async def test_offline_signed_in_person_without_cloud_session_reads_shared_cache(app, client):
    app.state.store.run("INSERT INTO cache VALUES (?, 200, ?, 'now')",
                        (ASSETS, json.dumps({"assets": [2]})))
    r = await client.get(ASSETS, headers=make_session(app, person_id="p-9"))
    assert r.json() == {"assets": [2]}


async def test_cacheable_kiosk_reads_need_a_session(client):
    r = await client.get(ASSETS)
    assert r.status_code == 401


async def test_move_locked_session_cannot_read_another_moves_cache(app, client):
    app.state.store.run("INSERT INTO cache VALUES (?, 200, '{}', 'now')",
                        ("/kiosk/sync/assets?initiative_id=m-2",))
    hdrs = make_session(app, kiosk_move={"initiative_id": "m-1", "name": "Move"})
    r = await client.get("/kiosk/sync/assets?initiative_id=m-2", headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"


async def test_offline_setup_options_filtered_for_move_session(app, client):
    body = {"initiatives": [{"id": "m-1"}, {"id": "m-2"}], "scan_types": []}
    app.state.store.run("INSERT INTO cache VALUES ('/kiosk/setup-options', 200, ?, 'now')",
                        (json.dumps(body),))
    hdrs = make_session(app, kiosk_move={"initiative_id": "m-1", "name": "Move"})
    r = await client.get("/kiosk/setup-options", headers=hdrs)
    assert [i["id"] for i in r.json()["initiatives"]] == ["m-1"]


async def test_online_only_write_offline_is_edge_offline(app, client, cloud):
    _online_as(app)
    cloud.post("/kiosk/assets/a-1/rfid").mock(side_effect=httpx.ConnectError("down"))
    r = await client.post("/kiosk/assets/a-1/rfid", json={"rfid_tag": "E2"},
                          headers=make_session(app))
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"


async def test_sign_out_offline_is_204(app, client):
    r = await client.post("/kiosk/sign-out", json={"serial": "x"}, headers=make_session(app))
    assert r.status_code == 204


async def test_heartbeat_body_rewritten_to_edge_identity(app, client, cloud):
    _online_as(app)
    route = cloud.post("/kiosk/heartbeat").respond(200, json={"registration": "ok"})
    await client.post("/kiosk/heartbeat", headers=make_session(app),
                      json={"serial": "browser", "name": "Browser", "mode": "web", "version": "1"})
    sent = json.loads(route.calls[0].request.content)
    ident = app.state.identity
    assert (sent["serial"], sent["name"], sent["mode"]) == (ident.serial, ident.name, "laptop")


async def test_signed_in_online_without_cloud_session_must_sign_in_again(app, client, cloud):
    cloud.get("/system/status").respond(200, json={})
    await app.state.upstream.probe()
    r = await client.post("/kiosk/assets/a-1/rfid", json={}, headers=make_session(app))
    # 403, not 401: the edge session is fine, so the kiosk must not sign the person out
    assert r.status_code == 403 and r.json()["detail"]["code"] == "cloud_sign_in_required"


async def test_anonymous_requests_forwarded_and_cloud_cookies_stripped(client, cloud):
    cloud.get("/system/status").respond(200, json={"read_only": False},
                                        headers={"set-cookie": "x=1; Path=/"})
    r = await client.get("/system/status")
    assert r.json() == {"read_only": False} and "set-cookie" not in r.headers


async def test_non_edge_bearer_forwarded_verbatim(client, cloud):
    route = cloud.post("/auth/totp/verify").respond(200, json={"ok": 1})
    await client.post("/auth/totp/verify", json={"code": "1"},
                      headers={"Authorization": "Bearer challenge-token"})
    assert route.calls[0].request.headers["authorization"] == "Bearer challenge-token"


async def test_duplicated_initiative_param_cannot_bypass_move_lock(app, client):
    key = "/kiosk/sync/assets?initiative_id=m-1&initiative_id=m-2"
    app.state.store.run("INSERT INTO cache VALUES (?, 200, '{}', 'now')", (key,))
    hdrs = make_session(app, kiosk_move={"initiative_id": "m-1", "name": "Move"})
    r = await client.get(key, headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"


async def test_online_no_cloud_session_cacheable_miss_is_403_hit_is_served(app, client, cloud):
    cloud.get("/system/status").respond(200, json={})
    await app.state.upstream.probe()
    hdrs = make_session(app)
    r = await client.get(ASSETS, headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "cloud_sign_in_required"
    app.state.store.run("INSERT INTO cache VALUES (?, 200, '{}', 'now')", (ASSETS,))
    r = await client.get(ASSETS, headers=hdrs)
    assert r.status_code == 200 and r.headers["x-edge-cache"] == "hit"


async def test_sign_out_without_cloud_session_is_204_even_online(app, client, cloud):
    cloud.get("/system/status").respond(200, json={})
    await app.state.upstream.probe()
    r = await client.post("/kiosk/sign-out", json={"serial": "x"}, headers=make_session(app))
    assert r.status_code == 204


async def test_offline_no_cloud_session_cacheable_miss_is_503(app, client):
    r = await client.get(ASSETS, headers=make_session(app))
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"


async def test_rejected_cloud_refresh_is_403_cloud_sign_in_required(app, client, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=-60)
    cloud.post("/auth/refresh").respond(401, json={"detail": {"code": "session_expired"}})
    r = await client.post("/kiosk/assets/a-1/rfid", json={}, headers=make_session(app))
    assert r.status_code == 403 and r.json()["detail"]["code"] == "cloud_sign_in_required"


async def test_heartbeat_without_cloud_session_is_edge_offline_even_online(app, client, cloud):
    cloud.get("/system/status").respond(200, json={})
    beat = cloud.post("/kiosk/heartbeat").respond(200, json={"registration": "ok"})
    await app.state.upstream.probe()
    r = await client.post("/kiosk/heartbeat", json={"serial": "x"}, headers=make_session(app))
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"
    assert not beat.called


async def test_heartbeat_with_rejected_cloud_refresh_is_edge_offline(app, client, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=-60)
    cloud.post("/auth/refresh").respond(401, json={"detail": {"code": "session_expired"}})
    r = await client.post("/kiosk/heartbeat", json={"serial": "x"}, headers=make_session(app))
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"
