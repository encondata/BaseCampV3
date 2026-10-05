"""cloud-init for the VMs Sirdar builds on ESXi (deploy phase 6), delivered
through VMware's guestinfo datasource.

Metadata holds the instance id, the host name and the network (netplan v2,
matched by the vmxnet3 driver). User-data holds the deploy user with
Sirdar's key, and the SSH host key Sirdar generated, so the fingerprint is
known before the VM first boots. Pure: no I/O.

User-data holds a private host key. esxi_provision scrubs it from the VM's
settings once SSH answers with that key; metadata cleans it up in the guest
as well."""

import base64
import uuid

import yaml

VM_USER = "deploy"


def metadata(*, env_id: uuid.UUID, hostname: str, ip_cidr: str | None, gateway: str | None,
             dns_servers: tuple[str, ...]) -> str:
    """A static address with its default route and DNS (the given servers,
    else the gateway), or DHCP (with the given DNS servers, if any)."""
    if ip_cidr:
        nic: dict = {"match": {"driver": "vmxnet3"}, "dhcp4": False, "addresses": [ip_cidr],
                     "routes": [{"to": "default", "via": gateway}],
                     "nameservers": {"addresses": list(dns_servers) or [gateway]}}
    else:
        nic = {"match": {"driver": "vmxnet3"}, "dhcp4": True}
        if dns_servers:
            nic["nameservers"] = {"addresses": list(dns_servers)}
    doc = {"instance-id": f"sirdar-{env_id}", "local-hostname": hostname,
           "network": {"version": 2, "ethernets": {"nic0": nic}},
           "cleanup-guestinfo": ["userdata"]}
    return yaml.safe_dump(doc, sort_keys=False)


def userdata(*, hostname: str, ssh_public_key: str, host_key_private: str,
             host_key_public: str) -> str:
    doc = {
        "hostname": hostname,
        "preserve_hostname": False,
        "ssh_pwauth": False,
        "disable_root": True,
        "users": [{"name": VM_USER, "groups": ["sudo"], "shell": "/bin/bash",
                   "sudo": "ALL=(ALL) NOPASSWD:ALL", "lock_passwd": True,
                   "ssh_authorized_keys": [ssh_public_key]}],
        # Only the host key Sirdar generated: its fingerprint is pinned before
        # the first boot.
        "ssh_deletekeys": True,
        "ssh_genkeytypes": [],
        "ssh_keys": {"ed25519_private": host_key_private, "ed25519_public": host_key_public},
        "growpart": {"mode": "auto", "devices": ["/"]},
        "resize_rootfs": True,
    }
    return "#cloud-config\n" + yaml.safe_dump(doc, sort_keys=False)


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def guestinfo(meta: str, user: str) -> dict[str, str]:
    return {"guestinfo.metadata": _b64(meta), "guestinfo.metadata.encoding": "base64",
            "guestinfo.userdata": _b64(user), "guestinfo.userdata.encoding": "base64"}


def scrub() -> dict[str, str]:
    """An empty value deletes an extraConfig key on ESXi."""
    return {"guestinfo.userdata": "", "guestinfo.userdata.encoding": ""}
