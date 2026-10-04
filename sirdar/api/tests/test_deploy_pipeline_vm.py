import asyncio
import base64
from dataclasses import replace

import pytest

from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, Environment, ProxmoxVm
from sirdar_api.deploy import envfile, pipeline, provision, vms
from sirdar_api.deploy.provision import VmOutcome
from sirdar_api.deploy.runner import RunResult
from sirdar_api.deploy.steps import STEPS_BY_KEY

from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .integration_helpers import PX_TOKEN_SECRET, configure_proxmox
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import OLD, SHA, UPDATE_KEYS, _load
from .vm_helpers import make_vm_environment

SNAP = "sirdar-20261004T120000Z"


@pytest.fixture
async def vm_env(db, deploy_env, secrets_key, ssh_server, monkeypatch):
    """uat3 on Proxmox, deployed at OLD; the tests' SSH server plays its VM
    (127.0.0.1, key pinned) once something records the VM's address."""
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_proxmox(db)
    env = await make_vm_environment(db, current_sha=OLD)
    await trust_fake(db, ssh_server)
    return env


async def _vm_up(ctx) -> None:
    """What a real step 0 leaves behind: the VM's id and address."""
    await provision._set_vm(ctx.env_id, vmid=120, created=True, ip="127.0.0.1")


async def _start(db, env, mode="update", sha=SHA, **kw):
    dep = await pipeline.create_deployment(db, env, mode=mode, git_ref="main", sha=sha,
                                           actor_id=None, vm=True, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_step_0_builds_the_vm_then_the_host_steps_run_on_it(db, vm_env, fake_runner,
                                                                   fake_provisioner, ssh_server):
    fake_provisioner.effects["provision"] = _vm_up
    fake_provisioner.outcomes["provision"] = VmOutcome(sha=SHA, vm_snapshot=SNAP)
    dep_id = await _start(db, vm_env, sha="", take_vm_snapshot=True)
    dep, steps, env = await _load(dep_id)
    assert fake_provisioner.calls == ["provision"] and fake_runner.steps() == UPDATE_KEYS
    assert (steps[0].number, steps[0].key, steps[0].status, steps[0].log) == (
        0, "provision", "succeeded", "provision: ok\n")
    assert (dep.status, dep.sha, dep.vm, dep.take_vm_snapshot, dep.vm_snapshot) == (
        "succeeded", SHA, True, True, SNAP)
    assert (env.status, env.current_sha, env.image_tag) == ("ready", SHA, envfile.image_tag(SHA))
    ctx = fake_provisioner.contexts[0]
    assert (ctx.env_name, ctx.sha, ctx.take_snapshot, ctx.vm_snapshot, ctx.vm.static_ip) == (
        "uat3", "", True, None, "127.0.0.1")
    target = fake_runner.requests[0].target
    assert (target.host, target.port, target.user, target.password, target.become_password) == (
        "127.0.0.1", ssh_server.port, "deploy", None, None)
    assert target.private_key.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    render = next(r for r in fake_runner.requests if r.step == "render")
    env_file = base64.b64decode(render.extravars["env_file_b64"]).decode()
    assert f"STACK_IMAGE_TAG={envfile.image_tag(SHA)}\n" in env_file   # step 0's commit


async def test_a_vm_without_an_address_stops_at_step_1(db, vm_env, fake_runner,
                                                        fake_provisioner):
    dep_id = await _start(db, vm_env)
    dep, steps, env = await _load(dep_id)
    assert fake_runner.steps() == []
    assert (dep.status, dep.failed_step, env.status) == ("failed", 1, "failed")
    assert steps[0].status == "succeeded"
    assert steps[1].log == ("This environment's VM has no address yet. Retry from step 0 "
                            "(Prepare VM).\n")


async def test_a_failed_step_0_runs_nothing_on_the_host(db, vm_env, fake_runner,
                                                        fake_provisioner):
    fake_provisioner.fail["provision"] = "Terraform couldn't create or update the VM."
    dep_id = await _start(db, vm_env)
    dep, steps, env = await _load(dep_id)
    assert fake_runner.steps() == []
    assert (dep.status, dep.failed_step, dep.error, env.status) == (
        "failed", 0, "Step 0 (Prepare VM) failed. See its log.", "failed")
    assert steps[0].log == "provision: ok\nTerraform couldn't create or update the VM.\n"
    assert {s.status for s in steps[1:]} == {"not_run"}


async def test_a_missing_integration_stops_step_0(db, vm_env, fake_runner, fake_provisioner):
    from sirdar_api.db.models import Integration
    await db.delete(await db.get(Integration, "proxmox"))
    await db.commit()
    dep_id = await _start(db, vm_env)
    dep, steps, _ = await _load(dep_id)
    assert fake_provisioner.calls == [] and dep.failed_step == 0
    assert steps[0].log == "Proxmox isn't set up. Add it in Settings › Integrations, then retry.\n"


async def test_restore_a_vm_snapshot(db, vm_env, fake_runner, fake_provisioner):
    vm_env.current_sha = SHA
    await db.commit()
    dep_id = await _start(db, vm_env, mode="vm_restore", sha=OLD, vm_snapshot=SNAP)
    dep, steps, env = await _load(dep_id)
    assert [s.key for s in steps] == ["vm_restore"] and fake_runner.steps() == []
    assert fake_provisioner.contexts[0].vm_snapshot == SNAP
    assert (dep.status, env.status, env.current_sha) == ("succeeded", "ready", OLD)


async def test_delete_destroys_the_vm_then_the_environment(db, vm_env, fake_runner,
                                                           fake_provisioner, fake_publisher):
    dep_id = await _start(db, vm_env, mode="teardown", sha="")
    assert fake_provisioner.calls == ["destroy"]
    assert fake_publisher.calls == ["unproxy", "undns"] and fake_runner.steps() == []
    async with get_sessionmaker()() as s:
        assert await s.get(Environment, vm_env.id) is None
        assert await s.get(ProxmoxVm, vm_env.id) is None
        assert await s.get(Deployment, dep_id) is None          # gone with the environment


async def test_a_retry_keeps_the_first_attempt_s_vm_snapshot(db, vm_env, fake_runner,
                                                             fake_provisioner):
    fake_provisioner.effects["provision"] = _vm_up
    fake_provisioner.outcomes["provision"] = VmOutcome(vm_snapshot=SNAP)
    fake_runner.results["build"] = RunResult(status="failed", rc=2)
    first = await _start(db, vm_env, take_vm_snapshot=True)
    fake_runner.results.clear()
    fake_provisioner.outcomes["provision"] = VmOutcome()
    await db.refresh(vm_env)
    second = await _start(db, vm_env, retry_of=first, start_step=0, take_vm_snapshot=True)
    dep, steps, env = await _load(second)
    assert fake_provisioner.contexts[1].vm_snapshot == SNAP
    assert (dep.status, dep.vm_snapshot, env.current_sha) == ("succeeded", SNAP, SHA)


async def test_step_0_s_log_is_redacted(db, vm_env, fake_runner, fake_provisioner):
    fake_provisioner.echo["provision"] = f"token {PX_TOKEN_SECRET}\n"
    fake_provisioner.fail["provision"] = "stop"
    dep_id = await _start(db, vm_env)
    _, steps, _ = await _load(dep_id)
    assert steps[0].log == "token [redacted]\nstop\n"


async def test_vm_restore_needs_a_vm_plan(db, vm_env):
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, vm_env, mode="vm_restore", git_ref=OLD, sha=OLD,
                                         actor_id=None)


async def _launch_gated(db, env, provisioner):
    provisioner.gates["provision"] = asyncio.Event()
    dep = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, vm=True)
    await db.commit()
    pipeline.launch(dep.id)
    for _ in range(200):
        if provisioner.calls:
            break
        await asyncio.sleep(0.01)
    assert provisioner.calls == ["provision"]
    return dep.id


async def test_cancel_during_step_0(db, vm_env, fake_runner, fake_provisioner):
    dep_id = await _launch_gated(db, vm_env, fake_provisioner)
    assert pipeline.request_cancel(dep_id)
    await pipeline.wait(dep_id)
    dep, steps, env = await _load(dep_id)
    assert (dep.status, dep.error, env.status) == ("cancelled", "Canceled.", "failed")
    assert steps[0].status == "cancelled" and steps[0].log == "provision: ok\n"
    assert {s.status for s in steps[1:]} == {"not_run"} and fake_runner.steps() == []


async def test_shutdown_during_step_0_interrupts_it(db, vm_env, fake_runner, fake_provisioner):
    dep_id = await _launch_gated(db, vm_env, fake_provisioner)
    await pipeline.shutdown()
    dep, steps, _ = await _load(dep_id)
    assert (dep.status, steps[0].status) == ("interrupted", "interrupted")
    assert {s.status for s in steps[1:]} == {"not_run"}


async def test_step_0_timeout_and_crash(db, vm_env, fake_runner, fake_provisioner,
                                        monkeypatch):
    monkeypatch.setitem(STEPS_BY_KEY, "provision",
                        replace(STEPS_BY_KEY["provision"], timeout=0.05))
    fake_provisioner.gates["provision"] = asyncio.Event()
    dep_id = await _start(db, vm_env)
    dep, steps, _ = await _load(dep_id)
    assert dep.error.startswith("Step 0 (Prepare VM) timed out")
    assert steps[0].status == "failed" and fake_runner.steps() == []
    fake_provisioner.gates.clear()
    fake_provisioner.raises["provision"] = RuntimeError(f"proxmox said {PX_TOKEN_SECRET}")
    await db.refresh(vm_env)
    dep_id = await _start(db, vm_env)
    dep, steps, _ = await _load(dep_id)
    assert steps[0].log == "provision: ok\nSirdar couldn't run this step.\n"
    assert PX_TOKEN_SECRET not in (dep.error or "")


async def test_host_steps_refuse_a_deployment_without_a_commit(db, vm_env, fake_runner,
                                                               fake_provisioner):
    """Step 0 resolves a branch on the VM; when it succeeded without a commit
    (it never should), step 1 refuses before writing an .env for no image."""
    fake_provisioner.effects["provision"] = _vm_up
    fake_provisioner.outcomes["provision"] = VmOutcome(sha=None)
    dep_id = await _start(db, vm_env, sha="")
    dep, steps, _env = await _load(dep_id)
    assert dep.status == "failed" and dep.error == pipeline.NO_COMMIT
    assert [s.status for s in steps][:2] == ["succeeded", "failed"]
    assert fake_runner.requests == []
