"""Shared pieces for the publish tests: fake Cloudflare, NPM and smoke
targets wired into outbound.transports(), and builders."""

from types import SimpleNamespace

import pytest

from sirdar_api.db.models import ManagedRecord
from sirdar_api.deploy import outbound
from sirdar_api.deploy.publish import ServicePlan

from .fake_cloudflare import FakeCloudflare
from .fake_npm import FakeNpm
from .fake_smoke import FakeSmoke

PUBLIC_IP = "203.0.113.7"


@pytest.fixture
def publish_fakes(monkeypatch):
    fakes = SimpleNamespace(cf=FakeCloudflare(), npm=FakeNpm(), smoke=FakeSmoke())
    monkeypatch.setattr(outbound, "transports", lambda: {
        "cloudflare": fakes.cf.transport(), "npm": fakes.npm.transport(),
        "smoke": fakes.smoke.transport()})
    return fakes


def sp(service: str = "api", env: str = "uat2", host_ip: str = "10.10.48.63",
       port: int = 8100, proxied: bool = False) -> ServicePlan:
    return ServicePlan(service, f"{service}.{env}.serversherpa.com", host_ip, port, proxied)


async def managed(db, env, service: str, kind: str, external_id, *, origin: str = "created",
                  name: str | None = None) -> ManagedRecord:
    row = ManagedRecord(environment_id=env.id, service=service, kind=kind,
                        external_id=str(external_id), origin=origin,
                        name=name or f"{service}.{env.base_domain}")
    db.add(row)
    await db.commit()
    return row
