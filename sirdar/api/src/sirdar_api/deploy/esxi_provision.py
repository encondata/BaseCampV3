"""Steps 0 and 15 of an ESXi environment (deploy phase 6), run in Sirdar:
Prepare VM ("provision"), Restore VM snapshot ("vm_restore") and Destroy VM
("destroy"), on a standalone ESXi host through esxi.connect.

Sirdar manages only the VM its esxi_vms row names, identified by instance
UUID, name and the sirdar.environment extraConfig marker together. The
marker is written with the VM itself and the VM is recorded the moment ESXi
creates it, so a later failure (or a lost record: the marker finds it again)
still knows what exists.

The VM's SSH host key is one Sirdar generated and delivered through
cloud-init. known_hosts.trust checks it against the live server; then the
user-data holding its private half is scrubbed from the VM's settings and
from esxi_vms. Failures raise publish.StepFailed with our own copy."""

import asyncio
import uuid
from collections import Counter
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime

import asyncssh
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Deployment, Environment, EsxiVm
from sirdar_api.deploy import (
    cloudinit,
    esxi,
    gitref,
    integrations,
    known_hosts,
    vault,
    vmcommon,
    vms,
)
from sirdar_api.deploy.esxi import EsxiApi, EsxiError, QuiesceFailed, SnapshotInfo, VmInfo
from sirdar_api.deploy.integrations import EsxiConfig, IntegrationError
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.vmcommon import Output, VmOutcome, VmPrepareError

TOOLS_WAIT_SECONDS = 5 * 60
SSH_WAIT_SECONDS = 5 * 60
SHUTDOWN_WAIT_SECONDS = 5 * 60
POLL_SECONDS = 5
SNAPSHOT_GRACE_SECONDS = 15
HOST_LABEL = "ESXi"


@dataclass(frozen=True)
class EsxiVmState:
    """The esxi_vms row when the run started (the host key's private half
    decrypted, only while it hasn't been delivered)."""
    name: str
    host: str
    datastore: str
    network: str
    resource_pool: str | None
    source_vm: str
    dns_servers: tuple[str, ...]
    moref: str | None
    instance_uuid: str | None
    vm_path: str | None
    cores: int
    memory_mb: int
    disk_gb: int
    ip_mode: str
    ip_cidr: str | None
    gateway: str | None
    ip: str | None
    ssh_public_key: str
    host_key_public: str
    keep_snapshots: int
    created: bool
    host_key_private: str | None = field(default=None, repr=False)

    @classmethod
    def of(cls, row: EsxiVm, host_key_private: str | None) -> "EsxiVmState":
        return cls(name=row.name, host=row.host, datastore=row.datastore, network=row.network,
                   resource_pool=row.resource_pool, source_vm=row.source_vm,
                   dns_servers=tuple(row.dns_servers or ()), moref=row.moref,
                   instance_uuid=row.instance_uuid, vm_path=row.vm_path, cores=row.cores,
                   memory_mb=row.memory_mb, disk_gb=row.disk_gb, ip_mode=row.ip_mode,
                   ip_cidr=row.ip_cidr, gateway=row.gateway, ip=row.ip,
                   ssh_public_key=row.ssh_public_key, host_key_public=row.host_key_public,
                   keep_snapshots=row.keep_snapshots, created=row.created,
                   host_key_private=host_key_private)

    @property
    def static_ip(self) -> str | None:
        return vms.static_ip(self.ip_cidr)

    @property
    def host_fingerprint(self) -> str:
        return known_hosts.fingerprint(asyncssh.import_public_key(self.host_key_public))


@dataclass(frozen=True)
class EsxiVmContext:
    env_id: uuid.UUID
    env_name: str
    deployment_id: uuid.UUID
    actor_id: uuid.UUID | None
    mode: str
    git_ref: str
    sha: str                       # "" until step 0 resolves git_ref on the VM
    repo_url: str
    take_snapshot: bool
    vm_snapshot: str | None
    vm: EsxiVmState
    esxi: EsxiConfig = field(repr=False)

    @property
    def secret_values(self) -> list[str]:
        """What the pipeline's redactor must hide."""
        return [v for v in (self.esxi.password, self.vm.host_key_private) if v]


async def prepare(db: AsyncSession, env: Environment, dep: Deployment,
                  settings: Settings) -> EsxiVmContext:
    try:
        cfg = await integrations.load_esxi(db, settings)
    except IntegrationError as e:
        raise VmPrepareError(e.reason) from None
    if cfg is None:
        raise VmPrepareError("VMware ESXi isn't set up. Add it in Settings › Integrations, "
                             "then retry.")
    row = await vms.get_for(db, env)
    if not isinstance(row, EsxiVm):
        raise VmPrepareError("This environment has no VM record, so Sirdar won't build or "
                             "remove a VM for it.")
    private = None
    if row.host_key_private_enc is not None:
        try:
            private = vault.decrypt(settings, row.host_key_private_enc)
        except (vault.SecretsKeyMissing, vault.SecretUnreadable):
            raise VmPrepareError("Sirdar can't read the VM's host key with the current "
                                 "SIRDAR_SECRETS_KEY.") from None
    return EsxiVmContext(env_id=env.id, env_name=env.name, deployment_id=dep.id,
                         actor_id=dep.actor_id, mode=dep.mode, git_ref=dep.git_ref, sha=dep.sha,
                         repo_url=settings.deploy_repo_url, take_snapshot=dep.take_vm_snapshot,
                         vm_snapshot=dep.vm_snapshot, vm=EsxiVmState.of(row, private),
                         esxi=cfg)


def _annotation(ctx: EsxiVmContext) -> str:
    return (f"sirdar:{ctx.env_id}\nBuilt by Sirdar for the environment {ctx.env_name}. Sirdar "
            "destroys this VM when the environment is deleted; don't change it by hand.")


class EsxiProvisioner:
    """The real ESXi provisioner. Waits, the clock, the port probe and the
    ref lookup are injectable for tests."""

    STEPS = ("provision", "vm_restore", "destroy")

    def __init__(self, *, settings: Settings,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 probe: Callable[[str, int], Awaitable[bool]] | None = None,
                 resolve=None, now: Callable[[], datetime] | None = None,
                 tools_wait: int = TOOLS_WAIT_SECONDS, ssh_wait: int = SSH_WAIT_SECONDS,
                 shutdown_wait: int = SHUTDOWN_WAIT_SECONDS, poll: int = POLL_SECONDS):
        self._settings = settings
        self._sleep = sleep
        self._probe = probe
        self._resolve = resolve or gitref.resolve_ref
        self._now = now or (lambda: datetime.now(UTC))
        self._tools_wait = tools_wait
        self._ssh_wait = ssh_wait
        self._shutdown_wait = shutdown_wait
        self._poll = poll

    async def run(self, step: str, ctx: EsxiVmContext, out: Output) -> VmOutcome:
        if step not in self.STEPS:
            raise ValueError(f"{step!r} isn't a VM step")
        try:
            async with esxi.connect(ctx.esxi) as api:
                if step == "provision":
                    return await self._provision(api, ctx, out)
                if step == "vm_restore":
                    await self._restore(api, ctx, out)
                else:
                    await self._destroy(api, ctx, out)
                return VmOutcome()
        except EsxiError as e:
            raise StepFailed(e.reason) from None

    # ---- identity ---------------------------------------------------------------------

    async def _identify(self, api: EsxiApi, ctx: EsxiVmContext, uuid_: str) -> VmInfo | None:
        """The recorded VM, None when ESXi no longer has it. A VM there that
        isn't named vm.name or lacks this environment's marker is refused."""
        found = await api.find_vm(uuid_)
        if found is None:
            return None
        if found.name != ctx.vm.name or found.owner != str(ctx.env_id):
            raise StepFailed(f"The VM Sirdar recorded for {ctx.env_name} isn't {ctx.vm.name} "
                             "with this environment's marker any more; Sirdar changed nothing.")
        return found

    async def _record(self, ctx: EsxiVmContext, info: VmInfo) -> None:
        await vmcommon.set_vm(EsxiVm, ctx.env_id, moref=info.moref,
                              instance_uuid=info.instance_uuid, vm_path=info.vm_path)

    async def _lost_vm(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> VmInfo | None:
        """A VM named vm.name: this environment's (its marker) from a create
        whose record was lost, adopted; anyone else's, refused."""
        found = await api.find_vm_by_name(ctx.vm.name)
        if found is None:
            return None
        if found.owner != str(ctx.env_id):
            raise StepFailed(f"ESXi already has a VM named {ctx.vm.name} that isn't this "
                             "environment's. Sirdar changed nothing: rename or remove that VM "
                             "by hand, or delete this environment.")
        await self._record(ctx, found)
        out(f"Found {ctx.vm.name} from an earlier attempt (it carries this environment's "
            "marker).\n")
        return found

    def _check_disk(self, info: VmInfo, ctx: EsxiVmContext) -> None:
        try:
            path = esxi.disk_path_for(info.vm_path, ctx.vm.name)
        except ValueError:
            raise StepFailed(f"ESXi keeps {ctx.vm.name} at {info.vm_path}, a path Sirdar "
                             "doesn't understand. Sirdar changed nothing.") from None
        if len(info.disks) != 1 or info.disks[0].path != path:
            raise StepFailed(f"{ctx.vm.name} has a disk Sirdar didn't put there. Sirdar "
                             "changed nothing: fix the VM by hand, then retry.")

    # ---- Prepare VM -------------------------------------------------------------------

    async def _provision(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> VmOutcome:
        vm = ctx.vm
        info: VmInfo | None = None
        if vm.instance_uuid is not None:
            info = await self._identify(api, ctx, vm.instance_uuid)
            if info is None and vm.created:
                raise StepFailed(f"The VM Sirdar made for {ctx.env_name} ({vm.name}) is gone "
                                 "from ESXi. Sirdar won't build a new one silently: delete the "
                                 "environment, or fix it by hand, then retry.")
            if info is None:
                out(f"The half-built {vm.name} is gone from ESXi; building it again.\n")
                await vmcommon.set_vm(EsxiVm, ctx.env_id, moref=None, instance_uuid=None,
                                      vm_path=None)
        if info is None:
            info = await self._lost_vm(api, ctx, out) or await self._create(api, ctx, out)
        uuid_ = info.instance_uuid
        snapshot: str | None = None
        grows = False
        if vm.created:
            self._check_disk(info, ctx)
            grows = vm.disk_gb > info.disk_gb
            doomed = None
            if grows:
                # ESXi can't grow a disk with snapshots. Refused here, before any
                # change, unless every one is Sirdar's; they go after the shutdown.
                doomed = await self._snapshots_for_grow(api, ctx, uuid_)
            else:
                # Before anything changes: the snapshot holds the VM as it was.
                snapshot = await self._snapshot(api, ctx, uuid_, out)
            await self._resize(api, ctx, info, doomed, out)
        else:
            await self._build(api, ctx, info, out)
        await self._start(api, uuid_, out)
        ip = await self._address(api, uuid_, out, vm)
        if grows:
            # The grown VM is back up (Tools answer, so it can quiesce).
            snapshot = await self._snapshot(api, ctx, uuid_, out)
        await vmcommon.settle_address(
            self._settings, model=EsxiVm, env_id=ctx.env_id, previous_ip=vm.ip, ip=ip,
            pin=lambda: self._pin(ctx, ip, out), actor_id=ctx.actor_id,
            target_id=f"esxi:{ctx.env_name}", out=out, host_label=HOST_LABEL)
        await self._scrub(api, ctx, uuid_, out)
        if not vm.created:
            await vmcommon.set_vm(EsxiVm, ctx.env_id, created=True)
            # A VM built just now had nothing before: still before step 1.
            snapshot = await self._snapshot(api, ctx, uuid_, out)
        sha = None if ctx.sha else await vmcommon.resolve_ref(
            self._settings, self._resolve, env_id=ctx.env_id, git_ref=ctx.git_ref,
            repo_url=ctx.repo_url, out=out)
        return VmOutcome(sha=sha, vm_snapshot=snapshot)

    async def _create(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> VmInfo:
        vm = ctx.vm
        probe = self._probe or vmcommon.tcp_open
        if vm.static_ip and await probe(vm.static_ip, vms.VM_SSH_PORT):
            raise StepFailed(f"Something already answers SSH at {vm.static_ip}, so Sirdar "
                             "won't give that address to a new VM. Free it, or delete this "
                             "environment and create it with another address.")
        if not vm.host_key_private:
            raise StepFailed(f"Sirdar no longer has the host key it made for {vm.name}, so it "
                             "can't build the VM. Delete this environment and create it again.")
        meta = cloudinit.metadata(env_id=ctx.env_id, hostname=vm.name, ip_cidr=vm.ip_cidr,
                                  gateway=vm.gateway, dns_servers=vm.dns_servers)
        user = cloudinit.userdata(hostname=vm.name, ssh_public_key=vm.ssh_public_key,
                                  host_key_private=vm.host_key_private,
                                  host_key_public=vm.host_key_public)
        spec = esxi.CreateSpec(
            name=vm.name, datastore=vm.datastore, network=vm.network,
            resource_pool=vm.resource_pool, cores=vm.cores, memory_mb=vm.memory_mb,
            annotation=_annotation(ctx),
            extra_config={esxi.OWNER_KEY: str(ctx.env_id), **cloudinit.guestinfo(meta, user)})
        out(f"Creating {vm.name} ({vm.cores} vCPU, {vm.memory_mb / 1024:g} GB) on "
            f"{vm.datastore}.\n")
        info = await api.create_vm(spec)
        await self._record(ctx, info)       # at once: a later failure still knows it exists
        out(f"Created {vm.name} (VM {info.moref}).\n")
        return info

    async def _seed_disk(self, api: EsxiApi, ctx: EsxiVmContext) -> str:
        seed = await api.find_vm_by_name(ctx.vm.source_vm)
        if (seed is None or seed.power_state != "poweredOff" or len(seed.disks) != 1
                or seed.snapshot_count):
            raise StepFailed(f"The seed VM {ctx.vm.source_vm} can't be copied: it must exist, "
                             "be powered off, and have one disk and no snapshots. Run Test in "
                             "Settings › Integrations › VMware ESXi.")
        return seed.disks[0].path

    async def _build(self, api: EsxiApi, ctx: EsxiVmContext, info: VmInfo,
                     out: Output) -> None:
        """The seed disk copied into the VM's own folder, attached, grown."""
        vm, uuid_ = ctx.vm, info.instance_uuid
        try:
            path = esxi.disk_path_for(info.vm_path, vm.name)
        except ValueError:
            raise StepFailed(f"ESXi keeps {vm.name} at {info.vm_path}, a path Sirdar doesn't "
                             "understand. Remove the VM by hand, then retry.") from None
        if not info.disks:
            if await api.file_exists(path):
                # Only this exact path, inside the VM's own folder, never attached.
                await api.delete_disk(path)
                out(f"Removed the half-copied disk {path} from an earlier attempt.\n")
            seed = await self._seed_disk(api, ctx)
            out(f"Copying the seed disk {seed} to {path}.\n")
            await api.copy_disk(seed, path)
            await api.attach_disk(uuid_, path)
            info = await self._identify(api, ctx, uuid_)
            if info is None:
                raise StepFailed(f"{vm.name} disappeared from ESXi while Sirdar built it.")
        self._check_disk(info, ctx)
        if info.disk_gb < vm.disk_gb:
            await api.grow_disk(uuid_, info.disks[0].key, vm.disk_gb)
            out(f"Grew the disk to {vm.disk_gb} GB.\n")

    async def _resize(self, api: EsxiApi, ctx: EsxiVmContext, info: VmInfo,
                      doomed: list[SnapshotInfo] | None, out: Output) -> None:
        """`doomed` (only when the disk grows): the snapshots to delete first.
        Order: graceful shutdown (or nothing changes), the snapshots, the
        size, the disk; _start powers the VM on after."""
        vm, uuid_ = ctx.vm, info.instance_uuid
        grows = doomed is not None
        if info.disk_gb > vm.disk_gb:
            out(f"The disk is {info.disk_gb} GB, more than the {vm.disk_gb} GB recorded; "
                "Sirdar never shrinks a disk.\n")
        resize = (info.cores, info.memory_mb) != (vm.cores, vm.memory_mb)
        if not resize and not grows:
            return
        stopped = False
        if info.power_state != "poweredOff":
            await self._shut_down(api, uuid_, out)
            stopped = True
        try:
            for snap in doomed or ():
                await api.delete_snapshot(uuid_, snap.id)
                out(f"Deleted the VM snapshot {snap.name}: ESXi can't grow a disk that has "
                    "snapshots.\n")
            if resize:
                await api.set_size(uuid_, vm.cores, vm.memory_mb)
                out(f"Set {vm.name} to {vm.cores} vCPU and {vm.memory_mb / 1024:g} GB.\n")
            if grows:
                await api.grow_disk(uuid_, info.disks[0].key, vm.disk_gb)
                out(f"Grew the disk from {info.disk_gb} GB to {vm.disk_gb} GB; the guest grows "
                    "its file system when it boots.\n")
        except (EsxiError, StepFailed):
            if stopped:
                out("The VM was left powered off; retry the deployment.\n")
            raise

    async def _snapshots_for_grow(self, api: EsxiApi, ctx: EsxiVmContext,
                                  uuid_: str) -> list[SnapshotInfo]:
        """The VM's snapshots, which a grow deletes: refused (changing nothing)
        unless each is one Sirdar recorded, and no two share a name."""
        snaps = await api.snapshots(uuid_)
        recorded = await vmcommon.recorded_snapshots(ctx.env_id)
        foreign = sorted({s.name for s in snaps
                          if s.name not in recorded or not vms.valid_snapshot_name(s.name)})
        if foreign:
            raise StepFailed(f"ESXi can't grow a disk that has snapshots, and "
                             f"{', '.join(foreign)} weren't taken by Sirdar, so it won't delete "
                             "them. Delete them in the ESXi Host Client, then retry.")
        names = Counter(s.name for s in snaps)
        twice = sorted(n for n, count in names.items() if count > 1)
        if twice:
            raise StepFailed(f"ESXi can't grow a disk that has snapshots, and it has more than "
                             f"one VM snapshot named {', '.join(twice)}, so Sirdar won't pick "
                             "which to delete. Sirdar changed nothing: delete the extra one in "
                             "the ESXi Host Client, then retry.")
        return snaps

    async def _shut_down(self, api: EsxiApi, uuid_: str, out: Output) -> None:
        out("Shutting the guest down to resize the VM.\n")
        await api.shutdown_guest(uuid_)
        for _ in range(max(1, self._shutdown_wait // self._poll)):
            info = await api.find_vm(uuid_)
            if info is not None and info.power_state == "poweredOff":
                return
            await self._sleep(self._poll)
        raise StepFailed(f"The guest didn't shut down in {self._shutdown_wait // 60} minutes, "
                         "so Sirdar didn't resize it. Check the VM in the ESXi Host Client, "
                         "then retry.")

    async def _start(self, api: EsxiApi, uuid_: str, out: Output) -> None:
        info = await api.find_vm(uuid_)
        if info is not None and info.power_state != "poweredOn":
            await api.power_on(uuid_)
            out("Started the VM.\n")

    async def _address(self, api: EsxiApi, uuid_: str, out: Output, vm: EsxiVmState) -> str:
        out("Waiting for VMware Tools to report the VM's address.\n")
        ips: tuple[str, ...] = ()
        for _ in range(max(1, self._tools_wait // self._poll)):
            guest = await api.guest(uuid_)
            ips = guest.ipv4 if guest.tools_running else ()
            if vm.static_ip and vm.static_ip in ips:
                out(f"The VM answers at {vm.static_ip}.\n")
                return vm.static_ip
            if not vm.static_ip and ips:
                out(f"DHCP gave the VM {ips[0]}.\n")
                return ips[0]
            await self._sleep(self._poll)
        if vm.static_ip and ips:
            raise StepFailed(f"The VM came up at {', '.join(ips)}, not {vm.static_ip}. Check "
                             "that the seed is Ubuntu's cloud image (see the README).")
        raise StepFailed(f"VMware Tools didn't report the VM's address in "
                         f"{self._tools_wait // 60} minutes. Is open-vm-tools in the seed "
                         "image?")

    async def _pin(self, ctx: EsxiVmContext, ip: str, out: Output) -> bool:
        return await vmcommon.confirm_pin(
            ip=ip, expected=ctx.vm.host_fingerprint, actor_id=ctx.actor_id,
            target_id=f"esxi:{ctx.env_name}", tries=max(1, self._ssh_wait // self._poll),
            poll=self._poll, sleep=self._sleep, out=out,
            how="the key Sirdar generated for the VM",
            mismatch="The VM's live SSH key isn't the one Sirdar generated for it. Sirdar "
                     "pinned nothing.")

    async def _scrub(self, api: EsxiApi, ctx: EsxiVmContext, uuid_: str, out: Output) -> None:
        """Once SSH answered with the generated key: the user-data that held
        its private half leaves the VM's settings, and Sirdar forgets it."""
        if ctx.vm.host_key_private is None:
            return
        await api.set_extra_config(uuid_, cloudinit.scrub())
        await vmcommon.set_vm(EsxiVm, ctx.env_id, host_key_private_enc=None)
        out("Removed the cloud-init user-data (it held the VM's host key) from the VM's "
            "settings.\n")

    async def _snapshot(self, api: EsxiApi, ctx: EsxiVmContext, uuid_: str,
                        out: Output) -> str | None:
        if ctx.vm_snapshot:
            if any(s.name == ctx.vm_snapshot for s in await api.snapshots(uuid_)):
                out(f"Keeping the VM snapshot from the first attempt: {ctx.vm_snapshot}\n")
                return ctx.vm_snapshot
            out(f"The VM snapshot {ctx.vm_snapshot} from the first attempt is gone; taking a "
                "new one.\n")
        elif not ctx.take_snapshot:
            return None
        name = vms.snapshot_name(self._now())
        description = (f"Sirdar: before {ctx.mode} of {ctx.env_name} "
                       f"(deployment {ctx.deployment_id})")
        # Recorded first: if waiting on ESXi's task fails, a snapshot that still
        # appears is Sirdar's (kept by a retry, listed, pruned in turn).
        await vmcommon.record_vm_snapshot(ctx.deployment_id, name)
        try:
            try:
                await api.take_snapshot(uuid_, name, description, quiesce=True)
            except QuiesceFailed:
                out("VMware Tools couldn't quiesce the file systems; taking a crash-consistent "
                    "snapshot instead.\n")
                await api.take_snapshot(uuid_, name, description, quiesce=False)
        except EsxiError:
            with suppress(EsxiError):
                # A task that timed out can still finish: give it a moment, so
                # a late snapshot stays recorded (and so pruned in turn).
                await self._sleep(SNAPSHOT_GRACE_SECONDS)
                if all(s.name != name for s in await api.snapshots(uuid_)):
                    await vmcommon.record_vm_snapshot(ctx.deployment_id, None)
            raise
        out(f"Took VM snapshot {name}.\n")
        current = await api.snapshots(uuid_)
        doomed = set(vmcommon.to_prune([s.name for s in current],
                                       await vmcommon.recorded_snapshots(ctx.env_id) | {name},
                                       ctx.vm.keep_snapshots))
        counts = Counter(s.name for s in current)
        for snap in current:
            if snap.name in doomed and counts[snap.name] > 1:
                out(f"ESXi has {counts[snap.name]} VM snapshots named {snap.name}; Sirdar won't "
                    "pick which to delete, so it kept them.\n")
                doomed.discard(snap.name)
            elif snap.name in doomed:
                await api.delete_snapshot(uuid_, snap.id)
                out(f"Deleted the old VM snapshot {snap.name} (keeping the newest "
                    f"{ctx.vm.keep_snapshots}).\n")
        return name

    # ---- Restore VM snapshot ------------------------------------------------------------

    async def _restore(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> None:
        vm, name = ctx.vm, ctx.vm_snapshot
        if vm.instance_uuid is None or not vm.created:
            raise StepFailed("This environment has no VM yet.")
        if not vms.valid_snapshot_name(name):
            raise StepFailed(f"{name} isn't a VM snapshot Sirdar takes.")
        if name not in await vmcommon.recorded_snapshots(ctx.env_id):
            raise StepFailed(f"Sirdar didn't take the VM snapshot {name} for {ctx.env_name}, "
                             "so it won't restore it.")
        if await self._identify(api, ctx, vm.instance_uuid) is None:
            raise StepFailed(f"{vm.name} is gone from ESXi.")
        matches = [s for s in await api.snapshots(vm.instance_uuid) if s.name == name]
        if not matches:
            raise StepFailed(f"The VM snapshot {name} is gone from ESXi.")
        if len(matches) > 1:
            raise StepFailed(f"ESXi has {len(matches)} VM snapshots named {name}; Sirdar won't "
                             "pick one.")
        out(f"Reverting {vm.name} to {name}.\n")
        await api.revert_snapshot(vm.instance_uuid, matches[0].id)
        await self._start(api, vm.instance_uuid, out)
        ip = await self._address(api, vm.instance_uuid, out, vm)
        await vmcommon.settle_address(
            self._settings, model=EsxiVm, env_id=ctx.env_id, previous_ip=vm.ip, ip=ip,
            pin=lambda: self._pin(ctx, ip, out), actor_id=ctx.actor_id,
            target_id=f"esxi:{ctx.env_name}", out=out, host_label=HOST_LABEL)
        out(f"{vm.name} is back at {name}; Docker starts its containers.\n")

    # ---- Destroy VM ---------------------------------------------------------------------

    async def _destroy(self, api: EsxiApi, ctx: EsxiVmContext, out: Output) -> None:
        vm, owner = ctx.vm, str(ctx.env_id)
        if vm.instance_uuid is None:
            found = await api.find_vm_by_name(vm.name)
            if found is None or found.owner != owner:
                out(f"Sirdar never created a VM for {ctx.env_name}.\n")
            else:
                out(f"Found {vm.name} from an unfinished create (it carries this "
                    "environment's marker).\n")
                await self._remove(api, found, vm, out)
        else:
            found = await api.find_vm(vm.instance_uuid)
            if found is None:
                twin = await api.find_vm_by_name(vm.name)
                if twin is not None and twin.owner == owner:
                    raise StepFailed(f"{vm.name} carries this environment's marker but isn't the "
                                     "VM Sirdar recorded (its id changed). Sirdar changed "
                                     "nothing: remove it by hand in the ESXi Host Client, then "
                                     "retry.")
                out(f"{vm.name} is already gone.\n")
            else:
                if found.name != vm.name:
                    raise StepFailed(f"The VM Sirdar recorded is {found.name or 'unnamed'} now, "
                                     f"not {vm.name}. Sirdar changed nothing.")
                if found.owner != owner:
                    raise StepFailed(f"{vm.name} doesn't carry this environment's marker, so it "
                                     "isn't the VM Sirdar made. Sirdar changed nothing.")
                await self._remove(api, found, vm, out)
        if vm.ip and await vmcommon.forget_pin(vm.ip, ctx.actor_id, f"esxi:{ctx.env_name}"):
            out(f"Forgot {vm.ip}'s SSH host key.\n")

    async def _remove(self, api: EsxiApi, found: VmInfo, vm: EsxiVmState, out: Output) -> None:
        # Destroy deletes every disk attached to the VM: only none, or the one
        # Sirdar copied into the VM's folder (its base, under any snapshot deltas).
        if found.disks:
            try:
                ours = esxi.disk_path_for(found.vm_path, vm.name)
            except ValueError:
                ours = None
            if len(found.disks) != 1 or found.disks[0].path != ours:
                raise StepFailed(f"VM {vm.name} has a disk Sirdar didn't put there; detach it "
                                 "before deleting the environment. Nothing was removed.")
        if found.power_state != "poweredOff":
            await api.power_off(found.instance_uuid)
            out("Powered the VM off.\n")
        out(f"Destroying {vm.name} and its VM snapshots.\n")
        await api.destroy(found.instance_uuid)
        if await api.find_vm(found.instance_uuid) is not None:
            raise StepFailed(f"{vm.name} is still there after destroy. Remove it by hand in "
                             "the ESXi Host Client, then retry.")
        out(f"Destroyed {vm.name}.\n")
