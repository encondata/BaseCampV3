"""Force delete through the pipeline (fakes): a forced teardown runs every
step of its plan, skips each one that fails (or can't start because the
host doesn't answer), and removes the environment from Sirdar anyway. The
audit row says force and lists what may be left behind."""

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import (
    AuditLog,
    Deployment,
    DeploymentStep,
    DoResource,
    Environment,
    ManagedRecord,
)
from sirdar_api.deploy import pipeline, vms
from sirdar_api.deploy.provision import VmOutcome
from sirdar_api.deploy.runner import RunResult

from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import built as do_built
from .do_helpers import make_do_environment
from .integration_helpers import configure, configure_esxi
from .lan_helpers import lan_built, make_bluegreen_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA, _load, env  # noqa: F401
from .test_deploy_pipeline_vm import vm_env  # noqa: F401


async def _force(db, env, **kw):
    dep = await pipeline.create_deployment(db, env, mode="teardown", git_ref="main",
                                           sha=kw.pop("sha", ""), actor_id=None, force=True,
                                           **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def _delete_audit():
    async with get_sessionmaker()() as s:
        return await s.scalar(select(AuditLog).where(
            AuditLog.action == "deploy.environment_delete"))


async def _gone(env_id) -> bool:
    async with get_sessionmaker()() as s:
        return await s.get(Environment, env_id) is None


def _record(env_id, kind, name, origin="created"):
    return ManagedRecord(environment_id=env_id, service="api", kind=kind, external_id="7",
                         name=name, origin=origin)


# ---- plans and records -------------------------------------------------------------

async def test_only_a_teardown_is_forced(db, env):
    for mode in ("update", "cleanup", "publish"):
        with pytest.raises(ValueError):
            await pipeline.create_deployment(db, env, mode=mode, git_ref="main", sha=SHA,
                                             actor_id=None, force=True)


async def test_a_forced_delete_records_force(db, env):
    dep = await pipeline.create_deployment(db, env, mode="teardown", git_ref="main", sha="",
                                           actor_id=None, force=True)
    await db.commit()
    assert dep.force is True
    assert [s.key for s in pipeline.plan_of(dep)] == ["teardown", "unproxy", "undns"]


# ---- LAN, one SSH host -------------------------------------------------------------

async def test_a_failing_step_is_skipped_and_the_environment_goes(db, env, fake_runner,
                                                                  fake_publisher):
    env_id = env.id
    fake_runner.results["teardown"] = RunResult(status="failed", rc=2)
    dep_id = await _force(db, env)
    assert fake_runner.steps() == ["teardown"]
    assert fake_publisher.calls == ["unproxy", "undns"]          # it carried on
    assert await _gone(env_id)
    async with get_sessionmaker()() as s:
        assert await s.get(Deployment, dep_id) is None          # as a normal Delete's
    audit = await _delete_audit()
    assert audit.entity_id == "uat"
    assert audit.changes == {
        "environment": "uat", "deployment": str(dep_id), "force": True,
        "left_behind": ["Step 15 (Remove environment) was skipped."]}


async def test_a_clean_forced_delete_leaves_nothing_behind(db, env, fake_runner,
                                                           fake_publisher):
    dep_id = await _force(db, env)
    audit = await _delete_audit()
    assert audit.changes == {"environment": "uat", "deployment": str(dep_id), "force": True,
                             "left_behind": []}


async def test_an_unreachable_host_skips_the_ssh_step(db, env, fake_runner, fake_publisher,
                                                      monkeypatch):
    """The SSH connection before the first host step is the reachability
    probe: when it fails, Ansible never starts (no 30-minute wait)."""
    async def unreachable(db_, cfg):
        raise pipeline.PrepareError("Couldn't connect to 10.0.0.9:22.")
    monkeypatch.setattr(pipeline, "_run_target", unreachable)
    env_id = env.id
    await _force(db, env)
    assert fake_runner.requests == []
    assert fake_publisher.calls == ["unproxy", "undns"]
    assert await _gone(env_id)
    audit = await _delete_audit()
    assert audit.changes["left_behind"] == ["Step 15 (Remove environment) was skipped."]


async def test_the_skip_and_left_behind_lines_reach_the_logs(db, env, fake_runner,
                                                             fake_publisher, monkeypatch):
    fake_runner.results["teardown"] = RunResult(status="timeout", rc=-1)
    fake_publisher.fail["unproxy"] = "Nginx Proxy Manager didn't answer."
    db.add(_record(env.id, "proxy_host", "api.uat.serversherpa.com"))
    db.add(_record(env.id, "dns_record", "kiosk.uat.serversherpa.com", origin="claimed"))
    await db.commit()
    logs: dict[str, str] = {}
    real_finish = pipeline._force_finish

    async def finish(db_, env_, dep_, steps, skipped):
        lines = await real_finish(db_, env_, dep_, steps, skipped)
        async with get_sessionmaker()() as s:
            for row in await s.scalars(select(DeploymentStep).where(
                    DeploymentStep.deployment_id == dep_.id)):
                logs[row.key] = row.log
        return lines
    monkeypatch.setattr(pipeline, "_force_finish", finish)
    await _force(db, env)
    assert logs["teardown"].endswith(
        "Step 15 (Remove environment) timed out after 30 minutes. Force delete skipped it "
        "and carried on.\n")
    assert logs["unproxy"].endswith(
        "Nginx Proxy Manager didn't answer.\nStep 16 (Remove proxy hosts) failed. Force delete "
        "skipped it and carried on.\n")
    # the last lines of the last step's log
    assert logs["undns"] == (
        "undns: ok\n"
        "Force delete: Sirdar removed uat from its records. These may be left behind; "
        "clean them up by hand:\n"
        "- Step 15 (Remove environment) was skipped.\n"
        "- Step 16 (Remove proxy hosts) was skipped.\n"
        "- Proxy host api.uat.serversherpa.com\n")
    audit = await _delete_audit()
    assert audit.changes["left_behind"] == [
        "Step 15 (Remove environment) was skipped.",
        "Step 16 (Remove proxy hosts) was skipped.",
        "Proxy host api.uat.serversherpa.com"]       # never a claimed record


async def test_a_clean_forced_delete_says_so_in_the_log(db, env, fake_runner, fake_publisher,
                                                        monkeypatch):
    logs: list[str] = []
    real_finish = pipeline._force_finish

    async def finish(db_, env_, dep_, steps, skipped):
        lines = await real_finish(db_, env_, dep_, steps, skipped)
        async with get_sessionmaker()() as s:
            logs.append(await s.scalar(select(DeploymentStep.log).where(
                DeploymentStep.deployment_id == dep_.id, DeploymentStep.key == "undns")))
        return lines
    monkeypatch.setattr(pipeline, "_force_finish", finish)
    await _force(db, env)
    assert logs[0].endswith("Force delete: no step failed, so nothing should be left "
                            "behind.\n")


DNS_NOTE = ("Force delete never skips removing DNS records: a record left pointing at a "
            "removed address could be taken over. Fix the problem (Cloudflare), then retry.")


async def test_dns_removal_is_never_skipped(db, env, fake_runner, fake_publisher):
    """A DNS record left at an address that is gone could be claimed by
    someone else: a failed step 17 fails the forced Delete, which keeps the
    environment and its records for a retry."""
    env_id = env.id
    fake_runner.results["teardown"] = RunResult(status="failed", rc=2)
    fake_publisher.fail["undns"] = "Cloudflare didn't answer."
    db.add(_record(env.id, "dns_record", "api.uat.serversherpa.com"))
    await db.commit()
    dep_id = await _force(db, env)
    dep, steps, e = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 17)
    assert dep.error == f"Step 17 (Remove DNS records) failed. See its log. {DNS_NOTE}"
    assert [s.status for s in steps] == ["failed", "succeeded", "failed"]
    assert steps[-1].log.endswith(f"Cloudflare didn't answer.\n{DNS_NOTE}\n")
    assert e is not None and e.status == "failed"
    async with get_sessionmaker()() as s:
        assert await s.scalar(select(func.count()).select_from(ManagedRecord).where(
            ManagedRecord.environment_id == env_id)) == 1
    assert await _delete_audit() is None


async def test_unreadable_cloudflare_credentials_stop_a_forced_delete_at_dns(
        db, env, fake_runner, fake_publisher, monkeypatch):
    from sirdar_api.deploy import publish

    async def unreadable(db_, env_, settings):
        raise publish.PublishError("The stored credentials don't open.")
    monkeypatch.setattr(publish, "prepare", unreadable)
    dep_id = await _force(db, env)
    dep, steps, e = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 17)
    assert dep.error == f"The stored credentials don't open. {DNS_NOTE}"
    # known before anything ran: nothing on the host was removed first
    assert [s.status for s in steps] == ["not_run", "not_run", "failed"]
    assert fake_runner.requests == [] and fake_publisher.calls == []
    assert e is not None and e.status == "failed"


async def test_a_vm_plan_destroys_nothing_when_dns_can_t_be_removed(
        db, vm_env, fake_runner, fake_publisher, fake_provisioner, monkeypatch):
    from sirdar_api.deploy import publish

    async def unreadable(db_, env_, settings):
        raise publish.PublishError("The stored credentials don't open.")
    monkeypatch.setattr(publish, "prepare", unreadable)
    dep_id = await _force(db, vm_env, vm=True)
    dep, steps, e = await _load(dep_id)
    assert [s.key for s in steps] == ["destroy", "unproxy", "undns"]
    assert (dep.status, dep.failed_step) == ("failed", 17)
    assert [s.status for s in steps] == ["not_run", "not_run", "failed"]
    assert fake_provisioner.calls == []                     # the VM is still there
    assert e is not None and e.status == "failed"


async def test_a_retried_forced_delete_keeps_what_earlier_attempts_skipped(
        db, vm_env, fake_runner, fake_publisher, fake_provisioner):
    """Destroy VM and proxy hosts skipped, DNS failed; the retry from 17
    succeeds: the list still names the skipped steps and the VM."""
    from sirdar_api.deploy import provision
    await provision._set_vm(vm_env.id, vmid=120, created=True, ip="127.0.0.1")
    fake_provisioner.fail["destroy"] = "Proxmox didn't answer."
    fake_publisher.fail["unproxy"] = "Nginx Proxy Manager didn't answer."
    fake_publisher.fail["undns"] = "Cloudflare didn't answer."
    first = await _force(db, vm_env, vm=True)
    d, _, env = await _load(first)
    assert (d.status, d.failed_step) == ("failed", 17)
    fake_publisher.fail.pop("undns")
    env = await db.get(Environment, vm_env.id, populate_existing=True)
    await _force(db, env, vm=True, start_step=17, retry_of=first)
    assert await _gone(vm_env.id)
    audit = await _delete_audit()
    assert audit.changes["left_behind"] == [
        "Step 15 (Destroy VM) was skipped.",
        "Step 16 (Remove proxy hosts) was skipped.",
        "Proxmox VM ss-uat3"]


async def test_a_retry_that_runs_a_skipped_step_again_drops_it(
        db, vm_env, fake_runner, fake_publisher, fake_provisioner):
    from sirdar_api.deploy import provision
    await provision._set_vm(vm_env.id, vmid=120, created=True, ip="127.0.0.1")
    fake_provisioner.fail["destroy"] = "Proxmox didn't answer."
    fake_publisher.fail["undns"] = "Cloudflare didn't answer."
    first = await _force(db, vm_env, vm=True)
    fake_publisher.fail.clear()
    fake_provisioner.fail.clear()
    env = await db.get(Environment, vm_env.id, populate_existing=True)
    await _force(db, env, vm=True, start_step=15, retry_of=first)
    assert await _gone(vm_env.id)
    assert (await _delete_audit()).changes["left_behind"] == []


async def test_a_raising_python_step_is_skipped(db, env, fake_runner, fake_publisher):
    fake_publisher.raises["unproxy"] = RuntimeError("SECRET-DETAIL")
    env_id = env.id
    await _force(db, env)
    assert fake_publisher.calls == ["unproxy", "undns"] and await _gone(env_id)
    audit = await _delete_audit()
    assert audit.changes["left_behind"] == ["Step 16 (Remove proxy hosts) was skipped."]
    assert "SECRET-DETAIL" not in str(audit.changes)


async def test_cancel_still_stops_a_forced_delete(db, env, fake_runner, fake_publisher):
    fake_publisher.gates["unproxy"] = asyncio.Event()
    dep = await pipeline.create_deployment(db, env, mode="teardown", git_ref="main", sha="",
                                           actor_id=None, force=True)
    await db.commit()
    pipeline.launch(dep.id)
    for _ in range(200):
        if fake_publisher.calls:
            break
        await asyncio.sleep(0.01)
    assert pipeline.request_cancel(dep.id)
    await pipeline.wait(dep.id)
    d, steps, e = await _load(dep.id)
    assert d.status == "cancelled" and e is not None and e.status == "failed"
    assert [s.status for s in steps] == ["succeeded", "cancelled", "not_run"]


# ---- DigitalOcean ------------------------------------------------------------------

@pytest.fixture
async def do_env(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    env = await make_do_environment(db)
    await trust_fake(db, ssh_server)
    await do_built(SimpleNamespace(env_id=env.id, env_name=env.name, slots=list(env.slots)))
    return env


async def test_a_forced_digitalocean_delete_forgets_what_it_couldn_t_remove(
        db, do_env, fake_runner, fake_publisher, fake_provisioner):
    env_id = do_env.id
    names = sorted((r.kind, r.name) for r in await db.scalars(
        select(DoResource).where(DoResource.environment_id == env_id)))
    assert names                                      # step 0 recorded resources
    fake_provisioner.fail["do_destroy"] = "DigitalOcean didn't answer."
    dep_id = await _force(db, do_env, sha=SHA, cloud=True)
    assert fake_publisher.calls == ["undns"] and fake_provisioner.calls == ["do_destroy"]
    assert await _gone(env_id)
    async with get_sessionmaker()() as s:
        assert await s.scalar(select(func.count()).select_from(DoResource).where(
            DoResource.environment_id == env_id)) == 0
    audit = await _delete_audit()
    assert audit.changes["deployment"] == str(dep_id) and audit.changes["force"] is True
    left = audit.changes["left_behind"]
    assert left[0] == "Step 18 (Remove DigitalOcean resources) was skipped."
    labels = {"vpc": "VPC", "load_balancer": "load balancer"}
    assert left[1:] == [f"DigitalOcean {labels.get(kind, kind)} {name}"
                        for kind, name in names]


async def test_a_forced_digitalocean_delete_removes_dns_before_anything_else(
        db, do_env, fake_runner, fake_publisher, fake_provisioner):
    env_id = do_env.id
    from sirdar_api.deploy.steps import plan_for
    assert [s.key for s in plan_for("teardown", cloud=True)] == ["undns", "do_destroy"]
    fake_publisher.fail["undns"] = "Cloudflare didn't answer."
    left = await db.scalar(select(func.count()).select_from(DoResource).where(
        DoResource.environment_id == env_id))
    dep_id = await _force(db, do_env, sha=SHA, cloud=True)
    d, steps, e = await _load(dep_id)
    assert (d.status, d.failed_step) == ("failed", 17)
    assert fake_provisioner.calls == []                  # the load balancer stays
    assert [s.status for s in steps] == ["failed", "not_run"]
    assert e is not None
    async with get_sessionmaker()() as s:
        assert await s.scalar(select(func.count()).select_from(DoResource).where(
            DoResource.environment_id == env_id)) == left


async def test_a_forced_digitalocean_delete_never_takes_a_snapshot(db, do_env, fake_runner,
                                                                   fake_publisher,
                                                                   fake_provisioner):
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, do_env, mode="teardown", git_ref="main",
                                         sha=SHA, actor_id=None, cloud=True, force=True,
                                         snapshot_id=uuid.uuid4())


# ---- LAN Blue/Green ----------------------------------------------------------------

@pytest.fixture
async def lan(db, secrets_key, ssh_server, monkeypatch, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    fake_provisioner.outcomes["provision"] = VmOutcome()
    return await make_bluegreen_environment(db)


async def test_a_forced_blue_green_delete_lists_the_vms_it_couldn_t_destroy(
        db, lan, fake_runner, fake_publisher, fake_provisioner):
    dep = await pipeline.create_deployment(db, lan, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, vm=True, bluegreen=True,
                                           slot="orange", go_live=True)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    for task in list(pipeline._tasks.values()):        # the other side's idle Update
        await asyncio.wait([task])
    env = await db.get(Environment, lan.id, populate_existing=True)
    machines = await vms.machines(db, env)
    fake_provisioner.fail["destroy"] = "ESXi didn't answer."
    await _force(db, env, sha=SHA, vm=True, bluegreen=True, slot="orange")
    assert fake_publisher.calls[-2:] == ["unproxy", "undns"]
    assert await _gone(lan.id)
    audit = await _delete_audit()
    assert audit.changes["left_behind"] == [
        "Step 15 (Destroy VM) was skipped.",
        *[f"ESXi VM {m.name}" for m in machines]]
