import json

import httpx

from edge import outbox
from tests.conftest import session_out

LOGIN = {"email": "Jane@Example.com", "password": "CorrectHorse9!"}
SET_COOKIE = {"set-cookie": "ss_refresh=cloud-r1; HttpOnly; Path=/auth"}


def _cloud_login_ok(cloud, **kw):
    return cloud.post("/auth/login").respond(200, json=session_out(**kw), headers=SET_COOKIE)


def _offline(cloud):
    cloud.post("/auth/login").mock(side_effect=httpx.ConnectError("down"))
    cloud.post("/kiosk/move-login").mock(side_effect=httpx.ConnectError("down"))


async def test_online_login_adopts_cloud_session(app, client, cloud):
    route = _cloud_login_ok(cloud)
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 200
    data = r.json()
    assert data["access_token"] != "cloud-access-1"           # edge token, not the cloud's
    assert data["person"]["id"] == "p-1"
    assert "cloud-r1" not in r.headers.get("set-cookie", "")    # cloud cookie never leaks
    assert client.cookies.get("ss_refresh")                     # edge cookie set
    assert json.loads(route.calls[0].request.content)["client"] == "kiosk"
    assert app.state.upstream.has_session("p-1")
    assert app.state.store.one("SELECT 1 FROM offline_logins WHERE email='jane@example.com'")


async def test_online_login_releases_waiting_rows(app, client, cloud):
    outbox.enqueue_scans(app.state.store, "p-1", "Jane Doe", [{"client_scan_id": "s1"}])
    app.state.store.run("UPDATE outbox SET status='needs_sign_in'")
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    assert outbox.counts(app.state.store)["queued"] == 1


async def test_two_factor_challenge_passes_through(client, cloud):
    challenge = {"status": "totp_verify", "challenge_token": "c", "backup_codes_remaining": 3}
    cloud.post("/auth/login").respond(200, json=challenge)
    r = await client.post("/auth/login", json=LOGIN)
    assert r.json() == challenge


async def test_cloud_rejection_passes_through_and_forgets_verifier(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    cloud.post("/auth/login").respond(401, json={"detail": {"code": "invalid_credentials"}})
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_credentials"
    assert app.state.store.one("SELECT 1 FROM offline_logins") is None


async def test_offline_login_with_cached_verifier(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    _offline(cloud)
    r = await client.post("/auth/login", json={**LOGIN, "email": "jane@example.com "})
    assert r.status_code == 200 and r.json()["person"]["id"] == "p-1"
    row = app.state.store.one("SELECT offline FROM edge_sessions ORDER BY rowid DESC")
    assert row["offline"] == 1


async def test_offline_login_wrong_password_or_unknown(client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    _offline(cloud)
    r = await client.post("/auth/login", json={**LOGIN, "password": "nope"})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_credentials"
    r = await client.post("/auth/login", json={"email": "who@x.com", "password": "x"})
    assert r.status_code == 401


async def test_offline_login_expires_after_window(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    app.state.store.run("UPDATE offline_logins SET cached_at='2000-01-01T00:00:00+00:00'")
    _offline(cloud)
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 401


async def test_offline_login_rate_limited(client, cloud):
    _offline(cloud)
    for _ in range(10):
        await client.post("/auth/login", json={**LOGIN, "password": "bad"})
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 423 and r.json()["detail"]["code"] == "account_locked"


async def test_move_login_offline_uses_cached_hash(app, client, cloud):
    from edge.crypto import make_verifier
    from edge.sessions import template_from
    tpl = template_from(session_out(person_id="kiosk-m1", name="Kiosk Move",
                                    kiosk_move={"initiative_id": "m-1", "name": "Move"}))
    app.state.store.run(
        "INSERT INTO move_passwords VALUES ('m-1', 'Move', ?, ?, '2026-10-01T00:00:00+00:00', 'v1')",
        (make_verifier("Crew-2026!"), json.dumps(tpl)))
    _offline(cloud)
    r = await client.post("/kiosk/move-login", json={"password": "Crew-2026!"})
    assert r.status_code == 200 and r.json()["kiosk_move"]["initiative_id"] == "m-1"
    r = await client.post("/kiosk/move-login", json={"password": "wrong-pass"})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_move_password"


async def test_move_login_online_adopts(app, client, cloud):
    cloud.post("/kiosk/move-login").respond(
        200, json=session_out(person_id="kiosk-m1",
                              kiosk_move={"initiative_id": "m-1", "name": "Move"}),
        headers=SET_COOKIE)
    r = await client.post("/kiosk/move-login", json={"password": "Crew-2026!"})
    assert r.status_code == 200 and app.state.upstream.has_session("kiosk-m1")


async def test_pair_poll_approved_is_adopted(app, client, cloud):
    cloud.post("/kiosk/pair/AB12/poll").respond(
        200, json={"status": "approved", "session": session_out()}, headers=SET_COOKIE)
    r = await client.post("/kiosk/pair/AB12/poll", json={"poll_token": "t"})
    body = r.json()
    assert body["status"] == "approved"
    assert body["session"]["access_token"] != "cloud-access-1"
    assert app.state.upstream.has_session("p-1")


async def test_pair_poll_pending_passes_through(client, cloud):
    cloud.post("/kiosk/pair/AB12/poll").respond(200, json={"status": "pending", "session": None})
    r = await client.post("/kiosk/pair/AB12/poll", json={"poll_token": "t"})
    assert r.json() == {"status": "pending", "session": None}


async def test_pair_poll_offline_is_edge_offline(client, cloud):
    cloud.post("/kiosk/pair/AB12/poll").mock(side_effect=httpx.ConnectError("down"))
    r = await client.post("/kiosk/pair/AB12/poll", json={"poll_token": "t"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"


async def test_refresh_and_logout(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    r = await client.post("/auth/refresh")
    assert r.status_code == 200 and r.json()["person"]["id"] == "p-1"
    r = await client.post("/auth/logout")
    assert r.status_code == 204
    # the cloud session is kept until the outbox drains, then ended
    assert app.state.upstream.ending_people() == ["p-1"]
    r = await client.post("/auth/refresh")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_refresh"


async def test_totp_verify_adopts(app, client, cloud):
    route = cloud.post("/auth/totp/verify").respond(
        200, json=session_out(), headers=SET_COOKIE)
    r = await client.post("/auth/totp/verify", json={"code": "123456"},
                          headers={"authorization": "Bearer chal"})
    assert r.status_code == 200
    assert r.json()["access_token"] != "cloud-access-1"
    assert "cloud-r1" not in r.headers.get("set-cookie", "")
    assert client.cookies.get("ss_refresh")
    assert app.state.upstream.has_session("p-1")
    assert route.calls[0].request.headers["authorization"] == "Bearer chal"


async def test_totp_verify_offline(client, cloud):
    cloud.post("/auth/totp/verify").mock(side_effect=httpx.ConnectError("down"))
    r = await client.post("/auth/totp/verify", json={"code": "1"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"


async def test_challenge_forgets_verifier(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    cloud.post("/auth/login").respond(200, json={"status": "totp_verify", "challenge_token": "c"})
    await client.post("/auth/login", json=LOGIN)
    assert app.state.store.one("SELECT 1 FROM offline_logins") is None


async def test_malformed_body_is_422(client):
    for path in ("/auth/login", "/kiosk/move-login", "/auth/totp/verify"):
        r = await client.post(path, content=b"{nope", headers={"content-type": "application/json"})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_request"
        r = await client.post(path, json=[1])
        assert r.status_code == 422


async def test_unhealthy_cloud_falls_back_to_offline_sign_in(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    cloud.post("/auth/login").respond(503, text="Service Unavailable")
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 200
    row = app.state.store.one("SELECT offline FROM edge_sessions ORDER BY rowid DESC")
    assert row["offline"] == 1
