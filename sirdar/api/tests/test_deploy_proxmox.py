from dataclasses import replace

import pytest

from sirdar_api.deploy import ConnectFailed, proxmox
from sirdar_api.deploy.integrations import ProxmoxConfig
from sirdar_api.deploy.proxmox import AgentNotReady, Proxmox, ProxmoxError

from .fake_proxmox import FakeProxmox
from .integration_helpers import PX_CERT, PX_FINGERPRINT, PX_TOKEN, PX_TOKEN_SECRET
from .proxmox_helpers import no_sleep

CFG = ProxmoxConfig(url="https://10.10.48.5:8006", node="pve", pool="sirdar",
                    storage="local-lvm", bridge="vmbr0", vlan_tag=None, template_vmid=9000,
                    tls_fingerprint=PX_FINGERPRINT, tls_cert_pem=PX_CERT, token=PX_TOKEN)
HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheTests0000000000000000000 root@vm"


def api(fake: FakeProxmox, cfg: ProxmoxConfig = CFG, **kw) -> Proxmox:
    return Proxmox(cfg, transport=fake.transport(), sleep=no_sleep, **kw)


def test_split_url():
    assert proxmox.split_url("https://10.10.48.5:8006") == ("10.10.48.5", 8006)
    assert proxmox.split_url("https://pve.lab") == ("pve.lab", 8006)


async def test_a_healthy_host_passes_every_check():
    fake = FakeProxmox()
    result = await proxmox.test_connection(CFG, transport=fake.transport())
    assert result.ok and result.target == "proxmox"
    assert [(c.label, c.status) for c in result.checks] == [
        ("Proxmox", "pass"), ("Node", "pass"), ("Pool", "pass"), ("Template", "pass"),
        ("Storage", "pass"), ("Bridge", "pass")]
    values = {c.label: c.value for c in result.checks}
    assert values["Proxmox"] == "Version 9.0.10"
    assert values["Pool"] == "sirdar · 1 VMs"
    assert values["Template"] == "ubuntu-2404-template (9000)"
    assert values["Storage"] == "local-lvm · 500 GB free"
    assert result.facts == {"url": "https://10.10.48.5:8006", "node": "pve",
                            "version": "9.0.10", "fingerprint": PX_FINGERPRINT,
                            "token_id": "sirdar@pve!sirdar"}
    assert PX_TOKEN_SECRET not in repr(result.as_dict())


async def test_problems_show_as_failed_checks():
    fake = FakeProxmox()
    fake.vms[9000]["template"] = 0
    fake.storage["active"] = 0
    fake.bridges = set()
    fake.fail[("GET", "/pools")] = 403
    result = await proxmox.test_connection(CFG, transport=fake.transport())
    assert not result.ok
    by = {c.label: (c.status, c.value) for c in result.checks}
    assert by["Template"] == ("fail", "VM 9000 (ubuntu-2404-template) isn't a template.")
    assert by["Storage"] == ("fail", "local-lvm isn't active or can't hold VM disks.")
    assert by["Bridge"] == ("fail", "No bridge named vmbr0 on pve.")
    assert by["Pool"] == ("fail", "The API token isn't allowed to read the pool. Check its "
                                  "privileges (see the README).")


async def test_a_template_outside_the_pool_and_an_unreadable_network():
    fake = FakeProxmox()
    del fake.vms[9000]
    fake.fail[("GET", "/nodes/pve/network/vmbr0")] = 403
    result = await proxmox.test_connection(CFG, transport=fake.transport())
    by = {c.label: (c.status, c.value) for c in result.checks}
    assert by["Template"] == ("fail", "VM 9000 isn't visible to the token. Is it in the sirdar "
                                      "pool?")
    assert by["Bridge"] == ("warn", "vmbr0 · can't check it (the token can't read the node's "
                                    "network)")


async def test_a_refused_token_or_a_changed_certificate_is_a_connect_failure():
    fake = FakeProxmox()
    bad = replace(CFG, token="sirdar@pve!sirdar=00000000-0000-4000-8000-000000000000")
    with pytest.raises(ConnectFailed) as e:
        await proxmox.test_connection(bad, transport=fake.transport())
    assert e.value.reason == "Proxmox rejected the API token."
    fake.tls_error = True
    with pytest.raises(ConnectFailed) as e:
        await proxmox.test_connection(CFG, transport=fake.transport())
    assert e.value.reason == proxmox.TLS_CHANGED


async def test_vm_ids_and_the_vm_list():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3", ips=("10.10.48.70",))
    async with api(fake) as px:
        assert await px.next_vmid() == 120
        vms = await px.vms()
        assert vms[120] == {"name": "ss-uat3", "status": "running", "template": False,
                            "tags": ("sirdar", "ss-uat3")}
        assert vms[9000]["template"] is True
        assert await px.pool_vmids() == {120, 9000}
        assert await px.status(120) == "running"


async def test_the_guest_agent():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3", ips=("10.10.48.70",), host_key=HOST_KEY)
    async with api(fake) as px:
        assert await px.agent_ipv4(120) == ["10.10.48.70"]
        assert (await px.agent_file(120, "/etc/ssh/ssh_host_ed25519_key.pub")).strip() == HOST_KEY
        fake.vms[120]["status"] = "stopped"
        with pytest.raises(AgentNotReady):
            await px.agent_ipv4(120)
        with pytest.raises(AgentNotReady):
            await px.agent_file(120, "/etc/ssh/ssh_host_ed25519_key.pub")


async def test_snapshots_rollback_start_and_delete():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3")
    fake.running_polls = 2
    async with api(fake) as px:
        await px.take_snapshot(120, "sirdar-20261004T120000Z", "before update")
        snaps = await px.snapshots(120)
        assert [(s["name"], s["description"], s["vmstate"]) for s in snaps] == [
            ("sirdar-20261004T120000Z", "before update", 0)]
        await px.rollback(120, "sirdar-20261004T120000Z")
        assert fake.rolled_back == [(120, "sirdar-20261004T120000Z")]
        assert await px.status(120) == "stopped"
        await px.start(120)
        assert await px.status(120) == "running"
        await px.delete_snapshot(120, "sirdar-20261004T120000Z")
        assert await px.snapshots(120) == []
    polled = [p for m, p in fake.requests if p.endswith("/status") and "/tasks/" in p]
    assert len(polled) == 4 * 3                      # 4 tasks, 2 "running" answers each


async def test_a_failed_task_and_a_task_that_never_ends():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3")
    fake.task_result["qmsnapshot"] = "snapshot feature is not available"
    async with api(fake) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.take_snapshot(120, "sirdar-20261004T120000Z", "x")
    assert e.value.reason == ("Proxmox couldn't take a VM snapshot: its task ended with an "
                              "error. See the task log in Proxmox.")
    fake.running_polls = 10 ** 6
    async with api(fake, task_timeout=0) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.start(120)
    assert e.value.reason == "Proxmox didn't finish (start the VM) in 0 seconds."


async def test_errors_carry_our_copy_never_the_token():
    fake = FakeProxmox()
    fake.fail[("GET", "/cluster/nextid")] = 500
    async with api(fake) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.next_vmid()
    assert e.value.reason == "Proxmox couldn't reserve a VM id (HTTP 500)."
    assert PX_TOKEN_SECRET not in repr(e.value) and PX_TOKEN_SECRET not in str(e.value)


async def test_the_real_transport_is_guarded(no_real_http):
    async with Proxmox(CFG) as px:
        with pytest.raises(AssertionError):
            await px.version()
    assert no_real_http == ["10.10.48.5"]
    no_real_http.clear()


async def test_the_pool_uses_the_query_form_and_skips_members_without_a_vmid():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3")
    async with api(fake) as px:
        assert await px.pool_vmids() == {120, 9000}
    assert ("GET", "/pools") in fake.requests
    assert ("GET", "/pools/sirdar") not in fake.requests


@pytest.mark.parametrize("status", [400, 501])
async def test_the_pool_falls_back_to_the_path_form_on_older_proxmox(status):
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3")
    fake.fail[("GET", "/pools")] = status
    async with api(fake) as px:
        assert await px.pool_vmids() == {120, 9000}
    assert ("GET", "/pools/sirdar") in fake.requests


async def test_the_pool_does_not_fall_back_on_other_errors():
    fake = FakeProxmox()
    fake.fail[("GET", "/pools")] = 500
    async with api(fake) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.pool_vmids()
    assert e.value.status == 500
    assert ("GET", "/pools/sirdar") not in fake.requests


async def test_a_bridge_check_needs_a_bridge_interface():
    fake = FakeProxmox()
    fake.iface_types["vmbr0"] = "OVSBridge"
    result = await proxmox.test_connection(CFG, transport=fake.transport())
    assert {c.label: c.status for c in result.checks}["Bridge"] == "pass"
    fake.iface_types["vmbr0"] = "eth"
    result = await proxmox.test_connection(CFG, transport=fake.transport())
    by = {c.label: (c.status, c.value) for c in result.checks}
    assert by["Bridge"] == ("fail", "vmbr0 isn't a bridge.")
    assert not result.ok


@pytest.mark.parametrize("path, data, call", [
    ("/nodes/pve/qemu", [{"name": "no-vmid"}], lambda px: px.vms()),
    ("/nodes/pve/qemu", [{"vmid": "abc"}], lambda px: px.vms()),
    ("/nodes/pve/qemu", {"not": "a list"}, lambda px: px.vms()),
    ("/pools", [{"poolid": "sirdar", "members": [{"vmid": "x"}]}], lambda px: px.pool_vmids()),
    ("/pools", "nonsense", lambda px: px.pool_vmids()),
    ("/nodes", [None], lambda px: px.nodes()),
    ("/version", ["9.0"], lambda px: px.version()),
    ("/nodes/pve/qemu/120/agent/network-get-interfaces", {"result": [None]},
     lambda px: px.agent_ipv4(120)),
    ("/nodes/pve/qemu/120/snapshot", [None], lambda px: px.snapshots(120)),
    ("/nodes/pve/qemu/120/status/current", ["running"], lambda px: px.status(120)),
    ("/cluster/resources", {"not": "a list"}, lambda px: px.find_vm(120)),
    ("/cluster/resources", [{"type": "qemu", "vmid": "abc"}], lambda px: px.find_vm(120)),
])
async def test_malformed_answers_are_a_proxmox_error(path, data, call):
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3")
    fake.answer[("GET", path)] = data
    async with api(fake) as px:
        with pytest.raises(ProxmoxError) as e:
            await call(px)
    assert e.value.reason == "Proxmox answered in a way Sirdar doesn't understand."


@pytest.mark.parametrize("upid", [None, 42, {"x": 1}, "", "not-a-upid", "upid:lower"])
async def test_wait_refuses_something_that_isnt_a_task_id(upid):
    fake = FakeProxmox()
    async with api(fake) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.wait(upid, "start the VM")
    assert e.value.reason == ("Proxmox didn't return a task id (start the VM), so Sirdar "
                              "can't follow it.")
    assert not any("/tasks/" in p for _, p in fake.requests)


async def test_a_start_that_answers_without_a_task_id_is_refused():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3", status="stopped")
    fake.answer[("POST", "/nodes/pve/qemu/120/status/start")] = None
    async with api(fake) as px:
        with pytest.raises(ProxmoxError):
            await px.start(120)


@pytest.mark.parametrize("seconds, copy", [(0, "0 seconds"), (90, "90 seconds"),
                                           (119, "119 seconds"), (120, "2 minutes"),
                                           (900, "15 minutes")])
async def test_the_task_timeout_copy(seconds, copy, monkeypatch):
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3", status="stopped")
    fake.running_polls = 10 ** 6
    clock = iter(range(0, 10 ** 6, 1000))
    monkeypatch.setattr(proxmox.time, "monotonic", lambda: next(clock))
    async with api(fake, task_timeout=seconds) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.start(120)
    assert e.value.reason == f"Proxmox didn't finish (start the VM) in {copy}."


async def test_a_missing_pool_is_named():
    fake = FakeProxmox(pool="other")
    async with api(fake) as px:
        with pytest.raises(ProxmoxError) as e:
            await px.pool_vmids()
    assert e.value.reason == "Proxmox has no pool named sirdar."


async def test_find_vm_looks_across_the_cluster():
    fake = FakeProxmox()
    fake.add_vm(120, "ss-uat3")
    fake.add_vm(121, "ss-uat4", node="pve2")
    async with api(fake) as px:
        assert await px.find_vm(120) == {"name": "ss-uat3", "node": "pve", "status": "running",
                                         "tags": ("sirdar", "ss-uat3")}
        assert (await px.find_vm(121))["node"] == "pve2"
        assert 121 not in await px.vms()                # the node's own list misses it
        assert await px.find_vm(130) is None
    assert ("GET", "/cluster/resources") in fake.requests
