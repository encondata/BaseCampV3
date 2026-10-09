"""Creating and editing DigitalOcean environments: the record (frozen
account and sizes, a key pair, one host key per slot), production's rules,
the locked fields, the slot an Update targets and whether it goes live, and
the SSH connection to a slot's droplet."""

import asyncssh
import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import DoEnvironment, DoSlot, Environment
from sirdar_api.deploy import do_accounts, do_envs, envfile, environments, vms
from sirdar_api.deploy import vault
from sirdar_api.deploy.environments import EnvError

from .api_helpers import auth_headers
from .deploy_factories import leak_guard, secrets_key  # noqa: F401
from .do_helpers import configure_account, make_do_environment
from .integration_helpers import configure

pytestmark = pytest.mark.usefixtures("secrets_key")
URL = "/api/deploy/environments"


def _pair(private: str, public: str) -> bool:
    """The stored private key is an OpenSSH key whose public half is `public`."""
    key = asyncssh.import_private_key(private)
    return key.export_public_key("openssh").decode().split()[:2] == public.split()[:2]


async def _private_keys(db) -> list[str]:
    """Every generated private key (decrypted): the droplets' SSH key, each
    slot's host key and the cert-worker's ACME key."""
    settings = get_settings()
    found = []
    for row in await db.scalars(select(DoEnvironment)):
        found += [vault.decrypt(settings, row.ssh_private_key_enc),
                  vault.decrypt(settings, row.acme_key_enc)]
    for slot in await db.scalars(select(DoSlot)):
        found.append(vault.decrypt(settings, slot.host_key_private_enc))
    return found


async def test_create_two_slots(db):
    env = await make_do_environment(db)
    assert (env.type, env.target_id, env.slots, env.active_slot) == (
        "dev", "digitalocean", ["orange", "purple"], None)
    assert (env.proxy_ip, env.bind_ip, env.publish) == ("172.30.0.2", "127.0.0.1", True)
    assert env.spaces_bucket == f"ss-uat9-{env.id.hex[:8]}"
    row = await db.get(DoEnvironment, env.id)
    assert (row.account_key, row.region, row.droplet_size, row.db_size, row.db_standby) == (
        "development", "nyc3", "s-2vcpu-4gb", "db-s-2vcpu-4gb", False)
    assert row.bucket == env.spaces_bucket
    assert _pair(vault.decrypt(get_settings(), row.ssh_private_key_enc), row.ssh_public_key)
    slots = (await db.scalars(select(DoSlot).where(DoSlot.environment_id == env.id))).all()
    assert sorted(s.slot for s in slots) == ["orange", "purple"]
    for s in slots:
        assert _pair(vault.decrypt(get_settings(), s.host_key_private_enc), s.host_key_public)
    hostnames = {s.service: s.hostname for s in await environments.services_of(db, env.id)}
    assert hostnames["api"] == "api.uat9.serversherpa.com"
    assert hostnames["spaces"] is None and hostnames["mailpit"] is None


async def test_production_rules(db):
    env = await make_do_environment(db, name="prod", type_="production", account="production",
                                    slots=None)
    assert env.slots == ["blue", "green"]
    with pytest.raises(EnvError) as e:
        await make_do_environment(db, name="prod2", type_="production", account="production")
    assert e.value.code == "production_exists"
    await db.rollback()
    env.retiring = True
    await db.commit()
    await make_do_environment(db, name="prod2", type_="production", account="production")
    for bad, code in (({"slots": 1}, "do_slots_invalid"), ({"acme_staging": True}, "do_invalid")):
        with pytest.raises(EnvError) as e:
            await make_do_environment(db, name="prod3", type_="production",
                                      account="production", **bad)
        assert e.value.code == code
        await db.rollback()


async def test_create_refusals(db):
    await configure(db, npm=False)
    settings = get_settings()

    async def create(**kw):
        base = dict(name="uat9", type_="dev", target_id="digitalocean",
                    do={"account": "development"})
        return await environments.create_new(db, settings, **{**base, **kw})

    with pytest.raises(EnvError) as e:
        await create()
    assert (e.value.code, e.value.extra) == ("do_account_not_configured",
                                             {"account": "development"})
    await configure_account(db)
    with pytest.raises(EnvError) as e:
        await create(base_domain="uat9.example.org")
    assert e.value.code == "base_domain_not_in_zone"
    with pytest.raises(EnvError) as e:
        await create(type_="production", target_id="proxmox", do=None)
    assert e.value.code == "production_requires_digitalocean"
    with pytest.raises(EnvError) as e:
        await create(target_id="proxmox")
    assert e.value.code == "do_not_allowed"
    for do, code in (({"account": "development", "droplet_size": "Huge!"}, "do_size_invalid"),
                     ({"account": "development", "db_size": "s-2vcpu-4gb"}, "do_db_size_invalid"),
                     ({"account": "development", "slots": 3}, "do_slots_invalid"),
                     ({"account": "elsewhere"}, "do_invalid")):
        with pytest.raises(EnvError) as e:
            await create(do=do)
        assert e.value.code == code
    with pytest.raises(EnvError) as e:
        await create(vm={"ip_mode": "dhcp"})
    assert e.value.code == "vm_not_allowed"


async def test_create_without_cloudflare(db):
    await configure_account(db)
    with pytest.raises(EnvError) as e:
        await environments.create_new(db, get_settings(), name="uat9", type_="dev",
                                      target_id="digitalocean", do={"account": "development"})
    assert (e.value.code, e.value.extra) == ("integration_not_configured",
                                             {"kinds": ["cloudflare"]})


def _env(slots, active=None, auto=False, type_="dev") -> Environment:
    return Environment(name="x", type=type_, target_id="digitalocean", slots=slots,
                       active_slot=active, auto_activate=auto)


def test_target_slot_and_going_live():
    assert do_envs.target_slot(_env(["orange", "purple"])) == "orange"
    assert do_envs.target_slot(_env(["orange", "purple"], "orange")) == "purple"
    assert do_envs.target_slot(_env(["orange", "purple"], "purple")) == "orange"
    assert do_envs.target_slot(_env(["orange"], "orange")) == "orange"
    assert do_envs.goes_live(_env(["orange", "purple"]), "orange")              # first deploy
    assert not do_envs.goes_live(_env(["orange", "purple"], "orange"), "purple")
    assert do_envs.goes_live(_env(["orange", "purple"], "orange", auto=True), "purple")
    assert do_envs.goes_live(_env(["orange"], "orange"), "orange")              # in place
    assert not do_envs.goes_live(_env(["blue", "green"], "blue", type_="production"), "green")


async def test_host_config_is_the_slots_droplet(db, monkeypatch):
    env = await make_do_environment(db)
    assert await vms.host_config(db, get_settings(), env) is None       # no droplet yet
    await do_envs.set_slot(env.id, "purple", public_ip="203.0.113.9", droplet_id="4002")
    await db.refresh(env)
    cfg = await vms.host_config(db, get_settings(), env, slot="purple")
    assert (cfg.host, cfg.user, cfg.port) == ("203.0.113.9", "deploy", vms.VM_SSH_PORT)
    assert cfg.private_key.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    assert await vms.host_config(db, get_settings(), env) is None       # orange: no droplet


async def test_the_api(client, db, leak_guard):
    await configure(db, npm=False)
    await configure_account(db)
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={
        "mode": "new", "name": "uat9", "type": "dev", "target": "digitalocean",
        "do": {"account": "development", "slots": 2, "acme_staging": True}})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["target_kind"], body["slots"], body["active_slot"], body["retiring"]) == (
        "digitalocean", ["orange", "purple"], None, False)
    do = body["do"]
    assert (do["account"], do["account_label"], do["acme_staging"], do["lb_ip"]) == (
        "development", "Development", True, None)
    assert [s["slot"] for s in do["slots"]] == ["orange", "purple"]
    keys = await _private_keys(db)
    assert len(keys) == 4
    leak_guard.extend(keys)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"proxy_ip": "10.0.0.9"})
    assert (resp.status_code, resp.json()["detail"]) == (
        422, {"code": "do_field_locked", "field": "proxy_ip"})
    resp = await client.patch(f"{URL}/uat9", headers=h,
                              json={"retiring": True, "confirm_name": "uat9"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "retiring_not_allowed")
    resp = await client.get("/api/deploy/environment-defaults", headers=h)
    assert resp.json()["do"] == {"droplet_size": "s-2vcpu-4gb", "db_size": "db-s-2vcpu-4gb",
                                 "db_standby": False, "production_slots": ["blue", "green"],
                                 "one_slot": ["orange"], "two_slots": ["orange", "purple"]}


async def test_retiring_production(client, db):
    await make_do_environment(db, name="prod", type_="production", account="production")
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/prod", headers=h, json={"retiring": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "confirm_name_mismatch")
    resp = await client.patch(f"{URL}/prod", headers=h,
                              json={"retiring": True, "confirm_name": "prod"})
    assert resp.status_code == 200 and resp.json()["retiring"] is True


async def test_unretiring_needs_no_other_production(client, db):
    await make_do_environment(db, name="prod", type_="production", account="production")
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/prod", headers=h,
                              json={"retiring": True, "confirm_name": "prod"})
    assert resp.status_code == 200
    await make_do_environment(db, name="prod2", type_="production", account="production")
    resp = await client.patch(f"{URL}/prod", headers=h,
                              json={"retiring": False, "confirm_name": "prod"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "production_exists")


CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIBfakeCA\n-----END CERTIFICATE-----\n"


async def _ready_for_extras(env, **over):
    from sirdar_api.deploy import vault
    values = {"lb_ip": "203.0.113.50", "vpc_ip_range": "10.116.0.0/20",
              "db_host": "private-ss-uat9-db.db.ondigitalocean.com", "db_port": 25060,
              "db_ca_cert": CA_PEM, "spaces_key_id": "DO00KEY000001",
              "spaces_secret_enc": vault.encrypt(get_settings(), "spaces-SECRET-1"), **over}
    await do_envs.set_do(env.id, **values)
    await do_envs.set_slot(env.id, "orange", droplet_id="4001", public_ip="127.0.0.1")
    await do_envs.record(env.id, "load_balancer", "lb-0001", "ss-uat9-lb")


async def test_env_extra(db):
    import base64

    from .deploy_factories import ENV_SECRETS
    env = await make_do_environment(db)
    with pytest.raises(do_envs.DoEnvError) as e:
        await do_envs.env_extra(db, get_settings(), env, "orange", ENV_SECRETS)
    assert e.value.code == "do_not_ready"
    assert e.value.extra["missing"] == ["load balancer address", "VPC range", "database host",
                                        "database port", "database CA", "Spaces key",
                                        "droplet", "load balancer"]
    await _ready_for_extras(env)
    extra, secrets = await do_envs.env_extra(db, get_settings(), env, "orange", ENV_SECRETS)
    password = ENV_SECRETS["POSTGRES_PASSWORD"]
    ca_b64 = base64.b64encode(CA_PEM.encode()).decode()
    from .fake_digitalocean import DEV_RENEW_TOKEN
    key_pem = vault.decrypt(get_settings(), (await do_envs.get(db, env.id)).acme_key_enc)
    acme_b64 = base64.b64encode(key_pem.encode()).decode()
    assert extra == {
        "STACK_EXTERNAL_DATA": "1", "STACK_CADDY": "1", "STACK_NETWORK_SUBNET": "172.30.0.0/24",
        "STACK_HOSTS_IP": "203.0.113.50", "STACK_TRUSTED_PROXIES": "10.116.0.0/20",
        "STACK_DB_HOST": "private-ss-uat9-db.db.ondigitalocean.com", "STACK_DB_PORT": "25060",
        "STACK_DB_NAME": "serversherpa", "STACK_DB_USER": "serversherpa",
        "SS_DATABASE_URL": "postgresql+asyncpg://serversherpa:"
                           f"{password}@private-ss-uat9-db.db.ondigitalocean.com:25060/serversherpa",
        "SS_DATABASE_SSL": "require", "SS_DATABASE_CA_B64": ca_b64,
        "SS_SPACES_ENDPOINT": "https://nyc3.digitaloceanspaces.com",
        "SS_SPACES_REGION": "nyc3", "SS_SPACES_ACCESS_KEY": "DO00KEY000001",
        "SS_SPACES_SECRET_KEY": "spaces-SECRET-1", "SS_SPACES_USE_PATH_STYLE": "false",
        "STACK_DROPLET_ID": "4001",
        "SS_CERT_DO_TOKEN": DEV_RENEW_TOKEN, "SS_CERT_LB_ID": "lb-0001",
        "SS_CERT_NAMES": ",".join(f"{s}.uat9.serversherpa.com"
                                  for s in ("api", "portal", "kiosk", "wiki", "status")),
        "SS_CERT_ACME_DIRECTORY": "https://acme-v02.api.letsencrypt.org/directory",
        "SS_CERT_ACME_KEY": acme_b64,
    }
    assert set(secrets) == {extra["SS_DATABASE_URL"], "spaces-SECRET-1", ca_b64,
                            DEV_RENEW_TOKEN, acme_b64}
    assert list(extra) == [k for k in envfile.EXTRA_KEYS if k in extra]
    # the rendered .env takes every value as it is (one line each)
    assert envfile.parse_env(envfile.render_env(envfile.EnvConfig(
        name=env.name, domain=env.base_domain, image_tag="0123abcd", proxy_ip=env.proxy_ip,
        bind_ip=env.bind_ip, ports=dict(envfile.DEFAULT_PORTS), keep_dumps=5,
        spaces_bucket=env.spaces_bucket, log_level="INFO", secrets=ENV_SECRETS,
        extra=extra)))["SS_DATABASE_CA_B64"] == ca_b64


async def test_env_extra_wants_the_renewal_token_and_a_numeric_droplet(db):
    from .deploy_factories import ENV_SECRETS
    env = await make_do_environment(db)
    await _ready_for_extras(env)
    await do_accounts.save(db, get_settings(), "development", label="Development",
                           region="nyc3", clear_renewal=True)
    await db.commit()
    await do_envs.set_slot(env.id, "orange", droplet_id="not-a-number")
    with pytest.raises(do_envs.DoEnvError) as e:
        await do_envs.env_extra(db, get_settings(), env, "orange", ENV_SECRETS)
    assert e.value.extra["missing"] == ["droplet", "renewal token"]


async def test_env_extra_uses_staging_for_a_staging_environment(db):
    from .deploy_factories import ENV_SECRETS
    env = await make_do_environment(db, acme_staging=True)
    await _ready_for_extras(env)
    extra, _ = await do_envs.env_extra(db, get_settings(), env, "orange", ENV_SECRETS)
    assert extra["SS_CERT_ACME_DIRECTORY"] == get_settings().acme_staging_directory


async def test_env_extra_quotes_the_password_in_the_url(db):
    from .deploy_factories import ENV_SECRETS
    env = await make_do_environment(db)
    await _ready_for_extras(env)
    extra, _ = await do_envs.env_extra(db, get_settings(), env, "orange",
                                       {**ENV_SECRETS, "POSTGRES_PASSWORD": "p@ss/w:rd%"})
    assert extra["SS_DATABASE_URL"].startswith(
        "postgresql+asyncpg://serversherpa:p%40ss%2Fw%3Ard%25@private-ss-uat9-db.")


async def test_the_droplet_env_names_the_environments_own_bucket(db):
    """Render writes SS_SPACES_BUCKET from env.spaces_bucket: on DigitalOcean
    that is the environment's own Spaces bucket, never the default."""
    env = await make_do_environment(db)
    row = await do_envs.get(db, env.id)
    assert env.spaces_bucket == row.bucket != envfile.DEFAULT_SPACES_BUCKET


async def test_a_dev_droplet_environment_gets_home_and_production_does_not(db):
    env = await make_do_environment(db)
    rows = {s.service: s for s in await environments.services_of(db, env.id)}
    assert (rows["home"].hostname, rows["home"].port) == ("uat9.serversherpa.com",
                                                          rows["portal"].port)
    prod = await make_do_environment(db, name="prod", type_="production", account="production",
                                     slots=None)
    assert "home" not in {s.service for s in await environments.services_of(db, prod.id)}
