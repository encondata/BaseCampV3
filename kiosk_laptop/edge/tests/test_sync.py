import json

import httpx

from edge.sync import sync_paths
from tests.conftest import make_session, session_out


def _mock_sync(cloud, initiative="m-1", mp_status=200, moves=None, unchanged=False):
    for path in sync_paths(initiative):
        cloud.get(path).respond(200, json={"path": path})
    return cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(
        mp_status, json={"moves": moves or [], "unchanged": unchanged})


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
    _mock_sync(cloud, moves=[{"initiative_id": "m-1", "name": "Move", "version": "v1",
                              "argon2_hash": make_verifier("Crew-2026!"), "session": tpl}])
    app.state.store.run("INSERT INTO move_passwords VALUES ('old', 'Old', 'v', '{}', 'now', 'v0')")
    await app.state.syncer.run()
    rows = app.state.store.all("SELECT initiative_id, version FROM move_passwords")
    assert [(r["initiative_id"], r["version"]) for r in rows] == [("m-1", "v1")]


async def test_sync_sends_stored_version_and_keeps_rows_when_unchanged(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    route = _mock_sync(cloud, unchanged=True)
    app.state.store.run("INSERT INTO move_passwords VALUES ('m-1', 'Move', 'v', '{}', 'now', "
                        "'abc123')")
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    assert "have=abc123" in str(route.calls[0].request.url)
    assert app.state.store.one("SELECT version FROM move_passwords WHERE initiative_id='m-1'")


async def test_sync_without_stored_version_sends_no_have(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    route = _mock_sync(cloud)
    await app.state.syncer.run()
    assert "have=" not in str(route.calls[0].request.url)


async def test_sync_keeps_move_passwords_when_endpoint_refuses(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    _mock_sync(cloud, mp_status=403)
    app.state.store.run("INSERT INTO move_passwords VALUES ('m-1', 'Move', 'v', '{}', 'now', 'v1')")
    meta = await app.state.syncer.run()
    assert meta["last_error"] == "move_passwords_http_403"
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
    app.state.store.run("INSERT INTO move_passwords VALUES ('old', 'Old', 'v', '{}', 'now', 'v0')")
    meta = await app.state.syncer.run()
    assert meta["last_error"] == "bad_move_passwords"
    assert app.state.store.one("SELECT 1 FROM move_passwords WHERE initiative_id='old'")
    assert app.state.store.one("SELECT 1 FROM cache WHERE key=?", (sync_paths("m-1")[0],))


async def test_sync_acts_as_the_person_signed_in_now(app, cloud):
    up = app.state.upstream
    up.save_session("p-a", refresh_token="ra", access_token="tok-a", expires_in=900)
    app.state.syncer.set_target("m-1", "p-a")                 # A ran Kiosk Setup
    up.save_session("p-b", refresh_token="rb", access_token="tok-b", expires_in=900)
    make_session(app, person_id="p-b", name="Bo Brown")         # B is signed in now
    route = _mock_sync(cloud)
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    assert route.calls[0].request.headers["authorization"] == "Bearer tok-b"


async def test_sync_skips_signed_in_person_whose_cloud_session_is_ending(app, cloud):
    up = app.state.upstream
    up.save_session("p-a", refresh_token="ra", access_token="tok-a", expires_in=900)
    app.state.syncer.set_target("m-1", "p-a")
    up.save_session("p-b", refresh_token="rb", access_token="tok-b", expires_in=900)
    up.mark_ending("p-b")
    make_session(app, person_id="p-b", name="Bo Brown")
    make_session(app, person_id="p-c", name="Cy Offline")       # offline sign-in: no cloud row
    route = _mock_sync(cloud)
    await app.state.syncer.run()
    assert route.calls[0].request.headers["authorization"] == "Bearer tok-a"


async def test_sync_prefers_a_person_session_over_a_newer_move_session(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="tok-p", expires_in=900)
    make_session(app, person_id="p-1")
    up.save_session("kiosk-m1", refresh_token="rm", access_token="tok-m", expires_in=900)
    make_session(app, person_id="kiosk-m1", name="Kiosk Move",
                 kiosk_move={"initiative_id": "m-1", "name": "Move"})       # newest
    app.state.syncer.set_target("m-1", "p-1")
    route = _mock_sync(cloud)
    await app.state.syncer.run()
    assert route.calls[0].request.headers["authorization"] == "Bearer tok-p"


async def test_only_a_move_session_skips_move_passwords_without_error(app, cloud):
    up = app.state.upstream
    up.save_session("kiosk-m1", refresh_token="rm", access_token="tok-m", expires_in=900)
    make_session(app, person_id="kiosk-m1", name="Kiosk Move",
                 kiosk_move={"initiative_id": "m-1", "name": "Move"})
    app.state.syncer.set_target("m-1", "kiosk-m1")
    for path in sync_paths("m-1"):
        cloud.get(path).respond(200, json={"path": path})
    route = cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(
        403, json={"detail": {"code": "move_locked"}})
    app.state.store.run("INSERT INTO move_passwords VALUES ('m-1', 'Move', 'v', '{}', 'now', 'v1')")
    meta = await app.state.syncer.run()
    assert route.calls[0].request.headers["authorization"] == "Bearer tok-m"
    assert meta["last_error"] is None and meta["synced_at"]
    assert app.state.store.one("SELECT 1 FROM move_passwords WHERE initiative_id='m-1'")


async def test_not_signed_in_here_is_skipped_without_error(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    for path in sync_paths("m-1"):
        cloud.get(path).respond(200, json={"path": path})
    cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(
        403, json={"detail": {"code": "not_signed_in_here"}})
    app.state.store.run("INSERT INTO move_passwords VALUES ('m-1', 'Move', 'v', '{}', 'now', 'v1')")
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    assert app.state.store.one("SELECT 1 FROM move_passwords WHERE initiative_id='m-1'")
