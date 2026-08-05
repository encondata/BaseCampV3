"""UI preferences: defaults, persistence across logins, validation."""

LOGIN = {"email": "alice@test.example.com", "password": "CorrectHorse9!"}

PREFS = {
    "accent": "aqua",
    "theme": "dark",
    "density": "compact",
    "motion": False,
    "notif": {"critical": True, "email": False, "maint": True, "digest": True},
}


async def _login(client):
    resp = await client.post("/auth/login", json=LOGIN)
    assert resp.status_code == 200
    return resp.json()


async def test_login_returns_default_preferences(client, seeded_user):
    body = await _login(client)
    assert body["preferences"] == {
        "accent": "amber", "theme": "light", "density": "comfortable",
        "motion": True,
        "notif": {"critical": True, "email": True, "maint": True, "digest": False},
    }


async def test_preferences_persist_across_logins(client, seeded_user):
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}

    resp = await client.put("/auth/me/preferences", json=PREFS, headers=headers)
    assert resp.status_code == 200
    assert resp.json() == PREFS

    # a completely fresh login sees the saved preferences
    fresh = await _login(client)
    assert fresh["preferences"] == PREFS

    # and /auth/me agrees
    me = await client.get("/auth/me", headers={
        "Authorization": f"Bearer {fresh['access_token']}"})
    assert me.json()["preferences"] == PREFS


async def test_invalid_accent_rejected(client, seeded_user):
    body = await _login(client)
    resp = await client.put(
        "/auth/me/preferences",
        json={**PREFS, "accent": "hotdog"},
        headers={"Authorization": f"Bearer {body['access_token']}"},
    )
    assert resp.status_code == 422


async def test_preferences_require_auth(client):
    assert (await client.put("/auth/me/preferences", json=PREFS)).status_code == 401
