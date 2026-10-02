import json

import pytest

from sirdar_api.config import get_settings
from sirdar_api.dashboard import service
from sirdar_api.dashboard.demo import demo_dashboard
from sirdar_api.deploy import digitalocean

from .api_helpers import auth_headers
from .test_dashboard_inventory import do_transport
from .test_deploy_digitalocean import TOKEN


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    service.clear_cache()
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", "")
    get_settings.cache_clear()
    yield
    service.clear_cache()
    get_settings.cache_clear()


@pytest.fixture
def with_token(monkeypatch):
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", TOKEN)
    get_settings.cache_clear()
    holder = {"transport": do_transport(), "calls": 0}
    real = digitalocean.inventory

    async def fake(settings, *, transport=None):
        holder["calls"] += 1
        return await real(settings, transport=holder["transport"])
    monkeypatch.setattr(digitalocean, "inventory", fake)
    return holder


async def test_real_no_token(client, db):
    h = await auth_headers(client, db)
    r = await client.get("/api/dashboard", headers=h)
    assert r.status_code == 200
    d = r.json()
    assert d["demo"] is False
    assert d["health"] == {"status": "unknown", "label": "No environments deployed"}
    assert d["infrastructure"] == {"source": "none", "error": None, "tree": []}
    p = d["production"]
    assert (p["status"], p["active_slot"]) == ("inactive", None)
    assert p["load_balancer"] == {"label": "Load balancer", "sub": "Not configured",
                                  "present": False}
    assert [s["id"] for s in p["slots"]] == ["blue", "green"]
    assert all(s["state"] == "empty" and s["version"] is None and s["traffic_pct"] == 0
               and s["instances"] == {"running": 0, "total": 0} for s in p["slots"])
    assert [(e["id"], e["state"], e["last_release"]) for e in d["environments"]] == \
        [("dev", "empty", None), ("beta", "empty", None)]


async def test_real_with_inventory(client, db, with_token):
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard", headers=h)).json()
    assert d["infrastructure"]["source"] == "digitalocean"
    assert d["infrastructure"]["error"] is None
    assert [n["name"] for n in d["infrastructure"]["tree"]][-1] == "Untagged"
    assert d["production"]["load_balancer"]["present"] is True
    assert [e["id"] for e in d["environments"]] == ["dev", "beta", "qa-team"]
    assert d["environments"][2]["label"] == "Qa Team"
    assert TOKEN not in json.dumps(d)


async def test_cache_and_refresh(client, db, with_token):
    h = await auth_headers(client, db)
    await client.get("/api/dashboard", headers=h)
    await client.get("/api/dashboard", headers=h)
    assert with_token["calls"] == 1
    await client.get("/api/dashboard?refresh=1", headers=h)
    assert with_token["calls"] == 2


async def test_do_401_still_200(client, db, with_token):
    with_token["transport"] = do_transport(status=401)
    h = await auth_headers(client, db)
    r = await client.get("/api/dashboard", headers=h)
    assert r.status_code == 200
    infra = r.json()["infrastructure"]
    assert infra["source"] == "digitalocean" and infra["tree"] == []
    assert infra["error"] == "DigitalOcean rejected the API token."
    assert TOKEN not in r.text


async def test_demo(client, db):
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard?demo=1", headers=h)).json()
    assert d["demo"] is True and d["infrastructure"]["source"] == "demo"
    assert d["health"] == {"status": "healthy", "label": "All systems healthy"}
    blue, green = d["production"]["slots"]
    assert (blue["version"], blue["traffic_pct"], blue["instances"]) == \
        ("v2.8.0", 100, {"running": 3, "total": 3})
    assert (green["state"], green["version"], green["instances"]["total"]) == ("standby", "v2.7.9", 3)
    assert [(e["id"], e["last_release"]) for e in d["environments"]] == \
        [("dev", "v2.8.1-dev"), ("beta", "v2.8.1-rc.2")]
    tree = d["infrastructure"]["tree"]
    assert [n["name"] for n in tree] == ["Production", "Development", "Beta"]
    blue_n, green_n, shared = tree[0]["children"]
    assert [c["endpoint"] for c in blue_n["children"]] == [f"10.20.0.{i}" for i in range(10, 14)]
    assert [c["endpoint"] for c in green_n["children"]] == [f"10.20.0.{i}" for i in range(20, 24)]
    assert green_n["status_label"] == "Standby" and shared["badge"] == "Blue + Green"
    assert shared["tone"] == "shared" and blue_n["tone"] is None
    assert [c["name"] for c in tree[1]["children"]] == ["dev-web", "dev-db", "dev-spaces"]


def test_demo_shape_is_stable():
    d = demo_dashboard()
    assert set(d) == {"demo", "generated_at", "health", "production", "environments",
                      "infrastructure"}

    def walk(n):
        assert set(n) == {"id", "name", "kind", "type_label", "status", "status_label", "region",
                          "endpoint", "badge", "dot", "tone", "children"}
        for c in n["children"]:
            walk(c)
    for n in d["infrastructure"]["tree"]:
        walk(n)


async def test_permission(client, db):
    assert (await client.get("/api/dashboard")).status_code == 401
    for i, role in enumerate(("admin", "founder", "super_admin", "developer")):
        h = await auth_headers(client, db, email=f"u{i}@test.example.com", roles=(role,))
        assert (await client.get("/api/dashboard", headers=h)).status_code == 200


async def test_cache_keyed_by_token_hash(client, db, with_token, monkeypatch):
    h = await auth_headers(client, db)
    await client.get("/api/dashboard", headers=h)
    assert TOKEN not in service._cache
    assert all(TOKEN not in k for k in service._cache)
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", TOKEN + "-other")
    get_settings.cache_clear()
    await client.get("/api/dashboard", headers=h)
    assert with_token["calls"] == 2


async def test_failure_negative_cache(client, db, with_token):
    with_token["transport"] = do_transport(status=401)
    h = await auth_headers(client, db)
    r1 = await client.get("/api/dashboard", headers=h)
    r2 = await client.get("/api/dashboard", headers=h)
    assert with_token["calls"] == 1
    assert r2.json()["infrastructure"]["error"] == r1.json()["infrastructure"]["error"]
    await client.get("/api/dashboard?refresh=1", headers=h)
    assert with_token["calls"] == 2
