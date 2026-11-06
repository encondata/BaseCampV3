"""Step 20 (Seed starter content): planned only for a first Update that
starts empty and asked for it, after everything else; the learning switch;
the font note; a failure fails step 20 and Retry runs it again; the deploy
route takes seed_content only for such an Update."""

import uuid

import pytest
from sqlalchemy import select

from sirdar_api.db.models import Deployment, Environment
from sirdar_api.deploy import envfile, pipeline, steps, vms
from sirdar_api.deploy.runner import RunResult
from sirdar_api.deploy.steps import STEPS_BY_KEY, StepDef
from sirdar_api.deploy.vmcommon import VmOutcome

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
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_apps_api import NEW, URL, target  # noqa: F401
from .test_deploy_deployments_api import LS
from .test_deploy_deployments_api import SHA as REMOTE_SHA
from .test_deploy_pipeline import SHA, _load


def _keys(**kw) -> list[str]:
    return [s.key for s in steps.plan_for("update", seed=True, **kw)]


def test_the_seed_step_ends_every_first_update_plan():
    assert STEPS_BY_KEY["seed"] == StepDef(20, "seed", "Seed starter content", "seed.yml",
                                           20 * 60)
    assert _keys()[-2:] == ["up", "seed"]
    assert _keys(publish=True, first_admin=True)[-6:] == [
        "up", "first_admin", "dns", "proxy", "smoke", "seed"]
    assert _keys(cloud=True, go_live=True, first_admin=True)[-6:] == [
        "up", "first_admin", "dns", "slot_smoke", "go_live", "seed"]
    assert _keys(vm=True, bluegreen=True, publish=True, go_live=True)[-5:] == [
        "up", "dns", "slot_smoke", "lan_switch", "seed"]
    for kw in ({"restore": True}, {}):
        mode = "update" if kw else "reset"
        with pytest.raises(ValueError):
            steps.plan_for(mode, seed=True, **kw)


@pytest.fixture
async def fresh(db, deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    return await make_environment(db, name="fresh", status="new")


async def _run(db, env, **kw):
    dep = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, seed_content=True, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_step_20_runs_last_with_the_learning_switch_and_the_font_note(db, fresh,
                                                                            fake_runner):
    dep_id = await _run(db, fresh)
    dep, steps_, _ = await _load(dep_id)
    assert fake_runner.steps()[-2:] == ["up", "seed"]
    assert [s.number for s in steps_][-1] == 20
    assert (dep.status, dep.seed_content) == ("succeeded", True)
    request = next(r for r in fake_runner.requests if r.step == "seed")
    assert request.playbook == "seed.yml"
    assert request.extravars["seed_learning"] is True
    assert steps_[-1].log.endswith(pipeline.SEED_FONT_NOTE)


async def test_without_learn_there_is_no_learning_seed(db, fresh, fake_runner):
    fresh.apps = ["wiki", "kiosk", "status", "mailpit"]
    await db.commit()
    await _run(db, fresh)
    request = next(r for r in fake_runner.requests if r.step == "seed")
    assert request.extravars["seed_learning"] is False


async def test_a_failed_seed_fails_step_20_and_a_retry_runs_only_it(db, fresh, fake_runner):
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)
    dep_id = await _run(db, fresh)
    dep, steps_, _ = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 20)
    assert [s.status for s in steps_ if s.key == "up"] == ["succeeded"]
    del fake_runner.results["seed"]
    fake_runner.requests.clear()
    env = await db.get(Environment, fresh.id, populate_existing=True)
    retry = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                             actor_id=None, start_step=20, retry_of=dep_id,
                                             seed_content=True)
    await db.commit()
    pipeline.launch(retry.id)
    await pipeline.wait(retry.id)
    assert fake_runner.steps() == ["seed"]
    assert (await _load(retry.id))[0].status == "succeeded"


async def test_the_route_seeds_a_first_empty_update_and_retry_keeps_it(client, db, target,
                                                                       fake_runner):
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{REMOTE_SHA}\trefs/heads/main\n"
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)
    resp = await client.post(f"{URL}/qa1/deployments", headers=h,
                             json={"mode": "update", "seed_content": True})
    assert resp.status_code == 201, resp.text
    dep_id = uuid.UUID(resp.json()["id"])
    await pipeline.wait(dep_id)
    body = (await client.get(f"/api/deploy/deployments/{dep_id}", headers=h)).json()
    assert (body["seed_content"], body["steps"][-1]["key"], body["failed_step"]) == (
        True, "seed", 20)
    del fake_runner.results["seed"]
    resp = await client.post(f"/api/deploy/deployments/{dep_id}/retry", headers=h, json={})
    assert resp.status_code == 201, resp.text
    retry_id = uuid.UUID(resp.json()["id"])
    await pipeline.wait(retry_id)
    retry = await db.get(Deployment, retry_id, populate_existing=True)
    assert (retry.seed_content, retry.status) == (True, "succeeded")
    assert fake_runner.steps()[-1] == "seed"


async def test_seed_content_only_for_a_first_update(client, db, target):
    await trust_fake(db, target)
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.post(f"{URL}/qa1/deployments", headers=h, json={
        "mode": "reset", "confirm_name": "qa1", "seed_content": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "seed_content_not_allowed")
    env = await db.scalar(select(Environment).where(Environment.name == "qa1"))
    env.current_sha = REMOTE_SHA
    await db.commit()
    resp = await client.post(f"{URL}/qa1/deployments", headers=h,
                             json={"mode": "update", "seed_content": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "seed_content_not_allowed")


# ---- a failed seed: the new commit is already serving ---------------------------------

async def _retry_seed(db, dep_id, env_id, fake_runner, **kw):
    """Retry from step 20 alone; it succeeds."""
    del fake_runner.results["seed"]
    fake_runner.requests.clear()
    env = await db.get(Environment, env_id, populate_existing=True)
    dep = await db.get(Deployment, dep_id, populate_existing=True)
    retry = await pipeline.create_deployment(
        db, env, mode="update", git_ref="main", sha=dep.sha, actor_id=None, start_step=20,
        retry_of=dep_id, seed_content=True, cloud=dep.cloud, vm=dep.vm,
        bluegreen=dep.bluegreen, slot=dep.slot, go_live=dep.go_live, **kw)
    await db.commit()
    pipeline.launch(retry.id)
    await pipeline.wait(retry.id)
    assert fake_runner.steps() == ["seed"]
    return await _load(retry.id)


async def test_a_failed_seed_records_the_commit_the_environment_serves(db, fresh, fake_runner,
                                                                       fake_publisher):
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)
    dep_id = await _run(db, fresh)
    dep, _, env = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 20)
    assert (env.current_sha, env.image_tag) == (SHA, envfile.image_tag(SHA))
    retried, _, env = await _retry_seed(db, dep_id, fresh.id, fake_runner)
    assert (retried.status, env.current_sha, env.status) == ("succeeded", SHA, "ready")


async def test_a_failed_seed_then_an_update_requires_the_dump(db, fresh, fake_runner,
                                                              fake_publisher):
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)
    await _run(db, fresh)
    del fake_runner.results["seed"]
    fake_runner.requests.clear()
    env = await db.get(Environment, fresh.id, populate_existing=True)
    nxt = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None)
    await db.commit()
    pipeline.launch(nxt.id)
    await pipeline.wait(nxt.id)
    dump = next(r for r in fake_runner.requests if r.step == "dump")
    assert dump.extravars["dump_required"] is True


@pytest.fixture
async def do_fresh(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_provisioner,
                   request):
    from .do_helpers import built, make_do_environment
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    env = await make_do_environment(db, slots=request.param)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = built
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)
    return env


@pytest.mark.parametrize("do_fresh", [1, 2], indirect=True)
async def test_a_failed_seed_on_digitalocean_records_the_live_commit(
        db, do_fresh, fake_runner, fake_publisher, fake_provisioner):
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)
    dep = await pipeline.create_deployment(db, do_fresh, mode="update", git_ref="main", sha="",
                                           actor_id=None, cloud=True, slot="orange",
                                           go_live=True, seed_content=True)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    dep, steps_, env = await _load(dep.id)
    assert (dep.status, dep.failed_step, steps_[-1].key) == ("failed", 20, "seed")
    assert (env.active_slot, env.current_sha, env.image_tag) == (
        "orange", SHA, envfile.image_tag(SHA))
    retried, _, env = await _retry_seed(db, dep.id, do_fresh.id, fake_runner)
    assert (retried.status, env.current_sha, env.status) == ("succeeded", SHA, "ready")


async def test_a_failed_seed_on_digitalocean_then_an_update_requires_the_dump(
        db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_provisioner, fake_runner,
        fake_publisher):
    from .do_helpers import built, make_do_environment
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    env = await make_do_environment(db, slots=1)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = built
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)
    for seed in (True, False):
        env = await db.get(Environment, env.id, populate_existing=True)
        dep = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha="",
                                               actor_id=None, cloud=True, slot="orange",
                                               go_live=True, seed_content=seed)
        await db.commit()
        fake_runner.requests.clear()
        pipeline.launch(dep.id)
        await pipeline.wait(dep.id)
    dump = next(r for r in fake_runner.requests if r.step == "dump")
    assert dump.extravars["dump_required"] is True


async def test_a_failed_seed_on_lan_bluegreen_records_the_live_commit(
        db, secrets_key, ssh_server, monkeypatch, fake_provisioner, fake_runner,
        fake_publisher):
    from .integration_helpers import configure, configure_esxi
    from .lan_helpers import lan_built, make_bluegreen_environment
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    fake_provisioner.outcomes["provision"] = VmOutcome()
    env = await make_bluegreen_environment(db)
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)
    dep = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, vm=True, bluegreen=True,
                                           slot="orange", go_live=True, seed_content=True)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    dep, steps_, env = await _load(dep.id)
    assert (dep.status, dep.failed_step, steps_[-1].key) == ("failed", 20, "seed")
    assert (env.active_slot, env.current_sha, env.image_tag) == (
        "orange", SHA, envfile.image_tag(SHA))
    retried, _, env = await _retry_seed(db, dep.id, env.id, fake_runner)
    assert (retried.status, env.current_sha, env.status) == ("succeeded", SHA, "ready")


async def test_a_failed_seed_whose_slot_emptied_stays_failed_once(
        db, secrets_key, ssh_server, monkeypatch, fake_provisioner, fake_runner,
        fake_publisher):
    """after_success refusing (the slot emptied meanwhile) is logged: the
    deployment keeps step 20's failure, not a second close as unexpected."""
    from sirdar_api.deploy import do_envs, lan_slots

    from .integration_helpers import configure, configure_esxi
    from .lan_helpers import lan_built, make_bluegreen_environment
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    fake_provisioner.outcomes["provision"] = VmOutcome()
    env = await make_bluegreen_environment(db)
    fake_runner.results["seed"] = RunResult(status="failed", rc=2)

    async def refuse(*_a, **_k):
        raise do_envs.DoEnvError("slot_not_deployed", slot="orange")

    monkeypatch.setattr(lan_slots, "after_success", refuse)
    dep = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, vm=True, bluegreen=True,
                                           slot="orange", go_live=True, seed_content=True)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    dep, steps_, env = await _load(dep.id)
    assert (dep.status, dep.failed_step, steps_[-1].key) == ("failed", 20, "seed")
    assert dep.error != pipeline.UNEXPECTED
    assert steps_[-1].status == "failed"
