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


# ── the client asset list and the station-key fallback (rfid scan processing §2.1, §3.2) ──

STATION_NAMES = ("assets", "containers", "people", "client-assets", "label-templates")


def _person_key(name, initiative="m-1"):
    return next(p for p in sync_paths(initiative) if p.startswith(f"/kiosk/sync/{name}"))


async def test_client_assets_cached(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    assert "/kiosk/sync/client-assets?initiative_id=m-1" in sync_paths("m-1")
    _mock_sync(cloud)
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    row = app.state.store.one("SELECT body FROM cache WHERE key = ?",
                              ("/kiosk/sync/client-assets?initiative_id=m-1",))
    assert json.loads(row["body"]) == {"path": "/kiosk/sync/client-assets?initiative_id=m-1"}


def _mock_station(cloud, status=200):
    return {name: cloud.get(f"/kiosk/station/sync/{name}").respond(
        status, json={"station": name}) for name in STATION_NAMES}


async def test_sync_falls_back_to_station_key(app, cloud):
    from edge.rfid import station_key
    store = app.state.store
    station_key.store_key(store, app.state.keys, "the-station-key")
    app.state.syncer.set_target("m-1", "p-gone")                   # nobody has a cloud session
    store.run("INSERT INTO cache VALUES ('/kiosk/labels/vocab', 200, 'vocab', 'then')")
    store.run("INSERT INTO move_passwords VALUES ('m-1', 'Move', 'v', '{}', 'now', 'v1')")
    station = _mock_station(cloud)
    person = cloud.get(url__regex=r"/kiosk/sync/.*").respond(200, json={})
    moves = cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(200, json={})
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None and meta["synced_at"]
    assert not person.called and not moves.called
    for name, route in station.items():
        req = route.calls[0].request
        assert req.headers["authorization"] == "Station the-station-key"
        assert req.url.params["serial"] == app.state.identity.serial
        assert req.url.params["initiative_id"] == "m-1"
        body = store.one("SELECT body FROM cache WHERE key = ?", (_person_key(name),))["body"]
        assert json.loads(body) == {"station": name}               # the SAME cache keys
    assert _person_key("people") == "/kiosk/sync/people"
    # reads the station routes don't cover keep their cached copies
    assert store.one("SELECT body FROM cache WHERE key='/kiosk/labels/vocab'")["body"] == "vocab"
    assert store.one("SELECT 1 FROM move_passwords WHERE initiative_id='m-1'")
    assert "the-station-key" not in json.dumps(meta)


async def test_station_sync_failure_keeps_old_snapshot(app, cloud):
    from edge.rfid import station_key
    store = app.state.store
    station_key.store_key(store, app.state.keys, "the-station-key")
    app.state.syncer.set_target("m-1", None)
    key = _person_key("assets")
    store.run("INSERT INTO cache VALUES (?, 200, 'old', 'then')", (key,))
    _mock_station(cloud)
    cloud.get("/kiosk/station/sync/client-assets").respond(
        403, json={"detail": {"code": "move_locked"}})
    meta = await app.state.syncer.run()
    assert meta["last_error"] == "http_403:/kiosk/station/sync/client-assets"
    assert store.one("SELECT body FROM cache WHERE key=?", (key,))["body"] == "old"


async def test_station_sync_offline(app, cloud):
    from edge.rfid import station_key
    station_key.store_key(app.state.store, app.state.keys, "the-station-key")
    app.state.syncer.set_target("m-1", None)
    cloud.get(url__regex=r"/kiosk/station/sync/.*").mock(side_effect=httpx.ConnectError("down"))
    assert (await app.state.syncer.run())["last_error"] == "offline"


async def test_person_session_still_syncs_as_the_person_with_a_key_stored(app, cloud):
    from edge.rfid import station_key
    station_key.store_key(app.state.store, app.state.keys, "the-station-key")
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    route = _mock_sync(cloud)
    station = _mock_station(cloud)
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None and route.called
    assert not any(r.called for r in station.values())


async def test_client_assets_404_from_an_old_portal_is_an_empty_list(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    _mock_sync(cloud)
    key = "/kiosk/sync/client-assets?initiative_id=m-1"
    cloud.get(key).respond(404, json={"detail": "Not Found"})
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None and meta["synced_at"]
    assert json.loads(app.state.store.one("SELECT body FROM cache WHERE key = ?",
                                          (key,))["body"]) == {"assets": []}
    assert app.state.store.one("SELECT 1 FROM cache WHERE key = ?", (_person_key("assets"),))


async def test_other_404_still_fails_the_sync(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    _mock_sync(cloud)
    cloud.get("/kiosk/sync/containers?initiative_id=m-1").respond(404)
    meta = await app.state.syncer.run()
    assert meta["last_error"].startswith("http_404")


async def test_client_assets_500_still_fails_the_sync(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    _mock_sync(cloud)
    cloud.get("/kiosk/sync/client-assets?initiative_id=m-1").respond(500)
    meta = await app.state.syncer.run()
    assert meta["last_error"] == "http_500:/kiosk/sync/client-assets?initiative_id=m-1"


# ── the move's label template set (kiosk label templates download §4) ──

LABEL_TEMPLATES = "/kiosk/sync/label-templates?initiative_id=m-1"


def _as_person(app):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")


async def test_person_sync_caches_label_templates(app, cloud):
    _as_person(app)
    assert LABEL_TEMPLATES in sync_paths("m-1")
    _mock_sync(cloud)
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    row = app.state.store.one("SELECT body FROM cache WHERE key = ?", (LABEL_TEMPLATES,))
    assert json.loads(row["body"]) == {"path": LABEL_TEMPLATES}


async def test_station_sync_caches_label_templates_under_the_person_key(app, cloud):
    from edge.rfid import station_key
    store = app.state.store
    station_key.store_key(store, app.state.keys, "the-station-key")
    app.state.syncer.set_target("m-1", None)
    station = _mock_station(cloud)
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    req = station["label-templates"].calls[0].request
    assert req.headers["authorization"] == "Station the-station-key"
    assert req.url.params["initiative_id"] == "m-1"
    body = store.one("SELECT body FROM cache WHERE key = ?", (LABEL_TEMPLATES,))["body"]
    assert json.loads(body) == {"station": "label-templates"}


async def test_label_templates_404_from_an_old_portal_is_an_empty_set(app, cloud):
    _as_person(app)
    _mock_sync(cloud)
    cloud.get(LABEL_TEMPLATES).respond(404, json={"detail": "Not Found"})
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None and meta["synced_at"]
    assert json.loads(app.state.store.one("SELECT body FROM cache WHERE key = ?",
                                          (LABEL_TEMPLATES,))["body"]) == {"templates": []}
    assert app.state.store.one("SELECT 1 FROM cache WHERE key = ?", (_person_key("assets"),))


async def test_station_label_templates_404_is_an_empty_set(app, cloud):
    from edge.rfid import station_key
    store = app.state.store
    station_key.store_key(store, app.state.keys, "the-station-key")
    app.state.syncer.set_target("m-1", None)
    _mock_station(cloud)
    cloud.get("/kiosk/station/sync/label-templates").respond(404, json={"detail": "Not Found"})
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    assert json.loads(store.one("SELECT body FROM cache WHERE key = ?",
                                (LABEL_TEMPLATES,))["body"]) == {"templates": []}


async def test_failed_label_templates_keep_old_set_and_the_rest_still_syncs(app, cloud):
    _as_person(app)
    store = app.state.store
    store.run("INSERT INTO cache VALUES (?, 200, 'old-set', 'then')", (LABEL_TEMPLATES,))
    store.run("INSERT INTO cache VALUES (?, 200, 'old-assets', 'then')", (_person_key("assets"),))
    _mock_sync(cloud)
    cloud.get(LABEL_TEMPLATES).respond(500)
    meta = await app.state.syncer.run()
    assert meta["synced_at"]
    assert meta["last_error"] == "label_templates_http_500"
    assert store.one("SELECT body FROM cache WHERE key = ?", (LABEL_TEMPLATES,))["body"] == "old-set"
    assets = store.one("SELECT body FROM cache WHERE key = ?", (_person_key("assets"),))["body"]
    assert json.loads(assets) == {"path": _person_key("assets")}       # the rest landed


async def test_station_failed_label_templates_keep_old_set(app, cloud):
    from edge.rfid import station_key
    store = app.state.store
    station_key.store_key(store, app.state.keys, "the-station-key")
    app.state.syncer.set_target("m-1", None)
    store.run("INSERT INTO cache VALUES (?, 200, 'old-set', 'then')", (LABEL_TEMPLATES,))
    _mock_station(cloud)
    cloud.get("/kiosk/station/sync/label-templates").respond(500)
    meta = await app.state.syncer.run()
    assert meta["synced_at"] and meta["last_error"] == "label_templates_http_500"
    assert store.one("SELECT body FROM cache WHERE key = ?", (LABEL_TEMPLATES,))["body"] == "old-set"
    assets = store.one("SELECT body FROM cache WHERE key = ?", (_person_key("assets"),))["body"]
    assert json.loads(assets) == {"station": "assets"}


async def test_label_template_and_move_password_errors_are_both_reported(app, cloud):
    _as_person(app)
    for path in sync_paths("m-1"):
        cloud.get(path).respond(200, json={"path": path})
    cloud.get(LABEL_TEMPLATES).respond(500)
    cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(
        200, json={"moves": [{"initiative_id": "m-1"}]})
    meta = await app.state.syncer.run()
    assert meta["last_error"] == "label_templates_http_500, bad_move_passwords"


async def test_label_station_syncs_as_station_without_a_person(app, cloud):
    """An unattended Label Station syncs through its key, skipping the client
    asset list (an RFID-only read; the portal refuses it to a Label key)."""
    from edge import laptop_setup
    from edge.rfid import station_key
    store = app.state.store
    laptop_setup.save(store, {"initiative_id": "m-1"}, "label")
    station_key.store_key(store, app.state.keys, "the-label-key")
    app.state.syncer.set_target("m-1", "p-gone")                   # nobody has a cloud session
    client_key = _person_key("client-assets")
    store.run("INSERT INTO cache VALUES (?, 200, 'kept', 'then')", (client_key,))
    station = _mock_station(cloud)
    station["client-assets"] = cloud.get("/kiosk/station/sync/client-assets").respond(
        403, json={"detail": {"code": "not_rfid_station"}})
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None and meta["synced_at"]
    assert not station["client-assets"].called
    for name in ("assets", "containers", "people", "label-templates"):
        req = station[name].calls[0].request
        assert req.headers["authorization"] == "Station the-label-key"
        body = store.one("SELECT body FROM cache WHERE key = ?", (_person_key(name),))["body"]
        assert json.loads(body) == {"station": name}
    assert store.one("SELECT body FROM cache WHERE key = ?", (client_key,))["body"] == "kept"
