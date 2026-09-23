import pytest
from datetime import UTC, datetime, timedelta
from fastapi.testclient import TestClient

from serversherpa_status.app import create_app
from serversherpa_status.config import load_settings


@pytest.fixture
def client(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html><body>status page</body></html>")
    settings = load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
        "STATUS_STATIC_DIR": str(static),
    })
    app = create_app(settings, start_checker=False)
    with TestClient(app) as c:
        yield c


def test_summary(client):
    now = datetime.now(UTC)
    client.app.state.store.record("api", now, True, 20, "")
    client.app.state.tracker.record("api", True, 20, now)
    resp = client.get("/api/summary")
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    body = resp.json()
    assert body["services"][0]["state"] == "up"
    assert body["services"][0]["days"][-1]["total"] == 1


def test_healthz(client):
    assert client.get("/healthz").json() == {"status": "ok"}


def test_page_served_at_root(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "status page" in resp.text


def test_security_headers_everywhere(client):
    for path in ("/", "/api/summary", "/healthz", "/nope"):
        h = client.get(path).headers
        assert h["x-frame-options"] == "DENY"
        assert h["x-content-type-options"] == "nosniff"
        assert h["referrer-policy"] == "same-origin"


def test_no_writes(client):
    assert client.post("/api/summary").status_code == 405
    assert client.post("/").status_code == 405
    assert client.delete("/healthz").status_code == 405


def test_unknown_path_404(client):
    assert client.get("/nope").status_code == 404


def test_no_openapi_or_docs(client):
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_summary_is_cached_briefly(client, monkeypatch):
    import serversherpa_status.app as app_module

    now = datetime.now(UTC)
    client.app.state.store.record("api", now, True, 20, "")
    client.app.state.tracker.record("api", True, 20, now)
    calls = []
    real = app_module.build_summary

    def counting(*a, **kw):
        calls.append(1)
        return real(*a, **kw)

    monkeypatch.setattr(app_module, "build_summary", counting)
    r1 = client.get("/api/summary")
    r2 = client.get("/api/summary")
    assert r1.status_code == r2.status_code == 200
    assert r1.json() == r2.json()
    assert len(calls) == 1
    assert r2.headers["cache-control"] == "no-store"


def test_head_summary_and_healthz_ok(client):
    r = client.head("/api/summary")
    assert r.status_code == 200
    r2 = client.head("/healthz")
    assert r2.status_code == 200


def test_healthz_ok_without_checker(client):
    # start_checker=False (this fixture) — always ok, no checker attribute needed.
    assert client.get("/healthz").json() == {"status": "ok"}


class FakeChecker:
    """Stand-in for serversherpa_status.checker.Checker: only the two
    attributes /healthz reads, set directly by the test — no real
    background loop, so no race with the request under test."""

    def __init__(self, last_cycle_at=None, store_ok=True):
        self.last_cycle_at = last_cycle_at
        self.store_ok = store_ok


def _client_no_checker_yet(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html><body>status page</body></html>")
    settings = load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
        "STATUS_STATIC_DIR": str(static),
        "STATUS_INTERVAL_SECONDS": "10",
        "STATUS_TIMEOUT_SECONDS": "5",
    })
    # start_checker=False so no real background task races the test; a
    # fake checker is installed on app.state after startup instead.
    return create_app(settings, start_checker=False)


def test_healthz_stale_before_any_cycle_completes(tmp_path):
    app = _client_no_checker_yet(tmp_path)
    with TestClient(app) as c:
        c.app.state.checker = FakeChecker(last_cycle_at=None)
        c.app.state.started_at = datetime.now(UTC) - timedelta(seconds=1000)
        resp = c.get("/healthz")
        assert resp.status_code == 503
        assert resp.json() == {"status": "stale"}


def test_healthz_store_error_after_cycle(tmp_path):
    app = _client_no_checker_yet(tmp_path)
    with TestClient(app) as c:
        c.app.state.checker = FakeChecker(last_cycle_at=datetime.now(UTC), store_ok=False)
        resp = c.get("/healthz")
        assert resp.status_code == 503
        assert resp.json() == {"status": "store_error"}


def test_healthz_ok_after_a_fresh_cycle(tmp_path):
    app = _client_no_checker_yet(tmp_path)
    with TestClient(app) as c:
        c.app.state.checker = FakeChecker(last_cycle_at=datetime.now(UTC), store_ok=True)
        resp = c.get("/healthz")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


def test_seeds_state_from_history(tmp_path):
    settings = load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
        "STATUS_STATIC_DIR": str(tmp_path),
    })
    from serversherpa_status.store import Store
    s = Store(settings.db_path)
    s.record("portal", datetime.now(UTC), True, 9, "")
    s.close()
    with TestClient(create_app(settings, start_checker=False)) as c:
        assert c.get("/api/summary").json()["services"][1]["state"] == "up"
