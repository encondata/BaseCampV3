"""A one-slot environment adds its second slot and deploys the running
commit to it (never a seed: the shared database already holds data); sizes
only grow, checked against DigitalOcean's catalogs; step 0 grows the slot
it deploys (power off, resize, power on, each action waited for) and the
database cluster."""

import uuid

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, DoEnvironment, DoSlot, Environment
from sirdar_api.deploy import pipeline, vms
from sirdar_api.deploy.provision import VmOutcome

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    make_environment,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import built, built_env, deployed, do_build, do_cloud, make_do_environment  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA

URL = "/api/deploy/environments"


@pytest.fixture
async def ready(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_runner,
                fake_publisher, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = built
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


async def test_add_the_second_slot(client, db, ready):
    env = await make_do_environment(db, name="solo", slots=1)
    await built_env(env)
    await deployed(db, env, "orange", sha=SHA)
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/solo/slots", headers=h)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["environment"]["slots"] == ["orange", "purple"]
    dep = body["deployment"]
    assert (dep["mode"], dep["slot"], dep["go_live"], dep["sha"]) == (
        "update", "purple", False, SHA)
    assert "restore" not in [s["key"] for s in dep["steps"]]     # never a seed
    await pipeline.wait(uuid.UUID(dep["id"]))
    purple = await db.get(DoSlot, (env.id, "purple"), populate_existing=True)
    assert purple is not None and purple.sha == SHA
    env = await db.get(Environment, env.id, populate_existing=True)
    assert env.active_slot == "orange"                           # traffic didn't move
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.slot_add"))).one()
    assert audit == {"environment": "solo", "slot": "purple"}
    assert _code(await client.post(f"{URL}/solo/slots", headers=h)) == (409, "slots_full")


async def test_a_new_environment_adds_the_slot_without_deploying(client, db, ready):
    env = await make_do_environment(db, name="solo", slots=1)
    h = await auth_headers(client, db)
    body = (await client.post(f"{URL}/solo/slots", headers=h)).json()
    assert body["deployment"] is None and body["environment"]["slots"] == ["orange", "purple"]
    assert (await db.get(DoSlot, (env.id, "purple"))).host_key_private_enc is not None


async def test_slot_refusals(client, db, ready):
    await make_do_environment(db, name="prod", type_="production", account="production")
    await make_environment(db, name="lan1", secrets={})
    h = await auth_headers(client, db)
    assert _code(await client.post(f"{URL}/prod/slots", headers=h)) == (422, "slot_not_allowed")
    assert _code(await client.post(f"{URL}/lan1/slots", headers=h)) == (
        409, "not_digitalocean_environment")
    viewer = await auth_headers(client, db, email="v@test.example.com", roles=("admin",))
    assert (await client.post(f"{URL}/prod/slots", headers=viewer)).status_code == 403


@pytest.mark.parametrize("do, status, code", [
    ({"droplet_size": "s-4vcpu-8gb"}, 200, None),
    ({"droplet_size": "s-1vcpu-2gb"}, 422, "do_shrink_refused"),
    ({"droplet_size": "s-99vcpu-1tb"}, 422, "do_size_invalid"),
    ({"db_size": "db-s-4vcpu-8gb"}, 200, None),
    ({"db_size": "db-s-1vcpu-1gb"}, 422, "do_shrink_refused"),
    ({"db_size": "db-s-64vcpu-1tb"}, 422, "do_db_size_invalid"),
    ({"db_standby": True}, 200, None),
])
async def test_sizes_only_grow(client, db, do_build, do, status, code):
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"do": do})
    assert resp.status_code == status, resp.text
    if code:
        assert resp.json()["detail"]["code"] == code
        return
    row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
    key, value = next(iter(do.items()))
    assert getattr(row, key) == value
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_update"))).one()
    assert audit["changed"] == [f"do.{key}"]


async def test_standby_never_goes_away(client, db, do_build):
    await db.execute(update(DoEnvironment).where(
        DoEnvironment.environment_id == do_build.env.id).values(db_standby=True))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"do": {"db_standby": False}})
    assert _code(resp) == (422, "do_shrink_refused")


async def test_sizes_belong_to_digitalocean(client, db, do_build):
    await make_environment(db, name="lan1", secrets={})
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/lan1", headers=h, json={"do": {"db_standby": True}})
    assert _code(resp) == (422, "do_not_allowed")


async def test_step_0_grows_the_slot_it_deploys_and_the_database(db, do_build):
    await do_build.run()
    await db.execute(update(DoEnvironment).where(
        DoEnvironment.environment_id == do_build.env.id).values(
        droplet_size="s-4vcpu-8gb", db_size="db-s-4vcpu-8gb", db_standby=True))
    await db.commit()
    fake = do_build.cloud.do
    fake.action_polls = 2                # each droplet action finishes only once polled
    await do_build.run(slot="purple", go_live=False)
    sizes = {d["name"]: d["size_slug"] for d in fake.droplets.values()}
    assert sizes == {"ss-uat9-orange": "s-2vcpu-4gb", "ss-uat9-purple": "s-4vcpu-8gb"}
    purple = next(d for d in fake.droplets.values() if d["name"] == "ss-uat9-purple")
    assert purple["status"] == "active"
    assert [a["type"] for a in fake.actions.values()] == ["power_off", "resize", "power_on"]
    (database,) = fake.databases.values()
    assert (database["size"], database["num_nodes"]) == ("db-s-4vcpu-8gb", 2)
    log = do_build.log()
    assert "Resizing ss-uat9-purple to s-4vcpu-8gb" in log
    assert "Database ss-uat9-db: resizing to db-s-4vcpu-8gb, 2 nodes." in log


async def test_a_second_run_with_matching_sizes_resizes_nothing(db, do_build):
    await do_build.run()
    await do_build.run(slot="purple", go_live=False)
    fake = do_build.cloud.do
    assert fake.actions == {}
    assert not any(path.endswith("/resize") for _, path in fake.writes())
