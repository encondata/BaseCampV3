"""A one-slot environment adds its second slot and deploys the running
commit to it (never a seed: the shared database already holds data); sizes
only grow, checked against DigitalOcean's catalogs; step 0 grows the slot
it deploys (power off, resize, power on, each action waited for) and the
database cluster."""

import uuid

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import DBAPIError

from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import (
    AuditLog,
    DoEnvironment,
    DoSlot,
    Environment,
    PermissionOverride,
    User,
)
from sirdar_api.deploy import do_envs, pipeline, vms
from sirdar_api.deploy.provision import VmOutcome
from sirdar_api.deploy.publish import StepFailed

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
from .do_helpers import (  # noqa: F401
    Build,
    Remote,
    built,
    built_env,
    deployed,
    do_build,
    do_cloud,
    make_do_environment,
)
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


async def test_adding_a_slot_needs_add_too(client, db, ready):
    await make_do_environment(db, name="solo", slots=1)
    h = await auth_headers(client, db, email="no-add@test.example.com", roles=("developer",))
    user = await db.scalar(select(User).where(User.email == "no-add@test.example.com"))
    db.add(PermissionOverride(person_id=user.person_id, resource="deploy", action="add",
                              allow=False))
    await db.commit()
    assert (await client.post(f"{URL}/solo/slots", headers=h)).status_code == 403


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


# ---- review fixes: what a grow may be ---------------------------------------------------

async def _set_do(db, env_id, **values) -> None:
    await db.execute(update(DoEnvironment).where(
        DoEnvironment.environment_id == env_id).values(**values))
    await db.commit()


@pytest.mark.parametrize("current, do, code", [
    (None, {"droplet_size": "s-8vcpu-16gb"}, "do_size_invalid"),     # not offered in nyc3
    (None, {"droplet_size": "c-4vcpu-8gb"}, "do_size_invalid"),      # another family
    ({"droplet_size": "s-8vcpu-32gb"}, {"droplet_size": "s-4vcpu-8gb"},
     "do_shrink_refused"),                                           # current not in the catalog
    ({"droplet_size": "custom-size"}, {"droplet_size": "s-4vcpu-8gb"},
     "do_shrink_refused"),                                           # nor readable
    (None, {"db_size": "db-amd-2vcpu-4gb"}, "do_db_size_invalid"),   # another family
    ({"db_size": "db-s-1vcpu-1gb"}, {"db_standby": True}, "db_standby_size_invalid"),
    ({"db_size": "db-s-1vcpu-2gb", "db_standby": True}, {"db_size": "db-s-1vcpu-1gb"},
     "do_db_size_invalid"),                                          # not in the 2-node layout
])
async def test_what_a_grow_may_be(client, db, do_build, current, do, code):
    if current:
        await _set_do(db, do_build.env.id, **current)
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"do": do})
    assert _code(resp) == (422, code)


async def test_a_standby_from_a_size_that_has_one(client, db, do_build):
    await _set_do(db, do_build.env.id, db_size="db-s-1vcpu-2gb")
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"do": {"db_standby": True}})
    assert resp.status_code == 200, resp.text


async def test_the_size_check_holds_the_row_lock(client, db, do_build, monkeypatch):
    """Check and apply are one locked step: a second PATCH can't check
    against the size the first is about to replace."""
    seen = []
    real = do_envs.check_grow

    async def spy(api, row, fields):
        async with get_sessionmaker()() as other:
            try:
                await other.execute(text(
                    "SELECT 1 FROM do_environments WHERE environment_id = :id FOR UPDATE NOWAIT"),
                    {"id": do_build.env.id})
                seen.append("free")
            except DBAPIError:
                seen.append("locked")
            await other.rollback()
        return await real(api, row, fields)

    monkeypatch.setattr(do_envs, "check_grow", spy)
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h,
                              json={"do": {"droplet_size": "s-4vcpu-8gb"}})
    assert resp.status_code == 200, resp.text
    assert seen == ["locked"]


# ---- review fixes: step 0's resizes ------------------------------------------------------

def _droplet(fake, name: str) -> dict:
    return next(d for d in fake.droplets.values() if d["name"] == name)


async def test_an_errored_resize_powers_the_droplet_back_on_and_a_retry_grows_it(db, do_build):
    await do_build.run()
    await _set_do(db, do_build.env.id, droplet_size="s-4vcpu-8gb")
    fake = do_build.cloud.do
    fake.action_errors = {"resize"}
    with pytest.raises(StepFailed) as err:
        await do_build.run(slot="purple", go_live=False)
    assert "The resize of ss-uat9-purple failed" in err.value.reason
    purple = _droplet(fake, "ss-uat9-purple")
    assert (purple["status"], purple["size_slug"]) == ("active", "s-2vcpu-4gb")
    assert [a["type"] for a in fake.actions.values()] == ["power_off", "resize", "power_on"]
    fake.action_errors = set()
    await do_build.run(slot="purple", go_live=False)
    assert (purple["status"], purple["size_slug"]) == ("active", "s-4vcpu-8gb")


async def test_a_power_on_that_never_finishes_is_recovered_by_a_retry(db, do_build):
    await do_build.run()
    await _set_do(db, do_build.env.id, droplet_size="s-4vcpu-8gb")
    fake = do_build.cloud.do
    fake.action_stall = {"power_on"}
    with pytest.raises(StepFailed) as err:
        await do_build.run(slot="purple", go_live=False, prov={"waits": {"droplet": 3}})
    assert "The power-on of ss-uat9-purple" in err.value.reason
    purple = _droplet(fake, "ss-uat9-purple")
    assert (purple["status"], purple["size_slug"]) == ("off", "s-4vcpu-8gb")
    fake.action_stall = set()
    fake.actions.clear()
    await do_build.run(slot="purple", go_live=False)
    assert purple["status"] == "active"
    assert [a["type"] for a in fake.actions.values()] == ["power_on"]


async def test_an_off_droplet_that_still_needs_its_size_is_resized_then_started(db, do_build):
    await do_build.run()
    await _set_do(db, do_build.env.id, droplet_size="s-4vcpu-8gb")
    fake = do_build.cloud.do
    purple = _droplet(fake, "ss-uat9-purple")
    purple["status"] = "off"                     # a cancelled run left it stopped
    await do_build.run(slot="purple", go_live=False)
    assert (purple["status"], purple["size_slug"]) == ("active", "s-4vcpu-8gb")
    assert [a["type"] for a in fake.actions.values()] == ["resize", "power_on"]


async def test_the_live_slot_of_two_is_never_resized(db, do_build):
    await do_build.run()
    await db.execute(update(Environment).where(Environment.id == do_build.env.id)
                     .values(active_slot="orange"))
    await _set_do(db, do_build.env.id, droplet_size="s-4vcpu-8gb")
    fake = do_build.cloud.do
    await do_build.run(slot="orange")
    assert fake.actions == {}
    assert _droplet(fake, "ss-uat9-orange")["size_slug"] == "s-2vcpu-4gb"
    assert "ss-uat9-orange is live, so it stays s-2vcpu-4gb" in do_build.log()


async def test_step_0_never_shrinks_a_larger_droplet(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    _droplet(fake, "ss-uat9-purple")["size_slug"] = "s-4vcpu-8gb"   # grown by hand
    await do_build.run(slot="purple", go_live=False)
    assert fake.actions == {}
    assert "ss-uat9-purple is s-4vcpu-8gb" in do_build.log()


async def test_the_database_resize_waits_through_resizing(db, do_build):
    await do_build.run()
    await _set_do(db, do_build.env.id, db_size="db-s-4vcpu-8gb")
    fake = do_build.cloud.do
    fake.db_resize_polls = 2
    await do_build.run(slot="purple", go_live=False)
    (database,) = fake.databases.values()
    assert (database["status"], database["size"]) == ("online", "db-s-4vcpu-8gb")
    assert sum(path.endswith("/resize") for _, path in fake.writes()) == 1


async def test_a_database_already_resizing_is_waited_for_not_resized_again(db, do_build):
    await do_build.run()
    await _set_do(db, do_build.env.id, db_size="db-s-4vcpu-8gb")
    fake = do_build.cloud.do
    (database,) = fake.databases.values()
    database.update(status="resizing", _resize_left=2, _resize=("db-s-4vcpu-8gb", 1))
    await do_build.run(slot="purple", go_live=False)
    assert (database["status"], database["size"]) == ("online", "db-s-4vcpu-8gb")
    assert not any(path.endswith("/resize") for _, path in fake.writes())


async def _solo(db, do_build) -> tuple:
    env = await make_do_environment(db, name="solo", slots=1)
    build = Build(db, do_build.cloud, env, get_settings(), Remote())
    build.host_key_private = do_build.host_key_private
    await build.run(slot="orange")
    return env, build


async def test_a_one_slot_environment_grows_in_place(db, do_build):
    env, build = await _solo(db, do_build)
    await _set_do(db, env.id, droplet_size="s-4vcpu-8gb")
    fake = do_build.cloud.do
    await build.run(slot="orange")
    orange = _droplet(fake, "ss-solo-orange")
    assert (orange["status"], orange["size_slug"]) == ("active", "s-4vcpu-8gb")
    assert [a["type"] for a in fake.actions.values()] == ["power_off", "resize", "power_on"]
    assert "Resizing ss-solo-orange to s-4vcpu-8gb" in build.log()


async def test_an_added_slot_reaches_the_database_and_carries_the_env_tag(db, do_build):
    env, build = await _solo(db, do_build)
    row = await db.get(Environment, env.id, populate_existing=True)
    await do_envs.add_slot(db, get_settings(), row, "purple")
    row.slots = [*row.slots, "purple"]
    await db.commit()
    await build.run(slot="purple", go_live=False)
    fake = do_build.cloud.do
    purple = _droplet(fake, "ss-solo-purple")
    assert do_envs.env_tag(env.id) in purple["tags"]
    (database,) = [d for d in fake.databases.values() if d["name"] == "ss-solo-db"]
    allowed = {str(r["value"]) for r in fake.db_rules[database["id"]]}
    assert allowed == {str(purple["id"]), str(_droplet(fake, "ss-solo-orange")["id"])}
