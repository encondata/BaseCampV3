"""The VMs Sirdar builds for environments, on Proxmox (phase 5) or ESXi
(phase 6). The proxmox_vms or esxi_vms row is both the VM's settings and
the record that it is Sirdar's: sizing and network checks, the
per-environment SSH key pair (private half encrypted with
SIRDAR_SECRETS_KEY), address checks that keep a new VM off addresses in
use, the VM's SSH connection for the deploy steps, and VM snapshot names.
Callers audit and commit."""

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
from sirdar_api.db.models import (Deployment, Environment, EnvironmentService, EsxiVm,
                                  ProxmoxVm)
from sirdar_api.deploy import integrations, targets, vault
from sirdar_api.deploy.ssh import SshTargetConfig

PROXMOX_TARGET = targets.PROXMOX_TARGET
ESXI_TARGET = targets.ESXI_TARGET
MODELS: dict[str, type[ProxmoxVm] | type[EsxiVm]] = {PROXMOX_TARGET: ProxmoxVm,
                                                     ESXI_TARGET: EsxiVm}
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


# A VM row's role (migration 0012): the one VM of a single-server
# environment is `main`; a LAN Blue/Green environment has a data VM and two
# app VMs, one per slot.
MAIN, DATA = "main", "data"
APP_SLOTS = ("orange", "purple")
ROLES = (MAIN, DATA, *APP_SLOTS)


def vm_name(env_name: str, role: str = MAIN) -> str:
    return f"ss-{env_name}" if role == MAIN else f"ss-{env_name}-{role}"


# A VM's name is its guest host name too (cloud-init's local-hostname): "ss-",
# an environment name (names.CUSTOM_NAME_RE) and, for a Blue/Green VM,
# "-data" / "-orange" / "-purple"; never ending in "-".
_VM_NAME_RE = re.compile(r"ss-[a-z][a-z0-9-]{0,52}[a-z0-9]")


def check_vm_hostname(name) -> str:
    """The VM name as a host name, checked before it reaches cloud-init."""
    if not isinstance(name, str) or not _VM_NAME_RE.fullmatch(name):
        raise VmError("vm_name_invalid")
    return name


def check_dns_servers(value) -> list[str]:
    """The integration's DNS servers, checked again before they are frozen
    into a VM row (and from there into cloud-init's metadata): only a list
    of up to integrations.MAX_DNS_SERVERS plain IPv4 addresses."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise VmError("dns_servers_invalid")
    try:
        found = integrations.check_dns_servers(value)
    except integrations.IntegrationError:
        raise VmError("dns_servers_invalid") from None
    if found != value:                  # stored values are already canonical
        raise VmError("dns_servers_invalid")
    return found


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


def new_host_keypair(env_name: str) -> tuple[str, str]:
    """(private, public) OpenSSH ed25519 host key for an ESXi VM: delivered by
    cloud-init, so its fingerprint is known before the VM first boots. Tests
    replace this to hand in their SSH server's key."""
    key = asyncssh.generate_private_key("ssh-ed25519", comment=f"root@{vm_name(env_name)}")
    return (key.export_private_key("openssh").decode(),
            key.export_public_key("openssh").decode().strip())


async def get(db: AsyncSession, env_id, role: str = MAIN) -> ProxmoxVm | None:
    return await db.get(ProxmoxVm, (env_id, role), populate_existing=True)


async def get_for(db: AsyncSession, env: Environment,
                  role: str = MAIN) -> ProxmoxVm | EsxiVm | None:
    """The VM row with this role of a VM environment (by its target), None
    otherwise."""
    model = MODELS.get(env.target_id)
    if model is None:
        return None
    return await db.get(model, (env.id, role), populate_existing=True)


async def machines(db: AsyncSession, env: Environment) -> list[ProxmoxVm | EsxiVm]:
    """Every VM row of a VM environment, in ROLES order."""
    model = MODELS.get(env.target_id)
    if model is None:
        return []
    rows = list(await db.scalars(select(model).where(model.environment_id == env.id)
                                 .execution_options(populate_existing=True)))
    return sorted(rows, key=lambda r: ROLES.index(r.role))


def stage(vm: ProxmoxVm | EsxiVm) -> str:
    """none: no VM yet; partial: one exists (or its id is reserved) but the
    first build didn't finish; built."""
    started = vm.instance_uuid if isinstance(vm, EsxiVm) else vm.vmid
    if started is None:
        return "none"
    return "built" if vm.created else "partial"


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
                         env_id=None, role: str | None = None) -> bool:
    """The proxy's address, any environment's proxy, every SSH target's host
    (uat's VM among them; names resolved), both VM hosts (Proxmox and ESXi),
    another environment's service address, or another VM's address. With
    `role`, this environment's other VMs (a Blue/Green environment's) count
    as taken too; only the VM with that role is the caller's own. Raises
    VmError("ssh_targets_unreadable"). Call lock_addresses first."""
    hosts = _target_hosts(settings)
    for kind in targets.VM_TARGETS:
        url = (await integrations.config_of(db, kind)).get("url")
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
    if env_id is not None:
        services = services.where(EnvironmentService.environment_id != env_id)
    if ip in set(await db.scalars(services)):
        return True
    for model in (ProxmoxVm, EsxiVm):
        machines_q = select(model.ip, model.ip_cidr)
        if env_id is not None:
            mine = model.environment_id == env_id
            # a Blue/Green environment's other VMs hold their addresses too
            machines_q = machines_q.where(~mine if role is None
                                          else ~(mine & (model.role == role)))
        if any(ip in (vm_ip, static_ip(cidr)) for vm_ip, cidr in await db.execute(machines_q)):
            return True
    return False


async def add(db: AsyncSession, settings: Settings, env: Environment, spec: dict,
              proxmox: dict, *, role: str = MAIN) -> ProxmoxVm:
    """`proxmox`: the integration's stored settings. The node and the clone
    inputs (template, storage, pool, bridge, VLAN) are frozen into the row:
    the VM keeps them whatever the integration says later."""
    private, public_key = new_keypair(env.name)
    vlan = proxmox.get("vlan_tag")
    vm = ProxmoxVm(environment_id=env.id, role=role, node=proxmox["node"],
                   template_vmid=int(proxmox["template_vmid"]), storage=proxmox["storage"],
                   pool=proxmox["pool"], bridge=proxmox["bridge"],
                   vlan_tag=None if vlan is None else int(vlan), name=vm_name(env.name, role),
                   cores=spec["cores"], memory_mb=spec["memory_mb"], disk_gb=spec["disk_gb"],
                   ip_mode=spec["ip_mode"], ip_cidr=spec["ip_cidr"], gateway=spec["gateway"],
                   ip=None, ssh_public_key=public_key,
                   ssh_private_key_enc=vault.encrypt(settings, private),
                   keep_snapshots=KEEP_SNAPSHOTS)
    db.add(vm)
    await db.flush()
    return vm


async def add_esxi(db: AsyncSession, settings: Settings, env: Environment, spec: dict,
                   esxi: dict, *, role: str = MAIN) -> EsxiVm:
    """`esxi`: the integration's stored settings. Where the VM is built (the
    host, datastore, port group, pool, seed VM and DNS servers) is frozen
    into the row. Two key pairs: Sirdar's SSH key for the deploy user, and
    the VM's own host key (private half kept only until step 0 delivers it).
    The host name and DNS servers, which reach cloud-init's metadata, are
    checked here first: VmError("vm_name_invalid" | "dns_servers_invalid")."""
    name = check_vm_hostname(vm_name(env.name, role))
    dns = check_dns_servers(esxi.get("dns_servers"))
    private, public_key = new_keypair(env.name)
    host_private, host_public = new_host_keypair(env.name)
    vm = EsxiVm(environment_id=env.id, role=role, name=name,
                host=urlsplit(esxi["url"]).hostname or "", datastore=esxi["datastore"],
                network=esxi["network"], resource_pool=esxi.get("resource_pool"),
                source_vm=esxi["source_vm"], dns_servers=dns,
                cores=spec["cores"], memory_mb=spec["memory_mb"], disk_gb=spec["disk_gb"],
                ip_mode=spec["ip_mode"], ip_cidr=spec["ip_cidr"], gateway=spec["gateway"],
                ip=None, ssh_public_key=public_key,
                ssh_private_key_enc=vault.encrypt(settings, private),
                host_key_public=host_public,
                host_key_private_enc=vault.encrypt(settings, host_private),
                keep_snapshots=KEEP_SNAPSHOTS)
    db.add(vm)
    await db.flush()
    return vm


async def host_config(db: AsyncSession, settings: Settings, env: Environment, *,
                      slot: str | None = None,
                      role: str | None = None) -> SshTargetConfig | None:
    """The SSH connection the deploy steps use: a saved target's, for a VM
    environment the VM's (a Blue/Green one: `role`, else the slot's: `slot`,
    else the active slot, else the first; None until step 0 has read its
    address), and for
    a DigitalOcean environment the slot's droplet (default: the active
    slot). Keys are decrypted here: vault.SecretsKeyMissing or
    vault.SecretUnreadable propagate."""
    if env.target_id == targets.DO_TARGET:
        from sirdar_api.deploy import do_envs           # do_envs imports vms
        return await do_envs.host_config(db, settings, env, slot)
    if not targets.is_vm_target(env.target_id):
        return targets.ssh_config_for(env.target_id, settings)
    if role is None:
        role = (slot or env.active_slot or env.slots[0]) if env.slots else MAIN
    vm = await get_for(db, env, role)
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


async def update(db: AsyncSession, vm: ProxmoxVm | EsxiVm, fields: dict) -> list[str]:
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


def public(vm: ProxmoxVm | EsxiVm) -> dict:
    common = {"stage": stage(vm), "name": vm.name, "cores": vm.cores,
              "memory_mb": vm.memory_mb, "disk_gb": vm.disk_gb, "ip_mode": vm.ip_mode,
              "ip_cidr": vm.ip_cidr, "gateway": vm.gateway, "ip": vm.ip,
              "keep_snapshots": vm.keep_snapshots, "created": vm.created,
              "role": vm.role}
    if isinstance(vm, EsxiVm):
        return {"kind": "esxi", **common, "host": vm.host, "node": None, "vmid": None,
                "moref": vm.moref}
    return {"kind": "proxmox", **common, "host": vm.node, "node": vm.node, "vmid": vm.vmid,
            "moref": None}
