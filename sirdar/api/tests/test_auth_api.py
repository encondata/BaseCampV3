from datetime import UTC, datetime

import pyotp

from sirdar_api.config import get_settings
from sirdar_api.security.totp import encrypt_secret

from .factories import PASSWORD, make_user


async def _login(client, email="alice@test.example.com", password=PASSWORD):
    return await client.post("/api/auth/login", json={"email": email, "password": password})


async def test_login_returns_portal_session_shape_and_cookie(client, db):
    await make_user(db, roles=("super_admin",))
    resp = await _login(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    for key in ("access_token", "expires_in", "session_expires_at", "person", "roles",
                "must_change_password", "preferences", "perms", "max_rank", "scope",
                "password_min_length", "totp"):
        assert key in body, key
    assert body["person"]["display_name"] == "Alice Anderson"
    assert body["scope"] == {"global": True, "client_ids": [], "partner_ids": []}
    assert body["perms"]["users"]["add"] is True
    assert body["preferences"]["nav_mode"] == "expanded"
    cookie = resp.headers["set-cookie"]
    assert "sirdar_refresh=" in cookie and "Path=/api/auth" in cookie and "HttpOnly" in cookie


async def test_login_errors_use_portal_codes(client, db):
    await make_user(db, must_change_password=True)
    bad = await _login(client, password="wrong")
    assert bad.status_code == 401 and bad.json() == {"detail": {"code": "invalid_credentials"}}
    must = await _login(client)
    assert must.status_code == 403
    assert must.json()["detail"]["code"] == "password_change_required"


async def test_totp_challenge_flow(client, db):
    seed = pyotp.random_base32()
    key = get_settings().totp_encryption_key.get_secret_value()
    await make_user(db, totp_secret_enc=encrypt_secret(seed, key=key),
                    totp_confirmed_at=datetime.now(UTC), totp_enabled=True)
    first = await _login(client)
    assert first.status_code == 200
    challenge = first.json()
    assert challenge["status"] == "totp_verify" and challenge["challenge_token"]
    missing = await client.post("/api/auth/totp/verify", json={"code": "123456"})
    assert missing.status_code == 401 and missing.json()["detail"]["code"] == "invalid_challenge"
    ok = await client.post("/api/auth/totp/verify",
                           json={"code": pyotp.TOTP(seed).now(), "remember": True},
                           headers={"X-Totp-Challenge": challenge["challenge_token"]})
    assert ok.status_code == 200 and ok.json()["status"] == "ok"


async def test_refresh_me_preferences_logout(client, db):
    await make_user(db)
    login = await _login(client)
    token = login.json()["access_token"]
    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200 and me.json()["person"]["email"] == "alice@test.example.com"
    prefs = await client.put("/api/auth/me/preferences",
                             headers={"Authorization": f"Bearer {token}"},
                             json={**login.json()["preferences"], "nav_mode": "rail"})
    assert prefs.status_code == 200 and prefs.json()["nav_mode"] == "rail"
    refreshed = await client.post("/api/auth/refresh")       # httpx keeps the cookie jar
    assert refreshed.status_code == 200
    assert refreshed.json()["preferences"]["nav_mode"] == "rail"
    out = await client.post("/api/auth/logout")
    assert out.status_code == 204
    again = await client.post("/api/auth/refresh")
    assert again.status_code == 401
    assert again.json()["detail"]["code"] in ("missing_refresh", "invalid_session")


async def test_refresh_without_cookie(client):
    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "missing_refresh"


async def test_me_requires_token_and_rejects_disabled(client, db):
    assert (await client.get("/api/auth/me")).json()["detail"]["code"] == "missing_token"
    user = await make_user(db)
    token = (await _login(client)).json()["access_token"]
    user.disabled_at = datetime.now(UTC)
    await db.commit()
    resp = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "account_disabled"


async def test_system_status(client, db):
    resp = await client.get("/api/system/status")
    assert resp.json() == {"read_only": False, "read_only_message": "", "workers_paused": False,
                           "banner": None, "totp_trust_days": 0, "needs_setup": True}
    await make_user(db)
    assert (await client.get("/api/system/status")).json()["needs_setup"] is False
