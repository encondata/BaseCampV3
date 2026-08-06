"""Dev CORS — any origin may consume the API outside production.

Jimmy hits the dev stack from phones/laptops via LAN IPs, .local mDNS
names, and tunnel hostnames; the old private-IP regex silently blocked
everything that wasn't RFC-1918. Production stays allowlist-only
(SS_ALLOWED_ORIGINS) — that path is pinned here too.
"""

from serversherpa.api.app import create_app
from serversherpa.config import get_settings


def _preflight_origin(app, origin: str):
    from starlette.testclient import TestClient

    with TestClient(app) as client:
        resp = client.options(
            "/auth/login",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
    return resp.headers.get("access-control-allow-origin")


async def test_dev_allows_any_origin(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("SS_ENV", "development")
    app = create_app()
    for origin in (
        "http://10.10.48.103:5173",         # LAN IP (worked before)
        "http://jimmys-macbook.local:5173",  # mDNS (blocked before)
        "http://100.101.102.103:5173",       # tailscale CGNAT (blocked before)
        "https://dev.example.com",           # arbitrary domain (blocked before)
    ):
        assert _preflight_origin(app, origin) == origin, origin
    get_settings.cache_clear()


async def test_production_stays_allowlist_only(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("SS_ENV", "production")
    monkeypatch.setenv("SS_ALLOWED_ORIGINS", "https://portal.example.com")
    app = create_app()
    assert _preflight_origin(app, "https://portal.example.com") == \
        "https://portal.example.com"
    assert _preflight_origin(app, "https://evil.example.com") is None
    get_settings.cache_clear()
