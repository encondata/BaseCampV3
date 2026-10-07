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
from sirdar_api.deploy.vmcommon import VmOutcome, VmPrepareError

from .deploy_factories import secrets_key, trust_fake  # noqa: F401
from .esxi_helpers import esxi_fake  # noqa: F401
from .integration_helpers import configure, configure_esxi, configure_proxmox
from .lan_helpers import make_bluegreen_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_esxi_provision import provisioner
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


async def _dep(db, env, mode="update", slot="orange") -> Deployment:
    dep = Deployment(environment_id=env.id, mode=mode, git_ref="main", sha="",
                     status="running", vm=True, bluegreen=True, slot=slot)
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
