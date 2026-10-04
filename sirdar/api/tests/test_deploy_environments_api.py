import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import envfile

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    ADOPT_SHA,
    CAT_ENV,
    leak_guard,
    make_environment,
    remote_env_text,
    secrets_key,
    serve_remote_env,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401

URL = "/api/deploy/environments"
ENV_KEYS = {"id", "name", "type", "target", "base_domain", "env_dir", "git_ref", "current_sha",
            "image_tag", "status", "proxy_ip", "bind_ip", "keep_dumps", "spaces_bucket",
            "log_level", "services", "secrets_set", "seed_snapshot", "last_deployment",
            "created_at", "updated_at"}
NEW = {"mode": "new", "name": "qa", "type": "custom", "target": "ssh",
       "proxy_ip": "10.10.48.6"}
DEFAULTS_URL = "/api/deploy/environment-defaults"


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def test_permissions(client, db, target, leak_guard):
    assert (await client.get(URL)).status_code == 401
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get(URL, headers=admin)).json() == {"environments": []}
    for method, url, body in (("POST", URL, NEW), ("PATCH", f"{URL}/qa", {"keep_dumps": 3})):
        resp = await client.request(method, url, headers=admin, json=body)
        assert resp.status_code == 403, url
        assert resp.json()["detail"]["code"] == "forbidden"


async def test_environment_defaults(client, db):
    assert (await client.get(DEFAULTS_URL)).status_code == 401
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.get(DEFAULTS_URL, headers=admin)
    assert resp.status_code == 200
    assert resp.json() == {
        "services": [{"service": "api", "port": 8000, "public": True},
                     {"service": "portal", "port": 8091, "public": True},
                     {"service": "kiosk", "port": 8090, "public": True},
                     {"service": "wiki", "port": 8096, "public": True},
                     {"service": "spaces", "port": 9000, "public": True},
                     {"service": "status", "port": 8095, "public": True},
                     {"service": "mailpit", "port": 8025, "public": False}],
        "domain_suffix": "serversherpa.com", "env_root": "/opt/serversherpa", "git_ref": "main",
        "bind_ip": "0.0.0.0", "keep_dumps": 5, "spaces_bucket": "serversherpa",
        "log_levels": ["DEBUG", "INFO", "WARNING", "ERROR"],
        "optional_secrets": ["SS_ANTHROPIC_API_KEY", "SS_DB_TESTING_PASSWORD"]}


async def test_create_new_environment(client, db, target, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "ports": {"api": 8100}})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == ENV_KEYS
    assert (body["name"], body["type"], body["target"], body["status"], body["base_domain"],
            body["env_dir"], body["current_sha"], body["last_deployment"]) == (
        "qa", "custom", "ssh", "new", "qa.serversherpa.com", "/opt/serversherpa/qa", None,
        None)
    assert body["services"][0] == {"service": "api", "host_ip": "127.0.0.1", "port": 8100,
                                   "hostname": "api.qa.serversherpa.com", "proxied": False}
    assert body["services"][-1]["service"] == "mailpit"
    assert body["services"][-1]["hostname"] is None
    assert body["secrets_set"] == {"SS_ANTHROPIC_API_KEY": False,
                                   "SS_DB_TESTING_PASSWORD": False}
    assert await _audits(db, "deploy.environment_create") == [{
        "name": "qa", "type": "custom", "target": "ssh", "base_domain": "qa.serversherpa.com",
        "git_ref": "main", "proxy_ip": "10.10.48.6", "bind_ip": "0.0.0.0"}]
    assert (await client.get(f"{URL}/qa", headers=h)).json() == body
    listed = (await client.get(URL, headers=h)).json()["environments"]
    assert [e["name"] for e in listed] == ["qa"]
    resp = await client.post(URL, headers=h, json=NEW)
    assert resp.status_code == 409
    assert resp.json() == {"detail": {"code": "environment_exists"}}


async def test_create_errors(client, db, target, leak_guard, monkeypatch, secrets_key):
    h = await auth_headers(client, db)
    for body, status, detail in (
            ({**NEW, "name": "Bad"}, 422, {"code": "name_invalid"}),
            ({**NEW, "proxy_ip": None}, 422, {"code": "proxy_ip_required"}),
            ({**NEW, "ports": {"db": 5432}}, 422, {"code": "service_unknown", "service": "db"}),
            ({**NEW, "target": "ssh:gone"}, 400, {"code": "target_not_configured"})):
        resp = await client.post(URL, headers=h, json=body)
        assert (resp.status_code, resp.json()) == (status, {"detail": detail}), body
    resp = await client.post(URL, headers=h, json={**NEW, "target": "digitalocean"})
    assert resp.status_code == 422                       # pydantic: not an SSH target id
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    resp = await client.post(URL, headers=h, json=NEW)
    assert (resp.status_code, resp.json()) == (400, {"detail": {"code": "secrets_key_missing"}})
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", secrets_key)    # the leak guard reads with it
    get_settings.cache_clear()


async def test_adopt_environment(client, db, target, leak_guard):
    await trust_fake(db, target)
    serve_remote_env(target)
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={"mode": "adopt", "name": "uat",
                                                   "type": "dev", "target": "ssh"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert set(body) == ENV_KEYS | {"ignored_keys", "imported_secrets"}
    assert body["imported_secrets"] == sorted(envfile.REQUIRED_SECRETS)
    assert (body["status"], body["current_sha"], body["image_tag"], body["proxy_ip"]) == (
        "ready", ADOPT_SHA, "e73b99ca", "10.10.48.6")
    assert body["ignored_keys"] == ["MINIO_ROOT_PASSWORD"]
    last = body["last_deployment"]
    assert (last["mode"], last["status"], last["sha"], last["actor_name"]) == (
        "adopt", "adopted", ADOPT_SHA, "Boss User")
    assert await _audits(db, "deploy.environment_adopt") == [{
        "name": "uat", "type": "dev", "target": "ssh", "sha": ADOPT_SHA,
        "image_tag": "e73b99ca", "imported_secrets": sorted(envfile.REQUIRED_SECRETS),
        "ignored_keys": ["MINIO_ROOT_PASSWORD"]}]


async def test_adopt_errors(client, db, target, leak_guard):
    h = await auth_headers(client, db)
    adopt = {"mode": "adopt", "name": "uat", "type": "dev", "target": "ssh"}
    serve_remote_env(target)
    resp = await client.post(URL, headers=h, json=adopt)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "host_key_unknown", "host": "127.0.0.1",
                                     "port": target.port, "key_type": "ssh-ed25519",
                                     "fingerprint": target.fingerprint}
    await trust_fake(db, target)
    serve_remote_env(target, remote_env_text(SS_JWT_SECRET="CHANGEME"))
    resp = await client.post(URL, headers=h, json=adopt)
    assert (resp.status_code, resp.json()) == (422, {"detail": {
        "code": "adopt_env_incomplete", "missing": ["SS_JWT_SECRET"]}})
    target.exits[CAT_ENV] = 1
    resp = await client.post(URL, headers=h, json=adopt)
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "adopt_env_missing"}})
    assert (await client.get(URL, headers=h)).json() == {"environments": []}


async def test_get_unknown_environment(client, db, target, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.get(f"{URL}/nope", headers=h)
    assert (resp.status_code, resp.json()) == (404, {"detail": {"code": "environment_not_found"}})
    resp = await client.patch(f"{URL}/nope", headers=h, json={"keep_dumps": 3})
    assert resp.status_code == 404


async def test_patch_environment(client, db, target, leak_guard):
    await make_environment(db)
    h = await auth_headers(client, db)
    key = "sk-ant-api03-SECRETvalue"
    leak_guard.append(key)
    resp = await client.patch(f"{URL}/uat", headers=h, json={
        "base_domain": "uat2.serversherpa.com",
        "services": {"api": {"port": 8100, "proxied": True}},
        "secrets": {"SS_ANTHROPIC_API_KEY": key}})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["services"][0] == {"service": "api", "host_ip": "127.0.0.1", "port": 8100,
                                   "hostname": "api.uat2.serversherpa.com", "proxied": True}
    assert body["secrets_set"] == {"SS_ANTHROPIC_API_KEY": True,
                                   "SS_DB_TESTING_PASSWORD": False}
    assert await _audits(db, "deploy.environment_update") == [{"changed": [
        "base_domain", "services.api.port", "services.api.proxied",
        "secrets.SS_ANTHROPIC_API_KEY"]}]

    resp = await client.patch(f"{URL}/uat", headers=h,
                              json={"secrets": {"SS_ANTHROPIC_API_KEY": ""}})
    assert resp.json()["secrets_set"]["SS_ANTHROPIC_API_KEY"] is False

    for body, detail in (
            ({"secrets": {"SS_ANTHROPIC_API_KEY": "has space SECRET-x"}},
             {"code": "secret_invalid", "key": "SS_ANTHROPIC_API_KEY"}),
            ({"secrets": {"POSTGRES_PASSWORD": "new-SECRET-x"}},
             {"code": "secret_not_editable", "key": "POSTGRES_PASSWORD"}),
            ({"services": {"api": {"port": 8091}}}, {"code": "ports_conflict"})):
        resp = await client.patch(f"{URL}/uat", headers=h, json=body)
        assert (resp.status_code, resp.json()) == (422, {"detail": detail})
        assert "SECRET-x" not in resp.text

    resp = await client.patch(f"{URL}/uat", headers=h, json={})
    assert resp.status_code == 200
    assert len(await _audits(db, "deploy.environment_update")) == 2


async def test_adopt_too_large(client, db, target, leak_guard):
    from sirdar_api.deploy import ssh
    await trust_fake(db, target)
    serve_remote_env(target, "A=" + "x" * ssh.OUTPUT_LIMIT)
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={"mode": "adopt", "name": "uat",
                                                   "type": "dev", "target": "ssh"})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "adopt_env_too_large"}})


async def test_adopt_rejects_non_ascii_digits(client, db, target, leak_guard):
    await trust_fake(db, target)
    h = await auth_headers(client, db)
    for key, code_key in (("STACK_API_PORT", "STACK_API_PORT"),
                          ("STACK_KEEP_DUMPS", "STACK_KEEP_DUMPS")):
        serve_remote_env(target, remote_env_text(**{key: "²"}))
        resp = await client.post(URL, headers=h, json={"mode": "adopt", "name": "uat",
                                                       "type": "dev", "target": "ssh"})
        assert (resp.status_code, resp.json()) == (422, {"detail": {
            "code": "adopt_value_invalid", "key": code_key}}), key


async def test_adopt_rejects_a_secret_that_wont_render_back(client, db, target, leak_guard):
    await trust_fake(db, target)
    h = await auth_headers(client, db)
    bad = "ab$cd-SECRET-x"
    leak_guard.append(bad)
    serve_remote_env(target, remote_env_text(POSTGRES_PASSWORD=f'"{bad}"'))
    resp = await client.post(URL, headers=h, json={"mode": "adopt", "name": "uat",
                                                   "type": "dev", "target": "ssh"})
    assert (resp.status_code, resp.json()) == (422, {"detail": {
        "code": "adopt_value_invalid", "key": "POSTGRES_PASSWORD"}})
    assert bad not in resp.text


async def test_patch_error_rolls_back(client, db, target, leak_guard):
    await make_environment(db)
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat", headers=h, json={
        "base_domain": "elsewhere.serversherpa.com",
        "secrets": {"POSTGRES_PASSWORD": "new-SECRET-x"}})
    assert (resp.status_code, resp.json()) == (422, {"detail": {
        "code": "secret_not_editable", "key": "POSTGRES_PASSWORD"}})
    body = (await client.get(f"{URL}/uat", headers=h)).json()
    assert body["base_domain"] == "uat.serversherpa.com"
    assert body["services"][0]["hostname"] == "api.uat.serversherpa.com"
    assert await _audits(db, "deploy.environment_update") == []


async def test_create_name_race(client, db, target, leak_guard, monkeypatch):
    from sirdar_api.deploy import environments
    h = await auth_headers(client, db)
    assert (await client.post(URL, headers=h, json=NEW)).status_code == 201

    async def none_found(db, name):                   # both racers saw "no such name"
        return None
    with monkeypatch.context() as patched:
        patched.setattr(environments, "get_by_name", none_found)
        resp = await client.post(URL, headers=h, json=NEW)
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "environment_exists"}})
    assert [e["name"] for e in (await client.get(URL, headers=h)).json()["environments"]] == [
        "qa"]
