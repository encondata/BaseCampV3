"""The two DigitalOcean accounts (Production and Development): tokens and
renewal tokens are write-only and vault-encrypted; the same token can't be
both; a token from another team is refused while environments use the
account; SIRDAR_DEPLOY_DO_TOKEN is the Production account's fallback; the
old /integrations/digitalocean routes act on the Production account."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, DoAccount, DoEnvironment, Environment
from sirdar_api.deploy import do_accounts, integrations
from sirdar_api.deploy.integrations import IntegrationError

from .api_helpers import auth_headers
from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import configure_account, do_cloud  # noqa: F401
from .fake_digitalocean import DEV_RENEW_TOKEN, DEV_TOKEN, DO_TOKEN, RENEW_TOKEN

pytestmark = pytest.mark.usefixtures("secrets_key")
URL = "/api/deploy/integrations/digitalocean/accounts"
TOKENS = (DO_TOKEN, DEV_TOKEN, RENEW_TOKEN, DEV_RENEW_TOKEN)


@pytest.fixture
def no_env_token(monkeypatch):
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", "")
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_REGION", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _in_use(db, key: str, team: str | None = "team-dev-0002") -> Environment:
    env = Environment(name="do9", type="dev", target_id="digitalocean",
                      base_domain="do9.serversherpa.com", proxy_ip="172.30.0.2",
                      slots=["orange"])
    db.add(env)
    await db.flush()
    db.add(DoEnvironment(environment_id=env.id, account_key=key, team_uuid=team,
                         region="nyc3", droplet_size="s-2vcpu-4gb", db_size="db-s-2vcpu-4gb",
                         ssh_public_key="ssh-ed25519 x", ssh_private_key_enc=b"k",
                         acme_key_enc=b"a", bucket="ss-do9-00000000"))
    await db.commit()
    return env


async def test_both_accounts_are_always_listed(db, no_env_token):
    view = await do_accounts.public(db, get_settings())
    assert [(a["key"], a["label"], a["configured"]) for a in view] == [
        ("production", "Production", False), ("development", "Development", False)]


async def test_save_load_and_secrets_stay_hidden(db, no_env_token):
    await configure_account(db)
    account = await do_accounts.load(db, get_settings(), "development")
    assert (account.token, account.renewal_token, account.region) == (
        DEV_TOKEN, DEV_RENEW_TOKEN, "nyc3")
    assert DEV_TOKEN not in repr(account) and DEV_RENEW_TOKEN not in repr(account)
    row = await db.get(DoAccount, "development", populate_existing=True)
    assert DEV_TOKEN.encode() not in bytes(row.token_enc)
    view = next(a for a in await do_accounts.public(db, get_settings())
                if a["key"] == "development")
    assert view | {"updated_at": None} == {
        "key": "development", "label": "Development", "region": "nyc3", "configured": True,
        "token_set": True, "source": "stored", "renewal_token_set": True, "team_name": None,
        "environments": [], "updated_at": None, "updated_by_name": None}


async def test_the_environment_token_is_production_only(db, monkeypatch):
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", DO_TOKEN)
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_REGION", "sfo3")
    get_settings.cache_clear()
    try:
        prod = await do_accounts.load(db, get_settings(), "production")
        assert (prod.token, prod.source, prod.region) == (DO_TOKEN, "environment", "sfo3")
        assert await do_accounts.load(db, get_settings(), "development") is None
        with pytest.raises(IntegrationError) as e:
            await do_accounts.require(db, get_settings(), "development")
        assert (e.value.code, e.value.extra) == ("do_account_not_configured",
                                                 {"account": "development"})
    finally:
        get_settings.cache_clear()


async def test_one_token_can_not_be_both_accounts(db, no_env_token):
    await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
    with pytest.raises(IntegrationError) as e:
        await do_accounts.save(db, get_settings(), "development", label="Development",
                               region="nyc3", token=DO_TOKEN)
    assert e.value.code == "do_token_shared"


@pytest.mark.parametrize("field,value,code", [
    ("label", "", "label_invalid"), ("label", "x" * 41, "label_invalid"),
    ("region", "New York", "region_invalid"), ("token", "has space", "do_token_invalid"),
    ("renewal_token", "dop_v1_short", "renewal_token_invalid"),
])
async def test_values_are_checked(db, no_env_token, field, value, code):
    kw = {"label": "Development", "region": "nyc3", "token": DEV_TOKEN, field: value}
    with pytest.raises(IntegrationError) as e:
        await do_accounts.save(db, get_settings(), "development", **kw)
    assert e.value.code == code


async def test_a_token_from_another_team_is_refused_while_in_use(db, no_env_token, do_cloud):
    await configure_account(db)
    await _in_use(db, "development", team="team-dev-0002")
    with pytest.raises(IntegrationError) as e:
        await do_accounts.save(db, get_settings(), "development", label="Development",
                               region="nyc3", token=DO_TOKEN)        # the Production team
    assert (e.value.code, e.value.extra) == ("do_team_changed", {"environments": ["do9"]})
    # A new token for the same team is fine, and the team is remembered.
    other = "dop_v1_" + "77" * 32
    do_cloud.do.tokens[other] = None
    from . import fake_digitalocean
    fake_digitalocean.TEAMS[other] = ("team-dev-0002", "Encon Development")
    try:
        assert await do_accounts.save(db, get_settings(), "development", label="Development",
                                      region="nyc3", token=other) == ["token"]
    finally:
        del fake_digitalocean.TEAMS[other]
    row = await db.get(DoAccount, "development", populate_existing=True)
    assert (row.team_uuid, row.team_name) == ("team-dev-0002", "Encon Development")


async def test_clear_is_refused_while_in_use(db, no_env_token):
    await configure_account(db)
    await _in_use(db, "development")
    with pytest.raises(IntegrationError) as e:
        await do_accounts.clear(db, "development")
    assert (e.value.code, e.value.extra) == ("account_in_use", {"environments": ["do9"]})


async def test_the_integrations_facade_is_the_production_account(db, no_env_token):
    assert await integrations.save(db, get_settings(), "digitalocean", {}, DO_TOKEN,
                                   None) == ["token"]
    await db.commit()
    assert (await integrations.load_digitalocean(db, get_settings())).token == DO_TOKEN
    assert (await do_accounts.load(db, get_settings(), "production")).token == DO_TOKEN
    assert await integrations.is_configured(db, "digitalocean")
    assert (await integrations.public(db, get_settings()))["digitalocean"]["token_set"]
    assert await integrations.remove(db, "digitalocean") is True
    await db.commit()
    assert await do_accounts.load(db, get_settings(), "production") is None


# ---- routes ------------------------------------------------------------------------

async def test_account_routes(client, db, no_env_token, do_cloud):
    h = await auth_headers(client, db)
    resp = await client.put(f"{URL}/development", headers=h, json={
        "label": "Dev account", "region": "nyc3", "token": DEV_TOKEN,
        "renewal_token": DEV_RENEW_TOKEN})
    assert resp.status_code == 200, resp.text
    dev = resp.json()["accounts"][1]
    assert (dev["label"], dev["token_set"], dev["renewal_token_set"]) == (
        "Dev account", True, True)
    resp = await client.post(f"{URL}/development/test", headers=h)
    assert resp.status_code == 200, resp.text
    checks = {c["label"]: c for c in resp.json()["checks"]}
    assert list(checks) == ["Account", "Team", "Droplets", "Region", "Renewal token"]
    assert checks["Team"]["value"] == "Encon Development"
    assert checks["Renewal token"]["status"] == "pass"
    resp = await client.put(f"{URL}/bogus", headers=h, json={"label": "x", "region": "nyc3"})
    assert resp.status_code == 422
    assert (await client.delete(f"{URL}/development", headers=h)).status_code == 204
    audits = [a.changes for a in await db.scalars(
        select(AuditLog).where(AuditLog.action.like("deploy.do_account%"))
        .order_by(AuditLog.id))]
    assert audits[0] == {"account": "development",
                         "changed": ["label", "region", "token", "renewal_token"]}
    texts = [repr(a) for a in audits] + [resp.text]
    assert not any(t in text for t in TOKENS for text in texts)


async def test_a_renewal_token_that_reads_droplets_warns(client, db, no_env_token, do_cloud):
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/development/test", headers=h, json={
        "label": "Development", "region": "nyc3", "token": DEV_TOKEN,
        "renewal_token": DEV_TOKEN})
    check = next(c for c in resp.json()["checks"] if c["label"] == "Renewal token")
    assert check["status"] == "warn"
    assert "can read droplets" in check["value"]


async def test_account_routes_need_change(client, db, no_env_token):
    viewer = await auth_headers(client, db, email="v@test.example.com", roles=("admin",))
    assert (await client.get(URL, headers=viewer)).status_code == 200
    resp = await client.put(f"{URL}/development", headers=viewer,
                            json={"label": "x", "region": "nyc3"})
    assert resp.status_code == 403
