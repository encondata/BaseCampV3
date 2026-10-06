"""Creating and editing DigitalOcean environments: the record (frozen
account and sizes, a key pair, one host key per slot), production's rules,
the locked fields, the slot an Update targets and whether it goes live, and
the SSH connection to a slot's droplet."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import DoEnvironment, DoSlot, Environment
from sirdar_api.deploy import do_envs, environments, vms
from sirdar_api.deploy.environments import EnvError

from .api_helpers import auth_headers
from .deploy_factories import leak_guard, secrets_key  # noqa: F401
from .do_helpers import configure_account, make_do_environment
from .integration_helpers import configure

pytestmark = pytest.mark.usefixtures("secrets_key")
URL = "/api/deploy/environments"


async def test_create_two_slots(db):
    env = await make_do_environment(db)
    assert (env.type, env.target_id, env.slots, env.active_slot) == (
        "dev", "digitalocean", ["orange", "purple"], None)
    assert (env.proxy_ip, env.bind_ip, env.publish) == ("172.30.0.2", "127.0.0.1", True)
    assert env.spaces_bucket == f"ss-uat9-{env.id.hex[:8]}"
    row = await db.get(DoEnvironment, env.id)
    assert (row.account_key, row.region, row.droplet_size, row.db_size, row.db_standby) == (
        "development", "nyc3", "s-2vcpu-4gb", "db-s-2vcpu-4gb", False)
    assert row.bucket == env.spaces_bucket and b"PRIVATE" not in bytes(row.ssh_private_key_enc)
    slots = (await db.scalars(select(DoSlot).where(DoSlot.environment_id == env.id))).all()
    assert sorted(s.slot for s in slots) == ["orange", "purple"]
    assert all(s.host_key_private_enc is not None for s in slots)
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
        await create(type_="production", target_id="ssh", do=None)
    assert e.value.code in ("production_requires_digitalocean", "target_not_configured")
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
