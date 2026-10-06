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
import ipaddress
import re
import uuid

import yaml

VM_USER = "deploy"
MAX_DNS_SERVERS = 3
# "ss-" and an environment name (vms.check_vm_hostname's rule).
_HOSTNAME_RE = re.compile(r"ss-[a-z][a-z0-9-]{0,30}[a-z0-9]")


def _checked(*, hostname, ip_cidr, gateway, dns_servers) -> None:
    """A last guard: callers check these first (vms.add_esxi), but nothing
    unchecked is ever written into the YAML. Raises ValueError."""
    if not isinstance(hostname, str) or not _HOSTNAME_RE.fullmatch(hostname):
        raise ValueError("hostname")
    if not isinstance(dns_servers, (tuple, list)):        # None too: ValueError, never TypeError
        raise ValueError("dns_servers")
    dns = tuple(dns_servers)
    if len(dns) > MAX_DNS_SERVERS:
        raise ValueError("dns_servers")
    for server in dns:
        if not isinstance(server, str) or str(ipaddress.IPv4Address(server)) != server:
            raise ValueError("dns_servers")
    if ip_cidr is None:
        if gateway is not None:
            raise ValueError("gateway")
        return
    if not isinstance(ip_cidr, str) or "/" not in ip_cidr:
        raise ValueError("ip_cidr")
    iface = ipaddress.IPv4Interface(ip_cidr)
    if str(iface) != ip_cidr:
        raise ValueError("ip_cidr")
    if not isinstance(gateway, str) or str(ipaddress.IPv4Address(gateway)) != gateway:
        raise ValueError("gateway")


def metadata(*, env_id: uuid.UUID, hostname: str, ip_cidr: str | None, gateway: str | None,
             dns_servers: tuple[str, ...]) -> str:
    """A static address with its default route and DNS (the given servers,
    else the gateway), or DHCP (with the given DNS servers, if any). Every
    value is checked first (ValueError)."""
    _checked(hostname=hostname, ip_cidr=ip_cidr, gateway=gateway, dns_servers=dns_servers)
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


# A droplet's host name: "ss-", the environment and the slot (a DNS label).
_DROPLET_HOSTNAME_RE = re.compile(r"ss-[a-z][a-z0-9-]{0,52}[a-z0-9]")


def droplet_userdata(*, hostname: str, ssh_public_key: str, host_key_private: str,
                     host_key_public: str) -> str:
    """A DigitalOcean droplet's user-data (deploy phase 7): the ESXi user-data
    (deploy user, Sirdar's key, the host key Sirdar generated) plus the
    PostgreSQL client step 0 uses to set up the managed database."""
    if not isinstance(hostname, str) or not _DROPLET_HOSTNAME_RE.fullmatch(hostname):
        raise ValueError("hostname")
    doc = yaml.safe_load(userdata(hostname=hostname, ssh_public_key=ssh_public_key,
                                  host_key_private=host_key_private,
                                  host_key_public=host_key_public)
                         .removeprefix("#cloud-config\n"))
    doc["package_update"] = True
    doc["packages"] = ["postgresql-client"]
    return "#cloud-config\n" + yaml.safe_dump(doc, sort_keys=False)
