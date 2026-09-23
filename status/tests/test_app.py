import pytest
from datetime import UTC, datetime
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
