"""The Deploy page's DigitalOcean pieces per account: regions and the
connection test read the chosen account's token; the target counts as set
up when either account has one."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog

from .api_helpers import auth_headers
from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import configure_account, do_cloud  # noqa: F401
from .fake_digitalocean import DEV_TOKEN

pytestmark = pytest.mark.usefixtures("secrets_key")


@pytest.fixture(autouse=True)
def _no_env_token(monkeypatch):
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def test_regions_per_account(client, db, do_cloud):
    await configure_account(db)                      # Development only
    h = await auth_headers(client, db)
    resp = await client.get("/api/deploy/digitalocean/regions?account=development", headers=h)
    assert resp.status_code == 200, resp.text
    assert {r.headers["authorization"] for r in do_cloud.do.requests} == {f"Bearer {DEV_TOKEN}"}
    resp = await client.get("/api/deploy/digitalocean/regions", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (400, "target_not_configured")
    resp = await client.get("/api/deploy/digitalocean/regions?account=staging", headers=h)
    assert resp.status_code == 422


async def test_connect_uses_the_chosen_account(client, db, do_cloud):
    await configure_account(db)
    h = await auth_headers(client, db)
    do_cloud.do.requests.clear()
    resp = await client.post("/api/deploy/connect", headers=h, json={
        "target": "digitalocean", "type": "dev", "account": "development"})
    assert resp.status_code == 200, resp.text
    assert {r.headers["authorization"] for r in do_cloud.do.requests} == {f"Bearer {DEV_TOKEN}"}
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.connect"))).one()
    assert audit["account"] == "development"


async def test_targets_count_either_account(client, db, do_cloud):
    h = await auth_headers(client, db)
    listed = (await client.get("/api/deploy/targets", headers=h)).json()["targets"]
    assert next(t for t in listed if t["id"] == "digitalocean")["configured"] is False
    await configure_account(db)
    listed = (await client.get("/api/deploy/targets", headers=h)).json()["targets"]
    assert next(t for t in listed if t["id"] == "digitalocean")["configured"] is True


async def test_the_account_is_audited_only_for_digitalocean(client, db, do_cloud):
    h = await auth_headers(client, db)
    await client.post("/api/deploy/connect", headers=h, json={
        "target": "ssh", "type": "dev", "account": "development"})
    (changes,) = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.connect"))).all()
    assert "account" not in changes
