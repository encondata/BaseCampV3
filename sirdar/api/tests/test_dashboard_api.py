import json
from datetime import UTC, datetime

import pytest

from sirdar_api.config import get_settings
from sirdar_api.dashboard import service
from sirdar_api.dashboard.demo import demo_dashboard
from sirdar_api.db.models import Deployment
from sirdar_api.deploy import digitalocean

from .api_helpers import auth_headers
from .deploy_factories import make_environment
from .test_dashboard_inventory import do_transport
from .test_deploy_digitalocean import TOKEN

SHA = "e73b99ca" + "1" * 32


def _plain(card: dict) -> dict:
    """A card without the spotlight fields (test_dashboard_flow covers them)."""
    return {k: v for k, v in card.items() if k not in ("flow", "production")}


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
    assert d["infrastructure"] == {"source": "none", "error": None, "tree": [], "accounts": []}
    assert "production" not in d
    assert [(e["id"], e["state"], e["last_release"], e["environment"], e["action_label"])
            for e in d["environments"]] == \
        [("production", "empty", None, None, "Set up Production"),
         ("dev", "empty", None, None, "Set up Dev"), ("beta", "empty", None, None, "Set up Beta")]


async def test_real_with_inventory(client, db, with_token):
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard", headers=h)).json()
    assert d["infrastructure"]["source"] == "digitalocean"
    assert d["infrastructure"]["error"] is None
    assert [n["name"] for n in d["infrastructure"]["tree"]][-1] == "Untagged"
    assert [e["id"] for e in d["environments"]] == ["production", "dev", "beta", "qa-team"]
    assert d["environments"][3]["label"] == "Qa Team"
    assert d["infrastructure"]["accounts"] == [
        {"key": "production", "label": "Production", "error": None}]
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
    assert infra["accounts"] == [{"key": "production", "label": "Production",
                                  "error": "DigitalOcean rejected the API token."}]
    assert TOKEN not in r.text


async def test_demo(client, db):
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard?demo=1", headers=h)).json()
    assert d["demo"] is True and d["infrastructure"]["source"] == "demo"
    assert d["health"] == {"status": "healthy", "label": "All systems healthy"}
    prod, dev, uat = d["environments"]
    blue, green = prod["flow"]["servers"]
    assert (blue["state"], blue["version"], green["state"], green["version"]) == (
        "live", "v2.8.0", "idle", "v2.7.9")
    assert (prod["flow"]["active_slot"], dev["flow"]["active_slot"]) == ("blue", "orange")
    assert uat["flow"]["middle"]["label"] == "Nginx Proxy Manager"
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
    assert set(d) == {"demo", "generated_at", "health", "environments", "infrastructure"}

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


async def test_real_environments(client, db):
    uat = await make_environment(db, name="uat", current_sha=SHA, secrets={})
    qa = await make_environment(db, name="qa-east", status="failed", secrets={})
    qa.type = "custom"
    db.add(Deployment(environment_id=uat.id, mode="adopt", git_ref="main", sha=SHA,
                      status="adopted", start_step=1,
                      finished_at=datetime(2026, 10, 3, 12, 0, tzinfo=UTC)))
    db.add(Deployment(environment_id=uat.id, mode="update", git_ref="main", sha="b" * 40,
                      status="failed", start_step=1,
                      finished_at=datetime(2026, 10, 3, 13, 0, tzinfo=UTC)))
    await db.commit()
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard", headers=h)).json()
    assert (d["environments"][0]["id"], d["environments"][0]["environment"]) == (
        "production", None)
    assert [_plain(c) for c in d["environments"][1:]] == [
        {"id": "uat", "label": "uat", "sub": "Development", "state": "active",
         "version": "e73b99ca", "last_release": "e73b99ca",
         "last_release_at": "2026-10-03T12:00:00+00:00", "action_label": "Deploy uat",
         "environment": "uat"},
        {"id": "beta", "label": "Beta", "sub": None, "state": "empty", "version": None,
         "last_release": None, "last_release_at": None, "action_label": "Set up Beta",
         "environment": None},
        {"id": "qa-east", "label": "qa-east", "sub": "Custom", "state": "failed",
         "version": None, "last_release": None, "last_release_at": None,
         "action_label": "Deploy qa-east", "environment": "qa-east"}]
    assert d["health"] == {"status": "degraded", "label": "A deployment failed"}


async def test_health_when_an_environment_is_deployed(client, db):
    await make_environment(db, name="uat", current_sha=SHA, secrets={})
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard", headers=h)).json()
    assert d["health"] == {"status": "healthy", "label": "Environments deployed"}
    assert [(e["id"], e["state"]) for e in d["environments"]] == [
        ("production", "empty"), ("uat", "active"), ("beta", "empty")]


async def test_a_tagged_droplet_with_an_environment_gets_one_card(client, db, with_token):
    env = await make_environment(db, name="qa-team", secrets={})
    env.type = "custom"
    await db.commit()
    h = await auth_headers(client, db)
    d = (await client.get("/api/dashboard", headers=h)).json()
    assert [(e["id"], e["environment"]) for e in d["environments"]] == [
        ("production", None), ("dev", None), ("beta", None), ("qa-team", "qa-team")]
