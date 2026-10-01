import asyncssh
import httpx
import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, SshKnownHost
from sirdar_api.deploy import digitalocean

from .api_helpers import auth_headers
from .ssh_server import KEY_PASSPHRASE, SSH_PASSWORD, SSH_USER, ssh_server  # noqa: F401
from .test_deploy_digitalocean import TOKEN, _transport

AWS_SECRET = "aws-SECRET-access-key-999"
SECRETS = (TOKEN, SSH_PASSWORD, KEY_PASSPHRASE, AWS_SECRET)
DEPLOY_ENV = ("DO_TOKEN", "DO_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION",
              "GCP_PROJECT_ID", "GCP_CREDENTIALS_FILE", "GCP_REGION", "SSH_HOST", "SSH_PORT",
              "SSH_USER", "SSH_PASSWORD", "SSH_KEY_PATH", "SSH_KEY_PASSPHRASE", "KEYS_DIR")


@pytest.fixture
def deploy_env(monkeypatch):
    """Set SIRDAR_DEPLOY_* (everything else blank) and re-read settings."""
    def apply(**values):
        for name in DEPLOY_ENV:
            monkeypatch.setenv(f"SIRDAR_DEPLOY_{name}", "")
        monkeypatch.setenv("SIRDAR_DEPLOY_SSH_PORT", "22")
        monkeypatch.setenv("SIRDAR_DEPLOY_KEYS_DIR", "/app/deploy-keys")
        for name, value in values.items():
            monkeypatch.setenv(f"SIRDAR_DEPLOY_{name.upper()}", str(value))
        get_settings.cache_clear()
    apply()
    yield apply
    get_settings.cache_clear()


@pytest.fixture
def bodies(client):
    """Every response body this test saw; checked for secrets at the end."""
    seen: list[str] = []

    async def record(response: httpx.Response):
        await response.aread()
        seen.append(response.text)

    client.event_hooks["response"].append(record)
    yield seen
    assert seen, "the response hook recorded nothing"
    for text in seen:
        for secret in SECRETS:
            assert secret not in text


def _ssh_env(deploy_env, fake, **over):
    values = dict(ssh_host=fake.host, ssh_port=fake.port, ssh_user=SSH_USER,
                  ssh_password=SSH_PASSWORD, keys_dir=fake.keys_dir,
                  do_token=TOKEN, aws_access_key_id="AKIA", aws_secret_access_key=AWS_SECRET,
                  ssh_key_passphrase=KEY_PASSPHRASE)
    values.update(over)
    deploy_env(**values)


async def _connect_audits(db):
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == "deploy.connect")
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def test_targets_for_admin(client, db, deploy_env, bodies):
    deploy_env(do_token=TOKEN, do_region="nyc3", ssh_host="10.10.48.20", ssh_user="root",
               ssh_password=SSH_PASSWORD, ssh_key_path="id_ed25519",
               ssh_key_passphrase=KEY_PASSPHRASE,
               aws_access_key_id="AKIA", aws_secret_access_key=AWS_SECRET, aws_region="us-east-1")
    h = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.get("/api/deploy/targets", headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert body["targets"] == [
        {"id": "aws", "label": "AWS", "available": False, "configured": True,
         "summary": "region us-east-1"},
        {"id": "gcp", "label": "Google Cloud", "available": False, "configured": False,
         "summary": None},
        {"id": "digitalocean", "label": "DigitalOcean", "available": True, "configured": True,
         "summary": "region nyc3"},
        {"id": "ssh", "label": "Custom (SSH)", "available": True, "configured": True,
         "summary": "root@10.10.48.20:22 · key + password"},
    ]
    assert [t["id"] for t in body["types"]] == ["blue", "green", "dev", "beta"]
    assert body["types"][0] == {"id": "blue", "label": "Blue", "description": "Production slot"}


async def test_permissions(client, db, deploy_env, bodies):
    assert (await client.get("/api/deploy/targets")).status_code == 401
    h = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get("/api/deploy/targets", headers=h)).status_code == 200
    assert (await client.get("/api/deploy/known-hosts", headers=h)).status_code == 200
    for method, url, kw in (
            ("POST", "/api/deploy/connect", {"json": {"target": "ssh", "type": "dev"}}),
            ("POST", "/api/deploy/known-hosts",
             {"json": {"host": "h", "port": 22, "fingerprint": "SHA256:x"}}),
            ("DELETE", "/api/deploy/known-hosts?host=h&port=22", {})):
        resp = await client.request(method, url, headers=h, **kw)
        assert resp.status_code == 403, url
        assert resp.json()["detail"]["code"] == "forbidden"
    assert await _connect_audits(db) == []


async def test_connect_validation_and_audit(client, db, deploy_env, bodies):
    h = await auth_headers(client, db)
    for payload in ({"target": "heroku", "type": "dev"}, {"target": "ssh", "type": "prod"},
                    {"target": "ssh"}):
        assert (await client.post("/api/deploy/connect", headers=h, json=payload)).status_code \
            == 422
    for target, code in (("aws", "target_unavailable"), ("gcp", "target_unavailable"),
                         ("digitalocean", "target_not_configured"),
                         ("ssh", "target_not_configured")):
        resp = await client.post("/api/deploy/connect", headers=h,
                                 json={"target": target, "type": "beta"})
        assert resp.status_code == 400 and resp.json() == {"detail": {"code": code}}
    assert await _connect_audits(db) == [
        {"target": "aws", "type": "beta", "ok": False, "code": "target_unavailable"},
        {"target": "gcp", "type": "beta", "ok": False, "code": "target_unavailable"},
        {"target": "digitalocean", "type": "beta", "ok": False, "code": "target_not_configured"},
        {"target": "ssh", "type": "beta", "ok": False, "code": "target_not_configured"}]


@pytest.fixture
def do_transport(monkeypatch):
    holder = {"transport": _transport()}
    real = digitalocean.test_connection

    async def fake(settings, *, transport=None):
        return await real(settings, transport=holder["transport"])

    monkeypatch.setattr(digitalocean, "test_connection", fake)
    return holder


async def test_digitalocean_connect(client, db, deploy_env, do_transport, bodies):
    deploy_env(do_token=TOKEN, do_region="nyc3")
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "digitalocean", "type": "blue"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["ok"], body["target"], body["type"]) == (True, "digitalocean", "blue")
    assert {"label": "Region", "status": "pass", "value": "nyc3 available"} in body["checks"]
    assert body["facts"]["email"] == "ops@example.com"

    do_transport["transport"] = _transport(status=401)
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "digitalocean", "type": "blue"})
    assert resp.status_code == 502
    assert resp.json() == {"detail": {"code": "connect_failed",
                                      "reason": "DigitalOcean rejected the API token."}}
    assert await _connect_audits(db) == [
        {"target": "digitalocean", "type": "blue", "ok": True},
        {"target": "digitalocean", "type": "blue", "ok": False, "code": "connect_failed"}]


async def test_ssh_trust_on_first_use_flow(client, db, deploy_env, ssh_server, bodies):
    _ssh_env(deploy_env, ssh_server)
    h = await auth_headers(client, db)
    connect = {"target": "ssh", "type": "dev"}

    resp = await client.post("/api/deploy/connect", headers=h, json=connect)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "host_key_unknown", "host": "127.0.0.1",
                                     "port": ssh_server.port, "key_type": "ssh-ed25519",
                                     "fingerprint": ssh_server.fingerprint}

    trust = {"host": "127.0.0.1", "port": ssh_server.port, "fingerprint": ssh_server.fingerprint}
    for bad in ({**trust, "host": "10.0.0.9"}, {**trust, "port": ssh_server.port + 1}):
        resp = await client.post("/api/deploy/known-hosts", headers=h, json=bad)
        assert resp.status_code == 400
        assert resp.json() == {"detail": {"code": "not_configured_host"}}
    resp = await client.post("/api/deploy/known-hosts", headers=h,
                             json={**trust, "fingerprint": "SHA256:stale"})
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "host_key_changed", "host": "127.0.0.1",
                                     "port": ssh_server.port, "key_type": "ssh-ed25519",
                                     "expected": "SHA256:stale",
                                     "actual": ssh_server.fingerprint}

    resp = await client.post("/api/deploy/known-hosts", headers=h, json=trust)
    assert resp.status_code == 200, resp.text
    row = resp.json()
    assert (row["host"], row["port"], row["key_type"], row["fingerprint"],
            row["trusted_by_name"]) == ("127.0.0.1", ssh_server.port, "ssh-ed25519",
                                        ssh_server.fingerprint, "Boss User")
    assert row["trusted_at"]
    listed = (await client.get("/api/deploy/known-hosts", headers=h)).json()
    assert listed == [row]

    resp = await client.post("/api/deploy/connect", headers=h, json=connect)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["ok"], body["target"], body["type"]) == (True, "ssh", "dev")
    assert [c["label"] for c in body["checks"]] == [
        "OS", "Kernel", "Docker", "Compose", "Disk", "Memory"]
    assert body["facts"]["fingerprint"] == ssh_server.fingerprint

    url = f"/api/deploy/known-hosts?host=127.0.0.1&port={ssh_server.port}"
    assert (await client.delete(url, headers=h)).status_code == 204
    resp = await client.delete(url, headers=h)
    assert resp.status_code == 404 and resp.json() == {"detail": {"code": "not_found"}}
    assert (await client.get("/api/deploy/known-hosts", headers=h)).json() == []
    resp = await client.post("/api/deploy/connect", headers=h, json=connect)
    assert resp.json()["detail"]["code"] == "host_key_unknown"

    assert await _connect_audits(db) == [
        {"target": "ssh", "type": "dev", "ok": False, "code": "host_key_unknown"},
        {"target": "ssh", "type": "dev", "ok": True},
        {"target": "ssh", "type": "dev", "ok": False, "code": "host_key_unknown"}]
    actions = list(await db.scalars(
        select(AuditLog.action).where(AuditLog.action.like("deploy.host_%"))
        .order_by(AuditLog.id)))
    assert actions == ["deploy.host_trust", "deploy.host_forget"]
    for changes in await db.scalars(select(AuditLog.changes)):
        for secret in SECRETS:
            assert secret not in repr(changes)


async def test_ssh_mismatch_and_auth_failure(client, db, deploy_env, ssh_server, bodies):
    _ssh_env(deploy_env, ssh_server, ssh_password="wrong-password")
    h = await auth_headers(client, db)
    other = asyncssh.generate_private_key("ssh-ed25519")
    db.add(SshKnownHost(host="127.0.0.1", port=ssh_server.port, key_type="ssh-ed25519",
                        fingerprint_sha256=other.get_fingerprint("sha256"),
                        public_key=other.export_public_key("openssh").decode().strip()))
    await db.commit()
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "ssh", "type": "green"})
    assert resp.status_code == 409
    assert resp.json()["detail"] == {
        "code": "host_key_mismatch", "host": "127.0.0.1", "port": ssh_server.port,
        "key_type": "ssh-ed25519", "expected": other.get_fingerprint("sha256"),
        "actual": ssh_server.fingerprint}

    url = f"/api/deploy/known-hosts?host=127.0.0.1&port={ssh_server.port}"
    assert (await client.delete(url, headers=h)).status_code == 204
    trust = {"host": "127.0.0.1", "port": ssh_server.port, "fingerprint": ssh_server.fingerprint}
    assert (await client.post("/api/deploy/known-hosts", headers=h, json=trust)).status_code == 200
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "ssh", "type": "green"})
    assert resp.status_code == 502
    assert resp.json() == {"detail": {
        "code": "connect_failed",
        "reason": "The SSH server rejected the username, password or key."}}


async def test_ssh_key_problems_and_trust_unreachable(client, db, deploy_env, ssh_server,
                                                      bodies):
    _ssh_env(deploy_env, ssh_server, ssh_key_path="id_locked", ssh_key_passphrase="nope")
    h = await auth_headers(client, db)
    trust = {"host": "127.0.0.1", "port": ssh_server.port, "fingerprint": ssh_server.fingerprint}
    assert (await client.post("/api/deploy/known-hosts", headers=h, json=trust)).status_code == 200
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "ssh", "type": "dev"})
    assert resp.status_code == 502
    assert resp.json()["detail"]["reason"] == "Couldn't unlock the SSH key (check the passphrase)."

    _ssh_env(deploy_env, ssh_server, ssh_key_path="../secrets/id_rsa")
    resp = await client.post("/api/deploy/connect", headers=h,
                             json={"target": "ssh", "type": "dev"})
    assert resp.json()["detail"]["reason"] == "The SSH key file id_rsa wasn't found in deploy-keys."

    _ssh_env(deploy_env, ssh_server, ssh_port=1)
    resp = await client.post("/api/deploy/known-hosts", headers=h, json={**trust, "port": 1})
    assert resp.status_code == 502
    assert resp.json() == {"detail": {"code": "connect_failed",
                                      "reason": "Couldn't reach 127.0.0.1:1."}}


async def test_unexpected_connect_error_is_audited(client, db, deploy_env, ssh_server,
                                                   monkeypatch):
    from sirdar_api.deploy import ssh as ssh_mod

    async def boom(settings, db):
        raise RuntimeError("kaboom")

    _ssh_env(deploy_env, ssh_server)
    monkeypatch.setattr(ssh_mod, "test_connection", boom)
    h = await auth_headers(client, db)
    with pytest.raises(RuntimeError):
        await client.post("/api/deploy/connect", headers=h, json={"target": "ssh", "type": "dev"})
    assert await _connect_audits(db) == [
        {"target": "ssh", "type": "dev", "ok": False, "code": "error"}]
