"""Shared fixtures and builders for the deploy pipeline tests (phase 2a)."""

import pytest
from cryptography.fernet import Fernet

from sirdar_api.config import get_settings
from sirdar_api.db.models import Environment, EnvironmentSecret, EnvironmentService
from sirdar_api.deploy import envfile, known_hosts, pipeline, vault

from .fake_runner import FakeRunner

SECRETS_KEY = Fernet.generate_key().decode()
ENV_SECRETS = {
    "POSTGRES_PASSWORD": "pg-SECRET-0a1b2c3d4e5f",
    "SPACES_SECRET_KEY": "spaces-SECRET-6a7b8c9d",
    "SS_JWT_SECRET": "jwt-SECRET-0f1e2d3c4b5a",
    "SS_TOTP_ENCRYPTION_KEY": Fernet.generate_key().decode(),
    "SS_PASSWORD_PEPPER": "pepper-SECRET-99887766",
    "SS_WIKI_SERVICE_TOKEN": "wiki-SECRET-55443322",
}


@pytest.fixture
def secrets_key(monkeypatch):
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", SECRETS_KEY)
    get_settings.cache_clear()
    yield SECRETS_KEY
    get_settings.cache_clear()


@pytest.fixture
def fake_runner(monkeypatch):
    runner = FakeRunner()
    monkeypatch.setattr(pipeline, "make_runner", lambda settings: runner)
    return runner


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
                           secrets: dict | None = None) -> Environment:
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
    for key, value in (ENV_SECRETS if secrets is None else secrets).items():
        db.add(EnvironmentSecret(environment_id=env.id, key=key,
                                 value_enc=vault.encrypt(settings, value)))
    await db.commit()
    return env
