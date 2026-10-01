import json

import httpx

from edge.sync import sync_paths
from tests.conftest import make_session, session_out


def _mock_sync(cloud, initiative="m-1", mp_status=200, moves=None):
    for path in sync_paths(initiative):
        cloud.get(path).respond(200, json={"path": path})
    cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(
        mp_status, json={"moves": moves or []})


async def test_setup_forwards_then_syncs(app, client, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    setup = cloud.post("/kiosk/setup").respond(200, json={"initiative_id": "m-1"})
    _mock_sync(cloud)
    r = await client.post("/kiosk/setup", headers=make_session(app),
                          json={"serial": "browser", "initiative_id": "m-1", "site_id": "s",
                                "scan_status": "x"})
    assert r.status_code == 200
    assert json.loads(setup.calls[0].request.content)["serial"] == app.state.identity.serial
    meta = app.state.syncer.meta()
    assert meta["initiative_id"] == "m-1" and meta["synced_at"] and meta["last_error"] is None
    keys = {r["key"] for r in app.state.store.all("SELECT key FROM cache")}
    assert set(sync_paths("m-1")) <= keys


async def test_setup_without_cloud_session_is_403(app, client, cloud):
    r = await client.post("/kiosk/setup", headers=make_session(app), json={"initiative_id": "m-1"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "cloud_sign_in_required"


async def test_setup_offline_is_edge_offline(app, client, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    cloud.post("/kiosk/setup").mock(side_effect=httpx.ConnectError("down"))
    r = await client.post("/kiosk/setup", headers=make_session(app), json={"initiative_id": "m-1"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"


async def test_sync_replaces_move_passwords(app, cloud):
    from edge.crypto import make_verifier
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    tpl = {k: v for k, v in session_out(person_id="km", kiosk_move={
        "initiative_id": "m-1", "name": "Move"}).items()
        if k not in ("status", "access_token", "token_type", "expires_in", "session_expires_at")}
    _mock_sync(cloud, moves=[{"initiative_id": "m-1", "name": "Move",
                              "argon2_hash": make_verifier("Crew-2026!"), "session": tpl}])
    app.state.store.run("INSERT INTO move_passwords VALUES ('old', 'Old', 'v', '{}', 'now')")
    await app.state.syncer.run()
    rows = app.state.store.all("SELECT initiative_id FROM move_passwords")
    assert [r["initiative_id"] for r in rows] == ["m-1"]


async def test_sync_keeps_move_passwords_when_endpoint_refuses(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    _mock_sync(cloud, mp_status=403)
    app.state.store.run("INSERT INTO move_passwords VALUES ('m-1', 'Move', 'v', '{}', 'now')")
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    assert app.state.store.one("SELECT 1 FROM move_passwords WHERE initiative_id='m-1'")


async def test_failed_pull_leaves_old_snapshot_intact(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    key = sync_paths("m-1")[0]
    app.state.store.run("INSERT INTO cache VALUES (?, 200, 'old', 'then')", (key,))
    for path in sync_paths("m-1"):
        cloud.get(path).respond(500 if path.startswith("/kiosk/sync/trucks") else 200, json={})
    meta = await app.state.syncer.run()
    assert meta["last_error"].startswith("http_500")
    assert app.state.store.one("SELECT body FROM cache WHERE key=?", (key,))["body"] == "old"


async def test_sync_falls_back_to_latest_cloud_session(app, cloud):
    app.state.upstream.save_session("p-2", refresh_token="r2", access_token="a2", expires_in=900)
    app.state.syncer.set_target("m-1", "p-gone")
    _mock_sync(cloud)
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None


async def test_sync_without_any_cloud_session_records_needs_sign_in(app):
    app.state.syncer.set_target("m-1", "p-1")
    meta = await app.state.syncer.run()
    assert meta["last_error"] == "needs_sign_in"


async def test_malformed_move_passwords_keep_old_and_still_cache(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    for path in sync_paths("m-1"):
        cloud.get(path).respond(200, json={"path": path})
    cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(
        200, json={"moves": [{"initiative_id": "m-1"}]})
    app.state.store.run("INSERT INTO move_passwords VALUES ('old', 'Old', 'v', '{}', 'now')")
    meta = await app.state.syncer.run()
    assert meta["last_error"] == "bad_move_passwords"
    assert app.state.store.one("SELECT 1 FROM move_passwords WHERE initiative_id='old'")
    assert app.state.store.one("SELECT 1 FROM cache WHERE key=?", (sync_paths("m-1")[0],))
