"""Steps 0 and 15 of a Proxmox environment (phase 5), run in Sirdar like
the publish steps: Prepare VM ("provision"), Restore VM snapshot
("vm_restore") and Destroy VM ("destroy"). Terraform creates, resizes and
destroys the VM (deploy/terraform.py); the Proxmox API (deploy/proxmox.py)
reserves its id, reads its address and SSH host key through the guest
agent, and takes, restores and prunes VM snapshots.

Sirdar manages only the VM its proxmox_vms row names: the id is reserved
and recorded before Terraform runs, and Destroy checks the VM's name and
"sirdar" tag before and its absence after. Every small record (the id,
created, the address, the services' address) is written at once in its own
committed transaction, so a later failure still knows what exists. The
host key comes from the guest agent (over the pinned, authenticated API) and
is then checked against the live SSH server by known_hosts.trust. Failures
raise publish.StepFailed with our own copy."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Protocol

import asyncssh
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, Environment, EnvironmentService, ProxmoxVm
from sirdar_api.deploy import (
    ConnectFailed,
    gitref,
    integrations,
    known_hosts,
    outbound,
    ssh,
    targets,
    terraform,
    vault,
    vms,
)
from sirdar_api.deploy.integrations import IntegrationError, ProxmoxConfig
from sirdar_api.deploy.proxmox import AgentNotReady, Proxmox, ProxmoxError
from sirdar_api.deploy.publish import StepFailed

Output = Callable[[str], None]
HOST_KEY_FILE = "/etc/ssh/ssh_host_ed25519_key.pub"
AGENT_WAIT_SECONDS = 5 * 60
SSH_WAIT_SECONDS = 5 * 60
POLL_SECONDS = 5
TERRAFORM_DIR_UNWRITABLE = ("Sirdar can't write its Terraform folder (SIRDAR_TERRAFORM_DIR). "
                            "It must be owned by uid 10001 with mode 700.")
PINNED_CERTIFICATE_INVALID = ("The pinned Proxmox certificate isn't one valid certificate. "
                              "Trust the server's certificate again in Settings › "
                              "Integrations › Proxmox, then retry.")
TARGETS_UNREADABLE = ("Sirdar can't read the saved SSH targets file, so it can't check that "
                      "the VM's address is free. Fix the file, then retry.")
_REF_REASONS = {
    "ref_not_found": "The repository has no branch, tag or commit named {ref}.",
    "ref_invalid": "{ref} isn't a valid branch, tag or commit.",
    "git_missing": "git isn't installed on the VM.",
    "ref_lookup_failed": "The VM couldn't list the repository's branches and tags.",
}


class VmPrepareError(Exception):
    """The VM steps can't start. `reason` is our own copy."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class VmState:
    """The proxmox_vms row when the run started."""
    vmid: int | None
    name: str
    node: str
    cores: int
    memory_mb: int
    disk_gb: int
    ip_mode: str
    ip_cidr: str | None
    gateway: str | None
    ip: str | None
    ssh_public_key: str
    keep_snapshots: int
    created: bool

    @classmethod
    def of(cls, row: ProxmoxVm) -> "VmState":
        return cls(vmid=row.vmid, name=row.name, node=row.node, cores=row.cores,
                   memory_mb=row.memory_mb, disk_gb=row.disk_gb, ip_mode=row.ip_mode,
                   ip_cidr=row.ip_cidr, gateway=row.gateway, ip=row.ip,
                   ssh_public_key=row.ssh_public_key, keep_snapshots=row.keep_snapshots,
                   created=row.created)

    @property
    def static_ip(self) -> str | None:
        return vms.static_ip(self.ip_cidr)


@dataclass(frozen=True)
class VmContext:
    env_id: uuid.UUID
    env_name: str
    deployment_id: uuid.UUID
    actor_id: uuid.UUID | None
    mode: str
    git_ref: str
    sha: str                       # "" until step 0 resolves git_ref on the VM
    repo_url: str
    take_snapshot: bool
    # The VM snapshot the deployment's chain already took (a retry keeps
    # it), or for vm_restore the one to restore.
    vm_snapshot: str | None
    vm: VmState
    proxmox: ProxmoxConfig = field(repr=False)

    @property
    def secret_values(self) -> list[str]:
        """What the pipeline's redactor must hide."""
        return [self.proxmox.token, self.proxmox.token_secret]


@dataclass(frozen=True)
class VmOutcome:
    sha: str | None = None             # the commit step 0 resolved
    vm_snapshot: str | None = None     # the VM snapshot step 0 took (or kept)


class Provisioner(Protocol):
    async def run(self, step: str, ctx: VmContext, out: Output) -> VmOutcome: ...


async def prepare(db: AsyncSession, env: Environment, dep: Deployment,
                  settings: Settings) -> VmContext:
    try:
        cfg = await integrations.load_proxmox(db, settings)
    except IntegrationError as e:
        raise VmPrepareError(e.reason) from None
    if cfg is None:
        raise VmPrepareError("Proxmox isn't set up. Add it in Settings › Integrations, "
                             "then retry.")
    row = await vms.get(db, env.id)
    if row is None:
        raise VmPrepareError("This environment has no VM record, so Sirdar won't build or "
                             "remove a VM for it.")
    return VmContext(env_id=env.id, env_name=env.name, deployment_id=dep.id,
                     actor_id=dep.actor_id, mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                     repo_url=settings.deploy_repo_url, take_snapshot=dep.take_vm_snapshot,
                     vm_snapshot=dep.vm_snapshot, vm=VmState.of(row), proxmox=cfg)


async def tcp_open(host: str, port: int, timeout: float = 3.0) -> bool:
    """Whether something accepts TCP connections at host:port. Tests guard it."""
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    except (OSError, TimeoutError):
        return False
    writer.close()
    with suppress(Exception):
        await writer.wait_closed()
    return True


async def _set_vm(env_id: uuid.UUID, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(ProxmoxVm).where(ProxmoxVm.environment_id == env_id)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


def _address_taken(ip: str) -> StepFailed:
    return StepFailed(f"The VM came up at {ip}, an address another environment, an SSH "
                      "target, the proxy or Proxmox already uses. Sirdar recorded nothing for "
                      "it: free the address (or fix the DHCP lease), then retry.")


async def _address_free(s: AsyncSession, settings: Settings, env_id: uuid.UUID,
                        ip: str) -> None:
    """Under the address lock (vms.lock_addresses, held until `s`'s
    transaction ends): StepFailed unless `ip` is free for this environment's
    VM."""
    proxy_ip = await s.scalar(select(Environment.proxy_ip).where(Environment.id == env_id))
    await vms.lock_addresses(s)
    try:
        taken = await vms.address_in_use(s, settings, ip, proxy_ip=proxy_ip or "",
                                         env_id=env_id)
    except vms.VmError:
        raise StepFailed(TARGETS_UNREADABLE) from None
    if taken:
        raise _address_taken(ip)


async def _check_address(settings: Settings, env_id: uuid.UUID, ip: str) -> None:
    """Before pinning a key at the address: is it free? (A DHCP lease can
    land on an address in use.)"""
    async with get_sessionmaker()() as s:
        await _address_free(s, settings, env_id, ip)
        await s.rollback()


async def _record_address(settings: Settings, env_id: uuid.UUID, previous: str | None,
                          ip: str) -> bool:
    """Re-check the address under the lock, then write the VM's address and
    point every service at it in the same transaction. True when a service
    moved."""
    async with get_sessionmaker()() as s:
        await _address_free(s, settings, env_id, ip)
        if ip != previous:
            await s.execute(update(ProxmoxVm).where(ProxmoxVm.environment_id == env_id)
                            .values(ip=ip, updated_at=datetime.now(UTC)))
        result = await s.execute(update(EnvironmentService).where(
            EnvironmentService.environment_id == env_id, EnvironmentService.host_ip != ip)
            .values(host_ip=ip))
        await s.commit()
        return result.rowcount > 0


async def _recorded(env_id: uuid.UUID) -> set[str]:
    """Names of the VM snapshots Sirdar took for this environment."""
    async with get_sessionmaker()() as s:
        return set(await s.scalars(select(Deployment.vm_snapshot).where(
            Deployment.environment_id == env_id, Deployment.vm_snapshot.is_not(None),
            Deployment.mode != "vm_restore")))


class ProxmoxProvisioner:
    """The real provisioner. Waits, the clock, the port probe and the ref
    lookup are injectable for tests."""

    STEPS = ("provision", "vm_restore", "destroy")

    def __init__(self, *, terraform_runner: terraform.TerraformRunner, settings: Settings,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 probe: Callable[[str, int], Awaitable[bool]] | None = None,
                 resolve=None, now: Callable[[], datetime] | None = None,
                 agent_wait: int = AGENT_WAIT_SECONDS, ssh_wait: int = SSH_WAIT_SECONDS,
                 poll: int = POLL_SECONDS):
        self._tf = terraform_runner
        self._settings = settings
        self._sleep = sleep
        self._probe = probe
        self._resolve = resolve or gitref.resolve_ref
        self._now = now or (lambda: datetime.now(UTC))
        self._agent_wait = agent_wait
        self._ssh_wait = ssh_wait
        self._poll = poll

    async def run(self, step: str, ctx: VmContext, out: Output) -> VmOutcome:
        if step not in self.STEPS:
            raise ValueError(f"{step!r} isn't a VM step")
        # The VM lives on the node it was made on, whatever the integration says now.
        cfg = replace(ctx.proxmox, node=ctx.vm.node)
        try:
            async with Proxmox(cfg, transport=outbound.transports()["proxmox"],
                               sleep=self._sleep) as api:
                if step == "provision":
                    return await self._provision(api, ctx, out)
                if step == "vm_restore":
                    await self._restore(api, ctx, out)
                else:
                    await self._destroy(api, ctx, out)
                return VmOutcome()
        except ProxmoxError as e:
            raise StepFailed(e.reason) from None

    # ---- Prepare VM --------------------------------------------------------------

    async def _provision(self, api: Proxmox, ctx: VmContext, out: Output) -> VmOutcome:
        vm = ctx.vm
        vmid = vm.vmid
        if vmid is None:
            probe = self._probe or tcp_open
            if vm.static_ip and await probe(vm.static_ip, vms.VM_SSH_PORT):
                raise StepFailed(f"Something already answers SSH at {vm.static_ip}, so Sirdar "
                                 "won't give that address to a new VM. Free it, or delete this "
                                 "environment and create it with another address.")
            vmid = await api.next_vmid()
            await _set_vm(ctx.env_id, vmid=vmid)
            out(f"Reserved VM id {vmid} for {vm.name}.\n")
        elif await self._identify(api, ctx) is None and vm.created:
            raise StepFailed(f"The VM Sirdar made for {ctx.env_name} ({vm.name}, VM {vmid}) is "
                             "gone from Proxmox. Sirdar won't build a new one silently: delete "
                             "the environment, or fix it by hand, then retry.")
        out(f"{'Updating' if vm.created else 'Creating'} {vm.name} ({vm.cores} vCPU, "
            f"{vm.memory_mb // 1024} GB, {vm.disk_gb} GB disk) with Terraform.\n")
        await self._terraform(ctx, vmid, terraform.APPLY, "create or update the VM", out)
        if not vm.created:
            await _set_vm(ctx.env_id, created=True)
        await self._settle_address(api, ctx, vmid, out)
        sha = None if ctx.sha else await self._resolve_ref(ctx, out)
        return VmOutcome(sha=sha, vm_snapshot=await self._snapshot(api, ctx, vmid, out))

    async def _identify(self, api: Proxmox, ctx: VmContext) -> dict | None:
        """VM vm.vmid looked up across the cluster: None when no node has it.
        Proxmox reuses free ids, so a VM there that isn't named vm.name with
        the sirdar tag, or that sits on another node, is refused."""
        vm = ctx.vm
        found = await api.find_vm(vm.vmid)
        if found is None:
            return None
        if found["name"] != vm.name or "sirdar" not in found["tags"]:
            raise StepFailed(f"VM {vm.vmid} on Proxmox isn't {vm.name} any more; Sirdar "
                             "changed nothing.")
        if found["node"] != vm.node:
            raise StepFailed(f"VM {vm.vmid} ({vm.name}) is on node {found['node']} now, not "
                             f"{vm.node}. Sirdar changed nothing: move it back, or fix it by "
                             "hand, then retry.")
        return found

    async def _settle_address(self, api: Proxmox, ctx: VmContext, vmid: int,
                              out: Output) -> None:
        """The guest agent's address: refused at a saved SSH target's or one in
        use, its key pinned, then recorded (re-checked under the lock) on the
        VM and every service."""
        ip = await self._address(api, vmid, ctx.vm, out)
        if any(cfg.host == ip for _, cfg in targets.ssh_configs(self._settings)):
            raise StepFailed(f"{ip} is a saved SSH target's address. Sirdar won't pin a VM's "
                             "key there.")
        await _check_address(self._settings, ctx.env_id, ip)
        made = await self._pin(api, ctx, vmid, ip, out)
        try:
            moved = await _record_address(self._settings, ctx.env_id, ctx.vm.ip, ip)
        except StepFailed:
            if made:                       # don't leave a pin for an address not recorded
                async with get_sessionmaker()() as s:
                    if await known_hosts.forget(s, ip, vms.VM_SSH_PORT, ctx.actor_id,
                                                target_id=f"proxmox:{ctx.env_name}"):
                        await s.commit()
            raise
        if moved:
            out(f"Every service now points at {ip}.\n")

    async def _terraform(self, ctx: VmContext, vmid: int, args: tuple[str, ...], what: str,
                         out: Output) -> None:
        vm, px = ctx.vm, ctx.proxmox
        spec = terraform.VmSpec(
            env_name=ctx.env_name, name=vm.name, vmid=vmid, node=vm.node, pool=px.pool,
            storage=px.storage, bridge=px.bridge, vlan_tag=px.vlan_tag,
            template_vmid=px.template_vmid, cores=vm.cores, memory_mb=vm.memory_mb,
            disk_gb=vm.disk_gb, ip_cidr=vm.ip_cidr, gateway=vm.gateway,
            ssh_public_key=vm.ssh_public_key)
        try:
            work = await asyncio.to_thread(terraform.prepare_workdir, self._settings,
                                           ctx.env_id, terraform.render_config(px.url, spec),
                                           px.tls_cert_pem)
        except terraform.TerraformDirUnwritable:
            raise StepFailed(TERRAFORM_DIR_UNWRITABLE) from None
        except terraform.PinnedCertificateInvalid:
            raise StepFailed(PINNED_CERTIFICATE_INVALID) from None
        env = terraform.run_env(self._settings, work, px.token)
        runs = [(terraform.INIT, "set up Terraform")] if terraform.needs_init(work) else []
        runs.append((args, what))
        for command, doing in runs:
            result = await self._tf.run(terraform.TfRequest(
                args=command, workdir=work, env=env, timeout=terraform.APPLY_TIMEOUT), out)
            if result.status == "timeout":
                raise StepFailed(f"Terraform didn't {doing} in "
                                 f"{terraform.APPLY_TIMEOUT // 60} minutes.")
            if result.status != "successful":
                raise StepFailed(f"Terraform couldn't {doing}. See the log above.")

    async def _address(self, api: Proxmox, vmid: int, vm: VmState, out: Output) -> str:
        out("Waiting for the VM's guest agent to report its address.\n")
        ips: list[str] = []
        for _ in range(max(1, self._agent_wait // self._poll)):
            try:
                ips = await api.agent_ipv4(vmid)
            except AgentNotReady:
                ips = []
            if vm.static_ip and vm.static_ip in ips:
                out(f"The VM answers at {vm.static_ip}.\n")
                return vm.static_ip
            if not vm.static_ip and ips:
                out(f"DHCP gave the VM {ips[0]}.\n")
                return ips[0]
            await self._sleep(self._poll)
        if vm.static_ip and ips:
            raise StepFailed(f"The VM came up at {', '.join(ips)}, not {vm.static_ip}. Check "
                             "the template's cloud-init settings.")
        raise StepFailed(f"The VM's guest agent didn't report an address in "
                         f"{self._agent_wait // 60} minutes. Is qemu-guest-agent installed in "
                         "the template?")

    async def _pin(self, api: Proxmox, ctx: VmContext, vmid: int, ip: str,
                   out: Output) -> bool:
        """Read the host key through the guest agent, then pin it with
        known_hosts.trust (which re-reads the live key and refuses a
        mismatch). The caller has refused a saved SSH target's address.
        True when this run made the pin (there was none before)."""
        port = vms.VM_SSH_PORT
        tries = max(1, self._ssh_wait // self._poll)
        line = ""
        for _ in range(tries):
            try:
                line = (await api.agent_file(vmid, HOST_KEY_FILE)).strip()
            except AgentNotReady:
                line = ""
            if line:
                break
            await self._sleep(self._poll)
        try:
            expected = known_hosts.fingerprint(asyncssh.import_public_key(line))
        except (asyncssh.KeyImportError, ValueError):
            raise StepFailed("The VM's SSH host key, read through its guest agent, isn't a key "
                             "Sirdar can use.") from None
        mismatch = StepFailed("The VM's live SSH key doesn't match the one its guest agent "
                              "reports. Sirdar pinned nothing.")
        for _ in range(tries):
            async with get_sessionmaker()() as s:
                stored = await known_hosts.lookup(s, ip, port)
                try:
                    if stored is not None and stored.fingerprint_sha256 == expected:
                        await ssh.pinned_host_key(s, ip, port)
                        out(f"SSH host key {expected} is pinned.\n")
                        return False
                    await known_hosts.trust(s, ip, port, expected, ctx.actor_id,
                                            target_id=f"proxmox:{ctx.env_name}")
                    await s.commit()
                    changed = " (it changed)" if stored is not None else ""
                    out(f"Pinned {ip}'s SSH host key {expected}, read through the guest "
                        f"agent{changed}.\n")
                    return stored is None
                except (known_hosts.HostKeyChanged, ssh.HostKeyMismatch):
                    raise mismatch from None
                except ConnectFailed:
                    pass                                  # SSH isn't up yet
            await self._sleep(self._poll)
        raise StepFailed(f"The VM didn't answer SSH at {ip} in {self._ssh_wait // 60} minutes.")

    async def _resolve_ref(self, ctx: VmContext, out: Output) -> str:
        async with get_sessionmaker()() as s:
            env = await s.get(Environment, ctx.env_id)
            try:
                cfg = await vms.host_config(s, self._settings, env)
            except (vault.SecretsKeyMissing, vault.SecretUnreadable):
                raise StepFailed("Sirdar can't read the VM's SSH key. Is SIRDAR_SECRETS_KEY the "
                                 "one it was made with?") from None
            if cfg is None:
                raise StepFailed("The VM has no recorded address yet. Retry from step 0.")
            try:
                sha = await self._resolve(cfg, s, ctx.repo_url, ctx.git_ref)
            except gitref.RefError as e:
                reason = _REF_REASONS.get(e.code, _REF_REASONS["ref_lookup_failed"])
                raise StepFailed(reason.format(ref=ctx.git_ref)) from None
            except ConnectFailed as e:
                raise StepFailed(e.reason) from None
            except (ssh.HostKeyUnknown, ssh.HostKeyMismatch):
                raise StepFailed("The VM's SSH host key changed while Sirdar was resolving the "
                                 "ref. Retry from step 0.") from None
        out(f"{ctx.git_ref} is {sha}.\n")
        return sha

    async def _snapshot(self, api: Proxmox, ctx: VmContext, vmid: int,
                        out: Output) -> str | None:
        if ctx.vm_snapshot:
            out(f"Keeping the VM snapshot from the first attempt: {ctx.vm_snapshot}\n")
            return ctx.vm_snapshot
        if not ctx.take_snapshot:
            return None
        name = vms.snapshot_name(self._now())
        await api.take_snapshot(vmid, name, f"Sirdar: before {ctx.mode} of {ctx.env_name} "
                                            f"(deployment {ctx.deployment_id})")
        out(f"Took VM snapshot {name}.\n")
        keep = await _recorded(ctx.env_id) | {name}
        # Only the sirdar-* snapshots Sirdar's deployments recorded: a snapshot
        # made by hand is never pruned, whatever its name.
        ours = sorted((s["name"] for s in await api.snapshots(vmid)
                       if s.get("name") in keep and vms.valid_snapshot_name(s["name"])),
                      reverse=True)
        for old in ours[ctx.vm.keep_snapshots:]:
            await api.delete_snapshot(vmid, old)
            out(f"Deleted the old VM snapshot {old} (keeping the newest "
                f"{ctx.vm.keep_snapshots}).\n")
        return name

    # ---- Restore VM snapshot -------------------------------------------------------

    async def _restore(self, api: Proxmox, ctx: VmContext, out: Output) -> None:
        vm, name = ctx.vm, ctx.vm_snapshot
        if vm.vmid is None or not vm.created:
            raise StepFailed("This environment has no VM yet.")
        if not vms.valid_snapshot_name(name):
            raise StepFailed(f"{name} isn't a VM snapshot Sirdar takes.")
        if name not in await _recorded(ctx.env_id):
            raise StepFailed(f"Sirdar didn't take the VM snapshot {name} for {ctx.env_name}, "
                             "so it won't restore it.")
        if await self._identify(api, ctx) is None:
            raise StepFailed(f"VM {vm.vmid} ({vm.name}) is gone from Proxmox.")
        if name not in {s.get("name") for s in await api.snapshots(vm.vmid)}:
            raise StepFailed(f"The VM snapshot {name} is gone from Proxmox.")
        out(f"Rolling {vm.name} back to {name}.\n")
        await api.rollback(vm.vmid, name)
        if await api.status(vm.vmid) != "running":
            await api.start(vm.vmid)
            out("Started the VM.\n")
        await self._settle_address(api, ctx, vm.vmid, out)
        out(f"{vm.name} is back at {name}; Docker starts its containers.\n")

    # ---- Destroy VM ----------------------------------------------------------------

    async def _destroy(self, api: Proxmox, ctx: VmContext, out: Output) -> None:
        vm = ctx.vm
        if vm.vmid is None:
            out(f"Sirdar never created a VM for {ctx.env_name}.\n")
        else:
            found = await api.find_vm(vm.vmid)
            if found is None:
                out(f"VM {vm.vmid} ({vm.name}) is already gone.\n")
            else:
                if found["name"] != vm.name:
                    raise StepFailed(f"VM {vm.vmid} is {found['name'] or 'unnamed'}, not the "
                                     f"{vm.name} Sirdar made. Sirdar changed nothing.")
                if "sirdar" not in found["tags"]:
                    raise StepFailed(f"VM {vm.vmid} ({vm.name}) has no sirdar tag, so it isn't "
                                     "the VM Sirdar made. Sirdar changed nothing.")
                if found["node"] != vm.node:
                    raise StepFailed(f"VM {vm.vmid} ({vm.name}) is on node {found['node']} now, "
                                     f"not {vm.node}. Sirdar changed nothing: move it back, or "
                                     "fix it by hand, then retry.")
                if not terraform.has_state(terraform.workdir(self._settings, ctx.env_id)):
                    raise StepFailed(f"Sirdar's Terraform state for {vm.name} is missing, so it "
                                     f"won't remove VM {vm.vmid}. Remove the VM by hand in "
                                     "Proxmox, then retry.")
                out(f"Destroying {vm.name} (VM {vm.vmid}) and its VM snapshots with "
                    "Terraform.\n")
                await self._terraform(ctx, vm.vmid, terraform.DESTROY, "destroy the VM", out)
                if await api.find_vm(vm.vmid) is not None:
                    raise StepFailed(f"VM {vm.vmid} is still there after Terraform's destroy. "
                                     "Remove it by hand in Proxmox, then retry.")
                out(f"Destroyed {vm.name}.\n")
            if vm.ip:
                async with get_sessionmaker()() as s:
                    if await known_hosts.forget(s, vm.ip, vms.VM_SSH_PORT, ctx.actor_id,
                                                target_id=f"proxmox:{ctx.env_name}"):
                        await s.commit()
                        out(f"Forgot {vm.ip}'s SSH host key.\n")
        await asyncio.to_thread(terraform.remove_workdir, self._settings, ctx.env_id)
