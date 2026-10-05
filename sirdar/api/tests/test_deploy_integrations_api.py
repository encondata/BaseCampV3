import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.api.routes import integrations as integration_routes
from sirdar_api.db.models import AuditLog, Integration
from sirdar_api.deploy import outbound

from .api_helpers import auth_headers
from .deploy_factories import secrets_key  # noqa: F401
from .fake_cloudflare import FakeCloudflare
from .fake_npm import FakeNpm
from .integration_helpers import CF_TOKEN, NPM_PASSWORD, NPM_VALUES

URL = "/api/deploy/integrations"
CF_BODY = {"zone": "serversherpa.com", "public_ip": "203.0.113.7", "token": CF_TOKEN}
NPM_BODY = {"url": "http://10.10.48.6:81", "identity": "admin@example.com",
            "password": NPM_PASSWORD}


@pytest.fixture
def fakes(monkeypatch):
    cf, proxy = FakeCloudflare(), FakeNpm()
    monkeypatch.setattr(outbound, "transports", lambda: {
        "cloudflare": cf.transport(), "npm": proxy.transport(), "smoke": None})
    return cf, proxy


@pytest.fixture
async def leaks(client, db):
    """No response body and no audit row this test produced holds a secret."""
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
        assert CF_TOKEN not in text and NPM_PASSWORD not in text


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def test_permissions(client, db, secrets_key):
    assert (await client.get(URL)).status_code == 401
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get(URL, headers=admin)).status_code == 200
    for method, path, body in (("PUT", "/cloudflare", CF_BODY), ("PUT", "/npm", NPM_BODY),
                               ("DELETE", "/npm", None), ("POST", "/cloudflare/test", None),
                               ("POST", "/npm/test", None)):
        resp = await client.request(method, URL + path, headers=admin, json=body)
        assert resp.status_code == 403, path


async def test_save_read_and_keep_the_secret(client, db, secrets_key, leaks):
    h = await auth_headers(client, db)
    resp = await client.put(f"{URL}/cloudflare", headers=h, json=CF_BODY)
    assert resp.status_code == 200
    cf = resp.json()["cloudflare"]
    assert (cf["configured"], cf["zone"], cf["public_ip"], cf["token_set"],
            cf["updated_by_name"]) == (True, "serversherpa.com", "203.0.113.7", True, "Boss User")
    resp = await client.put(f"{URL}/cloudflare", headers=h,
                            json={"zone": "serversherpa.com", "public_ip": "203.0.113.8"})
    assert resp.json()["cloudflare"]["token_set"] is True
    resp = await client.put(f"{URL}/npm", headers=h, json=NPM_BODY)
    assert resp.json()["npm"] | {"updated_at": None} == {
        "configured": True, "url": "http://10.10.48.6:81", "identity": "admin@example.com",
        "letsencrypt_email": "admin@example.com", "password_set": True, "updated_at": None,
        "updated_by_name": "Boss User"}
    assert resp.json()["secrets_key_configured"] is True
    assert await _audits(db, "deploy.integration_update") == [
        {"kind": "cloudflare", "changed": ["zone", "public_ip", "token"]},
        {"kind": "cloudflare", "changed": ["public_ip"]},
        {"kind": "npm", "changed": ["url", "identity", "letsencrypt_email", "password"]},
    ]


@pytest.mark.parametrize("path, body, status, code", [
    ("/cloudflare", {**CF_BODY, "public_ip": "nope"}, 422, "public_ip_invalid"),
    ("/cloudflare", {**CF_BODY, "zone": "-bad-"}, 422, "zone_invalid"),
    ("/cloudflare", {"zone": "serversherpa.com", "public_ip": "203.0.113.7"}, 422,
     "secret_required"),
    ("/cloudflare", {**CF_BODY, "token": "bad token"}, 422, "token_invalid"),
    ("/npm", {**NPM_BODY, "url": "ftp://npm"}, 422, "npm_url_invalid"),
    ("/npm", {**NPM_BODY, "identity": "admin"}, 422, "identity_invalid"),
    ("/npm", {**NPM_BODY, "password": ""}, 422, "password_invalid"),
])
async def test_save_errors(client, db, secrets_key, leaks, path, body, status, code):
    h = await auth_headers(client, db)
    resp = await client.put(URL + path, headers=h, json=body)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (status, code)
    assert await _audits(db, "deploy.integration_update") == []


async def test_saving_a_secret_needs_the_secrets_key(client, db, monkeypatch, leaks):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    h = await auth_headers(client, db)
    resp = await client.put(f"{URL}/cloudflare", headers=h, json=CF_BODY)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (400, "secrets_key_missing")
    assert (await client.get(URL, headers=h)).json()["secrets_key_configured"] is False
    get_settings.cache_clear()


async def test_remove(client, db, secrets_key, leaks):
    h = await auth_headers(client, db)
    await client.put(f"{URL}/npm", headers=h, json=NPM_BODY)
    assert (await client.delete(f"{URL}/npm", headers=h)).status_code == 204
    resp = await client.delete(f"{URL}/npm", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (404, "integration_not_found")
    assert (await client.delete(f"{URL}/route53", headers=h)).status_code == 422
    assert await _audits(db, "deploy.integration_remove") == [{"kind": "npm"}]
    assert (await client.get(URL, headers=h)).json()["npm"]["configured"] is False


async def test_test_with_saved_and_unsaved_values(client, db, secrets_key, fakes, leaks):
    _, proxy = fakes
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/cloudflare/test", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["cloudflare"]})
    resp = await client.post(f"{URL}/cloudflare/test", headers=h, json=CF_BODY)
    assert resp.status_code == 200
    assert (resp.json()["target"], resp.json()["checks"][0]["label"]) == ("cloudflare", "Zone")
    assert (await client.get(URL, headers=h)).json()["cloudflare"]["configured"] is False
    await client.put(f"{URL}/npm", headers=h, json=NPM_BODY)
    resp = await client.post(f"{URL}/npm/test", headers=h)
    assert (resp.status_code, resp.json()["facts"]["version"]) == (200, "2.16.0")
    resp = await client.post(f"{URL}/npm/test", headers=h,
                             json={**NPM_BODY, "password": "wrong-password"})
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": "Nginx Proxy Manager rejected the login."})
    resp = await client.post(f"{URL}/npm/test", headers=h,
                             json={**NPM_BODY, "password": None, "identity": "ops@example.com"})
    assert (resp.status_code, resp.json()["detail"]) == (422, {
        "code": "secret_required",
        "reason": "Enter the password again to use it with a different server or login."})
    resp = await client.put(f"{URL}/npm", headers=h,
                            json={**NPM_BODY, "password": None, "url": "http://10.10.48.99:81"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "secret_required")
    assert proxy.logins() == 2
    resp = await client.post(f"{URL}/npm/test", headers=h, json={**NPM_BODY, "url": "x"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "npm_url_invalid")
    assert await _audits(db, "deploy.integration_test") == [
        {"kind": "cloudflare", "ok": True}, {"kind": "npm", "ok": True},
        {"kind": "npm", "ok": False}]


async def test_an_unexpected_tester_error_is_a_generic_502(client, db, secrets_key, fakes,
                                                           leaks, monkeypatch, caplog):
    async def boom(cfg, *, transport=None):
        raise RuntimeError(f"upstream said {cfg.password}")

    monkeypatch.setitem(integration_routes.TESTERS, "npm", boom)
    h = await auth_headers(client, db)
    await client.put(f"{URL}/npm", headers=h, json=NPM_BODY)
    resp = await client.post(f"{URL}/npm/test", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": "Sirdar couldn't reach it."})
    assert await _audits(db, "deploy.integration_test") == [{"kind": "npm", "ok": False}]
    assert "RuntimeError" in caplog.text
    assert NPM_PASSWORD not in caplog.text and "upstream said" not in caplog.text


async def test_unreadable_stored_credentials(client, db, secrets_key, fakes, leaks):
    h = await auth_headers(client, db)
    db.add(Integration(kind="npm", config={**NPM_VALUES, "letsencrypt_email": "a@b.co"},
                       secret_enc=Fernet(Fernet.generate_key()).encrypt(b"x")))
    await db.commit()
    resp = await client.post(f"{URL}/npm/test", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_unreadable", "kind": "npm"})
    assert await _audits(db, "deploy.integration_test") == []
