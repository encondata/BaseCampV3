import base64
import uuid
from datetime import UTC, datetime

import pytest
import yaml
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment, EnvironmentService, EsxiVm, Integration
from sirdar_api.deploy import esxi, esxi_provision, known_hosts, vms
from sirdar_api.deploy.esxi import EsxiError, SnapshotInfo
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.vmcommon import VmPrepareError

from .deploy_factories import secrets_key  # noqa: F401
from .esxi_helpers import esxi_fake  # noqa: F401
from .fake_esxi import SEED, SEED_DISK
from .integration_helpers import ESXI_PASSWORD, configure_esxi
from .proxmox_helpers import no_sleep
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .vm_helpers import make_esxi_environment

SHA = "e73b99ca" + "0" * 32
NOW = datetime(2026, 10, 5, 12, 0, 0, tzinfo=UTC)
SNAP = "sirdar-20261005T120000Z"
DISK = "[datastore1] ss-uat3/ss-uat3-disk0.vmdk"


@pytest.fixture
async def esxi_env(db, deploy_env, secrets_key, ssh_server, esxi_fake, monkeypatch):
    """uat3 on ESXi; the tests' SSH server plays its VM at 127.0.0.1 with the
    host key Sirdar 'generated' (the server's own)."""
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    return await make_esxi_environment(db, host_key=ssh_server.host_key)


async def nothing_answers(host, port):
    return False


def resolves_to(sha):
    async def resolve(cfg, db, repo_url, ref):
        return sha
    return resolve


def provisioner(**kw):
    kw.setdefault("probe", nothing_answers)
    kw.setdefault("resolve", resolves_to(SHA))
    kw.setdefault("sleep", no_sleep)
    for key, value in (("poll", 1), ("tools_wait", 3), ("ssh_wait", 3), ("shutdown_wait", 3)):
        kw.setdefault(key, value)
    return esxi_provision.EsxiProvisioner(settings=get_settings(), now=lambda: NOW, **kw)


async def ctx_for(db, env, *, mode="update", sha="", take=False, vm_snapshot=None):
    dep = Deployment(id=uuid.uuid4(), environment_id=env.id, mode=mode, git_ref="main",
                     sha=sha, status="succeeded", start_step=0, vm=True,
                     take_vm_snapshot=take, vm_snapshot=vm_snapshot)
    db.add(dep)
    await db.commit()
    return await esxi_provision.prepare(db, env, dep, get_settings())


async def run(db, env, step="provision", lines=None, **ctx_kw):
    out = lines if lines is not None else []
    return await provisioner().run(step, await ctx_for(db, env, **ctx_kw), out.append)


async def row(db, env) -> EsxiVm:
    return await db.get(EsxiVm, env.id, populate_existing=True)


async def test_prepare_needs_the_integration(db, esxi_env):
    await db.execute(Integration.__table__.delete().where(Integration.kind == "esxi"))
    await db.commit()
    with pytest.raises(VmPrepareError) as e:
        await ctx_for(db, esxi_env)
    assert "VMware ESXi isn't set up" in e.value.reason


async def test_the_first_run_builds_the_vm_and_pins_the_generated_key(db, esxi_env, esxi_fake,
                                                                       ssh_server):
    lines: list[str] = []
    outcome = await run(db, esxi_env, lines=lines)
    assert outcome.sha == SHA
    [spec] = esxi_fake.specs
    assert (spec.name, spec.datastore, spec.network, spec.cores, spec.memory_mb) == (
        "ss-uat3", "datastore1", "VM Network", 4, 8192)
    assert spec.extra_config[esxi.OWNER_KEY] == str(esxi_env.id)
    assert spec.annotation.startswith(f"sirdar:{esxi_env.id}\n")
    user = yaml.safe_load(base64.b64decode(spec.extra_config["guestinfo.userdata"]))
    assert user["ssh_keys"]["ed25519_public"] == ssh_server.host_key.export_public_key(
        "openssh").decode().strip()
    vm = esxi_fake.by_name("ss-uat3")
    assert [d.path for d in vm.disks] == [DISK] and vm.disks[0].capacity_gb == 64
    assert vm.power_state == "poweredOn"
    assert "guestinfo.userdata" not in vm.extra and "guestinfo.metadata" in vm.extra
    assert "guestinfo.userdata.encoding" not in vm.extra
    record = await row(db, esxi_env)
    assert (record.moref, record.instance_uuid, record.vm_path, record.created, record.ip,
            record.host_key_private_enc) == (
        vm.moref, vm.instance_uuid, "[datastore1] ss-uat3/ss-uat3.vmx", True, "127.0.0.1", None)
    pinned = await known_hosts.lookup(db, "127.0.0.1", ssh_server.port)
    assert pinned.fingerprint_sha256 == ssh_server.fingerprint
    hosts = set(await db.scalars(select(EnvironmentService.host_ip).where(
        EnvironmentService.environment_id == esxi_env.id)))
    assert hosts == {"127.0.0.1"}
    log = "".join(lines)
    assert "PRIVATE KEY" not in log and ESXI_PASSWORD not in log
    assert SEED_DISK in esxi_fake.files                  # the seed is copied, never moved
    seed = esxi_fake.by_name(SEED)
    assert seed.power_state == "poweredOff" and [(d.path, d.capacity_gb) for d in seed.disks] == [
        (SEED_DISK, 3)] and not seed.snapshots


async def test_a_second_run_changes_nothing_and_keeps_the_pin(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    esxi_fake.calls.clear()
    lines: list[str] = []
    await run(db, esxi_env, lines=lines)
    assert "create_vm" not in esxi_fake.calls and "copy_disk" not in esxi_fake.calls
    assert "set_size" not in esxi_fake.calls and "is pinned" in "".join(lines)


async def test_a_lost_record_is_found_by_its_marker(db, esxi_env, esxi_fake):
    lost = esxi_fake.add_vm("ss-uat3", owner=str(esxi_env.id), power_state="poweredOff")
    await run(db, esxi_env)
    assert "create_vm" not in esxi_fake.calls
    assert (await row(db, esxi_env)).instance_uuid == lost.instance_uuid


async def test_a_vm_with_the_name_but_not_the_marker_is_never_touched(db, esxi_env, esxi_fake):
    foreign = esxi_fake.add_vm("ss-uat3", owner="", power_state="poweredOn")
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "isn't this environment's" in e.value.reason
    assert foreign.power_state == "poweredOn" and "create_vm" not in esxi_fake.calls
    assert (await row(db, esxi_env)).instance_uuid is None


async def test_a_busy_static_address_stops_before_anything_is_made(db, esxi_env, esxi_fake):
    async def answers(host, port):
        return True
    with pytest.raises(StepFailed) as e:
        await provisioner(probe=answers).run("provision", await ctx_for(db, esxi_env),
                                             lambda _: None)
    assert "already answers SSH" in e.value.reason and esxi_fake.specs == []


async def test_a_half_copied_disk_is_replaced(db, esxi_env, esxi_fake):
    esxi_fake.fail["attach_disk"] = EsxiError("ESXi couldn't attach the disk (x).")
    with pytest.raises(StepFailed):
        await run(db, esxi_env)
    assert DISK in esxi_fake.files and not esxi_fake.by_name("ss-uat3").disks
    del esxi_fake.fail["attach_disk"]
    await run(db, esxi_env)
    assert esxi_fake.calls.count("copy_disk") == 2 and "delete_disk" in esxi_fake.calls
    assert esxi_fake.by_name("ss-uat3").disks[0].path == DISK


async def test_a_created_vm_someone_changed_is_refused(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.owner = ""
    esxi_fake.calls.clear()
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "changed nothing" in e.value.reason
    assert not {"power_on", "power_off", "set_size", "take_snapshot"} & set(esxi_fake.calls)


async def test_a_created_vm_that_is_gone_is_not_rebuilt(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.power_state = "poweredOff"
    await esxi_fake.destroy(vm.instance_uuid)
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "won't build a new one silently" in e.value.reason


async def test_a_half_built_vm_that_is_gone_is_built_again(db, esxi_env, esxi_fake):
    esxi_fake.fail["copy_disk"] = EsxiError("ESXi couldn't copy the seed disk (x).")
    with pytest.raises(StepFailed):
        await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    await esxi_fake.destroy(vm.instance_uuid)
    del esxi_fake.fail["copy_disk"]
    await run(db, esxi_env)
    assert (await row(db, esxi_env)).created and len(esxi_fake.specs) == 2


async def test_cpu_and_memory_change_with_a_shutdown_after_the_snapshot(db, esxi_env,
                                                                        esxi_fake):
    await run(db, esxi_env)
    record = await row(db, esxi_env)
    record.cores, record.memory_mb = 6, 12288
    await db.commit()
    esxi_fake.calls.clear()
    outcome = await run(db, esxi_env, take=True)
    vm = esxi_fake.by_name("ss-uat3")
    assert (vm.cores, vm.memory_mb, vm.power_state) == (6, 12288, "poweredOn")
    calls = esxi_fake.calls
    assert calls.index("take_snapshot") < calls.index("shutdown_guest") < calls.index(
        "set_size") < calls.index("power_on")
    assert outcome.vm_snapshot == SNAP


async def test_a_disk_grow_deletes_sirdar_s_snapshots_then_snapshots_again(db, esxi_env,
                                                                           esxi_fake):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)                  # SNAP, recorded
    record = await row(db, esxi_env)
    record.disk_gb = 80
    await db.commit()
    lines: list[str] = []
    outcome = await run(db, esxi_env, take=True, lines=lines)
    vm = esxi_fake.by_name("ss-uat3")
    assert vm.disks[0].capacity_gb == 80
    assert [s.name for s in vm.snapshots] == [SNAP] and outcome.vm_snapshot == SNAP
    assert "ESXi can't grow a disk that has snapshots" in "".join(lines)


async def test_a_hand_made_snapshot_blocks_a_disk_grow(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.snapshots.append(SnapshotInfo(999, "before upgrade", "", None))
    record = await row(db, esxi_env)
    record.disk_gb = 80
    await db.commit()
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "before upgrade" in e.value.reason
    assert vm.disks[0].capacity_gb == 64 and len(vm.snapshots) == 1


async def test_a_guest_that_won_t_shut_down_isn_t_resized(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    record = await row(db, esxi_env)
    record.cores = 6
    await db.commit()
    esxi_fake.shutdown_stalls = True
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "didn't shut down" in e.value.reason and "set_size" not in esxi_fake.calls


async def test_snapshots_quiesce_fall_back_and_prune_only_sirdar_s(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    old = ["sirdar-20261001T000000Z", "sirdar-20261002T000000Z", "sirdar-20261003T000000Z"]
    for name in old:
        vm.snapshots.append(SnapshotInfo(len(vm.snapshots) + 100, name, "", None))
        db.add(Deployment(environment_id=esxi_env.id, mode="update", git_ref="main", sha=SHA,
                          status="succeeded", start_step=0, vm=True, vm_snapshot=name))
    vm.snapshots.append(SnapshotInfo(500, "sirdar-20200101T000000Z", "by hand", None))
    await db.commit()
    esxi_fake.quiesce_fails = True
    lines: list[str] = []
    await run(db, esxi_env, take=True, lines=lines)
    names = {s.name for s in vm.snapshots}
    assert names == {SNAP, old[2], old[1], "sirdar-20200101T000000Z"}
    assert "crash-consistent" in "".join(lines)


async def test_a_retry_keeps_the_first_attempt_s_snapshot_only_while_it_exists(db, esxi_env,
                                                                               esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.snapshots.append(SnapshotInfo(77, "sirdar-20261004T000000Z", "", None))
    esxi_fake.calls.clear()
    outcome = await run(db, esxi_env, take=True, vm_snapshot="sirdar-20261004T000000Z")
    assert outcome.vm_snapshot == "sirdar-20261004T000000Z"
    assert "take_snapshot" not in esxi_fake.calls
    vm.snapshots.clear()
    outcome = await run(db, esxi_env, take=True, vm_snapshot="sirdar-20261004T000000Z")
    assert outcome.vm_snapshot == SNAP


async def test_a_failed_snapshot_task_clears_its_record(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    esxi_fake.fail["take_snapshot"] = EsxiError("ESXi couldn't take a VM snapshot (x).")
    ctx = await ctx_for(db, esxi_env, take=True)
    with pytest.raises(StepFailed):
        await provisioner().run("provision", ctx, lambda _: None)
    dep = await db.get(Deployment, ctx.deployment_id, populate_existing=True)
    assert dep.vm_snapshot is None


async def test_a_live_key_that_isn_t_the_generated_one(db, deploy_env, secrets_key, ssh_server,
                                                       esxi_fake, monkeypatch):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    env = await make_esxi_environment(db)                       # a different host key
    with pytest.raises(StepFailed) as e:
        await run(db, env)
    assert "isn't the one Sirdar generated" in e.value.reason
    assert await known_hosts.lookup(db, "127.0.0.1", ssh_server.port) is None


async def test_restore_a_vm_snapshot(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)
    lines: list[str] = []
    await run(db, esxi_env, step="vm_restore", mode="vm_restore", sha=SHA, vm_snapshot=SNAP,
              lines=lines)
    assert "revert_snapshot" in esxi_fake.calls
    assert esxi_fake.by_name("ss-uat3").power_state == "poweredOn"
    assert f"back at {SNAP}" in "".join(lines)


@pytest.mark.parametrize("problem", ["unrecorded", "twice", "gone"])
async def test_restore_refuses(db, esxi_env, esxi_fake, problem):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)
    vm = esxi_fake.by_name("ss-uat3")
    name = SNAP
    if problem == "unrecorded":
        name = "sirdar-20261001T000000Z"
        vm.snapshots.append(SnapshotInfo(5, name, "", None))
    elif problem == "twice":
        vm.snapshots.append(SnapshotInfo(6, SNAP, "", None))
    else:
        vm.snapshots.clear()
    with pytest.raises(StepFailed):
        await run(db, esxi_env, step="vm_restore", mode="vm_restore", sha=SHA, vm_snapshot=name)
    assert "revert_snapshot" not in esxi_fake.calls


async def test_destroy_removes_only_sirdar_s_vm(db, esxi_env, esxi_fake, ssh_server):
    await run(db, esxi_env)
    other = esxi_fake.add_vm("uat", power_state="poweredOn")
    lines: list[str] = []
    await run(db, esxi_env, step="destroy", mode="teardown", lines=lines)
    assert esxi_fake.by_name("ss-uat3") is None and esxi_fake.by_name("uat") is other
    assert "power_off" in esxi_fake.calls
    assert await known_hosts.lookup(db, "127.0.0.1", ssh_server.port) is None


async def test_destroy_refuses_a_vm_without_the_marker(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    esxi_fake.by_name("ss-uat3").owner = ""
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env, step="destroy", mode="teardown")
    assert "isn't the VM Sirdar made" in e.value.reason
    assert esxi_fake.by_name("ss-uat3") is not None


async def test_destroy_finds_a_vm_from_an_unfinished_create(db, esxi_env, esxi_fake):
    esxi_fake.add_vm("ss-uat3", owner=str(esxi_env.id), power_state="poweredOff")
    await run(db, esxi_env, step="destroy", mode="teardown")
    assert esxi_fake.by_name("ss-uat3") is None


async def test_destroy_with_nothing_built(db, esxi_env, esxi_fake):
    foreign = esxi_fake.add_vm("ss-uat3", owner="", power_state="poweredOn")
    lines: list[str] = []
    await run(db, esxi_env, step="destroy", mode="teardown", lines=lines)
    assert "never created a VM" in "".join(lines) and esxi_fake.by_name("ss-uat3") is foreign


async def test_esxi_errors_end_as_our_copy(db, esxi_env, esxi_fake):
    esxi_fake.fail["connect"] = EsxiError("ESXi rejected the user name or password.")
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert e.value.reason == "ESXi rejected the user name or password."


async def test_the_context_hides_its_secrets(db, esxi_env):
    ctx = await ctx_for(db, esxi_env)
    assert ESXI_PASSWORD in ctx.secret_values
    assert any("PRIVATE KEY" in v for v in ctx.secret_values)
    assert ESXI_PASSWORD not in repr(ctx) and "PRIVATE KEY" not in repr(ctx)


async def test_an_update_after_a_vm_snapshot_passes_the_disk_check(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)
    vm = esxi_fake.by_name("ss-uat3")
    assert vm.disks[0].path == DISK
    assert vm.disks[0].current == "[datastore1] ss-uat3/ss-uat3-disk0-000001.vmdk"
    esxi_fake.calls.clear()
    await run(db, esxi_env)                             # still Sirdar's disk
    assert "power_on" not in esxi_fake.calls and [s.name for s in vm.snapshots] == [SNAP]


async def test_a_grow_after_snapshots_shuts_down_first_then_drops_them(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)
    record = await row(db, esxi_env)
    record.disk_gb = 80
    await db.commit()
    esxi_fake.calls.clear()
    outcome = await run(db, esxi_env, take=True)
    vm = esxi_fake.by_name("ss-uat3")
    calls = esxi_fake.calls
    assert calls.index("shutdown_guest") < calls.index("delete_snapshot") < calls.index(
        "grow_disk") < calls.index("power_on") < calls.index("take_snapshot")
    assert vm.disks[0].capacity_gb == 80 and outcome.vm_snapshot == SNAP
    assert vm.disks[0].path == DISK and vm.disks[0].current.endswith("-000002.vmdk")


async def test_a_grow_whose_guest_won_t_stop_keeps_its_snapshots(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)
    vm = esxi_fake.by_name("ss-uat3")
    before = list(vm.snapshots)
    record = await row(db, esxi_env)
    record.disk_gb = 80
    await db.commit()
    esxi_fake.shutdown_stalls = True
    esxi_fake.calls.clear()
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "didn't shut down" in e.value.reason
    assert vm.snapshots == before and vm.disks[0].capacity_gb == 64
    assert not {"delete_snapshot", "grow_disk", "set_size"} & set(esxi_fake.calls)


async def test_two_snapshots_with_a_recorded_name_block_a_grow(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    await run(db, esxi_env, take=True)
    vm = esxi_fake.by_name("ss-uat3")
    vm.snapshots.append(SnapshotInfo(606, SNAP, "", None))
    record = await row(db, esxi_env)
    record.disk_gb = 80
    await db.commit()
    esxi_fake.calls.clear()
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert SNAP in e.value.reason and len(vm.snapshots) == 2
    assert not {"shutdown_guest", "delete_snapshot", "grow_disk"} & set(esxi_fake.calls)


async def test_the_prune_skips_a_name_two_snapshots_share(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    old = ["sirdar-20261001T000000Z", "sirdar-20261002T000000Z", "sirdar-20261003T000000Z"]
    for name in old:
        vm.snapshots.append(SnapshotInfo(len(vm.snapshots) + 100, name, "", None))
        db.add(Deployment(environment_id=esxi_env.id, mode="update", git_ref="main", sha=SHA,
                          status="succeeded", start_step=0, vm=True, vm_snapshot=name))
    vm.snapshots.append(SnapshotInfo(700, old[0], "", None))
    await db.commit()
    lines: list[str] = []
    await run(db, esxi_env, take=True, lines=lines)
    assert [s.name for s in vm.snapshots].count(old[0]) == 2
    assert "delete_snapshot" not in esxi_fake.calls
    assert f"ESXi has 2 VM snapshots named {old[0]}" in "".join(lines)


async def test_a_failed_resize_after_the_shutdown_says_the_vm_is_off(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    record = await row(db, esxi_env)
    record.cores = 6
    await db.commit()
    esxi_fake.fail["set_size"] = EsxiError("ESXi couldn't resize the VM (x).")
    lines: list[str] = []
    with pytest.raises(StepFailed):
        await run(db, esxi_env, lines=lines)
    assert "The VM was left powered off; retry the deployment." in "".join(lines)
    assert esxi_fake.by_name("ss-uat3").power_state == "poweredOff"


async def test_a_snapshot_that_appears_after_its_task_failed_stays_recorded(db, esxi_env,
                                                                            esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    esxi_fake.fail["take_snapshot"] = EsxiError("ESXi didn't finish (take a VM snapshot).")
    waited: list[float] = []

    async def late(seconds):
        waited.append(seconds)
        if not any(s.name == SNAP for s in vm.snapshots):
            vm.snapshots.append(SnapshotInfo(808, SNAP, "", None))

    ctx = await ctx_for(db, esxi_env, take=True)
    with pytest.raises(StepFailed):
        await provisioner(sleep=late).run("provision", ctx, lambda _: None)
    assert waited
    dep = await db.get(Deployment, ctx.deployment_id, populate_existing=True)
    assert dep.vm_snapshot == SNAP


async def test_a_renamed_vm_is_refused_by_prepare(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.name = "renamed"
    esxi_fake.calls.clear()
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert "changed nothing" in e.value.reason
    assert not {"power_on", "power_off", "shutdown_guest", "set_size", "take_snapshot",
                "set_extra_config"} & set(esxi_fake.calls)


async def test_destroy_refuses_a_renamed_vm(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.name = "renamed"
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env, step="destroy", mode="teardown")
    assert "not ss-uat3" in e.value.reason
    assert vm.instance_uuid in esxi_fake.vms and vm.power_state == "poweredOn"


async def test_destroy_refuses_a_marker_twin(db, esxi_env, esxi_fake):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    vm.power_state = "poweredOff"
    await esxi_fake.destroy(vm.instance_uuid)
    twin = esxi_fake.add_vm("ss-uat3", owner=str(esxi_env.id), power_state="poweredOn")
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env, step="destroy", mode="teardown")
    assert "its id changed" in e.value.reason
    assert esxi_fake.by_name("ss-uat3") is twin and twin.power_state == "poweredOn"


FOREIGN_DISK = "[datastore1] shared/shared-data.vmdk"


@pytest.mark.parametrize("how", ["extra", "swapped"])
async def test_destroy_refuses_a_disk_sirdar_didn_t_put_there(db, esxi_env, esxi_fake, how):
    await run(db, esxi_env)
    vm = esxi_fake.by_name("ss-uat3")
    esxi_fake.files[FOREIGN_DISK] = 100
    foreign = esxi.DiskInfo(2100, FOREIGN_DISK, 100)
    vm.disks = [*vm.disks, foreign] if how == "extra" else [foreign]
    esxi_fake.calls.clear()
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env, step="destroy", mode="teardown")
    assert e.value.reason == ("VM ss-uat3 has a disk Sirdar didn't put there; detach it before "
                              "deleting the environment. Nothing was removed.")
    assert vm.instance_uuid in esxi_fake.vms and vm.power_state == "poweredOn"
    assert FOREIGN_DISK in esxi_fake.files
    assert not {"power_off", "destroy"} & set(esxi_fake.calls)


async def test_destroy_takes_a_vm_whose_disk_has_snapshot_deltas(db, esxi_env, esxi_fake):
    await run(db, esxi_env, take=True)
    await run(db, esxi_env, take=True)
    vm = esxi_fake.by_name("ss-uat3")
    assert vm.disks[0].current                       # writes go to a delta now
    await run(db, esxi_env, step="destroy", mode="teardown")
    assert esxi_fake.by_name("ss-uat3") is None


async def test_destroy_takes_an_unfinished_vm_with_no_disk(db, esxi_env, esxi_fake):
    esxi_fake.fail["copy_disk"] = EsxiError("ESXi couldn't copy the seed disk (x).")
    with pytest.raises(StepFailed):
        await run(db, esxi_env)
    assert esxi_fake.by_name("ss-uat3").disks == []
    await run(db, esxi_env, step="destroy", mode="teardown")
    assert esxi_fake.by_name("ss-uat3") is None


async def test_an_address_another_vm_on_the_host_reports_stops_the_create(db, esxi_env,
                                                                           esxi_fake):
    esxi_fake.add_vm("legacy-box", power_state="poweredOn", ips=("10.9.9.9", "127.0.0.1"))
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert e.value.reason == ("legacy-box on ESXi already reports 127.0.0.1, so Sirdar won't "
                              "give that address to a new VM. Free it, or delete this "
                              "environment and create it with another address.")
    assert esxi_fake.specs == [] and "create_vm" not in esxi_fake.calls


async def test_an_address_in_sirdar_s_registry_stops_the_create(db, esxi_env, esxi_fake,
                                                                monkeypatch):
    async def taken(*args, **kwargs) -> bool:
        return True
    monkeypatch.setattr(vms, "address_in_use", taken)
    with pytest.raises(StepFailed) as e:
        await run(db, esxi_env)
    assert e.value.reason.startswith("127.0.0.1 is an address another environment, an SSH "
                                     "target, the proxy or ESXi already uses")
    assert "Sirdar created nothing" in e.value.reason
    assert esxi_fake.specs == [] and "create_vm" not in esxi_fake.calls
