"""The digitalocean integration: the API token entered in Settings ›
Integrations (write-only, Fernet-encrypted), with SIRDAR_DEPLOY_DO_TOKEN as
the fallback when none is stored. Every DigitalOcean caller (the Deploy
page's connect and regions, the targets list, the dashboard inventory and
the Settings test) uses the one resolved token. No real HTTP: DigitalOcean
answers through a MockTransport handed out by outbound.transports()."""

import json

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.dashboard import service
from sirdar_api.db.models import AuditLog, Integration
from sirdar_api.deploy import digitalocean, integrations, outbound, targets
from sirdar_api.deploy.integrations import IntegrationError

from .api_helpers import auth_headers
from .deploy_factories import secrets_key  # noqa: F401
from .factories import make_user
from .test_dashboard_inventory import do_transport as inventory_transport
from .test_deploy_digitalocean import _transport

# SIRDAR_SECRETS_KEY for every test (one that clears it says so itself).
pytestmark = pytest.mark.usefixtures("secrets_key")

URL = "/api/deploy/integrations"
STORED = "dop_v1_" + "0123456789abcdef" * 4          # the shape DigitalOcean issues
ENV_TOKEN = "env-DO-token-s3cr3t-9876"                 # from SIRDAR_DEPLOY_DO_TOKEN
OTHER = "dop_v1_" + "fedcba9876543210" * 4             # an unsaved token a Test tries
TOKENS = (STORED, ENV_TOKEN, OTHER)


@pytest.fixture
def do_env(monkeypatch):
    """Set SIRDAR_DEPLOY_DO_TOKEN (blank by default) and re-read settings."""
    def apply(token: str = "", region: str = "") -> None:
        monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", token)
        monkeypatch.setenv("SIRDAR_DEPLOY_DO_REGION", region)
        get_settings.cache_clear()
    apply()
    service.clear_cache()
    yield apply
    service.clear_cache()
    get_settings.cache_clear()


@pytest.fixture
def do_api(monkeypatch):
    """DigitalOcean through outbound.transports(): every request is recorded;
    holder["status"] makes it answer an error."""
    holder: dict = {"seen": [], "status": 200}

    def transports():
        return {"digitalocean": _transport(status=holder["status"], seen=holder["seen"])}

    monkeypatch.setattr(outbound, "transports", transports)
    return holder


def _bearers(seen) -> set[str]:
    return {r.headers["authorization"] for r in seen}


@pytest.fixture
async def leaks(client, db):
    """No response body and no audit row this test produced holds a token."""
    seen: list[str] = []

    async def record(response):
        await response.aread()
        seen.append(response.text)

    client.event_hooks["response"].append(record)
    yield
    await db.rollback()
    audits = [repr(c) for c in await db.scalars(select(AuditLog.changes))]
    assert seen
    for text in seen + audits:
        for token in TOKENS:
            assert token not in text


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def _store(db, token: str = STORED, actor_id=None) -> None:
    await integrations.save(db, get_settings(), "digitalocean", {}, token, actor_id)
    await db.commit()


# ---- the store ---------------------------------------------------------------

@pytest.mark.parametrize("token", [
    STORED, "dop_v1_" + "ABCDEF0123456789" * 4, "legacy-token_1.2/3+4=", "x", "t" * 200,
])
def test_token_shapes_accepted(token):
    assert integrations.check_secret("digitalocean", token) == token


@pytest.mark.parametrize("token", [
    "", "t" * 201, "has space", "tab\there", "line\nbreak", "tök", None, 42,
    "dop_v1_short", "dop_v1_" + "g" * 64, "dop_v1_" + "a" * 65,
])
def test_token_shapes_refused(token):
    with pytest.raises(IntegrationError) as e:
        integrations.check_secret("digitalocean", token)
    assert e.value.code == "do_token_invalid"
    assert e.value.extra == {}


async def test_save_load_and_the_public_view(db, do_env):
    user = await make_user(db, email="ops@test.example.com", first_name="Jimmy",
                           last_name="Henderson")
    changed = await integrations.save(db, get_settings(), "digitalocean", {}, STORED,
                                      user.person_id)
    await db.commit()
    assert changed == ["token"]
    row = await db.get(Integration, "digitalocean")
    assert row.config == {}
    assert STORED.encode() not in bytes(row.secret_enc)
    cfg = await integrations.load_digitalocean(db, get_settings())
    assert (cfg.token, cfg.source) == (STORED, "stored")
    assert STORED not in repr(cfg)
    view = (await integrations.public(db, get_settings()))["digitalocean"]
    assert view | {"updated_at": None} == {
        "configured": True, "token_set": True, "source": "stored", "updated_at": None,
        "updated_by_name": "Jimmy Henderson"}
    assert view["updated_at"] is not None
    # Saving again without a token keeps the stored one and changes nothing.
    assert await integrations.save(db, get_settings(), "digitalocean", {}, None, None) == []


async def test_the_environment_token_is_the_fallback(db, do_env):
    empty = (await integrations.public(db, get_settings()))["digitalocean"]
    assert empty == {"configured": False, "token_set": False, "source": None,
                     "updated_at": None, "updated_by_name": None}
    assert await integrations.load_digitalocean(db, get_settings()) is None

    do_env(ENV_TOKEN)
    cfg = await integrations.load_digitalocean(db, get_settings())
    assert (cfg.token, cfg.source) == (ENV_TOKEN, "environment")
    view = (await integrations.public(db, get_settings()))["digitalocean"]
    assert (view["configured"], view["token_set"], view["source"]) == (True, False, "environment")

    await _store(db)                                     # the stored token wins
    cfg = await integrations.load_digitalocean(db, get_settings())
    assert (cfg.token, cfg.source) == (STORED, "stored")
    assert (await integrations.load(db, get_settings(), "digitalocean")).token == STORED

    assert await integrations.remove(db, "digitalocean") is True
    await db.commit()
    cfg = await integrations.load_digitalocean(db, get_settings())
    assert (cfg.token, cfg.source) == (ENV_TOKEN, "environment")


async def test_saving_needs_a_token_the_first_time(db, do_env):
    do_env(ENV_TOKEN)                  # the env token is never saved by omission
    with pytest.raises(IntegrationError) as e:
        await integrations.save(db, get_settings(), "digitalocean", {}, None, None)
    assert e.value.code == "secret_required"


async def test_resolve_hands_digitalocean_the_one_token(db, do_env):
    assert (await digitalocean.resolve(db, get_settings())).deploy_do_token is None
    do_env(ENV_TOKEN, "nyc3")
    resolved = await digitalocean.resolve(db, get_settings())
    assert resolved.deploy_do_token.get_secret_value() == ENV_TOKEN
    await _store(db)
    resolved = await digitalocean.resolve(db, get_settings())
    assert resolved.deploy_do_token.get_secret_value() == STORED
    assert resolved.deploy_do_region == "nyc3"
    assert get_settings().deploy_do_token.get_secret_value() == ENV_TOKEN   # not changed
    assert targets.is_configured("digitalocean", resolved)


# ---- routes ------------------------------------------------------------------

async def test_permissions(client, db, do_env):
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.get(URL, headers=admin)
    assert resp.status_code == 200 and "digitalocean" in resp.json()
    for method, path, body in (("PUT", "/digitalocean", {"token": STORED}),
                               ("POST", "/digitalocean/test", None),
                               ("POST", "/digitalocean/test", {"token": STORED}),
                               ("DELETE", "/digitalocean", None)):
        resp = await client.request(method, URL + path, headers=admin, json=body)
        assert resp.status_code == 403, (method, path)
    assert (await client.put(f"{URL}/digitalocean", json={"token": STORED})).status_code == 401


async def test_save_through_the_route(client, db, do_env, leaks):
    h = await auth_headers(client, db)
    resp = await client.put(f"{URL}/digitalocean", headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]) == (422, {"code": "secret_required"})
    resp = await client.put(f"{URL}/digitalocean", headers=h, json={"token": "dop_v1_short"})
    assert (resp.status_code, resp.json()["detail"]) == (422, {"code": "do_token_invalid"})
    resp = await client.put(f"{URL}/digitalocean", headers=h, json={"token": STORED})
    assert resp.status_code == 200
    assert resp.json()["digitalocean"] | {"updated_at": None} == {
        "configured": True, "token_set": True, "source": "stored", "updated_at": None,
        "updated_by_name": "Boss User"}
    resp = await client.put(f"{URL}/digitalocean", headers=h, json={})     # keeps it
    assert resp.json()["digitalocean"]["token_set"] is True
    assert await _audits(db, "deploy.integration_update") == [
        {"kind": "digitalocean", "changed": ["token"]}]


async def test_saving_needs_the_secrets_key(client, db, monkeypatch, do_env, leaks):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    h = await auth_headers(client, db)
    resp = await client.put(f"{URL}/digitalocean", headers=h, json={"token": STORED})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (400, "secrets_key_missing")


async def test_test_route(client, db, do_env, do_api, leaks):
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/digitalocean/test", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["digitalocean"]})

    # An unsaved token: tried, never stored.
    resp = await client.post(f"{URL}/digitalocean/test", headers=h, json={"token": OTHER})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["ok"], body["target"]) == (True, "digitalocean")
    assert body["checks"][0] == {"label": "Account", "status": "pass",
                                 "value": "ops@example.com · active"}
    assert _bearers(do_api["seen"]) == {f"Bearer {OTHER}"}
    assert await db.get(Integration, "digitalocean") is None

    resp = await client.post(f"{URL}/digitalocean/test", headers=h, json={"token": "a b"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "do_token_invalid")

    # The saved settings: the env token, then the stored one once saved.
    do_env(ENV_TOKEN)
    do_api["seen"].clear()
    assert (await client.post(f"{URL}/digitalocean/test", headers=h)).status_code == 200
    assert _bearers(do_api["seen"]) == {f"Bearer {ENV_TOKEN}"}
    await client.put(f"{URL}/digitalocean", headers=h, json={"token": STORED})
    do_api["seen"].clear()
    assert (await client.post(f"{URL}/digitalocean/test", headers=h, json={})).status_code == 200
    assert _bearers(do_api["seen"]) == {f"Bearer {STORED}"}

    do_api["status"] = 401
    resp = await client.post(f"{URL}/digitalocean/test", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": "DigitalOcean rejected the API token."})
    assert await _audits(db, "deploy.integration_test") == [
        {"kind": "digitalocean", "ok": True}, {"kind": "digitalocean", "ok": True},
        {"kind": "digitalocean", "ok": True}, {"kind": "digitalocean", "ok": False}]


async def test_remove_falls_back_to_the_environment(client, db, do_env, leaks):
    do_env(ENV_TOKEN)
    h = await auth_headers(client, db)
    await client.put(f"{URL}/digitalocean", headers=h, json={"token": STORED})
    assert (await client.delete(f"{URL}/digitalocean", headers=h)).status_code == 204
    resp = await client.delete(f"{URL}/digitalocean", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (404, "integration_not_found")
    view = (await client.get(URL, headers=h)).json()["digitalocean"]
    assert (view["configured"], view["token_set"], view["source"]) == (True, False, "environment")
    assert await _audits(db, "deploy.integration_remove") == [{"kind": "digitalocean"}]


# ---- every DigitalOcean caller uses the resolved token -----------------------

async def test_targets_list_counts_a_stored_token(client, db, do_env, leaks):
    h = await auth_headers(client, db)

    async def configured() -> bool:
        listed = (await client.get("/api/deploy/targets", headers=h)).json()["targets"]
        return next(t for t in listed if t["id"] == "digitalocean")["configured"]

    assert await configured() is False
    await _store(db)
    assert await configured() is True
    await integrations.remove(db, "digitalocean")
    await db.commit()
    do_env(ENV_TOKEN)
    assert await configured() is True


async def test_connect_and_regions_use_the_stored_token(client, db, do_env,
                                                        do_api, leaks):
    do_env(ENV_TOKEN, "nyc3")
    await _store(db)
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "digitalocean", "type": "dev"})
    assert resp.status_code == 200, resp.text
    assert {"label": "Region", "status": "pass", "value": "nyc3 available"} in resp.json()["checks"]
    resp = await client.get("/api/deploy/digitalocean/regions", headers=h)
    assert (resp.status_code, resp.json()["default"]) == (200, "nyc3")
    assert do_api["seen"] and _bearers(do_api["seen"]) == {f"Bearer {STORED}"}


async def test_connect_without_any_token(client, db, do_env, do_api, leaks):
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "digitalocean", "type": "dev"})
    assert (resp.status_code, resp.json()["detail"]) == (400, {"code": "target_not_configured"})
    resp = await client.get("/api/deploy/digitalocean/regions", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (400, {"code": "target_not_configured"})
    assert do_api["seen"] == []


async def test_an_unreadable_stored_token(client, db, do_env, do_api, leaks):
    do_env(ENV_TOKEN)          # never used instead of a stored token that won't open
    db.add(Integration(kind="digitalocean", config={},
                       secret_enc=Fernet(Fernet.generate_key()).encrypt(STORED.encode())))
    await db.commit()
    h = await auth_headers(client, db)
    view = (await client.get(URL, headers=h)).json()["digitalocean"]
    assert (view["token_set"], view["source"]) == (True, "stored")
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "digitalocean", "type": "dev"})
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_unreadable", "kind": "digitalocean"})
    resp = await client.get("/api/deploy/digitalocean/regions", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "integration_unreadable")
    resp = await client.post(f"{URL}/digitalocean/test", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "integration_unreadable")
    infra = (await client.get("/api/dashboard", headers=h)).json()["infrastructure"]
    assert infra["source"] == "digitalocean" and infra["tree"] == []
    assert infra["error"] == integrations.IntegrationError("integration_unreadable").reason
    assert do_api["seen"] == []
    assert await _audits(db, "deploy.connect") == [
        {"target": "digitalocean", "type": "dev", "ok": False,
         "code": "integration_unreadable"}]


async def test_dashboard_uses_the_stored_token(client, db, do_env, monkeypatch,
                                               leaks):
    seen: list = []
    monkeypatch.setattr(outbound, "transports",
                        lambda: {"digitalocean": inventory_transport(seen=seen)})
    h = await auth_headers(client, db)
    infra = (await client.get("/api/dashboard", headers=h)).json()["infrastructure"]
    assert infra == {"source": "none", "error": None, "tree": []}
    await _store(db)
    d = (await client.get("/api/dashboard", headers=h)).json()
    assert d["infrastructure"]["source"] == "digitalocean"
    assert d["infrastructure"]["error"] is None and d["infrastructure"]["tree"]
    assert seen and _bearers(seen) == {f"Bearer {STORED}"}
    assert STORED not in json.dumps(d)
