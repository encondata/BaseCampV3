"""Proxmox environments for tests. The VM's static address is on loopback
(127.0.0.1/8), so the tests' own SSH server plays the VM once
vms.VM_SSH_PORT points at it; FakeProxmox's agent reports that address on
eth0 and the server's host key. The Terraform effects create or remove the
VM in FakeProxmox the way a real apply or destroy would."""

import json

from sirdar_api.config import get_settings
from sirdar_api.db.models import Environment
from sirdar_api.deploy import envfile, environments

from .fake_terraform import write_state

VM_SPEC = {"ip_mode": "static", "ip_cidr": "127.0.0.1/8", "gateway": "127.0.0.254"}


async def make_vm_environment(db, *, name: str = "uat3", current_sha: str | None = None,
                              publish: bool = False, **vm) -> Environment:
    """Needs the secrets_key fixture and a saved Proxmox integration."""
    env = await environments.create_new(db, get_settings(), name=name, type_="dev",
                                        target_id="proxmox", proxy_ip="10.0.0.2",
                                        vm={**VM_SPEC, **vm}, publish=publish)
    if current_sha:
        env.current_sha, env.image_tag = current_sha, envfile.image_tag(current_sha)
        env.status = "ready"
    await db.commit()
    return env


def host_key_line(fake_ssh) -> str:
    return fake_ssh.host_key.export_public_key("openssh").decode().strip()


def _vm_block(request) -> dict:
    config = json.loads((request.workdir / "main.tf.json").read_text())
    return config["resource"]["proxmox_virtual_environment_vm"]["vm"]


def apply_creates_vm(fake_px, host_key: str | None, ips: tuple[str, ...] = ("127.0.0.1",)):
    def effect(request) -> None:
        vm = _vm_block(request)
        if vm["vm_id"] not in fake_px.vms:
            fake_px.add_vm(vm["vm_id"], vm["name"], ips=ips, host_key=host_key)
        write_state(request)
    return effect


def destroy_removes_vm(fake_px):
    def effect(request) -> None:
        fake_px.remove_vm(_vm_block(request)["vm_id"])
        write_state(request, vm=False)
    return effect
