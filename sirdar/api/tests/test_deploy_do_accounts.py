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


# ---- review fixes ------------------------------------------------------------------

FACADE = "/api/deploy/integrations/digitalocean"
UNKNOWN = "dop_v1_" + "ab" * 32           # the fake answers 401 for it


def _no_tokens(*texts) -> None:
    for text in texts:
        for token in TOKENS + (UNKNOWN,):
            assert token not in text


async def _account_row(db, key: str) -> DoAccount:
    return await db.get(DoAccount, key, populate_existing=True)


async def _locked(key: str) -> bool:
    """Whether another transaction holds the row lock on this account."""
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    from sirdar_api.db.engine import get_sessionmaker
    async with get_sessionmaker()() as other:
        try:
            await other.execute(text("SELECT 1 FROM do_accounts WHERE key = :k "
                                     "FOR UPDATE NOWAIT"), {"k": key})
        except DBAPIError:
            return True
        finally:
            await other.rollback()
    return False


async def test_save_and_clear_lock_both_accounts(db, no_env_token):
    await do_accounts.save(db, get_settings(), "development", label="Development",
                           region="nyc3")
    assert await _locked("production") and await _locked("development")
    await db.rollback()
    await do_accounts.clear(db, "development")
    assert await _locked("production") and await _locked("development")
    await db.rollback()
    assert not await _locked("production")


async def test_lock_account_locks_the_row(db):
    row = await do_accounts.lock_account(db, "development")
    assert row.key == "development"
    assert await _locked("development") and not await _locked("production")
    await db.rollback()


async def test_an_unreadable_other_token_does_not_block_a_save(db, no_env_token, caplog):
    from cryptography.fernet import Fernet
    row = await _account_row(db, "production")
    row.token_enc = Fernet(Fernet.generate_key()).encrypt(DO_TOKEN.encode())
    await db.commit()
    assert await do_accounts.save(db, get_settings(), "development", label="Development",
                                  region="nyc3", token=DEV_TOKEN) == ["region", "token"]
    _no_tokens(caplog.text)


@pytest.mark.parametrize("renewal", [DO_TOKEN, DEV_TOKEN], ids=["production", "same"])
async def test_a_renewal_token_can_not_be_an_account_token(db, no_env_token, renewal):
    await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
    with pytest.raises(IntegrationError) as e:
        await do_accounts.save(db, get_settings(), "development", label="Development",
                               region="nyc3", token=DEV_TOKEN, renewal_token=renewal)
    assert e.value.code == "renewal_token_shared"


async def test_team_of_without_a_team(do_cloud):
    import httpx

    def account(body):
        return lambda method, rest, b, request, token: httpx.Response(
            200, json={"account": body})
    do_cloud.do._account = account({"uuid": "acct-1", "email": "x@example.com"})
    assert await do_accounts.team_of(DEV_TOKEN) == ("personal:acct-1", None)
    do_cloud.do._account = account({"email": "x@example.com"})
    assert await do_accounts.team_of(DEV_TOKEN) == ("personal:x@example.com", None)
    do_cloud.do._account = account({"status": "active"})
    from sirdar_api.deploy import ConnectFailed
    with pytest.raises(ConnectFailed) as e:
        await do_accounts.team_of(DEV_TOKEN)
    assert e.value.reason == "DigitalOcean didn't say which team this token belongs to."


async def test_resolve_takes_the_account_and_its_region(db, monkeypatch):
    from sirdar_api.deploy import digitalocean
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", DO_TOKEN)
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_REGION", "sfo3")
    get_settings.cache_clear()
    try:
        dev = await digitalocean.resolve(db, get_settings(), account="development")
        assert (dev.deploy_do_token, dev.deploy_do_region) == (None, "")
        prod = await digitalocean.resolve(db, get_settings())
        assert (prod.deploy_do_token.get_secret_value(), prod.deploy_do_region) == (
            DO_TOKEN, "sfo3")
        await configure_account(db, "development", region="ams3")
        dev = await digitalocean.resolve(db, get_settings(), account="development")
        assert (dev.deploy_do_token.get_secret_value(), dev.deploy_do_region) == (
            DEV_TOKEN, "ams3")
        await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN,
                                region="lon1")       # a stored region beats the env one
        prod = await digitalocean.resolve(db, get_settings())
        assert prod.deploy_do_region == "lon1"
    finally:
        get_settings.cache_clear()


async def test_route_conflicts(client, db, no_env_token, do_cloud, caplog):
    h = await auth_headers(client, db)
    await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
    await configure_account(db)
    await _in_use(db, "development")
    texts = []
    resp = await client.put(f"{URL}/development", headers=h, json={
        "label": "Development", "region": "nyc3", "token": DO_TOKEN})
    texts.append(resp.text)
    assert (resp.status_code, resp.json()["detail"]) == (409, {"code": "do_token_shared"})
    other = "dop_v1_" + "cd" * 32                     # answers for "team-x"
    do_cloud.do.tokens[other] = None
    resp = await client.put(f"{URL}/development", headers=h, json={
        "label": "Development", "region": "nyc3", "token": other})
    texts.append(resp.text)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "do_team_changed", "environments": ["do9"]})
    resp = await client.delete(f"{URL}/development", headers=h)
    texts.append(resp.text)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "account_in_use", "environments": ["do9"]})
    row = await _account_row(db, "development")
    assert row.token_enc is not None
    _no_tokens(caplog.text, *texts)


async def test_bad_gateway_paths(client, db, no_env_token, do_cloud, caplog):
    h = await auth_headers(client, db)
    await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
    await _in_use(db, "production", team="team-prod-0001")
    texts = []
    # The old facade: the team check fails (DigitalOcean answers 401).
    resp = await client.put(FACADE, headers=h, json={"token": UNKNOWN})
    texts.append(resp.text)
    assert resp.status_code == 502, resp.text
    assert resp.json()["detail"]["code"] == "connect_failed"
    assert (await integrations.load_digitalocean(db, get_settings())).token == DO_TOKEN
    # The account PUT, same failure.
    resp = await client.put(f"{URL}/production", headers=h, json={
        "label": "Production", "region": "nyc3", "token": UNKNOWN})
    texts.append(resp.text)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (502, "connect_failed")
    # Test: DigitalOcean unreachable, and something unexpected.
    do_cloud.do.down = True
    resp = await client.post(f"{URL}/production/test", headers=h)
    texts.append(resp.text)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (502, "connect_failed")
    do_cloud.do.down = False

    async def boom(*a, **k):
        raise RuntimeError("secret " + DO_TOKEN)
    import sirdar_api.deploy.do_accounts as mod
    orig = mod.test
    mod.test = boom
    try:
        resp = await client.post(f"{URL}/production/test", headers=h)
    finally:
        mod.test = orig
    texts.append(resp.text)
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": "Sirdar couldn't reach it."})
    audits = [repr(a.changes) for a in await db.scalars(select(AuditLog))]
    _no_tokens(caplog.text, *texts, *audits)


async def test_the_account_test_reads_the_account_once(client, db, no_env_token, do_cloud,
                                                        caplog):
    h = await auth_headers(client, db)
    await configure_account(db)
    resp = await client.post(f"{URL}/development/test", headers=h)
    assert resp.status_code == 200, resp.text
    calls = [r for r in do_cloud.do.requests if r.url.path == "/v2/account"]
    assert len(calls) == 1
    row = await _account_row(db, "development")
    assert (row.team_uuid, row.team_name) == ("team-dev-0002", "Encon Development")
    # An unsaved token is tried, never stored, and doesn't change the team.
    other = "dop_v1_" + "ef" * 32
    do_cloud.do.tokens[other] = None
    before = bytes(row.token_enc)
    resp = await client.post(f"{URL}/development/test", headers=h, json={
        "label": "Development", "region": "nyc3", "token": other})
    assert resp.status_code == 200, resp.text
    row = await _account_row(db, "development")
    assert (bytes(row.token_enc), row.team_uuid, row.team_name) == (
        before, "team-dev-0002", "Encon Development")
    _no_tokens(caplog.text, resp.text)
    assert other not in resp.text and other not in caplog.text


async def test_responses_and_logs_carry_no_token(client, db, no_env_token, do_cloud, caplog):
    import logging
    caplog.set_level(logging.DEBUG)
    h = await auth_headers(client, db)
    texts = []
    resp = await client.put(f"{URL}/production", headers=h, json={
        "label": "Production", "region": "nyc3", "token": DO_TOKEN,
        "renewal_token": RENEW_TOKEN})
    texts.append(resp.text)
    resp = await client.put(f"{URL}/development", headers=h, json={
        "label": "Development", "region": "nyc3", "token": DEV_TOKEN,
        "renewal_token": DEV_RENEW_TOKEN})
    texts.append(resp.text)
    for key in ("production", "development"):
        resp = await client.post(f"{URL}/{key}/test", headers=h)
        assert resp.status_code == 200, resp.text
        texts.append(resp.text)
    texts.append((await client.get(URL, headers=h)).text)
    texts.append((await client.get("/api/deploy/integrations", headers=h)).text)
    texts.append((await client.post(f"{FACADE}/test", headers=h)).text)
    texts.append((await client.put(FACADE, headers=h, json={"token": None})).text)
    _no_tokens(caplog.text, *texts)


async def test_deleting_an_empty_account_is_not_found(client, db, no_env_token):
    h = await auth_headers(client, db)
    resp = await client.delete(f"{URL}/development", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (404, {"code": "integration_not_found"})
    assert not list(await db.scalars(
        select(AuditLog).where(AuditLog.action.like("deploy.do_account%"))))


async def test_clear_records_who(db, no_env_token):
    from .factories import make_user
    user = await make_user(db, email="ops@test.example.com")
    await configure_account(db)
    assert await do_accounts.clear(db, "development", actor_id=user.person_id) is True
    await db.commit()
    row = await _account_row(db, "development")
    assert row.updated_by == user.person_id and row.token_enc is None


async def test_the_team_is_read_before_the_rows_are_locked(db, no_env_token, monkeypatch):
    """DigitalOcean's answer can take seconds: neither account row is held
    FOR UPDATE meanwhile (an environment create, or the other account's
    save, isn't blocked behind it)."""
    from sqlalchemy import text

    from sirdar_api.db.engine import get_sessionmaker
    await configure_account(db)
    await _in_use(db, "development", team="team-dev-0002")
    free: list[bool] = []

    async def team_of(token):
        async with get_sessionmaker()() as s:
            for key in ("production", "development"):
                got = await s.execute(text(
                    "SELECT key FROM do_accounts WHERE key = :k FOR UPDATE NOWAIT"), {"k": key})
                free.append(got.scalar() == key)
            await s.rollback()
        return "team-dev-0002", "Encon Development"
    monkeypatch.setattr(do_accounts, "team_of", team_of)
    other = "dop_v1_" + "78" * 32
    assert await do_accounts.save(db, get_settings(), "development", label="Development",
                                  region="nyc3", token=other) == ["token"]
    assert free == [True, True]
    row = await db.get(DoAccount, "development", populate_existing=True)
    assert (row.team_uuid, row.team_name) == ("team-dev-0002", "Encon Development")


async def test_environments_that_appear_while_saving_are_checked(db, no_env_token, monkeypatch):
    """No environment used the account when the save began, so no team was
    read; one appeared before the lock: the save is refused, not stored
    with an unchecked team."""
    await configure_account(db)
    await _in_use(db, "development", team="team-dev-0002")
    real = do_accounts.in_use
    calls: list[int] = []

    async def in_use(db_, key):          # the first (unlocked) read is from before it
        calls.append(1)
        return [] if len(calls) == 1 else await real(db_, key)
    monkeypatch.setattr(do_accounts, "in_use", in_use)
    with pytest.raises(IntegrationError) as e:
        await do_accounts.save(db, get_settings(), "development", label="Development",
                               region="nyc3", token="dop_v1_" + "79" * 32)
    assert e.value.code == "do_account_changed"


async def test_a_test_that_clears_the_renewal_token_skips_it(client, db, no_env_token, do_cloud):
    await configure_account(db)                          # with DEV_RENEW_TOKEN stored
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/development/test", headers=h, json={
        "label": "Development", "region": "nyc3", "clear_renewal_token": True})
    assert resp.status_code == 200, resp.text
    check = next(c for c in resp.json()["checks"] if c["label"] == "Renewal token")
    assert check["status"] == "warn" and "cleared" in check["value"]
    assert f"Bearer {DEV_RENEW_TOKEN}" not in {
        r.headers.get("authorization") for r in do_cloud.do.requests}
