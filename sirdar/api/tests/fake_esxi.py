"""An in-memory standalone ESXi host for tests: the esxi.EsxiApi protocol
over plain records. It acts the way ESXi does where Sirdar depends on it:
VM names are unique, a disk with snapshots can't grow, CPU and memory change
only while the VM is off, a disk-only snapshot reverts to a powered-off VM,
destroying a running VM is refused, and a snapshot moves each disk's writes to
a new delta file (DiskInfo.current, "-00000N.vmdk") while DiskInfo.path stays
the base, as esxi.disk_info reads the backing.parent chain. `fail[method] = EsxiError(...)` makes
a method fail; `logins` records (url, user) — never the password. Missing
files, disks and snapshots, and a power-on of a running VM, fail the way
ESXi's faults do (through esxi.fault_reason)."""

import contextlib
import itertools
from dataclasses import dataclass, field, replace

from pyVmomi import vim

from sirdar_api.deploy import esxi
from sirdar_api.deploy.esxi import (
    About,
    DatastoreInfo,
    DiskInfo,
    EsxiError,
    Guest,
    QuiesceFailed,
    SnapshotInfo,
    VmInfo,
)

SEED = "sirdar-ubuntu-2404-seed"
SEED_DISK = f"[datastore1] {SEED}/{SEED}.vmdk"


@dataclass
class FakeVm:
    moref: str
    instance_uuid: str
    name: str
    vm_path: str
    owner: str = ""
    annotation: str = ""
    extra: dict = field(default_factory=dict)
    cores: int = 2
    memory_mb: int = 2048
    disks: list = field(default_factory=list)          # [DiskInfo]
    power_state: str = "poweredOff"
    tools_running: bool = False
    ipv4: tuple = ()
    snapshots: list = field(default_factory=list)      # [SnapshotInfo]
    template: bool = False
    deltas: int = 0                                    # delta files made so far

    def new_delta(self) -> None:
        """Writes go to a new delta whose parent chain ends at the base."""
        self.deltas += 1
        self.disks = [replace(d, current=f"{d.path.removesuffix('.vmdk')}-{self.deltas:06d}.vmdk")
                      for d in self.disks]

    def info(self) -> VmInfo:
        return VmInfo(moref=self.moref, instance_uuid=self.instance_uuid, name=self.name,
                      owner=self.owner, power_state=self.power_state, vm_path=self.vm_path,
                      cores=self.cores, memory_mb=self.memory_mb, disks=tuple(self.disks),
                      snapshot_count=len(self.snapshots), template=self.template)


class FakeEsxi:
    def __init__(self):
        self.about_ = About("VMware ESXi 7.0.3 build-21930508", "7.0.3", "21930508",
                            "HostAgent")
        self.editions = ["esx.enterprisePlus.cpuPackage"]
        self.datastores = {"datastore1": DatastoreInfo("datastore1", True, 800, 1800)}
        self.networks = ["VM Network"]
        self.pools: list[str] = []
        self.files: dict[str, int] = {}                # disk path -> size in GB
        self.vms: dict[str, FakeVm] = {}               # by instance UUID
        self.calls: list[str] = []
        self.fail: dict[str, EsxiError] = {}
        self.specs: list = []                          # every CreateSpec
        self.quiesce_fails = False
        self.shutdown_stalls = False
        self.boot_ips: tuple = ("127.0.0.1",)          # what Tools reports once a VM runs
        self.logins: list[tuple[str, str]] = []
        self._ids = itertools.count(10)

    # ---- set-up helpers ----------------------------------------------------------
    def add_vm(self, name: str, *, owner: str = "", power_state: str = "poweredOn",
               ips: tuple = (), disks: list | None = None, vm_path: str | None = None) -> FakeVm:
        n = next(self._ids)
        vm = FakeVm(moref=str(n), instance_uuid=f"52aa0000-0000-0000-0000-{n:012d}", name=name,
                    vm_path=vm_path or f"[datastore1] {name}/{name}.vmx", owner=owner,
                    extra={esxi.OWNER_KEY: owner} if owner else {},
                    disks=list(disks or []), power_state=power_state,
                    tools_running=power_state == "poweredOn", ipv4=tuple(ips))
        self.vms[vm.instance_uuid] = vm
        return vm

    def add_seed(self, name: str = SEED, size_gb: int = 3) -> FakeVm:
        path = f"[datastore1] {name}/{name}.vmdk"
        self.files[path] = size_gb
        return self.add_vm(name, power_state="poweredOff",
                           disks=[DiskInfo(2000, path, size_gb)])

    def by_name(self, name: str) -> FakeVm | None:
        return next((v for v in self.vms.values() if v.name == name), None)

    # ---- the seam ----------------------------------------------------------------
    @contextlib.asynccontextmanager
    async def connect(self, cfg):
        self._call("connect")
        self.logins.append((cfg.url, cfg.user))
        yield self

    def _call(self, name: str) -> None:
        self.calls.append(name)
        if name in self.fail:
            raise self.fail[name]

    def _vm(self, uuid: str) -> FakeVm:
        vm = self.vms.get(uuid)
        if vm is None:
            raise EsxiError("ESXi has no VM with that id.")
        return vm

    # ---- EsxiApi -----------------------------------------------------------------
    async def about(self) -> About:
        self._call("about")
        return self.about_

    async def license_editions(self) -> list[str]:
        self._call("license_editions")
        return list(self.editions)

    async def datastore(self, name: str) -> DatastoreInfo | None:
        self._call("datastore")
        return self.datastores.get(name)

    async def network_names(self) -> list[str]:
        self._call("network_names")
        return list(self.networks)

    async def resource_pool_names(self) -> list[str]:
        self._call("resource_pool_names")
        return list(self.pools)

    async def find_vm(self, instance_uuid: str) -> VmInfo | None:
        self._call("find_vm")
        vm = self.vms.get(instance_uuid)
        return vm.info() if vm else None

    async def find_vm_by_name(self, name: str) -> VmInfo | None:
        self._call("find_vm_by_name")
        found = [v for v in self.vms.values() if v.name == name]
        if len(found) > 1:
            raise EsxiError(f"ESXi has more than one VM named {name}; Sirdar won't pick one.")
        return found[0].info() if found else None

    async def guest_ips(self) -> list[tuple[str, tuple[str, ...]]]:
        self._call("guest_ips")
        return [(v.name, tuple(v.ipv4)) for v in self.vms.values() if v.ipv4]

    async def disk_users(self, path: str) -> list[str]:
        self._call("disk_users")
        return sorted({v.name for v in self.vms.values()
                       if any(path in (d.path, d.current) for d in v.disks)})

    async def create_vm(self, spec) -> VmInfo:
        self._call("create_vm")
        if self.by_name(spec.name):
            raise EsxiError("ESXi couldn't create the VM: the name or file already exists.")
        self.specs.append(spec)
        vm = self.add_vm(spec.name, owner=spec.extra_config.get(esxi.OWNER_KEY, ""),
                         power_state="poweredOff",
                         vm_path=f"[{spec.datastore}] {spec.name}/{spec.name}.vmx")
        vm.extra = dict(spec.extra_config)
        vm.annotation, vm.cores, vm.memory_mb = spec.annotation, spec.cores, spec.memory_mb
        return vm.info()

    async def file_exists(self, path: str) -> bool:
        self._call("file_exists")
        return path in self.files

    async def copy_disk(self, src: str, dst: str) -> None:
        self._call("copy_disk")
        if src not in self.files:
            raise EsxiError("ESXi couldn't copy the seed disk: a file it needs is missing.")
        if dst in self.files:
            raise EsxiError("ESXi couldn't copy the seed disk: the name or file already exists.")
        self.files[dst] = self.files[src]

    async def delete_disk(self, path: str) -> None:
        self._call("delete_disk")
        if path not in self.files:
            raise EsxiError(esxi.fault_reason(vim.fault.FileNotFound(),
                                              "delete the half-copied disk"))
        del self.files[path]

    async def attach_disk(self, uuid: str, path: str) -> None:
        self._call("attach_disk")
        vm = self._vm(uuid)
        if path not in self.files:
            raise EsxiError(esxi.fault_reason(vim.fault.FileNotFound(), "attach the disk"))
        vm.disks.append(DiskInfo(2000 + len(vm.disks), path, self.files[path]))

    async def grow_disk(self, uuid: str, disk_key: int, size_gb: int) -> None:
        self._call("grow_disk")
        vm = self._vm(uuid)
        if not any(d.key == disk_key for d in vm.disks):
            raise EsxiError("ESXi has no such disk on that VM.")
        if vm.snapshots:
            raise EsxiError("ESXi couldn't grow the disk (vim.fault.InvalidSnapshotFormat).")
        vm.disks = [replace(d, capacity_gb=max(d.capacity_gb, size_gb)) if d.key == disk_key
                    else d for d in vm.disks]
        for d in vm.disks:
            self.files[d.path] = d.capacity_gb

    async def set_size(self, uuid: str, cores: int, memory_mb: int) -> None:
        self._call("set_size")
        vm = self._vm(uuid)
        if vm.power_state != "poweredOff":
            raise EsxiError("ESXi couldn't resize the VM: the VM's power state doesn't allow it.")
        vm.cores, vm.memory_mb = cores, memory_mb

    async def set_extra_config(self, uuid: str, values: dict[str, str]) -> None:
        self._call("set_extra_config")
        vm = self._vm(uuid)
        for key, value in values.items():
            if value == "":
                vm.extra.pop(key, None)
            else:
                vm.extra[key] = value

    async def power_on(self, uuid: str) -> None:
        self._call("power_on")
        vm = self._vm(uuid)
        if vm.power_state == "poweredOn":
            raise EsxiError(esxi.fault_reason(vim.fault.InvalidPowerState(), "start the VM"))
        vm.power_state, vm.tools_running, vm.ipv4 = "poweredOn", True, tuple(self.boot_ips)

    async def shutdown_guest(self, uuid: str) -> None:
        self._call("shutdown_guest")
        vm = self._vm(uuid)
        if not vm.tools_running:
            raise EsxiError("ESXi couldn't shut down the guest (vim.fault.ToolsUnavailable).")
        if not self.shutdown_stalls:
            vm.power_state, vm.tools_running, vm.ipv4 = "poweredOff", False, ()

    async def power_off(self, uuid: str) -> None:
        self._call("power_off")
        vm = self._vm(uuid)
        vm.power_state, vm.tools_running, vm.ipv4 = "poweredOff", False, ()

    async def guest(self, uuid: str) -> Guest:
        self._call("guest")
        vm = self._vm(uuid)
        return Guest(tools_running=vm.tools_running, ipv4=tuple(vm.ipv4))

    async def snapshots(self, uuid: str) -> list[SnapshotInfo]:
        self._call("snapshots")
        return list(self._vm(uuid).snapshots)

    async def take_snapshot(self, uuid: str, name: str, description: str, *,
                            quiesce: bool) -> None:
        self._call("take_snapshot")
        vm = self._vm(uuid)
        # ESXi ignores quiesce on a VM that's off: there's no guest to quiesce.
        if quiesce and self.quiesce_fails and vm.power_state == "poweredOn":
            raise QuiesceFailed("ESXi couldn't quiesce the guest's file systems.")
        vm.snapshots.append(SnapshotInfo(next(self._ids), name, description, None))
        vm.new_delta()

    async def revert_snapshot(self, uuid: str, snapshot_id: int) -> None:
        self._call("revert_snapshot")
        vm = self._vm(uuid)
        if not any(s.id == snapshot_id for s in vm.snapshots):
            raise EsxiError("ESXi has no such snapshot.")
        vm.power_state, vm.tools_running, vm.ipv4 = "poweredOff", False, ()
        vm.new_delta()

    async def delete_snapshot(self, uuid: str, snapshot_id: int) -> None:
        self._call("delete_snapshot")
        vm = self._vm(uuid)
        if not any(s.id == snapshot_id for s in vm.snapshots):
            raise EsxiError("ESXi has no such snapshot.")
        vm.snapshots = [s for s in vm.snapshots if s.id != snapshot_id]
        if not vm.snapshots:                           # consolidated back into the base
            vm.disks = [replace(d, current="") for d in vm.disks]

    async def destroy(self, uuid: str) -> None:
        self._call("destroy")
        vm = self._vm(uuid)
        if vm.power_state != "poweredOff":
            raise EsxiError("ESXi couldn't destroy the VM: the VM's power state doesn't allow it.")
        for d in vm.disks:
            self.files.pop(d.path, None)
        del self.vms[uuid]
