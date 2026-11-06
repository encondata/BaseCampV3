"""A cleanup that succeeds keeps the environment and resets it to never
deployed: what step 0 recorded goes (droplets, VM ids, learned addresses,
slot commits, pins, VM snapshot records), a key a fresh build delivers is
made again, the first admin is pending again, and the user's settings stay."""

import asyncssh
import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import (
    AuditLog,
    Deployment,
    DoEnvironment,
    DoSlot,
    Environment,
    EnvironmentService,
    EsxiVm,
    ProxmoxVm,
    SshKnownHost,
    VmSlot,
)
from sirdar_api.deploy import (
    do_envs,
    do_provision,
    esxi_provision,
    first_admins,
    known_hosts,
    pipeline,
    provision,
    vault,
    vmcommon,
    vms,
)
from sirdar_api.deploy.vmcommon import VmOutcome

from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    make_environment,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .integration_helpers import configure, configure_esxi, configure_proxmox
from .lan_helpers import DATA, ORANGE, lan_built, make_bluegreen_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA, _load, _ssh_env
from .test_deploy_pipeline_do import _noop, do_env  # noqa: F401
from .test_deploy_pipeline_do import _start as _do_start
from .vm_helpers import make_esxi_environment, make_vm_environment

TYPED = "Correct-Horse-Battery-9"
ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": TYPED}
SNAP = "sirdar-20261004T120000Z"


async def _cleanup(db, env, **kw):
    dep = await pipeline.create_deployment(db, env, mode="cleanup", git_ref="main", sha="",
                                           actor_id=None, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def _pins(*hosts) -> set[str]:
    async with get_sessionmaker()() as s:
        return set(await s.scalars(select(SshKnownHost.host)
                                   .where(SshKnownHost.host.in_(hosts))))


async def _services(env_id) -> dict[str, str]:
    async with get_sessionmaker()() as s:
        rows = await s.scalars(select(EnvironmentService)
                               .where(EnvironmentService.environment_id == env_id))
        return {r.service: r.host_ip for r in rows}


def _pair_matches(private: str, public: str) -> bool:
    key = asyncssh.import_private_key(private)
    return key.export_public_key("openssh").decode().strip() == public.strip()


# ---- DigitalOcean -----------------------------------------------------------------------

async def test_cleanup_success_keeps_env_and_resets_do(db, do_env, fake_runner, fake_publisher,
                                                       fake_provisioner):
    await _do_start(db, do_env, slot="orange", go_live=True)
    # step 0 delivered both slots' host keys (_pin clears the private halves)
    for slot in do_env.slots:
        await do_envs.set_slot(do_env.id, slot, host_key_private_enc=None)
    dep_id = await _do_start(db, do_env, mode="cleanup", sha=SHA)
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded", [(s.key, s.status, s.log) for s in steps]
    assert fake_provisioner.calls[-1] == "do_destroy"
    assert env is not None
    assert (env.status, env.current_sha, env.image_tag, env.active_slot) == (
        "new", None, None, None)
    assert env.slots == ["orange", "purple"]
    settings = get_settings()
    async with get_sessionmaker()() as s:
        slots = await do_envs.slots_of(s, env.id)
        row = await s.get(DoEnvironment, env.id)
        audit = await s.scalar(select(AuditLog).where(
            AuditLog.action == "deploy.environment_cleanup"))
    for slot in slots.values():
        assert (slot.droplet_id, slot.public_ip, slot.private_ip) == (None, None, None)
        assert (slot.sha, slot.image_tag, slot.last_check_ok, slot.last_check_at) == (
            None, None, None, None)
        assert slot.host_key_private_enc is not None
        assert _pair_matches(vault.decrypt(settings, slot.host_key_private_enc),
                             slot.host_key_public)
    assert (row.vpc_ip_range, row.lb_ip, row.db_host, row.db_port, row.db_ca_cert,
            row.db_admin_password_enc, row.spaces_key_id, row.spaces_secret_enc,
            row.cert_not_after) == (None,) * 9
    # the settings frozen at create stay
    assert (row.region, row.account_key) == ("nyc3", "development")
    assert row.droplet_size and row.db_size and row.bucket
    assert row.ssh_private_key_enc is not None and row.acme_key_enc is not None
    assert (audit.entity_id, audit.changes) == (
        "uat9", {"environment": "uat9", "deployment": str(dep_id)})


async def test_cleanup_do_resources_left_fails_without_reset(db, do_env, fake_runner,
                                                             fake_publisher, fake_provisioner):
    await _do_start(db, do_env, slot="orange", go_live=True)
    fake_provisioner.effects["do_destroy"] = lambda ctx: _noop()
    dep_id = await _do_start(db, do_env, mode="cleanup", sha=SHA)
    dep, _, env = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 18)
    assert "still records" in dep.error
    assert (env.status, env.current_sha, env.active_slot) == ("failed", SHA, "orange")
    async with get_sessionmaker()() as s:
        slot = await s.get(DoSlot, (env.id, "orange"))
        row = await s.get(DoEnvironment, env.id)
        audit = await s.scalar(select(AuditLog).where(
            AuditLog.action == "deploy.environment_cleanup"))
    assert (slot.droplet_id, slot.public_ip, slot.sha) == ("4001", "127.0.0.1", SHA)
    assert row.lb_ip == "203.0.113.50"
    assert audit is None


async def test_cleanup_then_update_plans_step0_with_fresh_keys_on_do(
        db, do_env, fake_runner, fake_publisher, fake_provisioner):
    await _do_start(db, do_env, slot="orange", go_live=True)
    for slot in do_env.slots:
        await do_envs.set_slot(do_env.id, slot, host_key_private_enc=None)
    await _do_start(db, do_env, mode="cleanup", sha=SHA)
    env_id = do_env.id
    db.expire_all()
    env = await db.get(Environment, env_id)
    dep = Deployment(environment_id=env.id, mode="update", git_ref="main", sha="",
                     status="running", start_step=0, cloud=True, slot="orange", go_live=True)
    db.add(dep)
    await db.commit()
    ctx = await do_provision.prepare(db, env, dep, get_settings())
    for state in ctx.slot_states:
        # _create_droplet delivers this key, so _pin can confirm it
        assert state.host_key_private is not None
        assert _pair_matches(state.host_key_private, state.host_key_public)


# ---- Proxmox and ESXi ---------------------------------------------------------------------

@pytest.fixture
async def px_env(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_proxmox(db)
    env = await make_vm_environment(db)
    await trust_fake(db, ssh_server)
    return env


@pytest.fixture
async def esxi_env(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    env = await make_esxi_environment(db)
    await trust_fake(db, ssh_server)
    return env


async def _vm_start(db, env, mode="update", sha=SHA, **kw):
    dep = await pipeline.create_deployment(db, env, mode=mode, git_ref="main", sha=sha,
                                           actor_id=None, vm=True, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_cleanup_resets_proxmox_vm(db, px_env, fake_runner, fake_publisher,
                                         fake_provisioner, ssh_server):
    async def up(ctx):
        await provision._set_vm(ctx.env_id, vmid=120, created=True, ip="127.0.0.1")
    fake_provisioner.effects["provision"] = up
    fake_provisioner.outcomes["provision"] = VmOutcome(sha=SHA, vm_snapshot=SNAP)
    first = await _vm_start(db, px_env, sha="", take_vm_snapshot=True)
    assert (await _load(first))[0].status == "succeeded"
    before = await db.get(ProxmoxVm, (px_env.id, "main"), populate_existing=True)
    login_key = before.ssh_public_key
    dep_id = await _vm_start(db, px_env, mode="cleanup", sha="")
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded", [(s.key, s.status, s.log) for s in steps]
    assert fake_provisioner.calls[-1] == "destroy"
    assert (env.status, env.current_sha, env.image_tag) == ("new", None, None)
    vm = await db.get(ProxmoxVm, (px_env.id, "main"), populate_existing=True)
    assert (vm.vmid, vm.created) == (None, False)
    # the static address stays (it's the user's), and so does the VM's sizing
    assert (vm.ip_mode, vm.ip_cidr, vm.ip, vm.gateway) == (
        "static", "127.0.0.1/8", "127.0.0.1", "127.0.0.254")
    assert vm.ssh_public_key == login_key and vm.ssh_private_key_enc is not None
    assert vms.stage(vm) == "none"
    assert await _pins("127.0.0.1") == set()                     # the old VM's pin
    assert await vmcommon.recorded_snapshots(px_env.id) == set()
    assert set((await _services(px_env.id)).values()) == {"127.0.0.1"}


async def test_cleanup_forgets_a_dhcp_address(db, deploy_env, secrets_key, ssh_server,
                                              monkeypatch, fake_runner, fake_publisher,
                                              fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_proxmox(db)
    env = await make_vm_environment(db, ip_mode="dhcp", ip_cidr=None, gateway=None)
    await trust_fake(db, ssh_server)

    async def up(ctx):
        await provision._set_vm(ctx.env_id, vmid=121, created=True, ip="127.0.0.1")
        await vmcommon.record_address(get_settings(), ProxmoxVm, ctx.env_id, None, "127.0.0.1")
    fake_provisioner.effects["provision"] = up
    fake_provisioner.outcomes["provision"] = VmOutcome(sha=SHA)
    await _vm_start(db, env, sha="")
    assert set((await _services(env.id)).values()) == {"127.0.0.1"}
    dep_id = await _vm_start(db, env, mode="cleanup", sha="")
    assert (await _load(dep_id))[0].status == "succeeded"
    vm = await db.get(ProxmoxVm, (env.id, "main"), populate_existing=True)
    assert (vm.vmid, vm.ip, vm.ip_mode) == (None, None, "dhcp")
    assert set((await _services(env.id)).values()) == {"0.0.0.0"}
    assert await _pins("127.0.0.1") == set()


async def test_cleanup_resets_esxi_vm(db, esxi_env, fake_runner, fake_publisher,
                                      fake_provisioner):
    async def up(ctx):
        await vmcommon.set_vm(EsxiVm, ctx.env_id, moref="7", instance_uuid="uuid-main",
                              vm_path="[ds1] uat3/uat3.vmx", created=True, ip="127.0.0.1",
                              host_key_private_enc=None)        # delivered, then scrubbed
    fake_provisioner.effects["provision"] = up
    fake_provisioner.outcomes["provision"] = VmOutcome(sha=SHA, vm_snapshot=SNAP)
    await _vm_start(db, esxi_env, sha="", take_vm_snapshot=True)
    old = (await db.get(EsxiVm, (esxi_env.id, "main"), populate_existing=True)).host_key_public
    dep_id = await _vm_start(db, esxi_env, mode="cleanup", sha="")
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded", [(s.key, s.status, s.log) for s in steps]
    assert env.status == "new"
    vm = await db.get(EsxiVm, (esxi_env.id, "main"), populate_existing=True)
    assert (vm.moref, vm.instance_uuid, vm.vm_path, vm.created) == (None, None, None, False)
    assert (vm.ip_cidr, vm.ip) == ("127.0.0.1/8", "127.0.0.1")
    assert vm.host_key_private_enc is not None and vm.host_key_public != old
    assert _pair_matches(vault.decrypt(get_settings(), vm.host_key_private_enc),
                         vm.host_key_public)
    assert await _pins("127.0.0.1") == set()
    assert await vmcommon.recorded_snapshots(esxi_env.id) == set()


async def test_cleanup_then_update_plans_step0_with_fresh_keys_on_esxi(
        db, esxi_env, fake_runner, fake_publisher, fake_provisioner):
    async def up(ctx):
        await vmcommon.set_vm(EsxiVm, ctx.env_id, moref="7", instance_uuid="uuid-main",
                              created=True, ip="127.0.0.1", host_key_private_enc=None)
    fake_provisioner.effects["provision"] = up
    fake_provisioner.outcomes["provision"] = VmOutcome(sha=SHA)
    await _vm_start(db, esxi_env, sha="")
    await _vm_start(db, esxi_env, mode="cleanup", sha="")
    env_id = esxi_env.id
    db.expire_all()
    env = await db.get(Environment, env_id)
    dep = Deployment(environment_id=env.id, mode="update", git_ref="main", sha="",
                     status="running", start_step=0, vm=True)
    db.add(dep)
    await db.commit()
    ctx = await esxi_provision.prepare(db, env, dep, get_settings())
    # _create's "no longer has the host key" check passes: a key to deliver
    assert ctx.vm.host_key_pending and ctx.vm.host_key_private is not None
    assert _pair_matches(ctx.vm.host_key_private, ctx.vm.host_key_public)
    assert ctx.vm.instance_uuid is None and not ctx.vm.created


# ---- LAN Blue/Green -----------------------------------------------------------------------

@pytest.fixture
async def lan(db, secrets_key, ssh_server, monkeypatch, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    fake_provisioner.outcomes["provision"] = VmOutcome()
    return await make_bluegreen_environment(db)


async def test_cleanup_resets_bluegreen(db, lan, fake_runner, fake_publisher, fake_provisioner):
    dep = await pipeline.create_deployment(db, lan, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, vm=True, bluegreen=True,
                                           slot="orange", go_live=True)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    assert (await _load(dep.id))[2].active_slot == "orange"
    dep_id = await _cleanup(db, lan, vm=True, bluegreen=True, slot="orange")
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded", [(s.key, s.status, s.log) for s in steps]
    assert (env.status, env.active_slot, env.current_sha) == ("new", None, None)
    assert env.slots == ["orange", "purple"]
    async with get_sessionmaker()() as s:
        machines = await vms.machines(s, env)
        slots = await s.scalars(select(VmSlot).where(VmSlot.environment_id == env.id))
        slots = list(slots)
    assert sorted(m.role for m in machines) == ["data", "orange", "purple"]
    for m in machines:
        assert (m.moref, m.instance_uuid, m.created) == (None, None, False), m.role
        assert m.host_key_private_enc is not None, m.role
        assert m.ip_cidr is not None
    assert len(slots) == 2
    for row in slots:
        assert (row.sha, row.image_tag, row.last_check_ok, row.last_check_at) == (
            None, None, None, None)
    services = await _services(env.id)
    assert services["spaces"] == DATA
    assert {ip for svc, ip in services.items() if svc != "spaces"} == {ORANGE}


# ---- SSH targets and the first admin ----------------------------------------------------

@pytest.fixture
async def ssh_env(db, deploy_env, ssh_server, secrets_key, fake_provisioner):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    return await make_environment(db, current_sha=SHA)


async def test_cleanup_ssh_target_keeps_host(db, ssh_env, fake_runner, fake_publisher,
                                             ssh_server):
    before = await _services(ssh_env.id)
    dep_id = await _cleanup(db, ssh_env)
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded", [(s.key, s.status, s.log) for s in steps]
    assert fake_runner.steps() == ["teardown"]
    assert (env.status, env.current_sha, env.image_tag, env.target_id) == (
        "new", None, None, "ssh")
    assert await _services(ssh_env.id) == before
    async with get_sessionmaker()() as s:
        assert await known_hosts.lookup(s, ssh_server.host, ssh_server.port) is not None


async def test_cleanup_resets_typed_first_admin_to_needs_password(db, ssh_env, fake_runner,
                                                                  fake_publisher):
    await first_admins.put(db, get_settings(), ssh_env.id, first_admins.check(ADMIN))
    await first_admins.mark_done(db, ssh_env.id)
    await db.commit()
    row = await first_admins.get(db, ssh_env.id)
    assert first_admins.public(row)["needs_password"] is False      # done
    await _cleanup(db, ssh_env)
    row = await first_admins.get(db, ssh_env.id)
    assert (row.done_at, row.password_enc, row.email) == (None, None, "ada@test.example.com")
    assert await first_admins.pending(db, ssh_env.id)
    assert first_admins.needs_password(row)
    assert first_admins.public(row)["needs_password"] is True
    assert first_admins.public(row)["done"] is False


async def test_cleanup_resets_invite_first_admin(db, ssh_env, fake_runner, fake_publisher):
    invite = {**ADMIN, "password_mode": "invite", "password": None}
    await first_admins.put(db, get_settings(), ssh_env.id, first_admins.check(invite))
    await first_admins.mark_done(db, ssh_env.id)
    await db.commit()
    await _cleanup(db, ssh_env)
    row = await first_admins.get(db, ssh_env.id)
    assert (row.done_at, row.password_enc, row.password_mode) == (None, None, "invite")
    assert not first_admins.needs_password(row)
    assert first_admins.public(row)["needs_password"] is False


async def test_needs_password_only_for_a_pending_typed_admin_without_one(db, ssh_env):
    row = await first_admins.put(db, get_settings(), ssh_env.id, first_admins.check(ADMIN))
    assert not first_admins.needs_password(row)            # pending, password stored
    row.password_enc = None
    assert first_admins.needs_password(row)
    await first_admins.mark_done(db, ssh_env.id)
    assert not first_admins.needs_password(row)            # done
    assert first_admins.public(None) is None


async def test_reset_without_a_first_admin_is_a_no_op(db, ssh_env):
    await first_admins.reset(db, ssh_env.id)
    assert await first_admins.get(db, ssh_env.id) is None
