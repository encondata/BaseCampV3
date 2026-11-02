"""UI preferences: defaults, persistence across logins, validation."""

import pytest
from pydantic import ValidationError

LOGIN = {"email": "alice@test.example.com", "password": "CorrectHorse9!"}

ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

PREFS = {
    "accent": "aqua",
    "theme": "dark",
    "density": "compact",
    "list_size": "default",
    "motion": False,
    "notif": {
        "sound": "ping",
        # only the person's own values: an absent key follows the company default
        "switches": {"reports": {"email": False}, "wiki": {"inbox": False, "email": False}},
        "schedule": {"timezone": "America/Chicago", "days": ["mon", "tue", "wed", "thu", "fri"],
                     "quiet_start": "21:00", "quiet_end": "06:00"},
    },
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
    "list_view": "last",
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
        "notif": {"sound": "chime", "switches": {},
                  "schedule": {"timezone": None, "days": ALL_DAYS,
                               "quiet_start": None, "quiet_end": None}},
        "list_prefs": {},
        "nav_mode": "expanded",
        "nav_bg": "default",
        "nav_size": "default",
        "list_view": "expanded",
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


def _with_notif(**notif):
    """PREFS with some of its notif values replaced."""
    return {**PREFS, "notif": {**PREFS["notif"], **notif}}


async def _put(client, **notif):
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    return await client.put("/auth/me/preferences", json=_with_notif(**notif), headers=headers)


@pytest.mark.parametrize("schedule,code", [
    ({"timezone": "Not/AZone"}, "invalid_timezone"),
    ({"timezone": ""}, "invalid_timezone"),
    ({"days": []}, "invalid_days"),
    ({"days": ["mon", "funday"]}, "invalid_days"),
    ({"days": ["mon", "mon"]}, "invalid_days"),
    ({"quiet_start": "21:00", "quiet_end": "21:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "21:00", "quiet_end": "21:00:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "21:00", "quiet_end": None}, "invalid_quiet_hours"),
    ({"quiet_start": None, "quiet_end": "06:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "25:00", "quiet_end": "06:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "21:00", "quiet_end": "9pm"}, "invalid_quiet_hours"),
])
async def test_invalid_schedule_is_rejected_with_its_code(client, seeded_user, schedule, code):
    resp = await _put(client, schedule={**PREFS["notif"]["schedule"], **schedule})
    assert resp.status_code == 422
    assert any(code in error["msg"] for error in resp.json()["detail"]), resp.text


@pytest.mark.parametrize("schedule", [
    {"timezone": "Not/AZone"},
    {"days": []},
    {"quiet_start": "21:00"},
    {"quiet_start": "09:00", "quiet_end": "09:00"},
])
async def test_a_partial_schedule_is_checked_against_the_defaults(client, seeded_user, schedule):
    """A schedule that names only some keys: the others take their defaults,
    so the one that was given is the one that fails."""
    assert (await _put(client, schedule=schedule)).status_code == 422


async def test_schedule_clock_times_round_trip_normalized(client, seeded_user):
    schedule = {"timezone": "America/Chicago", "days": ["fri", "mon", "wed"],
                "quiet_start": "21:00:00", "quiet_end": "06:00"}
    resp = await _put(client, schedule=schedule)
    assert resp.status_code == 200, resp.text
    expected = {"timezone": "America/Chicago", "days": ["mon", "wed", "fri"],
                "quiet_start": "21:00", "quiet_end": "06:00"}
    assert resp.json()["notif"]["schedule"] == expected
    # what was stored is the normalized form, not the request's
    assert (await _login(client))["preferences"]["notif"]["schedule"] == expected


async def test_an_overnight_window_and_an_unset_zone_are_accepted(client, seeded_user):
    schedule = {"timezone": None, "days": ALL_DAYS, "quiet_start": "21:00", "quiet_end": "06:00"}
    resp = await _put(client, schedule=schedule)
    assert resp.status_code == 200, resp.text
    assert resp.json()["notif"]["schedule"] == schedule


async def test_switches_drop_security_unknown_and_empty_entries(client, seeded_user):
    switches = {"wiki": {"email": False}, "security": {"inbox": False, "email": False},
                "nope": {"inbox": False}, "reports": {}, "learning": {"inbox": None, "email": None}}
    resp = await _put(client, switches=switches)
    assert resp.status_code == 200, resp.text
    assert resp.json()["notif"]["switches"] == {"wiki": {"email": False}}
    assert (await _login(client))["preferences"]["notif"]["switches"] == {"wiki": {"email": False}}


async def test_switches_hold_only_the_values_a_person_set(client, seeded_user):
    """An unset value is absent, not null: absent means "follows the default"."""
    switches = {"approvals": {"inbox": False}, "learning": {"inbox": True, "email": None}}
    resp = await _put(client, switches=switches)
    assert resp.json()["notif"]["switches"] == {
        "approvals": {"inbox": False}, "learning": {"inbox": True}}


async def test_an_older_client_that_still_sends_categories_is_ignored_not_refused(
        client, seeded_user):
    resp = await _put(client, categories={"wiki": "sms"})     # not even a valid old choice
    assert resp.status_code == 200, resp.text
    assert "categories" not in resp.json()["notif"]


def test_legacy_notif_blob_parses_without_its_old_keys():
    from serversherpa.api.schemas import UiPreferences

    old = {"notif": {"categories": {"reports": "inbox"}, "critical": True, "digest": "daily",
                     "email": False, "maint": True, "sound": "pop"}}
    prefs = UiPreferences.model_validate(old)
    assert prefs.notif.sound == "pop"
    assert prefs.notif.switches == {}
    dumped = prefs.notif.model_dump()
    assert set(dumped) == {"sound", "switches", "schedule"}


def test_switches_validator_keeps_only_configurable_categories_with_a_value():
    from serversherpa.api.schemas import NotifPrefs

    prefs = NotifPrefs.model_validate({"switches": {
        "wiki": {"email": False}, "bogus": {"email": False}, "security": {"email": False},
        "reports": {"inbox": None, "email": None}, "approvals": {}}})
    assert list(prefs.switches) == ["wiki"]
    assert prefs.switches["wiki"].model_dump() == {"email": False}


def test_switches_come_back_in_registry_order():
    from serversherpa.api.schemas import NotifPrefs

    prefs = NotifPrefs.model_validate({"switches": {
        "learning": {"email": False}, "wiki": {"email": False}, "approvals": {"email": False}}})
    assert list(prefs.switches) == ["approvals", "wiki", "learning"]


def test_default_notif_has_no_own_switches_and_an_open_schedule():
    from serversherpa.api.schemas import UiPreferences

    notif = UiPreferences().notif
    assert notif.switches == {}
    assert notif.schedule.model_dump() == {
        "timezone": None, "days": ALL_DAYS, "quiet_start": None, "quiet_end": None}


def test_a_default_schedule_is_not_shared_between_instances():
    from serversherpa.api.schemas import NotifPrefs, NotifSchedule, SwitchOverride, UiPreferences

    a, b = NotifPrefs(), NotifPrefs()
    a.schedule.days.remove("sun")
    a.switches["wiki"] = SwitchOverride(email=False)
    assert b.schedule.days == ALL_DAYS and b.switches == {}
    assert NotifSchedule().days == ALL_DAYS

    # UiPreferences' own default notif is one instance too: it must be copied per use
    first, second = UiPreferences(), UiPreferences()
    first.notif.schedule.days.remove("sun")
    first.notif.switches["wiki"] = SwitchOverride(email=False)
    assert second.notif.schedule.days == ALL_DAYS and second.notif.switches == {}
    assert UiPreferences().notif.schedule.days == ALL_DAYS


@pytest.mark.parametrize("days,expected", [
    (["sun", "mon"], ["mon", "sun"]),
    (["fri", "tue", "mon"], ["mon", "tue", "fri"]),
    (ALL_DAYS, ALL_DAYS),
])
def test_schedule_days_come_back_in_week_order(days, expected):
    from serversherpa.api.schemas import NotifSchedule

    assert NotifSchedule(days=days).days == expected


@pytest.mark.parametrize("kwargs,code", [
    ({"timezone": "Not/AZone"}, "invalid_timezone"),
    ({"timezone": "../etc/passwd"}, "invalid_timezone"),
    ({"timezone": "America"}, "invalid_timezone"),           # a directory, not a zone
    ({"days": []}, "invalid_days"),
    ({"days": ["Mon"]}, "invalid_days"),
    ({"days": ["mon", "mon"]}, "invalid_days"),
    ({"quiet_start": "21:00"}, "invalid_quiet_hours"),
    ({"quiet_end": "06:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "06:00", "quiet_end": "06:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "24:00", "quiet_end": "06:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "21:60", "quiet_end": "06:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "9:00", "quiet_end": "06:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "21:00:61", "quiet_end": "06:00"}, "invalid_quiet_hours"),
    ({"quiet_start": "", "quiet_end": "06:00"}, "invalid_quiet_hours"),
])
def test_schedule_rules_use_their_code_as_the_message(kwargs, code):
    from serversherpa.api.schemas import NotifSchedule

    with pytest.raises(ValidationError) as caught:
        NotifSchedule(**kwargs)
    assert [error["msg"] for error in caught.value.errors()] == [f"Value error, {code}"]


def test_schedule_accepts_seconds_and_drops_them():
    from serversherpa.api.schemas import NotifSchedule

    s = NotifSchedule(quiet_start="21:00:00", quiet_end="06:30:00")
    assert (s.quiet_start, s.quiet_end) == ("21:00", "06:30")


async def test_list_view_rejects_unknown_value(client, seeded_user):
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    resp = await client.put("/auth/me/preferences",
                            json={**PREFS, "list_view": "sideways"}, headers=headers)
    assert resp.status_code == 422


async def test_list_view_defaults_when_absent(client, seeded_user):
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    legacy = {k: v for k, v in PREFS.items() if k != "list_view"}
    resp = await client.put("/auth/me/preferences", json=legacy, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["list_view"] == "expanded"
