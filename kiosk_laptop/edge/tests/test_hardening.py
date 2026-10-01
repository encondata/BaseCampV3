"""Path escapes never reach the cloud, and only local Host names are
served (a DNS-rebinding page can't drive the edge from another origin)."""

import dataclasses

import httpx
import pytest
from tests.conftest import make_session

from edge.app import create_app


@pytest.mark.parametrize("path", [
    "/kiosk/%2e%2e/admin/users",
    "/kiosk/%2E%2E/admin/users",
    "/kiosk/%2e/sync/people",
    "/kiosk/a%2fb",
    "/kiosk/a%2Fb",
    "/kiosk/a%5cb",
    "/kiosk/%252e%252e/admin/users",
    "/kiosk/a%2525b",
    "/auth/%2e%2e/admin/users",
    "/system/%2e%2e%2fadmin",
])
async def test_path_escapes_are_404_and_never_proxied(app, client, cloud, path):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    route = cloud.route().respond(200, json={"leaked": True})
    for method in ("GET", "POST"):
        r = await client.request(method, path, headers=make_session(app))
        assert r.status_code == 404, (method, path)
        assert "leaked" not in r.text
    assert not route.called


async def test_ordinary_api_paths_still_proxied(app, client, cloud):
    route = cloud.get("/system/status").respond(200, json={"ok": 1})
    r = await client.get("/system/status")
    assert r.status_code == 200 and route.called


async def test_foreign_host_header_is_400(client):
    r = await client.get("/edge/identity", headers={"host": "evil.example.com"})
    assert r.status_code == 400
    r = await client.get("/edge/identity", headers={"host": "evil.example.com:8090"})
    assert r.status_code == 400


@pytest.mark.parametrize("host", ["localhost:8090", "127.0.0.1:8090", "[::1]:8090", "localhost",
                                  "edge.test"])
async def test_local_hosts_are_served(client, host):
    r = await client.get("/edge/identity", headers={"host": host})
    assert r.status_code == 200


async def test_extra_allowed_hosts_from_settings(settings, cloud):
    app = create_app(dataclasses.replace(settings, allowed_hosts=("kiosk.lan",)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://kiosk.lan") as c:
        assert (await c.get("/edge/identity")).status_code == 200
        r = await c.get("/edge/identity", headers={"host": "other.lan"})
        assert r.status_code == 400


def test_allowed_hosts_env_parsed(monkeypatch):
    from edge.config import load_settings
    monkeypatch.setenv("EDGE_CLOUD_API_URL", "http://cloud.test")
    monkeypatch.setenv("EDGE_ALLOWED_HOSTS", " kiosk.lan, dock3.local ,,")
    assert load_settings().allowed_hosts == ("kiosk.lan", "dock3.local")
    monkeypatch.delenv("EDGE_ALLOWED_HOSTS")
    assert load_settings().allowed_hosts == ()
