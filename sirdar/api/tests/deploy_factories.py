"""Shared fixtures and builders for the deploy pipeline tests (phase 2a)."""

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Environment, EnvironmentSecret, EnvironmentService
from sirdar_api.deploy import envfile, known_hosts, pipeline, vault

from .fake_provisioner import FakeProvisioner
from .fake_publisher import FakePublisher
from .fake_runner import FakeRunner
from .ssh_server import SSH_PASSWORD

SECRETS_KEY = Fernet.generate_key().decode()
# Shaped like the values Sirdar generates (and uat holds): hex, plus a
# Fernet key for TOTP. Each is distinct so leak checks can find it.
ENV_SECRETS = {
    "POSTGRES_PASSWORD": "a1" * 8 + "0a1b2c3d4e5f" * 4,
    "SPACES_SECRET_KEY": "b2" * 8 + "6a7b8c9d" * 6,
    "SS_JWT_SECRET": "c3" * 8 + "0f1e2d3c4b5a" * 4,
    "SS_TOTP_ENCRYPTION_KEY": Fernet.generate_key().decode(),
    "SS_PASSWORD_PEPPER": "d4" * 8 + "99887766" * 6,
    "SS_WIKI_SERVICE_TOKEN": "e5" * 8 + "55443322" * 6,
}


@pytest.fixture
def secrets_key(monkeypatch):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", SECRETS_KEY)
    get_settings.cache_clear()
    yield SECRETS_KEY
    get_settings.cache_clear()


@pytest.fixture
def snapshots_dir(monkeypatch, tmp_path, secrets_key):
    """SIRDAR_SNAPSHOTS_DIR in this test's tmp folder (and a secrets key)."""
    folder = tmp_path / "snapshots"
    monkeypatch.setenv("SIRDAR_SNAPSHOTS_DIR", str(folder))
    get_settings.cache_clear()
    yield folder
    get_settings.cache_clear()


@pytest.fixture
def fake_runner(monkeypatch):
    runner = FakeRunner()
    monkeypatch.setattr(pipeline, "make_runner", lambda settings: runner)
    return runner


@pytest.fixture
def fake_publisher(monkeypatch):
    publisher = FakePublisher()
    monkeypatch.setattr(pipeline, "make_publisher", lambda settings: publisher)
    return publisher


@pytest.fixture
def fake_provisioner(monkeypatch):
    provisioner = FakeProvisioner()
    monkeypatch.setattr(pipeline, "make_provisioner", lambda settings: provisioner)
    return provisioner


@pytest.fixture(autouse=True)
async def stop_pipeline():
    """No deployment task outlives its test (and its event loop)."""
    yield
    await pipeline.shutdown()


async def trust_fake(db, fake) -> None:
    await known_hosts.trust(db, fake.host, fake.port, fake.fingerprint, actor_id=None)
    await db.commit()


async def make_environment(db, *, name: str = "uat", target_id: str = "ssh",
                           host: str = "127.0.0.1", status: str = "ready",
                           current_sha: str | None = None,
                           secrets: dict | None = None,
                           with_home: bool = False) -> Environment:
    settings = get_settings()
    env = Environment(name=name, type="dev", target_id=target_id,
                      base_domain=f"{name}.serversherpa.com", git_ref="main",
                      current_sha=current_sha,
                      image_tag=envfile.image_tag(current_sha) if current_sha else None,
                      status=status, proxy_ip="10.0.0.2", bind_ip="0.0.0.0",
                      keep_dumps=5, spaces_bucket="serversherpa", log_level="INFO")
    db.add(env)
    await db.flush()
    for service in envfile.SERVICES:
        db.add(EnvironmentService(
            environment_id=env.id, service=service, host_ip=host,
            port=envfile.DEFAULT_PORTS[service], proxied=False,
            hostname=(f"{service}.{env.base_domain}"
                      if service in envfile.PUBLIC_SERVICES else None)))
    if with_home:
        db.add(EnvironmentService(
            environment_id=env.id, service="home", host_ip=host,
            port=envfile.DEFAULT_PORTS["portal"], proxied=False, hostname=env.base_domain))
    for key, value in (ENV_SECRETS if secrets is None else secrets).items():
        db.add(EnvironmentSecret(environment_id=env.id, key=key,
                                 value_enc=vault.encrypt(settings, value)))
    await db.commit()
    return env


# ---- a hand-built environment to adopt (shaped like uat on 10.10.48.63) ----------

OLD_MINIO = "minio-SECRET-legacy-123"
ADOPT_SHA = "e73b99ca" + "1" * 32
CAT_ENV = "cat -- /opt/serversherpa/uat/.env"
REPO_HEAD = "git -C /opt/serversherpa/uat/repo rev-parse HEAD"
REMOTE_BASE = {
    "STACK_ENV": "uat", "STACK_DOMAIN": "uat.serversherpa.com", "STACK_IMAGE_TAG": "e73b99ca",
    "STACK_REPO_DIR": "/opt/serversherpa/uat/repo", "STACK_PROXY_IP": "10.10.48.6",
    "STACK_BIND_IP": "0.0.0.0", "STACK_API_PORT": "8000", "STACK_PORTAL_PORT": "8091",
    "STACK_KIOSK_PORT": "8090", "STACK_WIKI_PORT": "8096", "STACK_SPACES_PORT": "9000",
    "STACK_STATUS_PORT": "8095", "STACK_MAILPIT_PORT": "8025", "STACK_KEEP_DUMPS": "5",
    **ENV_SECRETS,
    "SS_SPACES_BUCKET": "serversherpa", "SS_LOG_LEVEL": "INFO", "SS_ANTHROPIC_API_KEY": "",
    "SS_DB_TESTING_PASSWORD": "", "MINIO_ROOT_PASSWORD": OLD_MINIO,
}


def remote_env_text(**over) -> str:
    """The hand-built .env; a keyword set to None drops that key."""
    values = {**REMOTE_BASE, **over}
    return "# hand-made\n" + "".join(f"{k}={v}\n" for k, v in values.items() if v is not None)


def serve_remote_env(fake, text: str | None = None, sha: str = ADOPT_SHA) -> None:
    fake.overrides[CAT_ENV] = remote_env_text() if text is None else text
    fake.overrides[REPO_HEAD] = sha + "\n"


@pytest.fixture
async def leak_guard(client, db, secrets_key):
    """Every response body this test saw, and every audit row, must hold no
    secret: ENV_SECRETS, the legacy MinIO password, the fake SSH password,
    every secret stored in the database (decrypted with SECRETS_KEY) and
    whatever the test appends to the yielded list."""
    seen: list[str] = []

    async def record(response):
        await response.aread()
        seen.append(response.text)

    client.event_hooks["response"].append(record)
    extra: list[str] = []
    yield extra
    await db.rollback()
    fernet = Fernet(SECRETS_KEY.encode())
    stored = [fernet.decrypt(bytes(r.value_enc)).decode()
              for r in await db.scalars(select(EnvironmentSecret))]
    audits = [repr(c) for c in await db.scalars(select(AuditLog.changes))]
    assert seen, "the response hook recorded nothing"
    secrets = (*ENV_SECRETS.values(), OLD_MINIO, SSH_PASSWORD, *stored, *extra)
    for text in seen + audits:
        for secret in secrets:
            assert secret not in text
