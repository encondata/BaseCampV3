"""Proxmox VMs Sirdar builds for environments (phase 5). The proxmox_vms
row is both the VM's settings and the record that it is Sirdar's: sizing
and network checks, the per-environment SSH key pair (private half
encrypted with SIRDAR_SECRETS_KEY), address checks that keep a new VM off
addresses in use, the VM's SSH connection for the deploy steps, and VM
snapshot names. Callers audit and commit."""

import asyncio
import ipaddress
import re
import socket
from datetime import UTC, datetime
from urllib.parse import urlsplit

import asyncssh
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Deployment, Environment, EnvironmentService, ProxmoxVm
from sirdar_api.deploy import integrations, targets, vault
from sirdar_api.deploy.ssh import SshTargetConfig

PROXMOX_TARGET = targets.PROXMOX_TARGET
VM_USER = "deploy"                 # cloud-init's user: passwordless sudo on Ubuntu cloud images
VM_SSH_PORT = 22                   # read at call time; tests point it at their SSH server
DEFAULTS = {"cores": 4, "memory_mb": 8192, "disk_gb": 64}
KEEP_SNAPSHOTS = 3
LIMITS = {"cores": (1, 64), "memory_mb": (2048, 262144), "disk_gb": (20, 4096),
          "keep_snapshots": (1, 10)}
_CODES = {"cores": "vm_cores_invalid", "memory_mb": "vm_memory_invalid",
          "disk_gb": "vm_disk_invalid", "keep_snapshots": "vm_keep_snapshots_invalid"}
# Loopback VM addresses are refused; tests turn this on so their own SSH
# server on 127.0.0.1 can play the VM.
ALLOW_LOOPBACK = False
RESOLVE_TIMEOUT = 2.0              # seconds per host name looked up by address_in_use
# pg_advisory_xact_lock key that serializes address checks with the rows they
# guard (create, and anything that changes a VM's address), until commit.
ADDRESS_LOCK_KEY = 0x53495244_41444452        # "SIRDADDR"
SNAPSHOT_RE = re.compile(r"sirdar-[0-9]{8}T[0-9]{6}Z")
_SNAPSHOT_FORMAT = "sirdar-%Y%m%dT%H%M%SZ"


class VmError(Exception):
    """A validation failure; `code` is the API error code."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def vm_name(env_name: str) -> str:
    return f"ss-{env_name}"


def check_size(key: str, value) -> int:
    low, high = LIMITS[key]
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise VmError(_CODES[key])
    return value


def check_network(ip_mode, ip_cidr, gateway) -> tuple[str, str | None, str | None]:
    """("dhcp", None, None) or ("static", "a.b.c.d/nn", "gateway"). The
    address needs its prefix (8–30) and can't be the network's own or
    broadcast address; the gateway must be another address in it."""
    if ip_mode == "dhcp":
        if ip_cidr not in (None, ""):       # DHCP picks the address: don't drop one silently
            raise VmError("vm_ip_invalid")
        if gateway not in (None, ""):
            raise VmError("vm_gateway_invalid")
        return "dhcp", None, None
    if ip_mode != "static":
        raise VmError("vm_ip_mode_invalid")
    try:
        iface = ipaddress.IPv4Interface(str(ip_cidr or "").strip())
    except ValueError:
        raise VmError("vm_ip_invalid") from None
    net, ip = iface.network, iface.ip
    if (not 8 <= net.prefixlen <= 30
            or ip in (net.network_address, net.broadcast_address)
            or ip.is_multicast or ip.is_link_local or ip.is_unspecified or ip.is_reserved
            or (ip.is_loopback and not ALLOW_LOOPBACK)
            or (ip in ipaddress.IPv4Network("0.0.0.0/8"))):
        raise VmError("vm_ip_invalid")
    try:
        gw = ipaddress.IPv4Address(str(gateway or "").strip())
    except ValueError:
        raise VmError("vm_gateway_invalid") from None
    if gw not in net or gw in (ip, net.network_address, net.broadcast_address):
        raise VmError("vm_gateway_invalid")
    return "static", str(iface), str(gw)


def static_ip(ip_cidr: str | None) -> str | None:
    return str(ipaddress.IPv4Interface(ip_cidr).ip) if ip_cidr else None


def check_spec(fields: dict) -> dict:
    if not isinstance(fields, dict):
        raise VmError("vm_invalid")
    sizes = {key: check_size(key, fields[key] if fields.get(key) is not None else default)
             for key, default in DEFAULTS.items()}
    mode, cidr, gateway = check_network(fields.get("ip_mode"), fields.get("ip_cidr"),
                                        fields.get("gateway"))
    return {**sizes, "ip_mode": mode, "ip_cidr": cidr, "gateway": gateway}


def new_keypair(env_name: str) -> tuple[str, str]:
    """(private, public) OpenSSH ed25519 keys for one VM."""
    key = asyncssh.generate_private_key("ssh-ed25519", comment=f"sirdar@{vm_name(env_name)}")
    return (key.export_private_key("openssh").decode(),
            key.export_public_key("openssh").decode().strip())


async def get(db: AsyncSession, env_id) -> ProxmoxVm | None:
    return await db.get(ProxmoxVm, env_id, populate_existing=True)


async def lock_addresses(db: AsyncSession) -> None:
    """Serialize address checks until this transaction ends: take it before
    address_in_use and keep it through the insert or update, so two creates
    can't both see an address free."""
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ADDRESS_LOCK_KEY})


async def resolve_host(host: str) -> set[str]:
    """The IPv4 addresses a target's host names (itself for an address);
    empty when it doesn't resolve within RESOLVE_TIMEOUT. Tests replace it."""
    try:
        return {str(ipaddress.IPv4Address(host))}
    except ValueError:
        pass
    try:
        found = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(host, None, family=socket.AF_INET,
                                                   type=socket.SOCK_STREAM),
            RESOLVE_TIMEOUT)
    except (OSError, TimeoutError, UnicodeError):
        return set()
    return {info[4][0] for info in found or ()}


def _target_hosts(settings: Settings) -> set[str]:
    """Every SSH target's host, configured or not: the installer's and each
    saved one. A targets file that exists but can't be read refuses (uat's
    host might be in it)."""
    hosts = {settings.deploy_ssh_host.strip()}
    try:
        saved = targets.ssh_store(settings).load()
    except (OSError, UnicodeDecodeError):
        raise VmError("ssh_targets_unreadable") from None
    hosts |= {t.host.strip() for t in saved}
    return {h for h in hosts if h}


async def address_in_use(db: AsyncSession, settings: Settings, ip: str, *, proxy_ip: str,
                         env_id=None) -> bool:
    """The proxy's address, any environment's proxy, every SSH target's host
    (uat's VM among them; names resolved), the Proxmox host, another
    environment's service address, or another VM's address. Raises
    VmError("ssh_targets_unreadable"). Call lock_addresses first."""
    hosts = _target_hosts(settings)
    url = (await integrations.config_of(db, "proxmox")).get("url")
    if url:
        hosts.add(urlsplit(url).hostname or "")
    refused = {proxy_ip, *(h.lower() for h in hosts)}
    for host in hosts:
        try:
            refused |= await resolve_host(host)
        except (OSError, TimeoutError, UnicodeError):
            pass                         # an unresolvable name is still compared as text
    refused |= set(await db.scalars(select(Environment.proxy_ip)))
    if ip in refused:
        return True
    services = select(EnvironmentService.host_ip)
    machines = select(ProxmoxVm.ip, ProxmoxVm.ip_cidr)
    if env_id is not None:
        services = services.where(EnvironmentService.environment_id != env_id)
        machines = machines.where(ProxmoxVm.environment_id != env_id)
    if ip in set(await db.scalars(services)):
        return True
    return any(ip in (vm_ip, static_ip(cidr)) for vm_ip, cidr in await db.execute(machines))


async def add(db: AsyncSession, settings: Settings, env: Environment, spec: dict,
              node: str) -> ProxmoxVm:
    private, public_key = new_keypair(env.name)
    vm = ProxmoxVm(environment_id=env.id, node=node, name=vm_name(env.name),
                   cores=spec["cores"], memory_mb=spec["memory_mb"], disk_gb=spec["disk_gb"],
                   ip_mode=spec["ip_mode"], ip_cidr=spec["ip_cidr"], gateway=spec["gateway"],
                   ip=None, ssh_public_key=public_key,
                   ssh_private_key_enc=vault.encrypt(settings, private),
                   keep_snapshots=KEEP_SNAPSHOTS)
    db.add(vm)
    await db.flush()
    return vm


async def host_config(db: AsyncSession, settings: Settings,
                      env: Environment) -> SshTargetConfig | None:
    """The SSH connection the deploy steps use: a saved target's, or for a
    Proxmox environment the VM's (None until step 0 has read its address).
    The VM's key is decrypted here: vault.SecretsKeyMissing or
    vault.SecretUnreadable propagate."""
    if env.target_id != PROXMOX_TARGET:
        return targets.ssh_config_for(env.target_id, settings)
    vm = await get(db, env.id)
    if vm is None or not vm.ip:
        return None
    return SshTargetConfig(host=vm.ip, port=VM_SSH_PORT, user=VM_USER,
                           private_key=vault.decrypt(settings, vm.ssh_private_key_enc),
                           key_name=f"Sirdar's key for {vm.name}")


def snapshot_name(now: datetime) -> str:
    return now.astimezone(UTC).strftime(_SNAPSHOT_FORMAT)


def snapshot_taken_at(name: str) -> datetime:
    return datetime.strptime(name, _SNAPSHOT_FORMAT).replace(tzinfo=UTC)


def valid_snapshot_name(name: str) -> bool:
    if not isinstance(name, str) or not SNAPSHOT_RE.fullmatch(name):
        return False
    try:
        snapshot_taken_at(name)
    except ValueError:
        return False
    return True


def snapshot_blocked(name: str, changed_at: datetime | None) -> str | None:
    """Why a VM snapshot can't be restored (environments.backup_blocked's
    rule): taken at or before a snapshot restore replaced the sign-in keys,
    its .env holds keys that exist nowhere any more."""
    if changed_at is None or snapshot_taken_at(name) > changed_at:
        return None
    when = changed_at.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")
    return f"Taken before the sign-in keys changed (snapshot restore on {when})."


async def taking_deployments(db: AsyncSession, env_id) -> dict[str, Deployment]:
    """VM snapshot name -> the first deployment that took it (its retries
    carry the same name; a vm_restore names the one it restores)."""
    rows = await db.scalars(select(Deployment).where(
        Deployment.environment_id == env_id, Deployment.vm_snapshot.is_not(None),
        Deployment.mode != "vm_restore").order_by(Deployment.created_at))
    found: dict[str, Deployment] = {}
    for dep in rows:
        found.setdefault(dep.vm_snapshot, dep)
    return found


async def update(db: AsyncSession, vm: ProxmoxVm, fields: dict) -> list[str]:
    """A PATCH's `vm`: sizes and how many VM snapshots to keep (the next
    deploy's step 0 applies the sizes). A disk never shrinks."""
    if not isinstance(fields, dict):
        raise VmError("vm_invalid")
    changed: list[str] = []
    for key in ("cores", "memory_mb", "disk_gb", "keep_snapshots"):
        if fields.get(key) is None:
            continue
        value = check_size(key, fields[key])
        if key == "disk_gb" and value < vm.disk_gb:
            raise VmError("vm_disk_shrink")
        if getattr(vm, key) != value:
            setattr(vm, key, value)
            changed.append(f"vm.{key}")
    if changed:
        vm.updated_at = datetime.now(UTC)
    await db.flush()
    return changed


def public(vm: ProxmoxVm) -> dict:
    return {"name": vm.name, "node": vm.node, "vmid": vm.vmid, "cores": vm.cores,
            "memory_mb": vm.memory_mb, "disk_gb": vm.disk_gb, "ip_mode": vm.ip_mode,
            "ip_cidr": vm.ip_cidr, "gateway": vm.gateway, "ip": vm.ip,
            "keep_snapshots": vm.keep_snapshots, "created": vm.created}
