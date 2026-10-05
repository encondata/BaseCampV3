"""VMware ESXi client (deploy phase 6): what Sirdar does on a standalone,
licensed ESXi 7 host through the vSphere API with pyVmomi. That covers the
connection test, VMs found by instance UUID or name, the empty VM step 0
creates, the seed disk copy, sizing, cloud-init guestinfo, power, VMware
Tools' view of the guest, VM snapshots and destroy.

One seam: connect(cfg) yields an EsxiApi. The real PyvmomiEsxi runs every
SOAP call on a one-thread executor of its own (pyVmomi blocks, and its stub
isn't shared across threads). Tests replace connect() with FakeEsxi's, and
an autouse guard replaces _smart_connect, the only function that opens a
real session.

TLS: the pinned certificate is the only trust anchor (no host name check:
ESXi's default certificate names only its host name), and pyVmomi also
compares the leaf's SHA-256 with the pin before the login is sent. Errors
are EsxiError with our own copy: never pyVmomi's or ESXi's text, and never
the password."""

import asyncio
import contextlib
import http.client
import ipaddress
import re
import ssl
import threading
import time
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol
from urllib.parse import urlsplit

from pyVim.connect import Disconnect, SmartConnect
from pyVmomi import vim, vmodl

from sirdar_api.deploy import Check, ConnectFailed, ConnectResult, tls_pin
from sirdar_api.deploy.integrations import EsxiConfig

DEFAULT_PORT = 443
# The extraConfig key that marks a VM as Sirdar's, holding the environment's
# id. Not a guestinfo.* key, so the guest can neither read nor change it.
OWNER_KEY = "sirdar.environment"
HTTP_TIMEOUT = 30
# SmartConnect's version discovery has no timeout of its own: sign-in as a whole has one.
SIGN_IN_TIMEOUT = HTTP_TIMEOUT + 5
TASK_POLL_SECONDS = 2.0
TASK_TIMEOUT_SECONDS = 30 * 60
SCSI_KEY = -101
NIC_KEY = -102
NEW_DISK_KEY = -201
_KB_PER_GB = 1024 * 1024
FREE_EDITIONS = ("esxBasic",)                 # the free license: the API is read-only
TLS_CHANGED = ("The ESXi host's certificate isn't the one Sirdar trusts. If it was renewed "
               "on purpose, trust the new one in Settings › Integrations › VMware ESXi.")
LICENSE_READ_ONLY = ("ESXi's license doesn't allow changes through its API (a free ESXi "
                     "license is read-only). Sirdar needs a paid license.")
MALFORMED = "ESXi answered in a way Sirdar doesn't understand."
_VM_PATH_RE = re.compile(r"(\[[^\]]+\] [^/]+)/[^/]+\.vmx")
# ESXi allows 32 snapshots in a chain: a longer backing.parent chain is malformed.
_MAX_DELTA_CHAIN = 64
_QUIESCE_FAULTS = ("ApplicationQuiesceFault", "FilesystemQuiesceFault")


class EsxiError(Exception):
    """`reason` is our own copy."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class QuiesceFailed(EsxiError):
    """VMware Tools couldn't quiesce the guest for a snapshot."""


@dataclass(frozen=True)
class About:
    product: str
    version: str
    build: str
    api_type: str                   # "HostAgent" for ESXi, "VirtualCenter" for vCenter


@dataclass(frozen=True)
class DatastoreInfo:
    name: str
    accessible: bool
    free_gb: int
    capacity_gb: int


@dataclass(frozen=True)
class DiskInfo:
    key: int
    path: str                       # the base file: "[datastore1] ss-uat3/ss-uat3-disk0.vmdk"
    capacity_gb: int
    # The file the VM writes now when a snapshot made it a delta
    # ("...-disk0-000001.vmdk"); "" while it writes the base itself.
    current: str = ""


@dataclass(frozen=True)
class VmInfo:
    moref: str
    instance_uuid: str
    name: str
    owner: str                      # extraConfig sirdar.environment, "" when unset
    power_state: str                # poweredOn | poweredOff | suspended
    vm_path: str                    # "[datastore1] ss-uat3/ss-uat3.vmx"
    cores: int
    memory_mb: int
    disks: tuple[DiskInfo, ...]
    snapshot_count: int
    template: bool

    @property
    def disk_gb(self) -> int:
        return self.disks[0].capacity_gb if self.disks else 0


@dataclass(frozen=True)
class Guest:
    tools_running: bool
    ipv4: tuple[str, ...]


@dataclass(frozen=True)
class SnapshotInfo:
    id: int
    name: str
    description: str
    created: datetime | None


@dataclass(frozen=True)
class CreateSpec:
    name: str
    datastore: str
    network: str
    resource_pool: str | None
    cores: int
    memory_mb: int
    annotation: str
    # guestinfo.userdata carries the VM's private host key: never in a repr.
    extra_config: dict[str, str] = field(repr=False)


class EsxiApi(Protocol):
    async def about(self) -> About: ...
    async def license_editions(self) -> list[str]: ...
    async def datastore(self, name: str) -> DatastoreInfo | None: ...
    async def network_names(self) -> list[str]: ...
    async def resource_pool_names(self) -> list[str]: ...
    async def find_vm(self, instance_uuid: str) -> VmInfo | None: ...
    async def find_vm_by_name(self, name: str) -> VmInfo | None: ...
    async def create_vm(self, spec: CreateSpec) -> VmInfo: ...
    async def file_exists(self, path: str) -> bool: ...
    async def copy_disk(self, src: str, dst: str) -> None: ...
    async def delete_disk(self, path: str) -> None: ...
    async def attach_disk(self, uuid: str, path: str) -> None: ...
    async def grow_disk(self, uuid: str, disk_key: int, size_gb: int) -> None: ...
    async def set_size(self, uuid: str, cores: int, memory_mb: int) -> None: ...
    async def set_extra_config(self, uuid: str, values: dict[str, str]) -> None: ...
    async def power_on(self, uuid: str) -> None: ...
    async def shutdown_guest(self, uuid: str) -> None: ...
    async def power_off(self, uuid: str) -> None: ...
    async def guest(self, uuid: str) -> Guest: ...
    async def snapshots(self, uuid: str) -> list[SnapshotInfo]: ...
    async def take_snapshot(self, uuid: str, name: str, description: str, *,
                            quiesce: bool) -> None: ...
    async def revert_snapshot(self, uuid: str, snapshot_id: int) -> None: ...
    async def delete_snapshot(self, uuid: str, snapshot_id: int) -> None: ...
    async def destroy(self, uuid: str) -> None: ...


# ---- pure helpers -----------------------------------------------------------------

def split_url(url: str) -> tuple[str, int]:
    parts = urlsplit(url)
    return parts.hostname or "", parts.port or DEFAULT_PORT


def vm_folder(vm_path: str) -> str:
    """"[datastore1] ss-uat3" from "[datastore1] ss-uat3/ss-uat3.vmx"."""
    match = _VM_PATH_RE.fullmatch(str(vm_path or ""))
    if not match:
        raise ValueError("not a VM's .vmx path")
    return match.group(1)


def disk_path_for(vm_path: str, name: str) -> str:
    """Where step 0 copies the seed disk: the VM's own folder."""
    return f"{vm_folder(vm_path)}/{name}-disk0.vmdk"


def _fault_name(fault: BaseException) -> str:
    return type(fault).__name__.rsplit(".", 1)[-1]


def fault_reason(fault: BaseException, what: str) -> str:
    """Our copy for a vSphere fault; never its msg."""
    if isinstance(fault, vim.fault.InvalidLogin):
        return "ESXi rejected the user name or password."
    if isinstance(fault, vim.fault.RestrictedVersion):
        return LICENSE_READ_ONLY
    if isinstance(fault, (vim.fault.NoPermission, vmodl.fault.SecurityError)):
        return f"The ESXi user isn't allowed to {what}."
    if isinstance(fault, (vim.fault.DuplicateName, vim.fault.FileAlreadyExists)):
        return f"ESXi couldn't {what}: the name or file already exists."
    if isinstance(fault, vim.fault.FileNotFound):
        return f"ESXi couldn't {what}: a file it needs is missing."
    if isinstance(fault, (vim.fault.NoDiskSpace, vim.fault.InsufficientResourcesFault)):
        return f"ESXi couldn't {what}: not enough disk space or resources."
    if isinstance(fault, vim.fault.InvalidPowerState):
        return f"ESXi couldn't {what}: the VM's power state doesn't allow it."
    return f"ESXi couldn't {what} ({type(fault).__name__})."


def _snapshot_fault(fault: BaseException) -> bool:
    kind = getattr(vim.fault, "SnapshotFault", None)
    if kind is not None and isinstance(fault, kind):
        return True
    return any(c.__name__.rsplit(".", 1)[-1] == "SnapshotFault" for c in type(fault).__mro__)


def _mapped(fault: BaseException, what: str, *, quiesce: bool = False) -> EsxiError:
    """A quiesce fault, or any snapshot fault while quiescing, is QuiesceFailed
    (the caller then falls back to a crash-consistent snapshot)."""
    if _fault_name(fault) in _QUIESCE_FAULTS or (quiesce and _snapshot_fault(fault)):
        return QuiesceFailed("ESXi couldn't quiesce the guest's file systems.")
    return EsxiError(fault_reason(fault, what))


def _tls_refused(exc: BaseException) -> bool:
    """Whether a connection error came from a certificate the pin refused."""
    seen: BaseException | None = exc
    for _ in range(8):
        if seen is None:
            return False
        if (isinstance(seen, ssl.SSLCertVerificationError)
                or type(seen).__name__ == "ThumbprintMismatchException"):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def owner_of(extra_config) -> str:
    for option in extra_config or ():
        if getattr(option, "key", None) == OWNER_KEY:
            return str(option.value or "")
    return ""


def flatten_snapshots(tree) -> list[SnapshotInfo]:
    found: list[SnapshotInfo] = []
    for node in tree or ():
        found.append(SnapshotInfo(id=int(node.id), name=str(node.name),
                                  description=str(node.description or ""),
                                  created=node.createTime))
        found += flatten_snapshots(node.childSnapshotList)
    return found


def guest_ipv4(guest) -> tuple[str, ...]:
    """The guest's IPv4 addresses on its virtual NICs (not Docker's bridges),
    without link-local ones, in VMware Tools' order."""
    found: list[str] = []

    def add(text) -> None:
        try:
            ip = ipaddress.IPv4Address(str(text))
        except ValueError:
            return
        if not ip.is_link_local and not ip.is_loopback and str(ip) not in found:
            found.append(str(ip))

    for nic in guest.net or ():
        device = getattr(nic, "deviceConfigId", None)
        if device is None or device < 0:              # not a virtual NIC (a bridge inside)
            continue
        config = getattr(nic, "ipConfig", None)
        addresses = [a.ipAddress for a in (config.ipAddress if config else None) or ()]
        for text in addresses or (nic.ipAddress or ()):
            add(text)
    if not found and guest.ipAddress:
        add(guest.ipAddress)
    return tuple(found)


def disk_info(device) -> DiskInfo:
    """A virtual disk by its base file. Once the VM has a snapshot,
    backing.fileName is the newest delta; the base is the root of the
    backing.parent chain."""
    backing = device.backing
    current = str(backing.fileName)
    for _ in range(_MAX_DELTA_CHAIN):
        parent = getattr(backing, "parent", None)
        if parent is None:
            break
        backing = parent
    else:
        raise EsxiError(MALFORMED)
    base = str(backing.fileName)
    return DiskInfo(int(device.key), base, int(device.capacityInKB) // _KB_PER_GB,
                    current="" if current == base else current)


def vm_info(vm) -> VmInfo:
    cfg = vm.config
    disks = tuple(disk_info(d) for d in cfg.hardware.device
                  if isinstance(d, vim.vm.device.VirtualDisk))
    tree = vm.snapshot.rootSnapshotList if vm.snapshot else ()
    return VmInfo(moref=str(vm._moId), instance_uuid=str(cfg.instanceUuid), name=str(cfg.name),
                  owner=owner_of(cfg.extraConfig), power_state=str(vm.runtime.powerState),
                  vm_path=str(cfg.files.vmPathName), cores=int(cfg.hardware.numCPU),
                  memory_mb=int(cfg.hardware.memoryMB), disks=disks,
                  snapshot_count=len(flatten_snapshots(tree)), template=bool(cfg.template))


def create_config(spec: CreateSpec, *, network) -> "vim.vm.ConfigSpec":
    """The empty VM step 0 creates: no disk yet (the seed copy is attached
    next), a ParaVirtual SCSI controller, a vmxnet3 NIC on the port group,
    the owner marker and the guestinfo cloud-init keys."""
    scsi = vim.vm.device.VirtualDeviceSpec(
        operation="add",
        device=vim.vm.device.ParaVirtualSCSIController(key=SCSI_KEY, busNumber=0,
                                                       sharedBus="noSharing"))
    nic = vim.vm.device.VirtualDeviceSpec(
        operation="add",
        device=vim.vm.device.VirtualVmxnet3(
            key=NIC_KEY, addressType="generated",
            backing=vim.vm.device.VirtualEthernetCard.NetworkBackingInfo(
                deviceName=spec.network, network=network),
            connectable=vim.vm.device.VirtualDevice.ConnectInfo(
                startConnected=True, allowGuestControl=True, connected=True)))
    extra = {**spec.extra_config, "disk.EnableUUID": "TRUE"}
    return vim.vm.ConfigSpec(
        name=spec.name, guestId="ubuntu64Guest", numCPUs=spec.cores, memoryMB=spec.memory_mb,
        annotation=spec.annotation, files=vim.vm.FileInfo(vmPathName=f"[{spec.datastore}]"),
        extraConfig=[vim.option.OptionValue(key=k, value=v) for k, v in extra.items()],
        deviceChange=[scsi, nic])


# ---- the real client ----------------------------------------------------------------

class PyvmomiEsxi:
    """EsxiApi over one pyVmomi session. Every call runs on the session's own
    one-thread executor; vSphere faults become EsxiError with our copy."""

    def __init__(self, si, pool: ThreadPoolExecutor, *, poll: float = TASK_POLL_SECONDS,
                 task_timeout: int = TASK_TIMEOUT_SECONDS):
        self._si = si
        self._pool = pool
        self._poll = poll
        self._task_timeout = task_timeout
        # Set when the awaiting coroutine is cancelled; _wait then cancels the
        # ESXi task. Each call brings its own (the worker runs one at a time).
        self._cancel = threading.Event()

    async def _do(self, what: str, fn: Callable, *args, quiesce: bool = False):
        loop = asyncio.get_running_loop()
        cancel = threading.Event()

        def job():
            self._cancel = cancel
            return fn(*args)

        try:
            return await loop.run_in_executor(self._pool, job)
        except asyncio.CancelledError:
            cancel.set()
            raise
        except EsxiError:
            raise
        except vmodl.MethodFault as e:
            raise _mapped(e, what, quiesce=quiesce) from None
        except (OSError, http.client.HTTPException) as e:
            raise EsxiError(TLS_CHANGED if _tls_refused(e) else "Sirdar lost its connection "
                            "to ESXi.") from None
        # StopIteration can't cross into a future (asyncio makes it a RuntimeError):
        # both are a safety net, the helpers below raise our own copy.
        except (AttributeError, TypeError, ValueError, KeyError, IndexError, StopIteration,
                RuntimeError):
            raise EsxiError(MALFORMED) from None

    # -- sync helpers (worker thread only) --
    def _content(self):
        return self._si.RetrieveContent()

    def _dc(self):
        dc = next((e for e in self._content().rootFolder.childEntity or ()
                   if isinstance(e, vim.Datacenter)), None)
        if dc is None:
            raise EsxiError("ESXi has no datacenter.")
        return dc

    def _host(self):
        compute = next((e for e in self._dc().hostFolder.childEntity or ()
                        if isinstance(e, vim.ComputeResource)), None)
        if compute is None or not compute.host:
            raise EsxiError("ESXi has no host in its datacenter.")
        return compute, compute.host[0]

    def _vm(self, uuid: str):
        vm = self._content().searchIndex.FindByUuid(None, uuid, True, True)
        if vm is None:
            raise EsxiError("ESXi has no VM with that id.")
        return vm

    @staticmethod
    def _cancel_task(task) -> None:
        with contextlib.suppress(Exception):          # best effort: it may have just ended
            task.CancelTask()

    def _wait(self, task, what: str, *, quiesce: bool = False):
        deadline = time.monotonic() + self._task_timeout
        cancel = self._cancel
        while True:
            info = task.info
            if info.state == vim.TaskInfo.State.success:
                return info.result
            if info.state == vim.TaskInfo.State.error:
                raise _mapped(info.error, what, quiesce=quiesce)
            if cancel.is_set():
                self._cancel_task(task)
                raise EsxiError(f"Sirdar stopped waiting for ESXi to {what}.")
            if time.monotonic() >= deadline:
                self._cancel_task(task)
                raise EsxiError(f"ESXi didn't finish ({what}) in "
                                f"{self._task_timeout // 60} minutes.")
            time.sleep(self._poll)

    def _pools(self) -> dict[str, list]:
        compute, _ = self._host()
        found: dict[str, list] = {}
        todo = list(compute.resourcePool.resourcePool or ())
        while todo:
            pool = todo.pop()
            found.setdefault(str(pool.name), []).append(pool)
            todo += list(pool.resourcePool or ())
        return found

    def _pool_named(self, name: str):
        """The resource pool with this name, None when there's none; refused
        when two share it (pools nest, so names needn't be unique)."""
        found = self._pools().get(name, [])
        if len(found) > 1:
            raise EsxiError(f"ESXi has more than one resource pool named {name}; Sirdar "
                            "won't pick one.")
        return found[0] if found else None

    def _all_vms(self):
        content = self._content()
        view = content.viewManager.CreateContainerView(content.rootFolder,
                                                       [vim.VirtualMachine], True)
        try:
            return list(view.view)
        finally:
            view.Destroy()

    def _device(self, vm, kind, missing: str, key: int | None = None):
        device = next((d for d in vm.config.hardware.device or ()
                       if isinstance(d, kind) and (key is None or d.key == key)), None)
        if device is None:
            raise EsxiError(missing)
        return device

    def _reconfig(self, uuid: str, spec, what: str) -> None:
        self._wait(self._vm(uuid).ReconfigVM_Task(spec=spec), what)

    def _snapshot_obj(self, vm, snapshot_id: int):
        todo = list(vm.snapshot.rootSnapshotList if vm.snapshot else ())
        while todo:
            node = todo.pop()
            if int(node.id) == int(snapshot_id):
                return node.snapshot
            todo += list(node.childSnapshotList or ())
        raise EsxiError("ESXi has no such snapshot.")

    # -- EsxiApi --
    async def about(self) -> About:
        def run():
            a = self._content().about
            return About(str(a.fullName), str(a.version), str(a.build), str(a.apiType))
        return await self._do("read its version", run)

    async def license_editions(self) -> list[str]:
        return await self._do("read its license", lambda: [
            str(lic.editionKey) for lic in self._content().licenseManager.licenses or ()])

    async def datastore(self, name: str) -> DatastoreInfo | None:
        def run():
            for ds in self._dc().datastore:
                if ds.name == name:
                    s = ds.summary
                    return DatastoreInfo(name, bool(s.accessible), int(s.freeSpace) // 1024 ** 3,
                                         int(s.capacity) // 1024 ** 3)
            return None
        return await self._do("read the datastores", run)

    async def network_names(self) -> list[str]:
        return await self._do("read the networks",
                              lambda: [str(n.name) for n in self._dc().network])

    async def resource_pool_names(self) -> list[str]:
        return await self._do("read the resource pools", lambda: sorted(self._pools()))

    async def find_vm(self, instance_uuid: str) -> VmInfo | None:
        def run():
            vm = self._content().searchIndex.FindByUuid(None, instance_uuid, True, True)
            return vm_info(vm) if vm is not None else None
        return await self._do("look up the VM", run)

    async def find_vm_by_name(self, name: str) -> VmInfo | None:
        def run():
            found = [vm for vm in self._all_vms() if vm.name == name]
            if len(found) > 1:
                raise EsxiError(f"ESXi has more than one VM named {name}; Sirdar won't pick "
                                "one.")
            return vm_info(found[0]) if found else None
        return await self._do("look up the VM", run)

    async def create_vm(self, spec: CreateSpec) -> VmInfo:
        def run():
            dc = self._dc()
            compute, host = self._host()
            network = next((n for n in dc.network if n.name == spec.network), None)
            if network is None:
                raise EsxiError(f"ESXi has no port group named {spec.network}.")
            pool = compute.resourcePool
            if spec.resource_pool:
                pool = self._pool_named(spec.resource_pool)
                if pool is None:
                    raise EsxiError(f"ESXi has no resource pool named {spec.resource_pool}.")
            task = dc.vmFolder.CreateVM_Task(config=create_config(spec, network=network),
                                             pool=pool, host=host)
            return vm_info(self._wait(task, "create the VM"))
        return await self._do("create the VM", run)

    async def file_exists(self, path: str) -> bool:
        def run():
            try:
                self._content().virtualDiskManager.QueryVirtualDiskUuid(name=path,
                                                                        datacenter=self._dc())
            except vim.fault.FileNotFound:
                return False
            except vim.fault.FileFault:                 # there, but locked or unreadable
                return True
            return True
        return await self._do("look for the disk", run)

    async def copy_disk(self, src: str, dst: str) -> None:
        def run():
            spec = vim.VirtualDiskManager.VirtualDiskSpec(diskType="thin", adapterType="lsiLogic")
            dc = self._dc()
            task = self._content().virtualDiskManager.CopyVirtualDisk_Task(
                sourceName=src, sourceDatacenter=dc, destName=dst, destDatacenter=dc,
                destSpec=spec, force=False)
            self._wait(task, "copy the seed disk")
        await self._do("copy the seed disk", run)

    async def delete_disk(self, path: str) -> None:
        await self._do("delete the half-copied disk", lambda: self._wait(
            self._content().virtualDiskManager.DeleteVirtualDisk_Task(name=path,
                                                                      datacenter=self._dc()),
            "delete the half-copied disk"))

    async def attach_disk(self, uuid: str, path: str) -> None:
        def run():
            vm = self._vm(uuid)
            controller = self._device(vm, vim.vm.device.ParaVirtualSCSIController,
                                      "That VM has no ParaVirtual SCSI controller.")
            disk = vim.vm.device.VirtualDisk(
                key=NEW_DISK_KEY, controllerKey=controller.key, unitNumber=0,
                backing=vim.vm.device.VirtualDisk.FlatVer2BackingInfo(
                    fileName=path, diskMode="persistent", thinProvisioned=True))
            spec = vim.vm.ConfigSpec(deviceChange=[
                vim.vm.device.VirtualDeviceSpec(operation="add", device=disk)])
            self._wait(vm.ReconfigVM_Task(spec=spec), "attach the disk")
        await self._do("attach the disk", run)

    async def grow_disk(self, uuid: str, disk_key: int, size_gb: int) -> None:
        def run():
            vm = self._vm(uuid)
            disk = self._device(vm, vim.vm.device.VirtualDisk,
                                "ESXi has no such disk on that VM.", disk_key)
            if size_gb * _KB_PER_GB <= int(disk.capacityInKB):
                return
            disk.capacityInKB = size_gb * _KB_PER_GB
            disk.capacityInBytes = size_gb * 1024 ** 3
            spec = vim.vm.ConfigSpec(deviceChange=[
                vim.vm.device.VirtualDeviceSpec(operation="edit", device=disk)])
            self._wait(vm.ReconfigVM_Task(spec=spec), "grow the disk")
        await self._do("grow the disk", run)

    async def set_size(self, uuid: str, cores: int, memory_mb: int) -> None:
        await self._do("resize the VM", self._reconfig, uuid,
                       vim.vm.ConfigSpec(numCPUs=cores, memoryMB=memory_mb), "resize the VM")

    async def set_extra_config(self, uuid: str, values: dict[str, str]) -> None:
        spec = vim.vm.ConfigSpec(extraConfig=[vim.option.OptionValue(key=k, value=v)
                                              for k, v in values.items()])
        await self._do("change the VM's settings", self._reconfig, uuid, spec,
                       "change the VM's settings")

    async def power_on(self, uuid: str) -> None:
        await self._do("start the VM", lambda: self._wait(self._vm(uuid).PowerOnVM_Task(),
                                                          "start the VM"))

    async def shutdown_guest(self, uuid: str) -> None:
        await self._do("shut down the guest", lambda: self._vm(uuid).ShutdownGuest())

    async def power_off(self, uuid: str) -> None:
        await self._do("power off the VM", lambda: self._wait(self._vm(uuid).PowerOffVM_Task(),
                                                              "power off the VM"))

    async def guest(self, uuid: str) -> Guest:
        def run():
            g = self._vm(uuid).guest
            return Guest(tools_running=str(g.toolsRunningStatus) == "guestToolsRunning",
                         ipv4=guest_ipv4(g))
        return await self._do("ask VMware Tools about the guest", run)

    async def snapshots(self, uuid: str) -> list[SnapshotInfo]:
        def run():
            vm = self._vm(uuid)
            return flatten_snapshots(vm.snapshot.rootSnapshotList if vm.snapshot else ())
        return await self._do("list the VM snapshots", run)

    async def take_snapshot(self, uuid: str, name: str, description: str, *,
                            quiesce: bool) -> None:
        await self._do("take a VM snapshot", lambda: self._wait(
            self._vm(uuid).CreateSnapshot_Task(name=name, description=description,
                                               memory=False, quiesce=quiesce),
            "take a VM snapshot", quiesce=quiesce), quiesce=quiesce)

    async def revert_snapshot(self, uuid: str, snapshot_id: int) -> None:
        def run():
            vm = self._vm(uuid)
            self._wait(self._snapshot_obj(vm, snapshot_id).RevertToSnapshot_Task(),
                       "restore the VM snapshot")
        await self._do("restore the VM snapshot", run)

    async def delete_snapshot(self, uuid: str, snapshot_id: int) -> None:
        def run():
            vm = self._vm(uuid)
            self._wait(self._snapshot_obj(vm, snapshot_id).RemoveSnapshot_Task(
                removeChildren=False), "delete a VM snapshot")
        await self._do("delete a VM snapshot", run)

    async def destroy(self, uuid: str) -> None:
        await self._do("destroy the VM", lambda: self._wait(self._vm(uuid).Destroy_Task(),
                                                            "destroy the VM"))


def _smart_connect(cfg: EsxiConfig):
    """The only call that opens a real ESXi session (tests guard it)."""
    host, port = split_url(cfg.url)
    return SmartConnect(host=host, port=port, user=cfg.user, pwd=cfg.password,
                        sslContext=tls_pin.pinned_context(cfg.tls_cert_pem,
                                                          check_hostname=False),
                        thumbprint=cfg.tls_fingerprint.replace(":", "").lower(),
                        httpConnectionTimeout=HTTP_TIMEOUT)


def _open(cfg: EsxiConfig):
    host, port = split_url(cfg.url)
    try:
        return _smart_connect(cfg)
    except vmodl.MethodFault as e:
        raise EsxiError(fault_reason(e, "sign in")) from None
    except Exception as e:  # noqa: BLE001 — the message may carry upstream text
        if _tls_refused(e):
            raise EsxiError(TLS_CHANGED) from None
        raise EsxiError(f"Couldn't reach ESXi at {host}:{port}.") from None


@contextlib.asynccontextmanager
async def connect(cfg: EsxiConfig) -> AsyncIterator[EsxiApi]:
    """A signed-in session for the length of the block, then signed out."""
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="esxi")
    opening = pool.submit(_open, cfg)
    try:
        si = await asyncio.wait_for(asyncio.wrap_future(opening), SIGN_IN_TIMEOUT)
    except BaseException as e:
        # The worker can't be interrupted: if it signs in after all, sign out.
        opening.add_done_callback(_sign_out_late)
        pool.shutdown(wait=False)
        if isinstance(e, TimeoutError):
            host, port = split_url(cfg.url)
            raise EsxiError(f"ESXi at {host}:{port} didn't answer in time.") from None
        raise
    try:
        yield PyvmomiEsxi(si, pool)
    finally:
        try:
            # Queued on the session's worker, so it runs after any call still in
            # flight; shielded, so a second cancel stops our wait, not the sign-out.
            closing = pool.submit(Disconnect, si)
            with contextlib.suppress(Exception):
                await asyncio.shield(asyncio.wrap_future(closing))
        finally:
            pool.shutdown(wait=False)


def _sign_out_late(opening) -> None:
    with contextlib.suppress(BaseException):
        if not opening.cancelled() and opening.exception() is None:
            Disconnect(opening.result())


async def test_connection(cfg: EsxiConfig, *, transport=None) -> ConnectResult:
    """Read-only: what the host is, then one check each for the license, the
    datastore, the port group, the resource pool and the seed VM. `transport`
    is unused (the other testers take one)."""
    checks: list[Check] = []
    try:
        async with connect(cfg) as api:
            try:
                about = await api.about()
            except EsxiError as e:
                raise ConnectFailed(e.reason) from None
            if about.api_type != "HostAgent":
                checks.append(Check("ESXi", "fail", f"This is {about.product}; Sirdar works "
                                                    "with a standalone ESXi host."))
            else:
                checks.append(Check("ESXi", "pass", about.product))

            async def license_() -> Check:
                editions = await api.license_editions()
                if any(e in FREE_EDITIONS for e in editions):
                    return Check("License", "fail", LICENSE_READ_ONLY)
                if not editions:
                    return Check("License", "warn", "ESXi didn't say which license it has.")
                return Check("License", "pass", ", ".join(editions))

            async def datastore() -> Check:
                ds = await api.datastore(cfg.datastore)
                if ds is None:
                    return Check("Datastore", "fail", f"No datastore named {cfg.datastore}.")
                if not ds.accessible:
                    return Check("Datastore", "fail", f"{cfg.datastore} isn't accessible.")
                return Check("Datastore", "pass", f"{cfg.datastore} · {ds.free_gb} GB free")

            async def network() -> Check:
                names = await api.network_names()
                if cfg.network in names:
                    return Check("Network", "pass", cfg.network)
                return Check("Network", "fail", f"No port group named {cfg.network} (found "
                                                f"{', '.join(names) or 'none'}).")

            async def pool() -> Check:
                if not cfg.resource_pool:
                    return Check("Resource pool", "pass", "The host's root pool")
                if cfg.resource_pool in await api.resource_pool_names():
                    return Check("Resource pool", "pass", cfg.resource_pool)
                return Check("Resource pool", "fail",
                             f"No resource pool named {cfg.resource_pool}.")

            async def seed() -> Check:
                vm = await api.find_vm_by_name(cfg.source_vm)
                if vm is None:
                    return Check("Seed VM", "fail", f"No VM named {cfg.source_vm}. Import the "
                                                    "Ubuntu 24.04 cloud image OVA with that "
                                                    "name (see the README).")
                if vm.power_state != "poweredOff":
                    return Check("Seed VM", "fail", f"{cfg.source_vm} is powered on. Power it "
                                                    "off and never start it: its disk is the "
                                                    "seed.")
                if len(vm.disks) != 1:
                    return Check("Seed VM", "fail", f"{cfg.source_vm} has {len(vm.disks)} "
                                                    "disks; the seed needs exactly one.")
                if vm.snapshot_count:
                    return Check("Seed VM", "fail", f"{cfg.source_vm} has snapshots. Delete "
                                                    "them so Sirdar copies one plain disk.")
                disk = vm.disks[0]
                return Check("Seed VM", "pass",
                             f"{cfg.source_vm} · {disk.path} · {disk.capacity_gb} GB")

            for label, check in (("License", license_), ("Datastore", datastore),
                                 ("Network", network), ("Resource pool", pool),
                                 ("Seed VM", seed)):
                try:
                    checks.append(await check())
                except EsxiError as e:
                    checks.append(Check(label, "fail", e.reason))
    except EsxiError as e:                       # signing in failed
        raise ConnectFailed(e.reason) from None
    facts = {"url": cfg.url, "version": about.version, "build": about.build,
             "fingerprint": cfg.tls_fingerprint, "user": cfg.user}
    return ConnectResult(ok=not any(c.status == "fail" for c in checks), target="esxi",
                         checks=checks, facts=facts)


test_connection.__test__ = False  # not a pytest test, despite the name
