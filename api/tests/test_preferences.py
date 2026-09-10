"""UI preferences: defaults, persistence across logins, validation."""

LOGIN = {"email": "alice@test.example.com", "password": "CorrectHorse9!"}

PREFS = {
    "accent": "aqua",
    "theme": "dark",
    "density": "compact",
    "list_size": "default",
    "motion": False,
    "notif": {"critical": True, "email": False, "maint": True, "digest": True, "sound": "ping"},
    "list_prefs": {
        "sites": {
            "visible": ["name", "status", "city"],
            "sortKey": "name",
            "sortDir": 1,
            "filters": {"status": {"values": ["active"]}},
        },
    },
    "nav_mode": "expanded",
    "nav_bg": "default",
    "nav_size": "default",
}


async def _login(client):
    resp = await client.post("/auth/login", json=LOGIN)
    assert resp.status_code == 200
    return resp.json()


async def test_login_returns_default_preferences(client, seeded_user):
    body = await _login(client)
    assert body["preferences"] == {
        "accent": "amber", "theme": "light", "density": "comfortable",
        "list_size": "default",
        "motion": True,
        "notif": {"critical": True, "email": True, "maint": True, "digest": False, "sound": "chime"},
        "list_prefs": {},
        "nav_mode": "expanded",
        "nav_bg": "default",
        "nav_size": "default",
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


async def test_list_prefs_round_trip(client, seeded_user):
    """list_prefs is free-form and survives the PUT exactly, per-page."""
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}

    resp = await client.put("/auth/me/preferences", json=PREFS, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["list_prefs"] == PREFS["list_prefs"]

    me = await client.get("/auth/me", headers=headers)
    assert me.json()["preferences"]["list_prefs"] == PREFS["list_prefs"]


async def test_list_prefs_defaults_empty_when_absent(client, seeded_user):
    """A PUT that omits list_prefs (an older client, or a page that never
    touched it) must not error — it defaults to {}, not None or a 422."""
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}

    prefs_without_list = {k: v for k, v in PREFS.items() if k != "list_prefs"}
    resp = await client.put("/auth/me/preferences", json=prefs_without_list, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["list_prefs"] == {}


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


async def test_list_size_round_trips_and_defaults(client, seeded_user):
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}

    resp = await client.get("/auth/me", headers=headers)
    assert resp.json()["preferences"]["list_size"] == "default"

    prefs = {**resp.json()["preferences"], "list_size": "xlarge"}
    resp = await client.put("/auth/me/preferences", headers=headers, json=prefs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["list_size"] == "xlarge"

    resp = await client.put(
        "/auth/me/preferences", headers=headers, json={**prefs, "list_size": "huge"},
    )
    assert resp.status_code == 422


async def test_nav_preferences_persist(client, seeded_user):
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}

    nav_prefs = {
        **PREFS,
        "nav_mode": "rail",
        "nav_bg": "#0f2a4a",
        "nav_size": "large",
    }
    resp = await client.put("/auth/me/preferences", json=nav_prefs, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["nav_mode"] == "rail"
    assert resp.json()["nav_bg"] == "#0f2a4a"
    assert resp.json()["nav_size"] == "large"

    fresh = await _login(client)
    assert fresh["preferences"]["nav_mode"] == "rail"
    assert fresh["preferences"]["nav_bg"] == "#0f2a4a"
    assert fresh["preferences"]["nav_size"] == "large"


async def test_invalid_nav_values_rejected(client, seeded_user):
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}

    resp = await client.put(
        "/auth/me/preferences",
        json={**PREFS, "nav_mode": "tiny"},
        headers=headers,
    )
    assert resp.status_code == 422

    resp = await client.put(
        "/auth/me/preferences",
        json={**PREFS, "nav_bg": "red"},
        headers=headers,
    )
    assert resp.status_code == 422

    # accepted, case preserved exactly like the accent validator
    resp = await client.put(
        "/auth/me/preferences",
        json={**PREFS, "nav_bg": "#0F2A4A"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["nav_bg"] == "#0F2A4A"


async def test_invalid_notification_sound_rejected(client, seeded_user):
    body = await _login(client)
    hdrs = {"Authorization": f"Bearer {body['access_token']}"}
    bad = {**body["preferences"], "notif": {**body["preferences"]["notif"], "sound": "klaxon"}}
    resp = await client.put("/auth/me/preferences", headers=hdrs, json=bad)
    assert resp.status_code == 422
