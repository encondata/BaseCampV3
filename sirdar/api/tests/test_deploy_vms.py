from datetime import UTC, datetime, timedelta

import asyncssh
import pytest

from sirdar_api.config import get_settings
from sirdar_api.deploy import ConnectFailed, environments, gitref, ssh, targets, vault, vms
from sirdar_api.deploy.environments import EnvError
from sirdar_api.deploy.ssh import SshTargetConfig

from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import configure_proxmox
from .test_deploy_api import deploy_env  # noqa: F401
from .test_scaffold import _settings

VM = {"ip_mode": "static", "ip_cidr": "10.10.48.70/24", "gateway": "10.10.48.1"}


async def _create(db, name="uat3", **kw):
    return await environments.create_new(
        db, get_settings(), name=name, type_="dev", target_id=kw.pop("target_id", "proxmox"),
        proxy_ip="10.10.48.6", vm=kw.pop("vm", VM), **kw)


def test_sizes_default_and_networks_are_checked():
    assert vms.check_spec({"ip_mode": "dhcp"}) == {
        "cores": 4, "memory_mb": 8192, "disk_gb": 64, "ip_mode": "dhcp", "ip_cidr": None,
        "gateway": None}
    spec = vms.check_spec({**VM, "cores": 8, "memory_mb": 16384, "disk_gb": 128,
                           "ip_cidr": " 10.10.48.70/24 "})
    assert (spec["cores"], spec["ip_cidr"], spec["gateway"]) == (8, "10.10.48.70/24", "10.10.48.1")
    assert vms.static_ip("10.10.48.70/24") == "10.10.48.70" and vms.static_ip(None) is None
    assert vms.check_spec({"ip_mode": "dhcp", "ip_cidr": "", "gateway": None})["ip_cidr"] is None


def test_loopback_only_behind_the_test_knob(monkeypatch):
    spec = {"ip_mode": "static", "ip_cidr": "127.0.0.1/8", "gateway": "127.0.0.254"}
    with pytest.raises(vms.VmError):
        vms.check_spec(spec)
    monkeypatch.setattr(vms, "ALLOW_LOOPBACK", True)
    assert vms.check_spec(spec)["ip_cidr"] == "127.0.0.1/8"


@pytest.mark.parametrize("fields,code", [
    ({"ip_mode": "dhcp", "cores": 0}, "vm_cores_invalid"),
    ({"ip_mode": "dhcp", "cores": True}, "vm_cores_invalid"),
    ({"ip_mode": "dhcp", "memory_mb": 1024}, "vm_memory_invalid"),
    ({"ip_mode": "dhcp", "disk_gb": 5000}, "vm_disk_invalid"),
    ({"ip_mode": "bridged"}, "vm_ip_mode_invalid"),
    ({}, "vm_ip_mode_invalid"),
    ({**VM, "ip_cidr": "10.10.48.70"}, "vm_ip_invalid"),         # no prefix
    ({**VM, "ip_cidr": "10.10.48.0/24"}, "vm_ip_invalid"),       # the network's own address
    ({**VM, "ip_cidr": "10.10.48.255/24"}, "vm_ip_invalid"),     # its broadcast address
    ({**VM, "ip_cidr": "fe80::1/64"}, "vm_ip_invalid"),
    ({**VM, "gateway": "10.10.49.1"}, "vm_gateway_invalid"),     # outside the network
    ({**VM, "gateway": "10.10.48.70"}, "vm_gateway_invalid"),    # the VM itself
    ({**VM, "gateway": ""}, "vm_gateway_invalid"),
    ({**VM, "gateway": "10.10.48.0"}, "vm_gateway_invalid"),     # the network's address
    ({**VM, "gateway": "10.10.48.255"}, "vm_gateway_invalid"),   # its broadcast address
    ({**VM, "ip_cidr": "224.0.0.5/8"}, "vm_ip_invalid"),         # multicast
    ({**VM, "ip_cidr": "169.254.3.4/16", "gateway": "169.254.0.1"}, "vm_ip_invalid"),
    ({**VM, "ip_cidr": "0.1.2.3/8", "gateway": "0.0.0.1"}, "vm_ip_invalid"),
    ({**VM, "ip_cidr": "240.0.0.5/8", "gateway": "240.0.0.1"}, "vm_ip_invalid"),  # reserved
    ({**VM, "ip_cidr": "127.0.0.5/8", "gateway": "127.0.0.1"}, "vm_ip_invalid"),  # loopback
    ({"ip_mode": "dhcp", "ip_cidr": "10.10.48.70/24"}, "vm_ip_invalid"),
    ({"ip_mode": "dhcp", "gateway": "10.10.48.1"}, "vm_gateway_invalid"),
    ("dhcp", "vm_invalid"),
])
def test_bad_specs(fields, code):
    with pytest.raises(vms.VmError) as e:
        vms.check_spec(fields)
    assert e.value.code == code


def test_snapshot_names_and_the_key_rule():
    now = datetime(2026, 10, 4, 12, 0, 5, tzinfo=UTC)
    name = vms.snapshot_name(now)
    assert name == "sirdar-20261004T120005Z"
    assert vms.valid_snapshot_name(name) and vms.snapshot_taken_at(name) == now
    for bad in ("sirdar-20261304T120005Z", "manual-before-upgrade", "sirdar-20261004T120005",
                "current"):
        assert not vms.valid_snapshot_name(bad)
    assert vms.snapshot_blocked(name, None) is None
    assert vms.snapshot_blocked(name, now - timedelta(minutes=1)) is None
    assert vms.snapshot_blocked(name, now) == (
        "Taken before the sign-in keys changed (snapshot restore on 2026-10-04 12:00 UTC).")


async def test_create_a_proxmox_environment(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    env = await _create(db)
    await db.commit()
    vm = await vms.get(db, env.id)
    assert (vm.name, vm.node, vm.vmid, vm.ip, vm.created, vm.cores, vm.keep_snapshots) == (
        "ss-uat3", "pve", None, None, False, 4, 3)
    assert vm.ssh_public_key.startswith("ssh-ed25519 ")
    assert vm.ssh_public_key.endswith(" sirdar@ss-uat3")
    private = vault.decrypt(get_settings(), vm.ssh_private_key_enc)
    derived = asyncssh.import_private_key(private).export_public_key("openssh").decode()
    assert derived.split()[:2] == vm.ssh_public_key.split()[:2]
    assert {s.host_ip for s in await environments.services_of(db, env.id)} == {"10.10.48.70"}
    assert env.target_id == "proxmox"
    assert await vms.host_config(db, get_settings(), env) is None     # no address read yet
    assert vms.public(vm) == {
        "kind": "proxmox", "stage": "none", "host": "pve", "moref": None,
        "name": "ss-uat3", "node": "pve", "vmid": None, "cores": 4, "memory_mb": 8192,
        "disk_gb": 64, "ip_mode": "static", "ip_cidr": "10.10.48.70/24",
        "gateway": "10.10.48.1", "ip": None, "keep_snapshots": 3, "created": False}


async def test_a_dhcp_vm_s_services_wait_for_its_address(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    env = await _create(db, vm={"ip_mode": "dhcp", "cores": 2})
    await db.commit()
    assert {s.host_ip for s in await environments.services_of(db, env.id)} == {"0.0.0.0"}


async def test_create_needs_the_integration(db, deploy_env, secrets_key):
    with pytest.raises(EnvError) as e:
        await _create(db)
    assert (e.value.code, e.value.extra) == ("integration_not_configured", {"kinds": ["proxmox"]})


def _saved_targets(tmp_path, **hosts) -> str:
    """deploy-targets.env with one saved target per slug=host (no user, no
    password: not configured)."""
    path = tmp_path / "targets" / "deploy-targets.env"
    path.parent.mkdir(exist_ok=True)
    lines = [f"SIRDAR_SSH_TARGETS={','.join(hosts)}"]
    for slug, host in hosts.items():
        lines.append(f"SIRDAR_SSH_{slug.upper()}_HOST={host}")
    path.write_text("\n".join(lines) + "\n")
    return str(path)


async def _refused(db, code="ip_in_use", **kw):
    with pytest.raises(EnvError) as e:
        await _create(db, **kw)
    assert e.value.code == code
    await db.rollback()


async def test_refuses_the_installer_target_s_host(db, deploy_env, secrets_key):
    deploy_env(ssh_host="10.10.48.63")                 # not configured: no user or password
    await configure_proxmox(db)
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.63/24"})


async def test_refuses_an_unconfigured_saved_target_s_host(db, deploy_env, secrets_key,
                                                           tmp_path, monkeypatch):
    deploy_env()
    monkeypatch.setenv("SIRDAR_DEPLOY_TARGETS_FILE", _saved_targets(tmp_path, uat="10.10.48.63"))
    get_settings.cache_clear()
    await configure_proxmox(db)
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.63/24"})


async def test_refuses_a_saved_target_s_resolved_name(db, deploy_env, secrets_key, tmp_path,
                                                      monkeypatch):
    deploy_env()
    monkeypatch.setenv("SIRDAR_DEPLOY_TARGETS_FILE",
                       _saved_targets(tmp_path, uat="uat.lan", odd="nowhere.lan"))
    get_settings.cache_clear()
    looked_up = []

    async def resolve(host):
        looked_up.append(host)
        if host == "nowhere.lan":
            raise OSError("no such host")
        return {"10.10.48.63"} if host == "uat.lan" else set()

    monkeypatch.setattr(vms, "resolve_host", resolve)
    await configure_proxmox(db)
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.63/24"})
    assert {"uat.lan", "nowhere.lan"} <= set(looked_up)
    await _create(db)                                   # an unresolvable name refuses nothing


async def test_resolve_host_gives_up_quickly(monkeypatch):
    import asyncio

    async def slow(*a, **kw):
        await asyncio.sleep(10)

    monkeypatch.setattr(vms, "RESOLVE_TIMEOUT", 0.05)
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", slow)
    assert await vms.resolve_host("slow.lan") == set()
    assert await vms.resolve_host("10.10.48.9") == {"10.10.48.9"}


async def test_an_unreadable_targets_file_refuses(db, deploy_env, secrets_key, tmp_path,
                                                  monkeypatch):
    deploy_env()
    path = tmp_path / "targets" / "deploy-targets.env"
    path.parent.mkdir()
    path.write_bytes(b"SIRDAR_SSH_TARGETS=\xff\xfe\n")          # not UTF-8
    monkeypatch.setenv("SIRDAR_DEPLOY_TARGETS_FILE", str(path))
    get_settings.cache_clear()
    await configure_proxmox(db)
    await _refused(db, code="ssh_targets_unreadable")


async def test_refuses_the_proxy_and_proxmox_itself(db, deploy_env, secrets_key):
    await configure_proxmox(db)                         # https://10.10.48.5:8006
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.6/24"})     # this environment's proxy
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.5/24"})     # the Proxmox host


async def test_refuses_another_environment_s_proxy(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    other = await make_environment(db, name="other")
    other.proxy_ip = "10.10.48.9"
    await db.commit()
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.9/24"})


async def test_refuses_another_environment_s_service_address(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    other = await make_environment(db, name="other")
    for row in await environments.services_of(db, other.id):
        row.host_ip = "10.10.48.70"
    await db.commit()
    await _refused(db)


async def test_refuses_another_vm_s_static_address(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    first = await _create(db)
    for row in await environments.services_of(db, first.id):
        row.host_ip = "10.10.48.99"                     # only the VM row still names .70
    await db.commit()
    await _refused(db, name="uat4")


async def test_refuses_another_vm_s_dhcp_lease(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    first = await _create(db, vm={"ip_mode": "dhcp"})
    (await vms.get(db, first.id)).ip = "10.10.48.70"
    await db.commit()
    await _refused(db, name="uat4")


async def test_sizes_are_checked_on_create(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    await _refused(db, code="vm_cores_invalid", vm={**VM, "cores": 99})
    for bad in ("static", ["x"], 5):
        await _refused(db, code="vm_invalid", vm=bad)


async def test_concurrent_creates_take_turns(db, deploy_env, secrets_key):
    import asyncio

    from sirdar_api.db.engine import get_sessionmaker

    await configure_proxmox(db)
    await _create(db)                                   # holds the address lock until commit
    async with get_sessionmaker()() as other:
        second = asyncio.create_task(_create(other, name="uat4"))
        await asyncio.sleep(0.3)
        assert not second.done()                        # waiting for the first create
        await db.commit()
        with pytest.raises(EnvError) as e:
            await second
        assert e.value.code == "ip_in_use"


async def test_target_rules(db, deploy_env, secrets_key):
    deploy_env(ssh_host="10.10.48.20", ssh_user="root", ssh_password="pw")
    await configure_proxmox(db)
    with pytest.raises(EnvError) as e:
        await _create(db, name="plain", target_id="ssh")
    assert e.value.code == "vm_not_allowed"
    with pytest.raises(EnvError) as e:
        await environments.adopt(db, get_settings(), name="uat", type_="dev",
                                 target_id="proxmox")
    assert e.value.code == "adopt_not_allowed"
    await _create(db)
    await db.commit()
    settings = get_settings()
    for fields, code in (({"target": "ssh"}, "target_kind_locked"),
                         ({"services": {"api": {"host_ip": "10.10.48.71"}}}, "host_ip_managed"),
                         ({"vm": {"disk_gb": 32}}, "vm_disk_shrink"),
                         ({"vm": {"keep_snapshots": 0}}, "vm_keep_snapshots_invalid"),
                         ({"vm": {"memory_mb": 1000}}, "vm_memory_invalid"),
                         ({"vm": "big"}, "vm_invalid"),
                         ({"vm": [1]}, "vm_invalid")):
        # A rollback expires every loaded row: read the environment again each time.
        env = await environments.get_by_name(db, "uat3")
        with pytest.raises(EnvError) as e:
            await environments.update(db, settings, env, fields)
        assert e.value.code == code, fields
        await db.rollback()
    env = await environments.get_by_name(db, "uat3")
    changed = await environments.update(db, settings, env, {
        "vm": {"cores": 8, "memory_mb": 16384, "disk_gb": 64, "keep_snapshots": 5},
        "services": {"api": {"port": 8100}}})
    await db.commit()
    assert changed == ["services.api.port", "vm.cores", "vm.memory_mb", "vm.keep_snapshots"]
    vm = await vms.get(db, env.id)
    assert (vm.cores, vm.memory_mb, vm.disk_gb, vm.keep_snapshots) == (8, 16384, 64, 5)
    plain = await make_environment(db, name="plain", target_id="ssh")
    with pytest.raises(EnvError) as e:
        await environments.update(db, settings, plain, {"vm": {"cores": 2}})
    assert e.value.code == "vm_not_allowed"
    await db.rollback()
    plain = await environments.get_by_name(db, "plain")
    with pytest.raises(EnvError) as e:
        await environments.update(db, settings, plain, {"target": "proxmox"})
    assert e.value.code == "target_kind_locked"


async def test_the_vm_s_ssh_connection(db, deploy_env, secrets_key):
    deploy_env(ssh_host="10.10.48.20", ssh_user="root", ssh_password="pw")
    await configure_proxmox(db)
    env = await _create(db)
    vm = await vms.get(db, env.id)
    vm.ip = "10.10.48.70"
    await db.commit()
    cfg = await vms.host_config(db, get_settings(), env)
    assert (cfg.host, cfg.port, cfg.user, cfg.auth_label, cfg.password) == (
        "10.10.48.70", 22, "deploy", "key", None)
    assert "PRIVATE KEY" not in repr(cfg)
    key = await ssh.load_client_key(cfg)
    assert key.export_public_key("openssh").decode().split()[:2] == vm.ssh_public_key.split()[:2]
    plain = await make_environment(db, name="plain", target_id="ssh")
    assert await vms.host_config(db, get_settings(), plain) == targets.ssh_config_for(
        "ssh", get_settings())
    with pytest.raises(ConnectFailed) as e:
        await ssh.load_client_key(SshTargetConfig(host="h", port=22, user="u",
                                                  private_key="not a key"))
    assert e.value.reason == "Sirdar's key for this VM can't be read."


def test_the_target_list_shows_proxmox_once_it_is_set_up(tmp_path):
    s = _settings(deploy_targets_file=str(tmp_path / "none.env"))
    assert "proxmox" not in [t["id"] for t in targets.public_targets(s)]
    assert targets.public_targets(s, proxmox_configured=True)[-1] == {
        "id": "proxmox", "label": "Proxmox", "kind": "proxmox", "available": True,
        "configured": True}


def test_is_full_sha():
    assert gitref.is_full_sha("A" * 40) and gitref.is_full_sha("0123456789" * 4)
    assert not gitref.is_full_sha("main") and not gitref.is_full_sha("a" * 39)
    assert gitref.full_sha("ABCDEF0123" * 4) == "abcdef0123" * 4      # stored lowercase
    assert gitref.full_sha("main") is None


async def test_the_helper_builds_a_loopback_vm_environment(db, deploy_env, secrets_key):
    from .vm_helpers import make_vm_environment

    deploy_env(ssh_host="127.0.0.1", ssh_user="root", ssh_password="pw")
    await configure_proxmox(db)
    env = await make_vm_environment(db, current_sha="a" * 40)
    assert (await vms.get(db, env.id)).ip_cidr == "127.0.0.1/8" and env.status == "ready"
    assert vms.ALLOW_LOOPBACK is False                  # only for that create
