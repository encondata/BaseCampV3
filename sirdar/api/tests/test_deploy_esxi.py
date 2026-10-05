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
