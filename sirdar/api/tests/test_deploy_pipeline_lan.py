"""A LAN Blue/Green environment's deployments through the pipeline (fakes):
the first deploy builds the data VM and orange and goes live; the next goes
to purple and waits; Activate switches; Delete snapshots then destroys."""

import base64

import pytest

from sirdar_api.db.models import Environment, VmSlot
from sirdar_api.deploy import envfile, pipeline, vms
from sirdar_api.deploy.vmcommon import VmOutcome

from .deploy_factories import (  # noqa: F401
    ENV_SECRETS,
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .integration_helpers import configure, configure_esxi
from .lan_helpers import DATA, ORANGE, PURPLE, lan_built, make_bluegreen_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_pipeline import SHA, _load

NEWER = "e1" * 20
FIRST = ["preflight", "bootstrap", "fetch", "render", "build", "dump", "data_vm", "up",
         "slot_smoke"]


@pytest.fixture
async def lan(db, secrets_key, ssh_server, monkeypatch, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    # every run names its commit (a full SHA): step 0 resolves nothing
    fake_provisioner.outcomes["provision"] = VmOutcome()
    return await make_bluegreen_environment(db)


async def _run(db, env, *, mode="update", slot="orange", go_live=False, sha=SHA, **kw):
    dep = await pipeline.create_deployment(db, env, mode=mode, git_ref="main", sha=sha,
                                           actor_id=None, vm=True, bluegreen=True, slot=slot,
                                           go_live=go_live, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_the_first_deploy_builds_and_goes_live(db, lan, fake_runner, fake_publisher,
                                                     fake_provisioner):
    dep_id = await _run(db, lan, go_live=True)
    dep, steps, env = await _load(dep_id)
    assert (dep.status, dep.bluegreen, dep.slot) == ("succeeded", True, "orange")
    assert fake_provisioner.calls == ["provision"] and fake_runner.steps() == FIRST
    assert fake_publisher.calls == ["lan_switch"]
    assert fake_publisher.contexts[0].slot == "orange"
    assert (env.active_slot, env.current_sha, env.status) == ("orange", SHA, "ready")
    slot = await db.get(VmSlot, (env.id, "orange"), populate_existing=True)
    assert (slot.sha, slot.last_check_ok) == (SHA, True)

    data = next(r for r in fake_runner.requests if r.step == "data_vm")
    assert data.extravars["db_clients"] == [ORANGE, PURPLE]
    assert data.extravars["spaces_clients"] == [ORANGE, PURPLE, "10.0.0.2"]
    data_env = envfile.parse_env(base64.b64decode(data.extravars["data_env_b64"]).decode())
    assert data_env["STACK_DB_ALLOW"] == f"{ORANGE},{PURPLE}"
    assert "data_vm_test_mode" not in data.extravars

    render = next(r for r in fake_runner.requests if r.step == "render")
    app_env = envfile.parse_env(base64.b64decode(render.extravars["env_file_b64"]).decode())
    # create_new generates the environment's secrets: compare with its own
    assert app_env["SS_JWT_SECRET"] not in data_env.values()
    assert data_env["POSTGRES_PASSWORD"] == app_env["POSTGRES_PASSWORD"]
    assert (app_env["STACK_EXTERNAL_DATA"], app_env["STACK_DB_HOST"],
            app_env["STACK_DB_SSLMODE"], app_env["SS_DATABASE_SSL"]) == (
        "1", DATA, "disable", "disable")
    assert app_env["SS_DATABASE_URL"].endswith(f"@{DATA}:5432/serversherpa")

    dump = next(r for r in fake_runner.requests if r.step == "dump")
    assert (dump.extravars["external_data"], dump.extravars["data_new"]) == (True, True)
    smoke = next(r for r in fake_runner.requests if r.step == "slot_smoke")
    assert {h["service"] for h in smoke.extravars["public_hosts"]} == {
        "api", "portal", "kiosk", "wiki", "status"}
    assert all("port" in h for h in smoke.extravars["public_hosts"])


async def test_the_next_deploy_goes_to_purple_and_waits(db, lan, fake_runner, fake_publisher):
    await _run(db, lan, go_live=True)
    fake_runner.requests.clear()
    dep_id = await _run(db, lan, slot="purple", sha=NEWER)
    dep, steps, env = await _load(dep_id)
    assert [s.key for s in steps][-1] == "slot_smoke"
    assert fake_publisher.calls == ["lan_switch"]                 # only the first deploy's
    assert (env.active_slot, env.current_sha) == ("orange", SHA)
    purple = await db.get(VmSlot, (env.id, "purple"), populate_existing=True)
    assert purple.sha == NEWER
    assert next(r for r in fake_runner.requests if r.step == "dump").extravars["data_new"] is False


async def test_activate_switches_to_the_idle_slot(db, lan, fake_runner, fake_publisher):
    await _run(db, lan, go_live=True)
    await _run(db, lan, slot="purple", sha=NEWER)
    fake_runner.requests.clear()
    dep_id = await _run(db, lan, mode="activate", slot="purple", sha=NEWER)
    dep, steps, env = await _load(dep_id)
    assert [s.key for s in steps] == ["slot_smoke", "lan_switch"]
    assert (env.active_slot, env.current_sha) == ("purple", NEWER)


async def test_a_failed_switch_keeps_the_live_slot(db, lan, fake_runner, fake_publisher):
    await _run(db, lan, go_live=True)
    await _run(db, lan, slot="purple", sha=NEWER)
    fake_publisher.fail["lan_switch"] = ("2 of 5 public URLs didn't answer. Traffic stays "
                                         "where it was.")
    dep_id = await _run(db, lan, mode="activate", slot="purple", sha=NEWER)
    dep, _, env = await _load(dep_id)
    assert (dep.status, env.active_slot, env.status) == ("failed", "orange", "failed")


@pytest.mark.parametrize("mode", ["reset", "restore_dump", "rollback", "vm_restore"])
async def test_shared_data_modes_are_refused(db, lan, mode):
    with pytest.raises(pipeline.NotSupportedOnBlueGreen):
        await pipeline.create_deployment(db, lan, mode=mode, git_ref="main", sha=SHA,
                                         actor_id=None, vm=True, bluegreen=True)


async def test_the_flag_must_match_the_environment(db, lan):
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, lan, mode="update", git_ref="main", sha=SHA,
                                         actor_id=None, vm=True)


async def test_activate_needs_a_deployed_slot(db, lan):
    from sirdar_api.deploy.do_envs import DoEnvError
    with pytest.raises(DoEnvError) as e:
        await pipeline.create_deployment(db, lan, mode="activate", git_ref="main", sha=SHA,
                                         actor_id=None, vm=True, bluegreen=True, slot="purple")
    assert e.value.code == "slot_not_deployed"


async def test_delete_destroys_all_three(db, lan, fake_runner, fake_publisher, fake_provisioner):
    await _run(db, lan, go_live=True)
    fake_provisioner.calls.clear()
    await _run(db, lan, mode="teardown", slot="orange")
    assert fake_provisioner.calls == ["destroy"]
    assert [m.vm.role for m in fake_provisioner.contexts[-1].machines] == [
        "purple", "orange", "data"]
    assert fake_publisher.calls[-2:] == ["unproxy", "undns"]
    assert await db.get(Environment, lan.id, populate_existing=True) is None


# ---- beyond the brief ----------------------------------------------------------

from sqlalchemy import select  # noqa: E402

from sirdar_api.config import get_settings  # noqa: E402
from sirdar_api.db.models import Snapshot  # noqa: E402
from sirdar_api.deploy import serialize, snapshots  # noqa: E402
from sirdar_api.deploy.do_envs import DoEnvError  # noqa: E402
from sirdar_api.deploy.runner import RunResult  # noqa: E402

from .deploy_factories import snapshots_dir  # noqa: E402, F401
from .do_helpers import fetched as _fetched  # noqa: E402
from .do_helpers import ready_snapshot as _ready_snapshot  # noqa: E402


async def _take_for_delete(db, env):
    snap = await snapshots.begin_take(db, get_settings(), env, name="lan9-before-delete-x",
                                      notes="", actor_id=None)
    await db.commit()
    return snap


async def test_the_summary_says_bluegreen(db, lan, fake_runner, fake_publisher):
    dep_id = await _run(db, lan, go_live=True)
    dep, _, _ = await _load(dep_id)
    assert (await serialize.deployment_summary(db, dep))["bluegreen"] is True


async def test_the_data_vm_step_runs_on_the_data_vm_and_hides_its_env(
        db, lan, fake_runner, fake_publisher):
    original = fake_runner.run

    async def run(request, on_output):
        if request.step == "data_vm":
            b64 = request.extravars["data_env_b64"]
            on_output(f"{b64}\n")
            on_output(f"{request.target.private_key}\n")
            on_output(f"{envfile.parse_env(base64.b64decode(b64).decode())['POSTGRES_PASSWORD']}\n")
        return await original(request, on_output)

    fake_runner.run = run
    dep_id = await _run(db, lan, go_live=True)
    dep, steps, _ = await _load(dep_id)
    assert dep.status == "succeeded"
    by_step = {r.step: r for r in fake_runner.requests}
    data, render = by_step["data_vm"], by_step["render"]
    # its own SSH key (the data VM's), the app steps the slot's
    assert data.target.private_key and render.target.private_key
    assert data.target.private_key != render.target.private_key
    assert all(by_step[k].target.private_key == render.target.private_key
               for k in ("preflight", "dump", "up", "slot_smoke"))
    assert "data_env_b64" not in render.extravars
    log = next(s.log for s in steps if s.key == "data_vm")
    data_env = envfile.parse_env(base64.b64decode(data.extravars["data_env_b64"]).decode())
    app_env = envfile.parse_env(base64.b64decode(render.extravars["env_file_b64"]).decode())
    assert data.extravars["data_env_b64"] not in log
    assert "BEGIN OPENSSH" not in log and data_env["POSTGRES_PASSWORD"] not in log
    assert log.count("[redacted]") == 3
    # the data VM's .env has no app secrets at all
    for key in ("SS_JWT_SECRET", "SS_PASSWORD_PEPPER", "SS_TOTP_ENCRYPTION_KEY",
                "SS_WIKI_SERVICE_TOKEN"):
        assert key not in data_env
        assert not app_env.get(key) or app_env[key] not in data_env.values()
    # the firewall inputs are the .env's own values
    assert (str(data.extravars["db_port"]), str(data.extravars["spaces_port"]),
            str(data.extravars["mailpit_port"]), ",".join(data.extravars["db_clients"])) == (
        data_env["STACK_DB_PORT"], data_env["STACK_SPACES_PORT"],
        data_env["STACK_MAILPIT_PORT"], data_env["STACK_DB_ALLOW"])
    for key in ("repo_url", "sha", "ss_stack", "env_name", "env_dir"):
        assert data.extravars[key] == render.extravars[key]


async def test_a_bluegreen_deploy_never_takes_a_vm_snapshot(db, lan):
    dep = await pipeline.create_deployment(db, lan, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, vm=True, bluegreen=True,
                                           slot="orange", take_vm_snapshot=True)
    assert dep.take_vm_snapshot is False


async def test_a_publish_job_is_the_ordinary_one(db, lan):
    env_id = lan.id
    dep = await pipeline.create_deployment(db, lan, mode="publish", git_ref="main", sha=SHA,
                                           actor_id=None, vm=True)
    assert dep.bluegreen is False
    assert [s.key for s in pipeline.plan_of(dep)] == ["dns", "proxy", "smoke"]
    await db.rollback()
    env = await db.get(Environment, env_id, populate_existing=True)
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, env, mode="publish", git_ref="main", sha=SHA,
                                         actor_id=None, vm=True, bluegreen=True)


async def test_seeding_again_once_live_is_refused(db, lan, snapshots_dir, fake_runner,
                                                  fake_publisher, tmp_path):
    await _run(db, lan, go_live=True)
    env = await db.get(Environment, lan.id, populate_existing=True)
    snap = await _ready_snapshot(db, tmp_path)
    with pytest.raises(DoEnvError) as e:
        await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=NEWER,
                                         actor_id=None, vm=True, bluegreen=True,
                                         slot="purple", snapshot_id=snap.id)
    assert e.value.code == "seed_not_allowed"


async def test_delete_takes_its_snapshot_on_the_slot_against_the_data_vm(
        db, lan, snapshots_dir, fake_runner, fake_publisher, fake_provisioner, tmp_path):
    await _run(db, lan, go_live=True)
    env = await db.get(Environment, lan.id, populate_existing=True)
    snap = await _take_for_delete(db, env)
    snap_id = snap.id
    fake_runner.effects["export"] = _fetched(tmp_path)
    fake_runner.requests.clear()
    fake_provisioner.calls.clear()
    await _run(db, env, mode="teardown", slot="orange", snapshot_id=snap_id)
    assert fake_runner.steps() == ["export"] and fake_provisioner.calls == ["destroy"]
    export = fake_runner.requests[0].extravars
    assert (export["external_data"], export["spaces_endpoint"], export["spaces_key_id"]) == (
        True, f"http://{DATA}:{envfile.DEFAULT_PORTS['spaces']}", "serversherpa")
    assert export["api_image"] == f"serversherpa-api:{envfile.image_tag(SHA)}"
    assert (await db.scalar(select(Snapshot.status).where(Snapshot.id == snap_id))) == "ready"
    assert await db.get(Environment, lan.id, populate_existing=True) is None


async def test_a_failed_delete_snapshot_is_marked_failed(db, lan, snapshots_dir, fake_runner,
                                                         fake_publisher, fake_provisioner):
    await _run(db, lan, go_live=True)
    env = await db.get(Environment, lan.id, populate_existing=True)
    snap = await _take_for_delete(db, env)
    fake_runner.results["export"] = RunResult(status="failed", rc=2)
    fake_provisioner.calls.clear()
    dep_id = await _run(db, env, mode="teardown", slot="orange", snapshot_id=snap.id)
    dep, _, env = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 11)
    assert fake_provisioner.calls == []
    assert (await db.scalar(select(Snapshot.status).where(Snapshot.id == snap.id))) == "failed"


async def test_an_orphaned_delete_marks_its_snapshot_failed(db, lan, snapshots_dir,
                                                            fake_runner, fake_publisher):
    await _run(db, lan, go_live=True)
    env = await db.get(Environment, lan.id, populate_existing=True)
    snap = await _take_for_delete(db, env)
    await pipeline.create_deployment(db, env, mode="teardown", git_ref="main", sha=SHA,
                                     actor_id=None, vm=True, bluegreen=True, slot="orange",
                                     snapshot_id=snap.id)
    await db.commit()
    assert await pipeline.recover_orphans() == 1
    assert (await db.scalar(select(Snapshot.status).where(Snapshot.id == snap.id))) == "failed"


async def test_bluegreen_step_0_and_destroy_get_an_hour(db, lan, fake_runner, fake_publisher,
                                                         fake_provisioner, monkeypatch):
    import asyncio

    seen: list[float] = []
    real = asyncio.wait_for

    async def wait_for(aw, timeout):
        seen.append(timeout)
        return await real(aw, timeout)

    monkeypatch.setattr(asyncio, "wait_for", wait_for)
    await _run(db, lan, go_live=True)
    assert seen[0] == 60 * 60                         # step 0
    seen.clear()
    await _run(db, lan, mode="teardown", slot="orange")
    assert seen[0] == 60 * 60                         # Destroy VM
