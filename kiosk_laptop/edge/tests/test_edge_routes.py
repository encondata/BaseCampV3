from edge import outbox
from tests.conftest import make_session


async def test_status_anonymous(app, client):
    r = await client.get("/edge/status")
    body = r.json()
    assert body["cloud"]["online"] is False
    assert body["session"] is None and body["waiting"] == []
    assert body["identity"]["serial"] == app.state.identity.serial
    assert body["outbox"]["queued"] == 0


async def test_status_signed_in_offline_session(app, client):
    outbox.enqueue_scans(app.state.store, "p-2", "Sam Lee", [{"client_scan_id": "s1"}])
    app.state.store.run("UPDATE outbox SET status='needs_sign_in'")
    r = await client.get("/edge/status", headers=make_session(app, offline=True))
    body = r.json()
    assert body["session"] == {"offline": True}
    assert body["waiting"] == [{"person_name": "Sam Lee", "count": 1}]


async def test_sync_and_retry_need_a_session(client):
    assert (await client.post("/edge/sync")).status_code == 401
    assert (await client.post("/edge/outbox/retry")).status_code == 401


async def test_sync_returns_status(app, client):
    r = await client.post("/edge/sync", headers=make_session(app))
    assert r.status_code == 200 and "sync" in r.json()


async def test_retry(app, client):
    outbox.enqueue_scans(app.state.store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    app.state.store.run("UPDATE outbox SET status='failed'")
    r = await client.post("/edge/outbox/retry", headers=make_session(app))
    assert r.json() == {"requeued": 1}


async def test_rename_admin_only(app, client):
    r = await client.post("/edge/identity", json={"name": "Dock 3"}, headers=make_session(app))
    assert r.status_code == 403
    admin = make_session(app, max_rank=60)
    r = await client.post("/edge/identity", json={"name": "  Dock 3 "}, headers=admin)
    assert r.json()["name"] == "Dock 3" and app.state.identity.name == "Dock 3"
    r = await client.post("/edge/identity", json={"name": ""}, headers=admin)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_name"


async def test_rename_bad_body_is_422(app, client):
    admin = make_session(app, max_rank=60)
    for content in (b"not json", b"[1]", b'"x"'):
        r = await client.post("/edge/identity", content=content, headers=admin)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_request"


async def test_wipe_clears_auth_and_move_data_when_outbox_empty(app, client):
    store = app.state.store
    app.state.upstream.save_session("p-1", refresh_token="r", access_token="a", expires_in=900)
    store.run("INSERT INTO cache VALUES ('/kiosk/sync/people', 200, '{}', 'now')")
    store.run("INSERT INTO move_passwords VALUES ('m', 'M', 'v', '{}', 'now', 'v1')")
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.json() == {"cleared_move_data": True}
    for table in ("cloud_sessions", "offline_logins", "edge_sessions", "move_passwords", "cache"):
        assert store.one(f"SELECT COUNT(*) AS n FROM {table}")["n"] == 0
    assert (app.state.settings.data_dir / "identity.json").exists()


async def test_wipe_with_empty_or_missing_body(app, client):
    r = await client.post("/edge/wipe", headers=make_session(app, max_rank=60))
    assert r.status_code == 200 and r.json() == {"cleared_move_data": True}


async def test_wipe_bad_body_is_422(app, client):
    admin = make_session(app, max_rank=60)
    r = await client.post("/edge/wipe", content=b"nope", headers=admin)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_request"
    r = await client.post("/edge/wipe", content=b"[1]", headers=make_session(app, max_rank=60))
    assert r.status_code == 422


async def test_wipe_with_pending_outbox_needs_typed_confirm(app, client):
    store = app.state.store
    outbox.enqueue_scans(store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    admin = make_session(app, max_rank=60)
    r = await client.post("/edge/wipe", json={}, headers=admin)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "outbox_not_empty", "pending": 1}
    admin = make_session(app, max_rank=60)
    r = await client.post("/edge/wipe", json={"confirm": "WIPE"}, headers=admin)
    assert r.json() == {"cleared_move_data": True}
    assert store.one("SELECT COUNT(*) AS n FROM outbox")["n"] == 0


async def test_wipe_not_for_workers(app, client):
    r = await client.post("/edge/wipe", json={}, headers=make_session(app))
    assert r.status_code == 403


async def test_unknown_edge_path_is_404_not_proxied(client, cloud):
    route = cloud.route().respond(200, json={})
    assert (await client.get("/edge/nope")).status_code == 404
    assert (await client.post("/edge/nope")).status_code == 404
    assert not route.called
