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


def _pub(target) -> str:
    """The target's SSH key, as its public half (an OpenSSH private key's
    export differs each time: a random check value)."""
    import asyncssh
    return asyncssh.import_private_key(target.private_key).export_public_key().decode()


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
    assert (env.current_sha, env.image_tag) == (SHA, envfile.image_tag(SHA))


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
    assert _pub(data.target) and _pub(render.target)
    assert _pub(data.target) != _pub(render.target)
    assert all(_pub(by_step[k].target) == _pub(render.target)
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
    assert 3600 in seen and 1800 not in seen
    seen.clear()
    await _run(db, lan, mode="teardown", slot="orange")
    assert seen[0] == 60 * 60                         # Destroy VM
    assert 3600 in seen and 1800 not in seen


# ---- review follow-ups ---------------------------------------------------------

from sqlalchemy import update  # noqa: E402

from sirdar_api.deploy import first_admins  # noqa: E402

ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": "Correct-Horse-Battery-9"}


@pytest.mark.parametrize("mode", ["update", "activate"])
async def test_an_update_or_activate_names_a_real_slot(db, lan, mode):
    for slot, code in ((None, "slot_required"), ("blue", "slot_invalid"),
                       ("data", "slot_invalid"), ("main", "slot_invalid")):
        with pytest.raises(DoEnvError) as e:
            await pipeline.create_deployment(db, lan, mode=mode, git_ref="main", sha=SHA,
                                             actor_id=None, vm=True, bluegreen=True,
                                             slot=slot)
        assert e.value.code == code, slot


async def test_a_delete_or_snapshot_slot_must_be_real_when_given(db, lan):
    with pytest.raises(DoEnvError) as e:
        await pipeline.create_deployment(db, lan, mode="teardown", git_ref="main", sha=SHA,
                                         actor_id=None, vm=True, bluegreen=True, slot="data")
    assert e.value.code == "slot_invalid"


async def test_a_vm_with_no_address_names_its_slot(db, lan, fake_runner, fake_publisher):
    """Activate of a slot whose VM has no address: the copy names the slot."""
    await db.execute(update(VmSlot).where(VmSlot.environment_id == lan.id,
                                          VmSlot.slot == "purple").values(sha=NEWER))
    await db.commit()
    dep_id = await _run(db, lan, mode="activate", slot="purple", sha=NEWER)
    dep, _, _ = await _load(dep_id)
    assert dep.status == "failed"
    assert dep.error.startswith("This environment's purple VM has no address yet.")


async def test_with_no_slot_known_the_copy_says_app_vm(db, lan, snapshots_dir, fake_runner,
                                                       fake_publisher):
    """A snapshot job with no slot, nothing live and orange unbuilt: never
    "VM VM"."""
    await db.execute(update(Environment).where(Environment.id == lan.id).values(
        current_sha=SHA, image_tag=envfile.image_tag(SHA)))
    await db.commit()
    env = await db.get(Environment, lan.id, populate_existing=True)
    snap = await _take_for_delete(db, env)
    dep = await pipeline.create_deployment(db, env, mode="snapshot", git_ref="main", sha=SHA,
                                           actor_id=None, vm=True, bluegreen=True,
                                           snapshot_id=snap.id)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    dep, _, _ = await _load(dep.id)
    assert dep.status == "failed"
    assert "VM VM" not in dep.error
    assert dep.error.startswith("This environment's app VM has no address yet.")


async def test_a_snapshot_job_falls_back_to_the_active_slot(db, lan, snapshots_dir,
                                                            fake_runner, fake_publisher,
                                                            tmp_path):
    await _run(db, lan, go_live=True)                       # orange live, at SHA
    orange_key = _pub(next(r for r in fake_runner.requests if r.step == "render").target)
    await _run(db, lan, slot="purple", sha=NEWER)           # purple idle, at NEWER
    purple_key = _pub(fake_runner.requests[-1].target)
    assert purple_key != orange_key
    env = await db.get(Environment, lan.id, populate_existing=True)
    snap = await _take_for_delete(db, env)
    snap_id = snap.id
    fake_runner.effects["export"] = _fetched(tmp_path)
    fake_runner.requests.clear()
    dep = await pipeline.create_deployment(db, env, mode="snapshot", git_ref="main", sha=SHA,
                                           actor_id=None, vm=True, bluegreen=True,
                                           snapshot_id=snap_id)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    dep, _, env = await _load(dep.id)
    assert dep.status == "succeeded" and fake_runner.steps() == ["preflight", "export"]
    export = fake_runner.requests[-1]
    assert _pub(export.target) == orange_key
    assert export.extravars["api_image"] == f"serversherpa-api:{envfile.image_tag(SHA)}"
    assert export.extravars["spaces_endpoint"].startswith(f"http://{DATA}:")
    assert (await db.scalar(select(Snapshot.status).where(Snapshot.id == snap_id))) == "ready"
    assert (env.active_slot, env.current_sha) == ("orange", SHA)


async def test_step_11_runs_on_the_slot_vm(db, lan, fake_runner, fake_publisher):
    await first_admins.put(db, get_settings(), lan.id, first_admins.check(ADMIN))
    await db.commit()
    fake_runner.results["first_admin"] = RunResult(status="successful", rc=0,
                                                   data={"first_admin_rc": "0"})
    dep_id = await _run(db, lan, go_live=True, first_admin=True)
    dep, steps, _ = await _load(dep_id)
    assert dep.status == "succeeded", dep.error
    assert fake_runner.steps() == [*FIRST[:-1], "first_admin", "slot_smoke"]
    by_step = {r.step: r for r in fake_runner.requests}
    admin = by_step["first_admin"]
    assert _pub(admin.target) == _pub(by_step["up"].target)
    assert _pub(admin.target) != _pub(by_step["data_vm"].target)
    assert not await first_admins.pending(db, lan.id)


async def test_a_retry_from_step_7_alone(db, lan, fake_runner, fake_publisher,
                                         fake_provisioner):
    fake_runner.results["data_vm"] = RunResult(status="failed", rc=2)
    first = await _run(db, lan, go_live=True)
    dep, _, env = await _load(first)
    assert (dep.status, dep.failed_step) == ("failed", 7)
    del fake_runner.results["data_vm"]
    fake_runner.requests.clear()
    fake_provisioner.calls.clear()
    dep_id = await _run(db, env, go_live=True, start_step=7, retry_of=first)
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded", dep.error
    assert fake_provisioner.calls == []
    assert fake_runner.steps() == ["data_vm", "up", "slot_smoke"]
    assert [s.key for s in steps if s.status == "skipped"] == FIRST_SKIPPED
    data = fake_runner.requests[0]
    assert data.extravars["data_env_b64"] and data.extravars["db_clients"] == [ORANGE, PURPLE]
    assert _pub(data.target) != _pub(fake_runner.requests[1].target)
    assert (env.active_slot, env.current_sha) == ("orange", SHA)


FIRST_SKIPPED = ["provision", "preflight", "bootstrap", "fetch", "render", "build", "dump"]


# ---- an unresolved switch --------------------------------------------------------

import asyncio  # noqa: E402
import dataclasses  # noqa: E402
import inspect  # noqa: E402

from sirdar_api.deploy import lan_slots, publish, steps as steps_mod  # noqa: E402

PUT_BACK_FAILED = ("2 of 5 public URLs didn't answer. Sirdar couldn't put 2 of 5 proxy hosts "
                   "back: check them in Nginx Proxy Manager.")


async def _interrupted_switch(db, env, fake_publisher, **kw) -> object:
    """Launch a deployment, stop Sirdar while 14 Switch traffic runs."""
    gate = asyncio.Event()
    fake_publisher.gates["lan_switch"] = gate
    dep = await pipeline.create_deployment(db, env, git_ref="main", actor_id=None, vm=True,
                                           bluegreen=True, **kw)
    await db.commit()
    dep_id = dep.id
    before = len(fake_publisher.calls)
    pipeline.launch(dep_id)
    for _ in range(200):
        if "lan_switch" in fake_publisher.calls[before:]:
            break
        await asyncio.sleep(0.05)
    assert "lan_switch" in fake_publisher.calls[before:]
    await pipeline.shutdown()
    del fake_publisher.gates["lan_switch"]
    return dep_id


async def _env(db, env_id):
    return await db.get(Environment, env_id, populate_existing=True)


async def _refused(db, env, **kw):
    with pytest.raises(DoEnvError) as e:
        await pipeline.create_deployment(db, env, git_ref="main", actor_id=None, vm=True,
                                         bluegreen=True, **kw)
    await db.rollback()
    return e.value


async def test_an_interrupted_switch_blocks_updates_until_retried(db, lan, fake_runner,
                                                                  fake_publisher):
    env_id = lan.id
    await _run(db, lan, go_live=True)                                 # orange live
    await _run(db, await _env(db, env_id), slot="purple", sha=NEWER)  # purple idle
    stuck = await _interrupted_switch(db, await _env(db, env_id), fake_publisher,
                                      mode="activate", slot="purple", sha=NEWER)
    dep, steps, env = await _load(stuck)
    assert dep.status == "interrupted"
    assert next(s.status for s in steps if s.key == "lan_switch") == "interrupted"
    assert env.active_slot == "orange"
    for slot in ("purple", "orange"):
        e = await _refused(db, await _env(db, env_id), mode="update", sha=SHA, slot=slot)
        assert (e.code, e.extra) == ("switch_unresolved", {"slot": "purple"})
    # Activate of the live slot or of the stuck one puts NPM somewhere known
    for slot in ("orange", "purple"):
        dep = await pipeline.create_deployment(db, await _env(db, env_id), mode="activate",
                                               git_ref="main", sha=NEWER, actor_id=None,
                                               vm=True, bluegreen=True, slot=slot)
        await db.rollback()
    # the retry (from 14) succeeds: the guard lifts
    retry = await _run(db, await _env(db, env_id), mode="activate", slot="purple", sha=NEWER,
                       start_step=14, retry_of=stuck)
    dep, _, env = await _load(retry)
    assert (dep.status, env.active_slot) == ("succeeded", "purple")
    ok = await _run(db, await _env(db, env_id), slot="orange", sha=SHA)
    assert (await _load(ok))[0].status == "succeeded"


async def test_an_interrupted_auto_activate_update_retries_from_14(db, lan, fake_runner,
                                                                    fake_publisher):
    env_id = lan.id
    await _run(db, lan, go_live=True)
    stuck = await _interrupted_switch(db, await _env(db, env_id), fake_publisher,
                                      mode="update", slot="purple", sha=NEWER, go_live=True)
    e = await _refused(db, await _env(db, env_id), mode="update", sha=NEWER, slot="purple",
                       go_live=True)
    assert e.code == "switch_unresolved"
    # a retry of that Update from earlier than 14 would rebuild the slot NPM may serve
    e = await _refused(db, await _env(db, env_id), mode="update", sha=NEWER, slot="purple",
                       go_live=True, start_step=10, retry_of=stuck)
    assert e.code == "switch_unresolved"
    retry = await _run(db, await _env(db, env_id), slot="purple", sha=NEWER, go_live=True,
                       start_step=14, retry_of=stuck)
    dep, _, env = await _load(retry)
    assert (dep.status, env.active_slot, env.current_sha) == ("succeeded", "purple", NEWER)


async def test_a_switch_that_couldnt_put_npm_back_blocks_updates(db, lan, fake_runner,
                                                                  fake_publisher):
    env_id = lan.id
    await _run(db, lan, go_live=True)
    await _run(db, await _env(db, env_id), slot="purple", sha=NEWER)
    fake_publisher.fail["lan_switch"] = PUT_BACK_FAILED
    await _run(db, await _env(db, env_id), mode="activate", slot="purple", sha=NEWER)
    e = await _refused(db, await _env(db, env_id), mode="update", sha=SHA, slot="purple")
    assert e.code == "switch_unresolved"
    # a later switch that succeeds (to the live slot) lifts it
    del fake_publisher.fail["lan_switch"]
    await _run(db, await _env(db, env_id), mode="activate", slot="orange", sha=SHA)
    ok = await _run(db, await _env(db, env_id), slot="purple", sha=NEWER)
    assert (await _load(ok))[0].status == "succeeded"


async def test_a_switch_that_put_npm_back_blocks_nothing(db, lan, fake_runner,
                                                         fake_publisher):
    env_id = lan.id
    await _run(db, lan, go_live=True)
    await _run(db, await _env(db, env_id), slot="purple", sha=NEWER)
    fake_publisher.fail["lan_switch"] = ("2 of 5 public URLs didn't answer. Traffic stays "
                                         "where it was.")
    await _run(db, await _env(db, env_id), mode="activate", slot="purple", sha=NEWER)
    del fake_publisher.fail["lan_switch"]
    ok = await _run(db, await _env(db, env_id), slot="purple", sha=NEWER)
    assert (await _load(ok))[0].status == "succeeded"


async def test_a_switch_that_timed_out_blocks_updates(db, lan, fake_runner, fake_publisher,
                                                      monkeypatch):
    env_id = lan.id
    await _run(db, lan, go_live=True)
    await _run(db, await _env(db, env_id), slot="purple", sha=NEWER)
    monkeypatch.setitem(steps_mod.STEPS_BY_KEY, "lan_switch", dataclasses.replace(
        steps_mod.STEPS_BY_KEY["lan_switch"], timeout=0.2))
    fake_publisher.gates["lan_switch"] = asyncio.Event()
    stuck = await _run(db, await _env(db, env_id), mode="activate", slot="purple", sha=NEWER)
    dep, _, _ = await _load(stuck)
    assert dep.status == "failed"
    assert dep.error.startswith("Step 14 (Switch traffic) timed out after")
    del fake_publisher.gates["lan_switch"]
    e = await _refused(db, await _env(db, env_id), mode="update", sha=SHA, slot="purple")
    assert e.code == "switch_unresolved"


def test_the_put_back_marker_is_publish_s_own_copy():
    source = inspect.getsource(publish._roll_back)
    assert source.count(lan_slots.PUT_BACK_FAILED) == 3
