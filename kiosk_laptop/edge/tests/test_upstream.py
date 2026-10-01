import asyncio

import httpx
import pytest

from edge.upstream import CloudOffline, refresh_cookie_from


def _set_cookie(token):
    return {"set-cookie": f"ss_refresh={token}; HttpOnly; Path=/auth; SameSite=lax"}


async def test_transport_error_is_offline(app, cloud):
    cloud.get("/system/status").mock(side_effect=httpx.ConnectError("down"))
    up = app.state.upstream
    with pytest.raises(CloudOffline):
        await up.request("GET", "/system/status")
    assert up.online is False
    assert await up.probe() is False


async def test_any_http_answer_is_online(app, cloud):
    cloud.get("/system/status").respond(503, json={"detail": "x"})
    up = app.state.upstream
    resp = await up.request("GET", "/system/status")
    assert resp.status_code == 503 and up.online is True and up.last_contact


def test_refresh_cookie_parsed_from_set_cookie():
    resp = httpx.Response(200, headers=[("set-cookie", "other=1; Path=/"),
                                        ("set-cookie", "ss_refresh=abc123; HttpOnly; Path=/auth")])
    assert refresh_cookie_from(resp) == "abc123"
    assert refresh_cookie_from(httpx.Response(200)) is None


async def test_as_person_uses_stored_access_token(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    route = cloud.get("/kiosk/setup-options").respond(200, json={"ok": True})
    resp = await up.as_person("p-1", "GET", "/kiosk/setup-options")
    assert resp.json() == {"ok": True}
    assert route.calls[0].request.headers["authorization"] == "Bearer a1"


async def test_as_person_refreshes_on_401_and_stores_rotated_cookie(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="stale", expires_in=900)
    cloud.get("/kiosk/setup-options").mock(side_effect=[
        httpx.Response(401, json={"detail": {"code": "token_expired"}}),
        httpx.Response(200, json={"ok": True}),
    ])
    refresh = cloud.post("/auth/refresh").respond(
        200, json={"access_token": "a2", "expires_in": 900}, headers=_set_cookie("r2"))
    resp = await up.as_person("p-1", "GET", "/kiosk/setup-options")
    assert resp.status_code == 200
    assert refresh.calls[0].request.headers["cookie"] == "ss_refresh=r1"
    assert up._refresh_token("p-1") == "r2"     # the rotated token is the one kept


async def test_rejected_refresh_drops_the_cloud_session(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=-60)
    cloud.post("/auth/refresh").respond(401, json={"detail": {"code": "invalid_refresh"}})
    assert await up.as_person("p-1", "GET", "/kiosk/setup-options") is None
    assert up.has_session("p-1") is False


async def test_no_session_returns_none_without_network(app, cloud):
    assert await app.state.upstream.as_person("nobody", "GET", "/x") is None
    assert len(cloud.calls) == 0


async def test_end_session_logs_out_and_drops(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    logout = cloud.post("/auth/logout").respond(204)
    assert await up.end_session("p-1") is True
    assert logout.calls[0].request.headers["cookie"] == "ss_refresh=r1"
    assert up.has_session("p-1") is False


async def test_tokens_are_encrypted_at_rest(app):
    app.state.upstream.save_session("p-1", refresh_token="r1-secret", access_token="a1-secret",
                                     expires_in=900)
    row = app.state.store.one("SELECT * FROM cloud_sessions WHERE person_id='p-1'")
    assert "r1-secret" not in row["refresh_enc"] and "a1-secret" not in row["access_enc"]


async def test_refresh_cookie_never_leaks_to_other_requests(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=-60)
    cloud.get("/kiosk/setup-options").respond(200, json={})
    cloud.post("/auth/refresh").respond(
        200, json={"access_token": "a2", "expires_in": 900}, headers=_set_cookie("r2"))
    login = cloud.post("/auth/login").respond(200, json={})
    await up.as_person("p-1", "GET", "/kiosk/setup-options")
    await up.request("POST", "/auth/login", json={"email": "x"})
    assert "cookie" not in login.calls[0].request.headers


async def test_refresh_keeps_ending_flag(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=-60)
    up.mark_ending("p-1")
    cloud.get("/kiosk/setup-options").respond(200, json={})
    cloud.post("/auth/refresh").respond(200, json={"access_token": "a2", "expires_in": 900})
    await up.as_person("p-1", "GET", "/kiosk/setup-options")
    assert "p-1" in up.ending_people()


async def test_concurrent_requests_refresh_once(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=-60)
    cloud.get("/kiosk/setup-options").respond(200, json={})
    refresh = cloud.post("/auth/refresh").respond(
        200, json={"access_token": "a2", "expires_in": 900}, headers=_set_cookie("r2"))
    r = await asyncio.gather(*[up.as_person("p-1", "GET", "/kiosk/setup-options")
                               for _ in range(2)])
    assert all(x.status_code == 200 for x in r)
    assert refresh.call_count == 1


async def test_end_session_offline_keeps_session(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    cloud.post("/auth/logout").mock(side_effect=httpx.ConnectError("down"))
    assert await up.end_session("p-1") is False
    assert up.has_session("p-1") is True
