"""LAN Blue/Green environments for tests. The three VMs' static addresses
are on loopback (127.0.0.1-3/8); the step-0 effect records 127.0.0.1 for
every VM, so the tests' own SSH server plays all three once vms.VM_SSH_PORT
points at it."""

import pytest

from sirdar_api.config import get_settings
from sirdar_api.db.models import EsxiVm
from sirdar_api.deploy import environments, vmcommon, vms

ORANGE, PURPLE, DATA = "127.0.0.1", "127.0.0.2", "127.0.0.3"
LAN_VM = {"slots": 2, "ip_mode": "static", "ip_cidr": f"{ORANGE}/8",
          "purple_ip_cidr": f"{PURPLE}/8", "data_ip_cidr": f"{DATA}/8",
          "gateway": "127.0.0.254", "cores": 2, "memory_mb": 4096, "disk_gb": 40,
          "data": {"cores": 2, "memory_mb": 4096, "disk_gb": 60}}


async def make_bluegreen_environment(db, *, name: str = "lan9", target: str = "esxi",
                                     publish: bool = False, host_key=None,
                                     check_addresses: bool = False, **vm):
    """Needs secrets_key, the target's integration and NPM (integration_helpers).
    Loopback is allowed and (unless check_addresses) the address check
    skipped, as in vm_helpers."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(vms, "ALLOW_LOOPBACK", True)

        async def free(*args, **kwargs) -> bool:
            return False

        if not check_addresses:
            mp.setattr(vms, "address_in_use", free)
        if host_key is not None:
            mp.setattr(vms, "new_host_keypair", lambda env_name: (
                host_key.export_private_key("openssh").decode(),
                host_key.export_public_key("openssh").decode().strip()))
        env = await environments.create_new(db, get_settings(), name=name, type_="dev",
                                            target_id=target, proxy_ip="10.0.0.2",
                                            vm={**LAN_VM, **vm}, publish=publish)
    await db.commit()
    return env


def lan_built(model=EsxiVm):
    """A step-0 effect for a LanContext: every VM it names is built at
    127.0.0.1 (each Proxmox VM gets its own id: vmid is unique)."""
    async def effect(ctx) -> None:
        for n, machine in enumerate(ctx.machines):
            extra = {"moref": str(n + 1)} if model is EsxiVm else {"vmid": 200 + n}
            await vmcommon.set_vm(model, ctx.env_id, role=machine.vm.role, created=True,
                                  ip="127.0.0.1", **extra)
    return effect
