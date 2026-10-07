"""Step 0 and Destroy VM on a LAN Blue/Green environment: the data VM, then
the slot's VM; Delete removes all three. FakeEsxi boots every VM at
127.0.0.1, where the tests' SSH server answers, so the end-to-end build runs
one VM (the data VM, moved to 127.0.0.1); the order and dispatch are checked
with a recording provisioner."""

import pytest
from sqlalchemy import delete, select, update

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment, EnvironmentService, EsxiVm, ProxmoxVm
from sirdar_api.deploy import provision, vms, vmsteps
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.vmcommon import VmOutcome, VmPrepareError

from .deploy_factories import secrets_key, trust_fake  # noqa: F401
from .esxi_helpers import esxi_fake  # noqa: F401
from .integration_helpers import configure, configure_esxi, configure_proxmox
from .lan_helpers import make_bluegreen_environment
from .proxmox_helpers import proxmox_fake  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_esxi_provision import provisioner
from .test_deploy_provision import provisioner as px_provisioner
from .test_deploy_provision import tf  # noqa: F401
from .test_deploy_pipeline import SHA
from .vm_helpers import make_vm_environment


@pytest.fixture
async def lan(db, secrets_key, ssh_server, monkeypatch):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)

    async def free(*args, **kwargs) -> bool:
        return False

    monkeypatch.setattr(vms, "address_in_use", free)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    return await make_bluegreen_environment(db, host_key=ssh_server.host_key)


async def _dep(db, env, mode="update", slot="orange", **kw) -> Deployment:
    dep = Deployment(environment_id=env.id, mode=mode, git_ref="main", sha="",
                     status="running", vm=True, bluegreen=True, slot=slot, **kw)
    db.add(dep)
    await db.commit()
    return dep


class Recorder:
    """A host provisioner that records (step, role) and resolves on app VMs."""

    def __init__(self):
        self.seen: list[tuple[str, str]] = []

    async def run(self, step, ctx, out) -> VmOutcome:
        self.seen.append((step, ctx.vm.role))
        return VmOutcome(sha=SHA if ctx.resolve else None)


async def test_prepare_names_the_data_vm_then_the_slot(db, lan):
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan), get_settings())
    assert isinstance(ctx, vmsteps.LanContext)
    assert [(m.vm.role, m.services, m.resolve) for m in ctx.machines] == [
        ("data", ("spaces",), False), ("orange", (), True)]
    assert all(v in ctx.secret_values for m in ctx.machines for v in m.secret_values)


async def test_destroy_names_every_vm_apps_first(db, lan):
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan, mode="teardown", slot=None),
                                get_settings())
    assert [m.vm.role for m in ctx.machines] == ["purple", "orange", "data"]


async def test_the_host_provisioner_runs_each_vm_in_order(db, lan):
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan, slot="purple"), get_settings())
    recorder, lines = Recorder(), []
    outcome = await vmsteps.HostProvisioner(proxmox=recorder, esxi=recorder).run(
        "provision", ctx, lines.append)
    assert recorder.seen == [("provision", "data"), ("provision", "purple")]
    assert outcome == VmOutcome(sha=SHA)                 # the slot's; never a VM snapshot
    assert lines[0] == "— ss-lan9-data —\n"


async def test_the_data_vm_is_built_and_moves_only_spaces(db, lan, esxi_fake):
    await db.execute(update(EsxiVm).where(EsxiVm.environment_id == lan.id,
                                          EsxiVm.role == "data").values(ip_cidr="127.0.0.1/8"))
    await db.execute(update(EnvironmentService).where(
        EnvironmentService.environment_id == lan.id).values(host_ip="0.0.0.0"))
    await db.commit()
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan), get_settings())
    outcome = await provisioner().run("provision", ctx.machines[0], lambda _: None)
    assert outcome.sha is None                           # the data VM resolves nothing
    rows = {r.role: r for r in await db.scalars(
        select(EsxiVm).where(EsxiVm.environment_id == lan.id)
        .execution_options(populate_existing=True))}
    assert (rows["data"].created, rows["data"].ip) == (True, "127.0.0.1")
    assert rows["data"].host_key_private_enc is None     # delivered, then scrubbed
    assert not rows["orange"].created and rows["orange"].moref is None
    hosts = dict((await db.execute(select(EnvironmentService.service,
                                          EnvironmentService.host_ip))).all())
    assert hosts["spaces"] == "127.0.0.1" and hosts["api"] == "0.0.0.0"
    assert [v.name for v in esxi_fake.vms.values() if v.name.startswith("ss-")] == [
        "ss-lan9-data"]


async def test_vm_restore_is_refused(db, lan):
    with pytest.raises(VmPrepareError, match="no VM snapshots"):
        await vmsteps.prepare(db, lan, await _dep(db, lan, mode="vm_restore"), get_settings())


async def test_a_second_run_finds_the_recorded_data_vm(db, lan, esxi_fake):
    """Resumable: the data VM is recorded as it is built, so a retry of step 0
    updates that VM and never builds another."""
    await db.execute(update(EsxiVm).where(EsxiVm.environment_id == lan.id,
                                          EsxiVm.role == "data").values(ip_cidr="127.0.0.1/8"))
    await db.commit()
    dep = await _dep(db, lan)
    ctx = await vmsteps.prepare(db, lan, dep, get_settings())
    await provisioner().run("provision", ctx.machines[0], lambda _: None)
    again = await vmsteps.prepare(db, lan, dep, get_settings())
    assert again.machines[0].vm.created and again.machines[0].vm.moref is not None
    lines: list[str] = []
    await provisioner().run("provision", again.machines[0], lines.append)
    assert not any(line.startswith("Creating ") for line in lines)
    assert [v.name for v in esxi_fake.vms.values() if v.name.startswith("ss-")] == [
        "ss-lan9-data"]


async def test_an_update_without_a_slot_is_refused(db, lan):
    with pytest.raises(VmPrepareError, match="no server"):
        await vmsteps.prepare(db, lan, await _dep(db, lan, slot=None), get_settings())


async def test_destroy_names_only_the_vms_that_have_a_row(db, lan):
    await db.execute(delete(EsxiVm).where(EsxiVm.environment_id == lan.id,
                                          EsxiVm.role == "purple"))
    await db.commit()
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan, mode="teardown", slot=None),
                                get_settings())
    assert [(m.vm.role, m.services, m.resolve) for m in ctx.machines] == [
        ("orange", (), False), ("data", (), False)]


async def test_a_single_server_vm_keeps_its_one_context(db, secrets_key, monkeypatch):
    await configure_proxmox(db)
    await configure(db, cloudflare=True, npm=True)
    env = await make_vm_environment(db)
    ctx = await vmsteps.prepare(db, env, await _dep(db, env, slot=None), get_settings())
    assert isinstance(ctx, provision.VmContext)
    assert (ctx.vm.role, ctx.services, ctx.resolve) == ("main", None, True)


async def test_proxmox_prepares_each_role_and_records_it_alone(db, secrets_key):
    await configure_proxmox(db)
    await configure(db, cloudflare=True, npm=True)
    env = await make_bluegreen_environment(db, name="lan8", target="proxmox")
    ctx = await vmsteps.prepare(db, env, await _dep(db, env, slot="purple"), get_settings())
    assert all(isinstance(m, provision.VmContext) for m in ctx.machines)
    assert [(m.vm.role, m.vm.name, m.services, m.resolve) for m in ctx.machines] == [
        ("data", "ss-lan8-data", ("spaces",), False), ("purple", "ss-lan8-purple", (), True)]
    assert await provision._claim_vmid(env.id, 731, role="purple")
    await provision._set_vm(env.id, role="data", created=True)
    rows = {r.role: r for r in await db.scalars(
        select(ProxmoxVm).where(ProxmoxVm.environment_id == env.id)
        .execution_options(populate_existing=True))}
    assert {r: (v.vmid, v.created) for r, v in rows.items()} == {
        "data": (None, True), "orange": (None, False), "purple": (731, False)}


async def _rows(db, model, env_id) -> dict:
    return {r.role: r for r in await db.scalars(
        select(model).where(model.environment_id == env_id)
        .execution_options(populate_existing=True))}


async def _hosts(db) -> dict:
    return dict((await db.execute(select(EnvironmentService.service,
                                         EnvironmentService.host_ip))).all())


async def test_the_slot_vm_is_built_and_moves_no_service(db, lan, esxi_fake):
    await db.execute(update(EnvironmentService).where(
        EnvironmentService.environment_id == lan.id).values(host_ip="0.0.0.0"))
    await db.commit()
    before = await _hosts(db)
    data_before = (await _rows(db, EsxiVm, lan.id))["data"]
    data_before = (data_before.created, data_before.ip, data_before.moref,
                   data_before.host_key_private_enc)
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan), get_settings())
    outcome = await provisioner().run("provision", ctx.machines[1], lambda _: None)
    assert outcome.sha == SHA
    rows = await _rows(db, EsxiVm, lan.id)
    assert (rows["orange"].created, rows["orange"].ip) == (True, "127.0.0.1")
    assert rows["orange"].host_key_private_enc is None
    assert (rows["data"].created, rows["data"].ip, rows["data"].moref,
            rows["data"].host_key_private_enc) == data_before
    assert await _hosts(db) == before and set(before.values()) == {"0.0.0.0"}


class Failing(Recorder):
    def __init__(self, failing: set[str]):
        super().__init__()
        self.failing = failing

    async def run(self, step, ctx, out) -> VmOutcome:
        await super().run(step, ctx, out)
        if ctx.vm.role in self.failing:
            raise StepFailed(f"{ctx.vm.name} broke.")
        return VmOutcome()


@pytest.mark.parametrize("failing", [{"purple"}, {"orange"}, {"purple", "orange"}])
async def test_destroy_keeps_going_and_names_every_failure(db, lan, failing):
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan, mode="teardown", slot=None),
                                get_settings())
    host = Failing(failing)
    with pytest.raises(StepFailed) as e:
        await vmsteps.HostProvisioner(proxmox=host, esxi=host).run("destroy", ctx,
                                                                   lambda _: None)
    assert host.seen == [("destroy", "purple"), ("destroy", "orange")]   # never the data VM
    for role in ("purple", "orange"):
        assert (f"ss-lan9-{role} broke." in e.value.reason) == (role in failing)
    assert "ss-lan9-data" in e.value.reason


async def test_a_data_vm_failure_is_named(db, lan):
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan, mode="teardown", slot=None),
                                get_settings())
    host = Failing({"data"})
    with pytest.raises(StepFailed, match="ss-lan9-data broke."):
        await vmsteps.HostProvisioner(proxmox=host, esxi=host).run("destroy", ctx,
                                                                   lambda _: None)
    assert [r for _, r in host.seen] == ["purple", "orange", "data"]


async def test_no_machine_takes_or_keeps_a_vm_snapshot(db, lan):
    for mode, slot in (("update", "orange"), ("teardown", None)):
        dep = await _dep(db, lan, mode=mode, slot=slot, take_vm_snapshot=True,
                         vm_snapshot="sirdar-20261004T120000Z")
        ctx = await vmsteps.prepare(db, lan, dep, get_settings())
        dep.status = "succeeded"                          # one running deployment at a time
        await db.commit()
        assert [(m.take_snapshot, m.vm_snapshot) for m in ctx.machines] == [
            (False, None)] * len(ctx.machines)


async def test_an_update_leaves_a_built_data_vm_as_it_is(db, lan, esxi_fake):
    await db.execute(update(EsxiVm).where(EsxiVm.environment_id == lan.id,
                                          EsxiVm.role == "data").values(ip_cidr="127.0.0.1/8"))
    await db.commit()
    dep = await _dep(db, lan)
    ctx = await vmsteps.prepare(db, lan, dep, get_settings())
    assert [m.as_built for m in ctx.machines] == [True, False]
    await provisioner().run("provision", ctx.machines[0], lambda _: None)
    # Sizes changed on the record, and the VM is off: an Update only starts it.
    await db.execute(update(EsxiVm).where(EsxiVm.environment_id == lan.id,
                                          EsxiVm.role == "data")
                     .values(cores=4, memory_mb=8192, disk_gb=120))
    await db.commit()
    built = esxi_fake.by_name("ss-lan9-data")
    built.power_state, built.tools_running = "poweredOff", False
    esxi_fake.calls.clear()
    again = await vmsteps.prepare(db, lan, dep, get_settings())
    lines: list[str] = []
    outcome = await provisioner().run("provision", again.machines[0], lines.append)
    assert outcome == VmOutcome()
    changes = {"create_vm", "set_size", "grow_disk", "shutdown_guest", "take_snapshot",
               "copy_disk", "attach_disk", "set_extra_config", "delete_snapshot"}
    assert not changes & set(esxi_fake.calls)
    assert "power_on" in esxi_fake.calls
    assert (built.cores, built.memory_mb) == (2, 4096)
    assert (await _rows(db, EsxiVm, lan.id))["data"].ip == "127.0.0.1"


async def test_a_built_data_vm_that_is_gone_is_refused(db, lan, esxi_fake):
    await db.execute(update(EsxiVm).where(EsxiVm.environment_id == lan.id,
                                          EsxiVm.role == "data").values(ip_cidr="127.0.0.1/8"))
    await db.commit()
    dep = await _dep(db, lan)
    ctx = await vmsteps.prepare(db, lan, dep, get_settings())
    await provisioner().run("provision", ctx.machines[0], lambda _: None)
    del esxi_fake.vms[esxi_fake.by_name("ss-lan9-data").instance_uuid]
    again = await vmsteps.prepare(db, lan, dep, get_settings())
    with pytest.raises(StepFailed, match="gone"):
        await provisioner().run("provision", again.machines[0], lambda _: None)


@pytest.fixture
async def lan_px(db, secrets_key, ssh_server, proxmox_fake, monkeypatch, tmp_path):
    monkeypatch.setenv("SIRDAR_TERRAFORM_DIR", str(tmp_path / "terraform"))
    get_settings.cache_clear()
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)

    async def free(*args, **kwargs) -> bool:
        return False

    monkeypatch.setattr(vms, "address_in_use", free)
    await configure_proxmox(db)
    await configure(db, cloudflare=True, npm=True)
    env = await make_bluegreen_environment(db, name="lan7", target="proxmox")
    await db.execute(update(ProxmoxVm).where(ProxmoxVm.environment_id == env.id,
                                             ProxmoxVm.role == "data")
                     .values(ip_cidr="127.0.0.1/8"))
    await db.commit()
    yield env
    get_settings.cache_clear()


async def test_proxmox_update_leaves_a_built_data_vm_as_it_is(db, lan_px, tf, proxmox_fake):
    dep = await _dep(db, lan_px)
    ctx = await vmsteps.prepare(db, lan_px, dep, get_settings())
    await px_provisioner(tf).run("provision", ctx.machines[0], lambda _: None)
    row = (await _rows(db, ProxmoxVm, lan_px.id))["data"]
    assert (row.created, row.ip) == (True, "127.0.0.1")
    assert tf.requests                                   # the build ran Terraform
    await db.execute(update(ProxmoxVm).where(ProxmoxVm.environment_id == lan_px.id,
                                             ProxmoxVm.role == "data").values(cores=8))
    await db.commit()
    tf.requests.clear()
    again = await vmsteps.prepare(db, lan_px, dep, get_settings())
    outcome = await px_provisioner(tf).run("provision", again.machines[0], lambda _: None)
    assert outcome == VmOutcome() and tf.requests == []  # no plan, no apply


async def test_destroy_names_the_vm_it_never_created(db, lan, esxi_fake):
    ctx = await vmsteps.prepare(db, lan, await _dep(db, lan, mode="teardown", slot=None),
                                get_settings())
    lines: list[str] = []
    await provisioner().run("destroy", ctx.machines[0], lines.append)
    assert "Sirdar never created ss-lan9-purple.\n" in lines
