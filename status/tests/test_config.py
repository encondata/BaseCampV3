import pytest

from serversherpa_status.config import ConfigError, load_settings, stale_after_seconds

BASE = {
    "STATUS_API_URL": "https://api.example.com/",
    "STATUS_PORTAL_URL": "https://portal.example.com",
    "STATUS_KIOSK_URL": "https://kiosk.example.com//",
}


def test_defaults_and_trailing_slashes_stripped():
    s = load_settings(BASE)
    assert [(x.key, x.name, x.url) for x in s.services] == [
        ("api", "API", "https://api.example.com"),
        ("portal", "Portal", "https://portal.example.com"),
        ("kiosk", "Kiosk", "https://kiosk.example.com"),
    ]
    assert s.interval_seconds == 60
    assert s.timeout_seconds == 10
    assert s.failure_threshold == 2
    assert s.db_path == "/data/status.db"
    assert s.static_dir.endswith("static")


@pytest.mark.parametrize("missing", list(BASE))
def test_missing_url_names_the_variable(missing):
    env = {k: v for k, v in BASE.items() if k != missing}
    with pytest.raises(ConfigError, match=missing):
        load_settings(env)


def test_blank_url_is_missing():
    with pytest.raises(ConfigError, match="STATUS_API_URL"):
        load_settings({**BASE, "STATUS_API_URL": "  "})


def test_url_must_be_http():
    with pytest.raises(ConfigError, match="STATUS_PORTAL_URL"):
        load_settings({**BASE, "STATUS_PORTAL_URL": "portal.example.com"})


def test_overrides():
    s = load_settings({
        **BASE,
        "STATUS_INTERVAL_SECONDS": "15",
        "STATUS_TIMEOUT_SECONDS": "3.5",
        "STATUS_FAILURE_THRESHOLD": "3",
        "STATUS_DB_PATH": "/tmp/x.db",
        "STATUS_STATIC_DIR": "/srv/page",
    })
    assert (s.interval_seconds, s.timeout_seconds, s.failure_threshold) == (15, 3.5, 3)
    assert (s.db_path, s.static_dir) == ("/tmp/x.db", "/srv/page")


@pytest.mark.parametrize("var,value", [
    ("STATUS_INTERVAL_SECONDS", "5"),
    ("STATUS_INTERVAL_SECONDS", "soon"),
    ("STATUS_TIMEOUT_SECONDS", "0"),
    ("STATUS_FAILURE_THRESHOLD", "0"),
    ("STATUS_FAILURE_THRESHOLD", "1.5"),
])
def test_bad_numbers_rejected(var, value):
    with pytest.raises(ConfigError, match=var):
        load_settings({**BASE, var: value})


def test_stale_after_seconds_is_three_intervals_plus_timeout():
    s = load_settings({**BASE, "STATUS_INTERVAL_SECONDS": "20", "STATUS_TIMEOUT_SECONDS": "5"})
    assert stale_after_seconds(s) == 65
