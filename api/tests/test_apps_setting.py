"""SS_APPS: which optional apps this environment runs (deploy/stack's
STACK_APPS). Unset or empty means every app is on; "none" means none."""

import pytest

from serversherpa.config import Settings


@pytest.fixture
def apps_env(monkeypatch):
    from serversherpa.config import get_settings

    def set_apps(raw: str) -> None:
        monkeypatch.setenv("SS_APPS", raw)
        get_settings.cache_clear()

    yield set_apps
    get_settings.cache_clear()


@pytest.mark.parametrize("raw, apps", [
    ("", []), (" ", []), ("wiki,kiosk", ["wiki", "kiosk"]),
    ("Wiki, LEARN ,", ["wiki", "learn"]), ("none", ["none"]),
])
def test_the_setting_is_split_trimmed_and_lowercased(monkeypatch, raw, apps):
    monkeypatch.setenv("SS_APPS", raw)
    assert Settings().apps == apps


@pytest.mark.parametrize("raw, on", [
    ("", {"wiki": True, "kiosk": True, "learn": True}),
    ("none", {"wiki": False, "kiosk": False, "learn": False}),
    ("kiosk,status", {"wiki": False, "kiosk": True, "learn": False}),
    ("wiki,learn,mailpit", {"wiki": True, "kiosk": False, "learn": True}),
])
def test_app_on(monkeypatch, raw, on):
    monkeypatch.setenv("SS_APPS", raw)
    settings = Settings()
    assert {app: settings.app_on(app) for app in on} == on


async def test_the_status_says_which_apps_run(client, apps_env):
    apps_env("kiosk,status")
    body = (await client.get("/system/status")).json()
    assert body["apps"] == {"wiki": False, "kiosk": True, "learn": False}
    apps_env("")
    body = (await client.get("/system/status")).json()
    assert body["apps"] == {"wiki": True, "kiosk": True, "learn": True}
