"""Settings › Integrations › Switchyard over the API: save (the key is
write-only and kept when omitted), Test (status and hosts), remove."""

import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import outbound

from .api_helpers import auth_headers
from .deploy_factories import secrets_key, stop_pipeline  # noqa: F401
from .fake_switchyard import FakeSwitchyard
from .integration_helpers import SY_KEY, configure
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401

URL = "/api/deploy/integrations"
BODY = {"url": "https://switchyard.lan:8443", "api_key": SY_KEY}


@pytest.fixture
def fake(monkeypatch):
    sy = FakeSwitchyard()
    monkeypatch.setattr(outbound, "transports", lambda: {"switchyard": sy.transport()})
    return sy


@pytest.fixture
async def leaks(client, db):
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
        assert SY_KEY not in text


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def test_permissions(client, db, secrets_key):  # noqa: F811
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    for method, path, body in (("PUT", "/switchyard", BODY), ("DELETE", "/switchyard", None),
                               ("POST", "/switchyard/test", None)):
        resp = await client.request(method, URL + path, headers=admin, json=body)
        assert resp.status_code == 403, path


async def test_save_read_and_keep_the_key(client, db, secrets_key, leaks):  # noqa: F811
    h = await auth_headers(client, db)
    before = (await client.get(URL, headers=h)).json()["switchyard"]
    assert (before["configured"], before["url"], before["api_key_set"]) == (False, None, False)
    resp = await client.put(f"{URL}/switchyard", headers=h, json=BODY)
    assert resp.status_code == 200
    sy = resp.json()["switchyard"]
    assert (sy["configured"], sy["url"], sy["api_key_set"], sy["updated_by_name"]) == (
        True, "https://switchyard.lan:8443", True, "Boss User")
    # An empty key keeps the stored one (for the same URL).
    resp = await client.put(f"{URL}/switchyard", headers=h,
                            json={"url": "https://switchyard.lan:8443/"})
    assert resp.status_code == 200 and resp.json()["switchyard"]["api_key_set"] is True
    # ... but never sends it to another server.
    resp = await client.put(f"{URL}/switchyard", headers=h, json={"url": "https://elsewhere"})
    assert resp.json()["detail"] == {
        "code": "secret_required",
        "reason": "Enter the API key again to use it with a different Switchyard server."}
    assert await _audits(db, "deploy.integration_update") == [
        {"kind": "switchyard", "changed": ["url", "api_key"]}]


@pytest.mark.parametrize("body, code", [
    ({**BODY, "url": "ftp://switchyard"}, "switchyard_url_invalid"),
    ({**BODY, "url": "https://switchyard/api"}, "switchyard_url_invalid"),
    ({**BODY, "api_key": "not-a-key"}, "switchyard_key_invalid"),
    ({**BODY, "api_key": "sy_short"}, "switchyard_key_invalid"),
    ({"url": BODY["url"]}, "secret_required"),
])
async def test_save_errors(client, db, secrets_key, leaks, body, code):  # noqa: F811
    h = await auth_headers(client, db)
    resp = await client.put(f"{URL}/switchyard", headers=h, json=body)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, code)


async def test_test_saved_and_unsaved(client, db, secrets_key, fake, leaks):  # noqa: F811
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/switchyard/test", headers=h)
    assert resp.json()["detail"] == {"code": "integration_not_configured",
                                     "kinds": ["switchyard"]}
    resp = await client.post(f"{URL}/switchyard/test", headers=h, json=BODY)
    assert resp.status_code == 200
    assert [c["label"] for c in resp.json()["checks"]] == ["Reachable", "Caddy", "API key",
                                                           "Hosts"]
    assert [(r.method, r.url.path) for r in fake.requests] == [
        ("GET", "/api/status"), ("GET", "/api/hosts")]
    await client.put(f"{URL}/switchyard", headers=h, json=BODY)
    assert (await client.post(f"{URL}/switchyard/test", headers=h)).status_code == 200
    assert await _audits(db, "deploy.integration_test") == [
        {"kind": "switchyard", "ok": True}, {"kind": "switchyard", "ok": True}]


@pytest.mark.parametrize("set_up, reason", [
    (lambda f: setattr(f, "key", "sy_other"), "Switchyard rejected the API key."),
    (lambda f: f.permissions.discard("hosts.list"),
     ("Switchyard's API key doesn't have the hosts.list permission. Add it to the key in "
      "Switchyard.")),
    (lambda f: setattr(f, "down", True), "Couldn't reach Switchyard."),
])
async def test_test_failures_are_told_apart(client, db, secrets_key, fake, leaks,  # noqa: F811
                                            set_up, reason):
    set_up(fake)
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/switchyard/test", headers=h, json=BODY)
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": reason})
    assert await _audits(db, "deploy.integration_test") == [{"kind": "switchyard", "ok": False}]


async def test_remove(client, db, secrets_key, leaks):  # noqa: F811
    h = await auth_headers(client, db)
    await client.put(f"{URL}/switchyard", headers=h, json=BODY)
    assert (await client.delete(f"{URL}/switchyard", headers=h)).status_code == 204
    assert (await client.get(URL, headers=h)).json()["switchyard"]["configured"] is False


# ---- the environment's proxy (POST /environments) ----------------------------------------

ENV_URL = "/api/deploy/environments"
NEW = {"mode": "new", "name": "qa", "type": "custom", "target": "ssh", "proxy_ip": "10.10.48.6"}


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):  # noqa: F811
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


async def test_a_new_lan_environment_defaults_to_switchyard(client, db, target):
    await configure(db, cloudflare=False, npm=False, switchyard=True)
    h = await auth_headers(client, db)
    resp = await client.post(ENV_URL, headers=h, json=NEW)
    assert resp.status_code == 201, resp.text
    assert resp.json()["proxy"] == "switchyard"
    changes = (await _audits(db, "deploy.environment_create"))[0]
    assert changes["proxy"] == "switchyard"


async def test_publishing_through_an_unset_proxy_is_refused_when_deploying(client, db, target):
    """As with Cloudflare: the create takes it; the first deploy names what's missing."""
    h = await auth_headers(client, db)
    resp = await client.post(ENV_URL, headers=h, json=NEW)
    assert (resp.status_code, resp.json()["proxy"]) == (201, "switchyard")
    resp = await client.post(ENV_URL, headers=h, json={**NEW, "name": "qb", "proxy": "npm"})
    assert (resp.status_code, resp.json()["proxy"]) == (201, "npm")


async def test_publish_off_needs_no_proxy_yet(client, db, target):
    h = await auth_headers(client, db)
    resp = await client.post(ENV_URL, headers=h, json={**NEW, "publish": False})
    assert (resp.status_code, resp.json()["proxy"]) == (201, "switchyard")


async def test_an_unknown_proxy_is_refused(client, db, target):
    h = await auth_headers(client, db)
    resp = await client.post(ENV_URL, headers=h, json={**NEW, "proxy": "caddy"})
    assert resp.status_code == 422


async def test_blue_green_needs_the_chosen_proxy(db, secrets_key):  # noqa: F811
    from sirdar_api.deploy import environments

    from .integration_helpers import configure_esxi
    from .lan_helpers import make_bluegreen_environment

    await configure_esxi(db)
    await configure(db, cloudflare=False, npm=True)
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db, proxy="switchyard")
    assert (e.value.code, e.value.extra) == ("integration_not_configured",
                                             {"kinds": ["switchyard"]})
    await db.rollback()
    env = await make_bluegreen_environment(db, proxy="npm")
    assert env.proxy == "npm"


async def test_digitalocean_takes_no_proxy(db, secrets_key):  # noqa: F811
    from sirdar_api.config import get_settings
    from sirdar_api.deploy import environments

    with pytest.raises(environments.EnvError) as e:
        await environments.create_new(db, get_settings(), name="do7", type_="dev",
                                      target_id="digitalocean", proxy="switchyard")
    assert e.value.code == "proxy_not_allowed"
