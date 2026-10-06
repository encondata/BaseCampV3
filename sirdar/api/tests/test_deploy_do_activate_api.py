"""Activate on a DigitalOcean environment: a deployment that smoke-tests the
slot on its droplet, then moves the load balancer to it (7a's zero-downtime
Switch traffic); Deactivate (a retiring production only) points the load
balancer at nothing; a non-production environment can activate by itself
after a good deploy. The pipeline runs with fakes."""

import uuid

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, Deployment, DoSlot, Environment, PermissionOverride, User
from sirdar_api.deploy import environments, pipeline, vms
from sirdar_api.deploy.provision import VmOutcome
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import built, built_env, deployed, make_do_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA

NEWER = "e1" * 20
URL = "/api/deploy/environments"


@pytest.fixture
async def ready(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_runner,
                fake_publisher, fake_provisioner):
    """make(**kw): a built DigitalOcean environment, every slot deployed at SHA
    and `active` (default: the first slot) live."""
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = built
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)

    async def make(*, active: str | None = None, **kw) -> Environment:
        env = await make_do_environment(db, **kw)
        await built_env(env)
        await deployed(db, env, active or env.slots[0], sha=SHA)
        return env
    return make


async def _wait(resp):
    if resp.status_code == 201:
        await pipeline.wait(uuid.UUID(resp.json()["id"]))
    return resp


async def _activate(client, h, name, **body):
    return await _wait(await client.post(f"{URL}/{name}/activate", headers=h, json=body))


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


async def _env(db, env_id) -> Environment:
    return await db.get(Environment, env_id, populate_existing=True)


async def test_activate_the_idle_slot(client, db, ready, fake_provisioner, fake_runner):
    env = await ready()
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "purple")
                     .values(sha=NEWER, image_tag=NEWER[:8]))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _activate(client, h, "uat9", slot="purple")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["slot"], body["go_live"], body["sha"]) == (
        "activate", "purple", True, NEWER)
    assert [s["key"] for s in body["steps"]] == ["slot_smoke", "go_live"]
    assert fake_runner.steps() == ["slot_smoke"]
    assert fake_provisioner.calls == ["go_live"]
    env = await _env(db, env.id)
    assert (env.active_slot, env.current_sha, env.image_tag, env.status) == (
        "purple", NEWER, NEWER[:8], "ready")
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.activate"))).one()
    assert (audit["environment"], audit["mode"], audit["slot"], audit["go_live"]) == (
        "uat9", "activate", "purple", True)


@pytest.mark.parametrize("body, expected", [
    ({"slot": "orange"}, (409, "slot_already_active")),
    ({"slot": "blue"}, (422, "slot_invalid")),
    ({"slot": None}, (422, "slot_required")),
])
async def test_activate_refusals(client, db, ready, body, expected):
    await ready()
    h = await auth_headers(client, db)
    assert _code(await _activate(client, h, "uat9", **body)) == expected


async def test_a_slot_that_never_ran_a_deploy(client, db, ready):
    env = await ready()
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "purple").values(sha=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _activate(client, h, "uat9", slot="purple")
    assert _code(resp) == (409, "slot_not_deployed")
    assert resp.json()["detail"]["slot"] == "purple"


async def test_only_digitalocean_activates(client, db, ready):
    from .deploy_factories import make_environment
    await make_environment(db, name="lan1", secrets={})
    h = await auth_headers(client, db)
    assert _code(await _activate(client, h, "lan1", slot="orange")) == (
        409, "not_digitalocean_environment")


async def test_production_needs_the_name_and_deactivates_only_when_retiring(
        client, db, ready, fake_runner):
    env = await ready(name="prod", type_="production", account="production", active="blue")
    h = await auth_headers(client, db)
    assert _code(await _activate(client, h, "prod", slot="green")) == (
        422, "confirm_name_mismatch")
    resp = await _activate(client, h, "prod", slot="green", confirm_name="prod")
    assert resp.status_code == 201, resp.text
    assert (await _env(db, env.id)).active_slot == "green"
    assert _code(await _activate(client, h, "prod", slot=None, confirm_name="prod")) == (
        422, "slot_required")
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.commit()
    assert _code(await _activate(client, h, "prod", slot="blue", confirm_name="prod")) == (
        409, "production_retiring")
    fake_runner.requests.clear()
    resp = await _activate(client, h, "prod", slot=None, confirm_name="prod")
    assert resp.status_code == 201, resp.text
    assert ([s["key"] for s in resp.json()["steps"]], resp.json()["slot"]) == (["go_live"], None)
    assert fake_runner.requests == []                    # Deactivate has no slot to test
    env = await _env(db, env.id)
    assert (env.active_slot, env.status) == (None, "ready")
    assert _code(await _activate(client, h, "prod", slot=None, confirm_name="prod")) == (
        409, "already_inactive")


async def test_activate_needs_change(client, db, ready):
    await ready()
    h = await auth_headers(client, db, email="v@test.example.com", roles=("admin",))
    resp = await client.post(f"{URL}/uat9/activate", headers=h, json={"slot": "purple"})
    assert resp.status_code == 403


async def test_a_failed_activate_is_retried(client, db, ready, fake_runner):
    env = await ready()
    fake_runner.results["slot_smoke"] = RunResult(status="failed", rc=2)
    h = await auth_headers(client, db)
    failed = (await _activate(client, h, "uat9", slot="purple")).json()
    env = await _env(db, env.id)
    assert (env.active_slot, env.status) == ("orange", "failed")   # orange still live
    fake_runner.results.clear()
    resp = await _wait(await client.post(f"/api/deploy/deployments/{failed['id']}/retry",
                                         headers=h, json={}))
    assert resp.status_code == 201, resp.text
    assert (resp.json()["mode"], resp.json()["slot"], resp.json()["start_step"]) == (
        "activate", "purple", 13)
    assert (await _env(db, env.id)).active_slot == "purple"


async def test_a_production_activate_retry_needs_the_name(client, db, ready, fake_runner):
    await ready(name="prod", type_="production", account="production", active="blue")
    fake_runner.results["slot_smoke"] = RunResult(status="failed", rc=2)
    h = await auth_headers(client, db)
    failed = (await _activate(client, h, "prod", slot="green", confirm_name="prod")).json()
    fake_runner.results.clear()
    retry = f"/api/deploy/deployments/{failed['id']}/retry"
    assert _code(await client.post(retry, headers=h, json={})) == (422, "confirm_name_mismatch")
    resp = await _wait(await client.post(retry, headers=h, json={"confirm_name": "prod"}))
    assert resp.status_code == 201, resp.text


async def test_auto_activate(client, db, ready, fake_provisioner):
    env = await ready()
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=NEWER)
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat9", headers=h, json={"auto_activate": True})
    assert resp.status_code == 200 and resp.json()["auto_activate"] is True
    resp = await _wait(await client.post(f"{URL}/uat9/deployments", headers=h,
                                         json={"mode": "update"}))
    assert (resp.json()["slot"], resp.json()["go_live"]) == ("purple", True)
    dep = await db.get(Deployment, uuid.UUID(resp.json()["id"]), populate_existing=True)
    assert dep.status == "succeeded"
    env = await _env(db, env.id)
    assert (env.active_slot, env.current_sha, env.status) == ("purple", NEWER, "ready")


async def test_auto_activate_is_not_for_production(client, db, ready):
    await ready(name="prod", type_="production", account="production", active="blue")
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/prod", headers=h, json={"auto_activate": True})
    assert _code(resp) == (422, "auto_activate_not_allowed")
    from .deploy_factories import make_environment
    await make_environment(db, name="lan1", secrets={})
    resp = await client.patch(f"{URL}/lan1", headers=h, json={"auto_activate": True})
    assert _code(resp) == (422, "auto_activate_not_allowed")
    for name in ("prod", "lan1"):                        # turning it off is always fine
        resp = await client.patch(f"{URL}/{name}", headers=h, json={"auto_activate": False})
        assert resp.status_code == 200 and resp.json()["auto_activate"] is False, resp.text


async def test_auto_activate_at_create(client, db, ready):
    env = await make_do_environment(db, name="auto1", auto_activate=True)
    assert (await _env(db, env.id)).auto_activate is True
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={
        "mode": "new", "name": "prod2", "type": "production", "target": "digitalocean",
        "do": {"account": "production", "auto_activate": True}})
    assert _code(resp) == (422, "auto_activate_not_allowed")


async def _deny(client, db, action: str) -> dict:
    """A developer with deploy:<action> denied by an override."""
    email = f"no-{action}@test.example.com"
    h = await auth_headers(client, db, email=email, roles=("developer",))
    user = await db.scalar(select(User).where(User.email == email))
    db.add(PermissionOverride(person_id=user.person_id, resource="deploy", action=action,
                              allow=False))
    await db.commit()
    return h


async def test_activate_needs_add_too(client, db, ready):
    await ready()
    h = await _deny(client, db, "add")                   # so any Activate can be retried
    resp = await client.post(f"{URL}/uat9/activate", headers=h, json={"slot": "purple"})
    assert resp.status_code == 403


async def test_a_one_slot_environment_cannot_deactivate(client, db, ready):
    await ready(slots=1)
    h = await auth_headers(client, db)
    assert _code(await _activate(client, h, "uat9", slot=None)) == (422, "slot_required")


async def test_a_slot_whose_droplet_has_no_address(client, db, ready):
    env = await ready()
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "purple").values(public_ip=None))
    await db.commit()
    h = await auth_headers(client, db)
    assert _code(await _activate(client, h, "uat9", slot="purple")) == (409, "do_not_ready")


async def _retiring_prod(db, ready) -> Environment:
    env = await ready(name="prod", type_="production", account="production", active="blue")
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.commit()
    return env


async def _failed_deactivate(client, db, h, fake_provisioner) -> dict:
    fake_provisioner.fail["go_live"] = "load balancer refused"
    failed = (await _activate(client, h, "prod", slot=None, confirm_name="prod")).json()
    fake_provisioner.fail.clear()
    assert failed["status"] == "running"                  # as started; it fails in the task
    return failed


def _retry(client, h, dep_id, **body):
    return client.post(f"/api/deploy/deployments/{dep_id}/retry", headers=h,
                       json={"confirm_name": "prod", **body})


async def test_a_failed_deactivate_is_retried(client, db, ready, fake_provisioner):
    env = await _retiring_prod(db, ready)
    h = await auth_headers(client, db)
    failed = await _failed_deactivate(client, db, h, fake_provisioner)
    assert (await _env(db, env.id)).active_slot == "blue"
    resp = await _wait(await _retry(client, h, failed["id"]))
    assert resp.status_code == 201, resp.text
    assert ([s["key"] for s in resp.json()["steps"]], resp.json()["slot"]) == (["go_live"], None)
    env = await _env(db, env.id)
    assert (env.active_slot, env.status) == (None, "ready")


async def test_a_deactivate_retry_needs_a_retiring_production(client, db, ready,
                                                              fake_provisioner):
    env = await _retiring_prod(db, ready)
    h = await auth_headers(client, db)
    failed = await _failed_deactivate(client, db, h, fake_provisioner)
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=False))
    await db.commit()
    assert _code(await _retry(client, h, failed["id"])) == (422, "slot_required")
    assert (await _env(db, env.id)).active_slot == "blue"


async def test_a_deactivate_retry_with_nothing_live(client, db, ready, fake_provisioner):
    env = await _retiring_prod(db, ready)
    h = await auth_headers(client, db)
    failed = await _failed_deactivate(client, db, h, fake_provisioner)
    await db.execute(update(Environment).where(Environment.id == env.id).values(active_slot=None))
    await db.commit()
    assert _code(await _retry(client, h, failed["id"])) == (409, "already_inactive")


@pytest.fixture
def lock_spy(monkeypatch):
    calls = []
    real = environments.lock_production

    async def spy(db):
        calls.append(True)
        await real(db)
    monkeypatch.setattr(environments, "lock_production", spy)
    return calls


async def test_production_activate_takes_the_production_lock(client, db, ready, fake_runner,
                                                             lock_spy):
    await ready(name="prod", type_="production", account="production", active="blue")
    h = await auth_headers(client, db)
    fake_runner.results["slot_smoke"] = RunResult(status="failed", rc=2)
    lock_spy.clear()                                      # creating production took it
    failed = (await _activate(client, h, "prod", slot="green", confirm_name="prod")).json()
    assert len(lock_spy) == 1                             # at start
    fake_runner.results.clear()
    assert (await _wait(await _retry(client, h, failed["id"]))).status_code == 201
    assert len(lock_spy) == 2                             # and on retry


async def test_deactivate_takes_the_production_lock(client, db, ready, lock_spy):
    await _retiring_prod(db, ready)
    h = await auth_headers(client, db)
    lock_spy.clear()                                      # creating production took it
    resp = await _activate(client, h, "prod", slot=None, confirm_name="prod")
    assert resp.status_code == 201, resp.text
    assert len(lock_spy) == 1


async def test_a_retiring_production_cannot_update(client, db, ready):
    """Deactivated and retiring: Update would put it live again."""
    env = await _retiring_prod(db, ready)
    await db.execute(update(Environment).where(Environment.id == env.id).values(active_slot=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/prod/deployments", headers=h, json={"mode": "update"})
    assert _code(resp) == (409, "production_retiring")


async def test_a_retiring_production_cannot_retry_an_update(client, db, ready, fake_runner):
    env = await ready(name="prod", type_="production", account="production", active="blue")
    fake_runner.results["up"] = RunResult(status="failed", rc=2)
    h = await auth_headers(client, db)
    failed = (await _wait(await client.post(f"{URL}/prod/deployments", headers=h,
                                            json={"mode": "update"}))).json()
    fake_runner.results.clear()
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.commit()
    resp = await client.post(f"/api/deploy/deployments/{failed['id']}/retry", headers=h, json={})
    assert _code(resp) == (409, "production_retiring")
