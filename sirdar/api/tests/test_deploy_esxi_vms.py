import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentService, EsxiVm, Integration
from sirdar_api.deploy import environments, integrations, serialize, vault, vms
from sirdar_api.deploy.environments import EnvError

from .deploy_factories import secrets_key  # noqa: F401
from .integration_helpers import configure_esxi, configure_proxmox
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_vms import _saved_targets
from .vm_helpers import make_esxi_environment, make_vm_environment


async def test_an_esxi_environment_freezes_its_inputs_and_holds_two_key_pairs(db, secrets_key):
    await configure_esxi(db)
    env = await make_esxi_environment(db)
    vm = await vms.get_for(db, env)
    assert isinstance(vm, EsxiVm)
    assert (vm.name, vm.host, vm.datastore, vm.network, vm.source_vm, vm.resource_pool,
            vm.dns_servers, vm.instance_uuid, vm.created) == (
        "ss-uat3", "10.10.48.10", "datastore1", "VM Network", "sirdar-ubuntu-2404-seed",
        None, [], None, False)
    assert vm.ssh_public_key.startswith("ssh-ed25519 ")
    assert vm.host_key_public.startswith("ssh-ed25519 ")
    private = vault.decrypt(get_settings(), vm.host_key_private_enc)
    assert private.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    hosts = set(await db.scalars(select(EnvironmentService.host_ip).where(
        EnvironmentService.environment_id == env.id)))
    assert hosts == {"127.0.0.1"}
    assert vms.public(vm) == {
        "kind": "esxi", "stage": "none", "name": "ss-uat3", "host": "10.10.48.10",
        "node": None, "vmid": None, "moref": None, "cores": 4, "memory_mb": 8192,
        "disk_gb": 64, "ip_mode": "static", "ip_cidr": "127.0.0.1/8",
        "gateway": "127.0.0.254", "ip": None, "keep_snapshots": 3, "created": False,
        "role": "main"}
    out = await serialize.environment_out(db, env)
    assert (out["target"], out["target_kind"], out["vm"]["kind"]) == ("esxi", "esxi", "esxi")


async def test_stage():
    vm = EsxiVm(instance_uuid=None, created=False)
    assert vms.stage(vm) == "none"
    vm.instance_uuid = "52aa"
    assert vms.stage(vm) == "partial"
    vm.created = True
    assert vms.stage(vm) == "built"


async def test_esxi_must_be_set_up(db, secrets_key, deploy_env):
    with pytest.raises(EnvError) as e:
        await environments.create_new(db, get_settings(), name="uat3", type_="dev",
                                      target_id="esxi", proxy_ip="10.0.0.2",
                                      vm={"ip_mode": "dhcp"})
    assert (e.value.code, e.value.extra) == ("integration_not_configured", {"kinds": ["esxi"]})


async def test_the_esxi_host_and_esxi_vm_addresses_are_in_use(db, secrets_key, deploy_env):
    await configure_esxi(db)
    env = await make_esxi_environment(db, ip_cidr="10.10.48.71/24", gateway="10.10.48.1")
    s = get_settings()
    assert await vms.address_in_use(db, s, "10.10.48.10", proxy_ip="10.0.0.2")   # ESXi itself
    assert await vms.address_in_use(db, s, "10.10.48.71", proxy_ip="10.0.0.2")   # its VM
    assert not await vms.address_in_use(db, s, "10.10.48.71", proxy_ip="10.0.0.2",
                                        env_id=env.id)
    assert not await vms.address_in_use(db, s, "10.10.48.72", proxy_ip="10.0.0.2")


async def test_a_proxmox_vm_address_is_in_use_for_esxi_too(db, secrets_key, deploy_env):
    await configure_proxmox(db)
    await configure_esxi(db)
    await make_vm_environment(db, name="pve1", ip_cidr="10.10.48.70/24", gateway="10.10.48.1")
    assert await vms.address_in_use(db, get_settings(), "10.10.48.70", proxy_ip="10.0.0.2")


async def test_adopt_and_moving_between_hosts_are_refused(db, secrets_key, deploy_env):
    await configure_proxmox(db)
    await configure_esxi(db)
    with pytest.raises(EnvError) as e:
        await environments.adopt(db, get_settings(), name="uat3", type_="dev",
                                 target_id="esxi")
    assert e.value.code == "adopt_not_allowed"
    await make_esxi_environment(db)
    for target in ("proxmox", "ssh"):
        # A rollback expires every loaded row: read the environment again each time.
        env = await environments.get_by_name(db, "uat3")
        with pytest.raises(EnvError) as e:
            await environments.update(db, get_settings(), env, {"target": target})
        assert e.value.code == "target_kind_locked"
        await db.rollback()


async def test_patch_sizes_and_managed_addresses(db, secrets_key, deploy_env):
    await configure_esxi(db)
    env = await make_esxi_environment(db)
    changed = await environments.update(db, get_settings(), env,
                                        {"vm": {"cores": 6, "disk_gb": 80}})
    assert changed == ["vm.cores", "vm.disk_gb"]
    with pytest.raises(EnvError) as e:
        await environments.update(db, get_settings(), env, {"vm": {"disk_gb": 70}})
    assert e.value.code == "vm_disk_shrink"
    await db.rollback()
    env = await environments.get_by_name(db, "uat3")
    with pytest.raises(EnvError) as e:
        await environments.update(db, get_settings(), env,
                                  {"services": {"api": {"host_ip": "10.10.48.9"}}})
    assert e.value.code == "host_ip_managed"


async def test_host_config_is_the_vm_once_it_has_an_address(db, secrets_key, deploy_env):
    await configure_esxi(db)
    env = await make_esxi_environment(db)
    assert await vms.host_config(db, get_settings(), env) is None
    vm = await vms.get_for(db, env)
    vm.ip = "127.0.0.1"
    await db.commit()
    cfg = await vms.host_config(db, get_settings(), env)
    assert (cfg.host, cfg.user, cfg.key_name) == ("127.0.0.1", "deploy",
                                                  "Sirdar's key for ss-uat3")
    assert cfg.private_key.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")


# ---- address safety on ESXi (phase 5's rules over both hosts) -----------------

VM = {"ip_mode": "static", "ip_cidr": "10.10.48.70/24", "gateway": "10.10.48.1"}


async def _create(db, name="uat3", **kw):
    return await environments.create_new(
        db, get_settings(), name=name, type_="dev", target_id="esxi",
        proxy_ip="10.10.48.6", vm=kw.pop("vm", VM), **kw)


async def _refused(db, code="ip_in_use", **kw):
    with pytest.raises(EnvError) as e:
        await _create(db, **kw)
    assert e.value.code == code
    await db.rollback()


async def test_esxi_create_refuses_saved_targets_hosts_and_proxies(db, deploy_env, secrets_key,
                                                                  tmp_path, monkeypatch):
    deploy_env(ssh_host="10.10.48.20")
    monkeypatch.setenv("SIRDAR_DEPLOY_TARGETS_FILE", _saved_targets(tmp_path, uat="10.10.48.63"))
    get_settings.cache_clear()
    await configure_proxmox(db)                         # https://10.10.48.5:8006
    await configure_esxi(db)                            # https://10.10.48.10
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.63/24"})    # uat, a saved target
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.20/24"})    # the installer target
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.5/24"})     # the Proxmox host
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.10/24"})    # the ESXi host
    await _refused(db, vm={**VM, "ip_cidr": "10.10.48.6/24"})     # this environment's proxy
    await _create(db)                                   # .70 is free


async def test_proxmox_create_refuses_the_esxi_host_and_esxi_vms(db, deploy_env, secrets_key):
    await configure_proxmox(db)
    await configure_esxi(db)
    with pytest.raises(EnvError) as e:
        await environments.create_new(db, get_settings(), name="pve1", type_="dev",
                                      target_id="proxmox", proxy_ip="10.10.48.6",
                                      vm={**VM, "ip_cidr": "10.10.48.10/24"})
    assert e.value.code == "ip_in_use"
    await db.rollback()
    await _create(db)                                   # an ESXi VM on .70
    await db.commit()
    with pytest.raises(EnvError) as e:
        await environments.create_new(db, get_settings(), name="pve1", type_="dev",
                                      target_id="proxmox", proxy_ip="10.10.48.6", vm=VM)
    assert e.value.code == "ip_in_use"


async def test_an_esxi_vm_s_dhcp_lease_is_in_use(db, deploy_env, secrets_key):
    await configure_esxi(db)
    first = await _create(db, vm={"ip_mode": "dhcp"})
    (await vms.get_for(db, first)).ip = "10.10.48.70"
    await db.commit()
    await _refused(db, name="uat4")


async def test_concurrent_esxi_creates_take_turns(db, deploy_env, secrets_key):
    import asyncio

    from sirdar_api.db.engine import get_sessionmaker

    await configure_esxi(db)
    await _create(db)                                   # holds the address lock until commit
    async with get_sessionmaker()() as other:
        second = asyncio.create_task(_create(other, name="uat4"))
        await asyncio.sleep(0.3)
        assert not second.done()                        # waiting for the first create
        await db.commit()
        with pytest.raises(EnvError) as e:
            await second
        assert e.value.code == "ip_in_use"


# ---- what reaches cloud-init's metadata is checked first ----------------------

async def _tamper_esxi(db, **config) -> None:
    row = await db.scalar(select(Integration).where(Integration.kind == "esxi"))
    row.config = {**row.config, **config}
    await db.commit()


@pytest.mark.parametrize("bad", [["10.10.48.1\nfoo: bar"], ["1.1.1.1", "nameserver"],
                                 ["127.0.0.1"], ["1.1.1.1", "1.0.0.1", "8.8.8.8", "9.9.9.9"],
                                 "10.10.48.1", [{"a": 1}]])
async def test_dns_servers_are_checked_again_before_they_are_frozen(db, deploy_env, secrets_key,
                                                                     bad):
    await configure_esxi(db)
    await _tamper_esxi(db, dns_servers=bad)
    await _refused(db, code="dns_servers_invalid")
    assert await db.scalar(select(EsxiVm.environment_id)) is None


async def test_good_dns_servers_are_frozen(db, deploy_env, secrets_key):
    await configure_esxi(db)
    await _tamper_esxi(db, dns_servers=["10.10.48.1", "1.1.1.1"])
    env = await _create(db)
    assert (await vms.get_for(db, env)).dns_servers == ["10.10.48.1", "1.1.1.1"]


def test_vm_host_names_are_checked():
    assert vms.check_vm_hostname("ss-uat3") == "ss-uat3"
    for bad in ("uat3", "ss-", "ss-uat3-", "ss-Uat3", "ss-uat3\nfoo: bar", "ss-uat 3",
                "ss-" + "a" * 61, "", None):
        with pytest.raises(vms.VmError) as e:
            vms.check_vm_hostname(bad)
        assert e.value.code == "vm_name_invalid"


async def test_add_esxi_refuses_a_bad_host_name(db, deploy_env, secrets_key):
    await configure_esxi(db)
    env = await _create(db)
    env.name = "bad\nname"                              # never saved: create checks names first
    with pytest.raises(vms.VmError) as e:
        await vms.add_esxi(db, get_settings(), env, vms.check_spec(VM),
                           await integrations.config_of(db, "esxi"))
    assert e.value.code == "vm_name_invalid"
    await db.rollback()
