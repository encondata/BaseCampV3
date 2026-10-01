import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from sirdar_api.config import Settings, get_settings

ORIGIN = "https://sirdar.example.com"


async def _preflight(origin: str):
    from sirdar_api.api.app import create_app
    async with AsyncClient(transport=ASGITransport(app=create_app()),
                           base_url="http://testserver") as c:
        return await c.options("/api/auth/login", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST"})


@pytest.fixture
def origins(monkeypatch):
    def _set(value):
        if value is None:
            monkeypatch.delenv("SIRDAR_ALLOWED_ORIGINS", raising=False)
        else:
            monkeypatch.setenv("SIRDAR_ALLOWED_ORIGINS", value)
        get_settings.cache_clear()
    yield _set
    monkeypatch.undo()
    get_settings.cache_clear()


async def test_allowed_origin_gets_cors_headers(origins):
    origins(ORIGIN + "/")  # trailing slash is stripped
    r = await _preflight(ORIGIN)
    assert r.headers["access-control-allow-origin"] == ORIGIN
    assert r.headers["access-control-allow-credentials"] == "true"


async def test_other_origin_gets_none(origins):
    origins(ORIGIN)
    r = await _preflight("https://evil.example.com")
    assert "access-control-allow-origin" not in r.headers


async def test_unset_means_no_cors(origins):
    origins(None)
    r = await _preflight(ORIGIN)
    assert "access-control-allow-origin" not in r.headers


@pytest.mark.parametrize("bad", ["https://x.com/path", "ftp://x", "x.com", "https://"])
def test_settings_reject_bad_origin(monkeypatch, bad):
    monkeypatch.setenv("SIRDAR_ALLOWED_ORIGINS", bad)
    with pytest.raises(ValidationError):
        Settings()


def test_settings_parse_list(monkeypatch):
    monkeypatch.setenv("SIRDAR_ALLOWED_ORIGINS", " https://a.com/ , http://b.com:8080 ")
    assert Settings().allowed_origin_list == ["https://a.com", "http://b.com:8080"]
