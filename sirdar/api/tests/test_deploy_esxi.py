import ssl
from types import SimpleNamespace

import pytest
from pyVmomi import vim, vmodl

from sirdar_api.deploy import ConnectFailed, esxi, integrations
from sirdar_api.deploy.esxi import CreateSpec, EsxiError

from .esxi_helpers import esxi_fake  # noqa: F401
from .fake_esxi import SEED
from .integration_helpers import ESXI_CERT, ESXI_FINGERPRINT, ESXI_PASSWORD

CFG = integrations.EsxiConfig(
    url="https://10.10.48.10", user="sirdar", datastore="datastore1", network="VM Network",
    resource_pool=None, source_vm=SEED, dns_servers=(), tls_fingerprint=ESXI_FINGERPRINT,
    tls_cert_pem=ESXI_CERT, password=ESXI_PASSWORD)


def test_paths():
    assert esxi.split_url("https://10.10.48.10") == ("10.10.48.10", 443)
    assert esxi.split_url("https://esx.lab:8443") == ("esx.lab", 8443)
    assert esxi.vm_folder("[datastore1] ss-uat3/ss-uat3.vmx") == "[datastore1] ss-uat3"
    assert esxi.vm_folder("[SSD 2] ss-uat3_1/ss-uat3.vmx") == "[SSD 2] ss-uat3_1"
    assert esxi.disk_path_for("[datastore1] ss-uat3/ss-uat3.vmx", "ss-uat3") == (
        "[datastore1] ss-uat3/ss-uat3-disk0.vmdk")
    for bad in ("ss-uat3.vmx", "[datastore1] ss-uat3.vmx", ""):
        with pytest.raises(ValueError):
            esxi.vm_folder(bad)


@pytest.mark.parametrize(("fault", "expected"), [
    (vim.fault.InvalidLogin(), "ESXi rejected the user name or password."),
    (vim.fault.RestrictedVersion(), esxi.LICENSE_READ_ONLY),
    (vim.fault.NoPermission(), "The ESXi user isn't allowed to create the VM."),
    (vmodl.fault.SecurityError(), "The ESXi user isn't allowed to create the VM."),
    (vim.fault.DuplicateName(), "ESXi couldn't create the VM: the name or file already exists."),
    (vim.fault.FileNotFound(), "ESXi couldn't create the VM: a file it needs is missing."),
    (vim.fault.NoDiskSpace(), "ESXi couldn't create the VM: not enough disk space or resources."),
    (vim.fault.InvalidPowerState(),
     "ESXi couldn't create the VM: the VM's power state doesn't allow it."),
])
def test_faults_become_our_copy(fault, expected):
    fault.msg = "raw ESXi text with a SECRET"
    assert esxi.fault_reason(fault, "create the VM") == expected


def test_an_unknown_fault_names_only_its_class():
    fault = vim.fault.TaskInProgress(msg="raw text")
    reason = esxi.fault_reason(fault, "start the VM")
    assert reason.startswith("ESXi couldn't start the VM (") and "raw text" not in reason


def test_create_config():
    spec = CreateSpec(name="ss-uat3", datastore="datastore1", network="VM Network",
                      resource_pool=None, cores=4, memory_mb=8192, annotation="sirdar:abc",
                      extra_config={esxi.OWNER_KEY: "abc", "guestinfo.userdata": "c2VjcmV0"})
    config = esxi.create_config(spec, network=None)
    assert (config.name, config.guestId, config.numCPUs, config.memoryMB, config.annotation,
            config.files.vmPathName) == ("ss-uat3", "ubuntu64Guest", 4, 8192, "sirdar:abc",
                                         "[datastore1]")
    extra = {o.key: o.value for o in config.extraConfig}
    assert extra[esxi.OWNER_KEY] == "abc" and extra["disk.EnableUUID"] == "TRUE"
    kinds = [type(c.device) for c in config.deviceChange]
    assert kinds == [vim.vm.device.ParaVirtualSCSIController, vim.vm.device.VirtualVmxnet3]
    nic = config.deviceChange[1].device
    assert nic.backing.deviceName == "VM Network" and nic.connectable.startConnected
    assert "c2VjcmV0" not in repr(spec)


def test_vm_info_reads_disks_owner_and_snapshots():
    disk = vim.vm.device.VirtualDisk(key=2000, capacityInKB=64 * 1024 * 1024,
                                     backing=vim.vm.device.VirtualDisk.FlatVer2BackingInfo(
                                         fileName="[datastore1] ss-uat3/ss-uat3-disk0.vmdk"))
    tree = [SimpleNamespace(id=1, name="sirdar-20261005T120000Z", description="d",
                            createTime=None,
                            childSnapshotList=[SimpleNamespace(id=2, name="by hand",
                                                               description="", createTime=None,
                                                               childSnapshotList=[])])]
    vm = SimpleNamespace(
        _moId="12", runtime=SimpleNamespace(powerState="poweredOn"),
        snapshot=SimpleNamespace(rootSnapshotList=tree),
        config=SimpleNamespace(
            instanceUuid="52aa", name="ss-uat3", template=False,
            files=SimpleNamespace(vmPathName="[datastore1] ss-uat3/ss-uat3.vmx"),
            extraConfig=[SimpleNamespace(key=esxi.OWNER_KEY, value="env-1")],
            hardware=SimpleNamespace(numCPU=4, memoryMB=8192,
                                     device=[vim.vm.device.VirtualVmxnet3(key=4000), disk])))
    info = esxi.vm_info(vm)
    assert (info.moref, info.instance_uuid, info.owner, info.power_state, info.cores,
            info.memory_mb, info.disk_gb, info.snapshot_count) == (
        "12", "52aa", "env-1", "poweredOn", 4, 8192, 64, 2)
    assert [s.name for s in esxi.flatten_snapshots(tree)] == ["sirdar-20261005T120000Z",
                                                              "by hand"]


def test_vm_info_reports_a_snapshotted_disk_by_its_base_file():
    """Once a VM has a snapshot, ESXi's backing.fileName is the delta; the
    base is the root of backing.parent."""
    Backing = vim.vm.device.VirtualDisk.FlatVer2BackingInfo
    base = Backing(fileName="[datastore1] ss-uat3/ss-uat3-disk0.vmdk")
    middle = Backing(fileName="[datastore1] ss-uat3/ss-uat3-disk0-000001.vmdk", parent=base)
    delta = Backing(fileName="[datastore1] ss-uat3/ss-uat3-disk0-000002.vmdk", parent=middle)
    disk = vim.vm.device.VirtualDisk(key=2000, capacityInKB=64 * 1024 * 1024, backing=delta)
    vm = SimpleNamespace(
        _moId="12", runtime=SimpleNamespace(powerState="poweredOn"), snapshot=None,
        config=SimpleNamespace(
            instanceUuid="52aa", name="ss-uat3", template=False,
            files=SimpleNamespace(vmPathName="[datastore1] ss-uat3/ss-uat3.vmx"),
            extraConfig=[], hardware=SimpleNamespace(numCPU=4, memoryMB=8192, device=[disk])))
    [info] = esxi.vm_info(vm).disks
    assert info.path == "[datastore1] ss-uat3/ss-uat3-disk0.vmdk"
    assert info.current == "[datastore1] ss-uat3/ss-uat3-disk0-000002.vmdk"


def test_guest_ipv4_skips_link_local_and_non_virtual_nics():
    def nic(device, *ips):
        return SimpleNamespace(deviceConfigId=device, ipAddress=list(ips),
                               ipConfig=SimpleNamespace(ipAddress=[
                                   SimpleNamespace(ipAddress=i) for i in ips]))
    guest = SimpleNamespace(ipAddress="10.10.48.71", net=[
        nic(-1, "172.17.0.1"), nic(4000, "fe80::1", "169.254.3.4", "10.10.48.71")])
    assert esxi.guest_ipv4(guest) == ("10.10.48.71",)
    assert esxi.guest_ipv4(SimpleNamespace(ipAddress=None, net=None)) == ()


async def test_the_test_passes_on_a_good_host(esxi_fake):
    result = await esxi.test_connection(CFG)
    assert result.ok and result.target == "esxi"
    assert [c.label for c in result.checks] == ["ESXi", "License", "Datastore", "Network",
                                                "Resource pool", "Seed VM"]
    assert result.facts == {"url": CFG.url, "version": "7.0.3", "build": "21930508",
                            "fingerprint": ESXI_FINGERPRINT, "user": "sirdar"}
    assert esxi_fake.logins == [(CFG.url, "sirdar")]


async def test_the_test_names_each_problem(esxi_fake):
    esxi_fake.editions = ["esxBasic"]
    esxi_fake.datastores["datastore1"] = esxi.DatastoreInfo("datastore1", False, 0, 0)
    esxi_fake.networks = ["Management Network"]
    esxi_fake.by_name(SEED).power_state = "poweredOn"
    cfg = integrations.EsxiConfig(**{**CFG.__dict__, "resource_pool": "sirdar"})
    result = await esxi.test_connection(cfg)
    status = {c.label: (c.status, c.value) for c in result.checks}
    assert not result.ok
    assert status["License"] == ("fail", esxi.LICENSE_READ_ONLY)
    assert status["Datastore"][0] == "fail" and status["Network"][0] == "fail"
    assert status["Resource pool"] == ("fail", "No resource pool named sirdar.")
    assert status["Seed VM"][0] == "fail" and "powered on" in status["Seed VM"][1]


async def test_a_vcenter_is_refused(esxi_fake):
    esxi_fake.about_ = esxi.About("VMware vCenter Server 7.0.3", "7.0.3", "1", "VirtualCenter")
    result = await esxi.test_connection(CFG)
    assert result.checks[0].status == "fail" and "standalone ESXi" in result.checks[0].value


async def test_a_seed_with_snapshots_or_two_disks_is_refused(esxi_fake):
    seed = esxi_fake.by_name(SEED)
    seed.snapshots.append(esxi.SnapshotInfo(1, "base", "", None))
    result = await esxi.test_connection(CFG)
    assert "snapshots" in result.checks[-1].value
    seed.snapshots.clear()
    seed.disks.append(esxi.DiskInfo(2001, "[datastore1] x.vmdk", 1))
    result = await esxi.test_connection(CFG)
    assert "2 disks" in result.checks[-1].value


async def test_a_failed_sign_in_is_connect_failed(esxi_fake):
    esxi_fake.fail["connect"] = EsxiError("ESXi rejected the user name or password.")
    with pytest.raises(ConnectFailed) as e:
        await esxi.test_connection(CFG)
    assert e.value.reason == "ESXi rejected the user name or password."


def test_the_tls_refusal_is_recognized():
    err = OSError("wrapped")
    err.__cause__ = ssl.SSLCertVerificationError("bad cert")
    assert esxi._tls_refused(err) and not esxi._tls_refused(OSError("refused"))


async def test_the_guard_refuses_a_real_esxi(no_real_hosts):
    with pytest.raises(EsxiError):
        async with esxi.connect(CFG):
            pass
    assert no_real_hosts == ["esxi:10.10.48.10"]
    no_real_hosts.clear()


def test_the_password_never_reaches_a_repr():
    assert ESXI_PASSWORD not in repr(CFG)


# ---- review fixes: the real client's edges, over hand-made pyVmomi stand-ins --------

def _client(content=None, **kw):
    import concurrent.futures
    si = SimpleNamespace(RetrieveContent=lambda: content)
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    return esxi.PyvmomiEsxi(si, pool, **kw), pool


def _content_with_vm(vm):
    return SimpleNamespace(searchIndex=SimpleNamespace(
        FindByUuid=lambda *a: vm), rootFolder=SimpleNamespace(childEntity=[]))


async def test_a_host_without_a_datacenter_is_our_copy_not_a_runtime_error():
    api, pool = _client(SimpleNamespace(rootFolder=SimpleNamespace(childEntity=[])))
    with pytest.raises(EsxiError) as e:
        await api.datastore("datastore1")
    assert e.value.reason == "ESXi has no datacenter."
    pool.shutdown()


async def test_a_stray_stop_iteration_or_runtime_error_is_malformed():
    api, pool = _client()

    def stop():
        return next(iter(()))

    for fn in (stop, lambda: (_ for _ in ()).throw(RuntimeError("raw"))):
        with pytest.raises(EsxiError) as e:
            await api._do("x", fn)
        assert e.value.reason == esxi.MALFORMED
    pool.shutdown()


async def test_missing_devices_are_named():
    vm = SimpleNamespace(config=SimpleNamespace(hardware=SimpleNamespace(device=[])))
    api, pool = _client(_content_with_vm(vm))
    with pytest.raises(EsxiError) as e:
        await api.attach_disk("52aa", "[datastore1] x/x-disk0.vmdk")
    assert e.value.reason == "That VM has no ParaVirtual SCSI controller."
    with pytest.raises(EsxiError) as e:
        await api.grow_disk("52aa", 2000, 64)
    assert e.value.reason == "ESXi has no such disk on that VM."
    pool.shutdown()


class _Task:
    """A vSphere task stand-in. A running one finishes by itself after a
    second, so a client that never cancels it can't hang the test run."""

    def __init__(self, state="running", error=None):
        import time as time_
        self._info = SimpleNamespace(state=state, error=error, result=None)
        self._ends = time_.monotonic() + 1.0
        self.cancelled = 0

    @property
    def info(self):
        import time as time_
        if self._info.state == "running" and time_.monotonic() >= self._ends:
            self._info.state = "success"
        return self._info

    def CancelTask(self):
        self.cancelled += 1


async def test_a_task_that_runs_too_long_is_cancelled():
    task = _Task()
    vm = SimpleNamespace(PowerOnVM_Task=lambda: task)
    api, pool = _client(_content_with_vm(vm), poll=0.01, task_timeout=0)
    with pytest.raises(EsxiError) as e:
        await api.power_on("52aa")
    assert "didn't finish" in e.value.reason and task.cancelled == 1
    pool.shutdown()


async def test_a_cancelled_call_cancels_its_esxi_task():
    import asyncio
    task = _Task()
    vm = SimpleNamespace(PowerOnVM_Task=lambda: task)
    api, pool = _client(_content_with_vm(vm), poll=0.01)
    call = asyncio.ensure_future(api.power_on("52aa"))
    await asyncio.sleep(0.05)
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    for _ in range(50):
        if task.cancelled:
            break
        await asyncio.sleep(0.01)
    assert task.cancelled == 1
    pool.shutdown(wait=True)


@pytest.mark.parametrize("fault", [vim.fault.SnapshotFault(),
                                   vim.fault.FilesystemQuiesceFault(),
                                   vim.fault.ApplicationQuiesceFault()])
async def test_any_snapshot_fault_while_quiescing_is_quiesce_failed(fault):
    task = _Task("error", fault)
    vm = SimpleNamespace(CreateSnapshot_Task=lambda **kw: task)
    api, pool = _client(_content_with_vm(vm))
    with pytest.raises(esxi.QuiesceFailed):
        await api.take_snapshot("52aa", "s", "", quiesce=True)
    pool.shutdown()


async def test_a_snapshot_fault_without_quiescing_is_a_plain_error():
    task = _Task("error", vim.fault.SnapshotFault())
    vm = SimpleNamespace(CreateSnapshot_Task=lambda **kw: task)
    api, pool = _client(_content_with_vm(vm))
    with pytest.raises(EsxiError) as e:
        await api.take_snapshot("52aa", "s", "", quiesce=False)
    assert not isinstance(e.value, esxi.QuiesceFailed)
    pool.shutdown()


@pytest.mark.parametrize(("fault", "exists"), [(vim.fault.FileNotFound(), False),
                                               (vim.fault.FileLocked(), True),
                                               (None, True)])
async def test_file_exists_treats_only_file_not_found_as_absent(monkeypatch, fault, exists):
    def query(**kw):
        if fault is not None:
            raise fault
        return "uuid"
    content = SimpleNamespace(virtualDiskManager=SimpleNamespace(QueryVirtualDiskUuid=query))
    api, pool = _client(content)
    monkeypatch.setattr(api, "_dc", lambda: None)
    assert await api.file_exists("[datastore1] x/x-disk0.vmdk") is exists
    pool.shutdown()


def test_an_ambiguous_resource_pool_is_refused(monkeypatch):
    def pool(name, *children):
        return SimpleNamespace(name=name, resourcePool=list(children))
    root = pool("Resources", pool("sirdar"), pool("lab", pool("sirdar")), pool("other"))
    api, executor = _client()
    monkeypatch.setattr(api, "_host", lambda: (SimpleNamespace(resourcePool=root), None))
    assert api._pool_named("other").name == "other"
    assert api._pool_named("missing") is None
    with pytest.raises(EsxiError) as e:
        api._pool_named("sirdar")
    assert e.value.reason == ("ESXi has more than one resource pool named sirdar; Sirdar "
                              "won't pick one.")
    executor.shutdown()


async def test_a_sign_in_that_hangs_times_out(monkeypatch):
    import time as time_
    monkeypatch.setattr(esxi, "SIGN_IN_TIMEOUT", 0.1)
    monkeypatch.setattr(esxi, "_smart_connect", lambda cfg: time_.sleep(0.5))
    with pytest.raises(ConnectFailed) as e:
        await esxi.test_connection(CFG)
    assert e.value.reason == "ESXi at 10.10.48.10:443 didn't answer in time."


async def test_the_session_is_closed_even_on_a_second_cancel(monkeypatch):
    import asyncio
    import threading
    closed = threading.Event()
    monkeypatch.setattr(esxi, "_smart_connect", lambda cfg: "si")

    def disconnect(si):
        import time as time_
        time_.sleep(0.1)
        closed.set()
    monkeypatch.setattr(esxi, "Disconnect", disconnect)
    entered = asyncio.Event()

    async def body():
        async with esxi.connect(CFG):
            entered.set()
            await asyncio.sleep(10)

    run = asyncio.ensure_future(body())
    await entered.wait()
    run.cancel()
    await asyncio.sleep(0.01)
    run.cancel()
    with pytest.raises(asyncio.CancelledError):
        await run
    await asyncio.to_thread(closed.wait, 2)
    assert closed.is_set()


# ---- the fake is as strict as ESXi --------------------------------------------------

async def test_the_fake_is_strict(esxi_fake):
    seed = esxi_fake.by_name(SEED)
    vm = esxi_fake.add_vm("ss-uat3", power_state="poweredOff")
    with pytest.raises(EsxiError) as e:
        await esxi_fake.attach_disk(vm.instance_uuid, "[datastore1] nope.vmdk")
    assert e.value.reason == "ESXi couldn't attach the disk: a file it needs is missing."
    with pytest.raises(EsxiError):
        await esxi_fake.delete_disk("[datastore1] nope.vmdk")
    with pytest.raises(EsxiError):
        await esxi_fake.delete_snapshot(vm.instance_uuid, 999)
    with pytest.raises(EsxiError):
        await esxi_fake.grow_disk(seed.instance_uuid, 9999, 64)
    await esxi_fake.power_on(vm.instance_uuid)
    with pytest.raises(EsxiError) as e:
        await esxi_fake.power_on(vm.instance_uuid)
    assert "power state" in e.value.reason
    await esxi_fake.power_off(vm.instance_uuid)
    esxi_fake.quiesce_fails = True
    await esxi_fake.take_snapshot(vm.instance_uuid, "s", "", quiesce=True)   # off: ignored
    assert len(vm.snapshots) == 1


def _listed_vm(name, *, ips=(), disk=None, config=True):
    nics = [SimpleNamespace(deviceConfigId=4000, ipAddress=list(ips), ipConfig=None)]
    devices = []
    if disk is not None:
        devices.append(vim.vm.device.VirtualDisk(
            key=2000, capacityInKB=64 * 1024 * 1024, backing=disk))
    return SimpleNamespace(
        name=name, guest=SimpleNamespace(ipAddress=None, net=nics),
        config=SimpleNamespace(name=name, hardware=SimpleNamespace(device=devices))
        if config else None)


async def test_guest_ips_lists_every_vm_that_reports_an_address(monkeypatch):
    api, pool = _client()
    monkeypatch.setattr(api, "_all_vms", lambda: [
        _listed_vm("legacy", ips=("10.10.48.71", "fe80::1")), _listed_vm("quiet"),
        _listed_vm("orphan", ips=("10.10.48.72",), config=False)])
    assert await api.guest_ips() == [("legacy", ("10.10.48.71",)),
                                     ("orphan", ("10.10.48.72",))]
    pool.shutdown()


async def test_disk_users_finds_a_disk_as_base_or_current_delta(monkeypatch):
    Backing = vim.vm.device.VirtualDisk.FlatVer2BackingInfo
    path = "[datastore1] ss-uat3/ss-uat3-disk0.vmdk"
    base = Backing(fileName=path)
    delta = Backing(fileName="[datastore1] ss-uat3/ss-uat3-disk0-000001.vmdk", parent=base)
    api, pool = _client()
    monkeypatch.setattr(api, "_all_vms", lambda: [
        _listed_vm("a", disk=Backing(fileName=path)), _listed_vm("b", disk=delta),
        _listed_vm("c", disk=Backing(fileName="[datastore1] c/c.vmdk")),
        _listed_vm("gone", config=False)])
    assert await api.disk_users(path) == ["a", "b"]
    assert await api.disk_users("[datastore1] x/x.vmdk") == []
    pool.shutdown()
