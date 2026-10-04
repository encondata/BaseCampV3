"""A stateful Proxmox VE API for tests: an httpx MockTransport handler that
checks the token header and answers the endpoints Sirdar's client calls.
Tasks finish at once (after `running_polls` "running" answers) with
`task_result[action]`, default "OK"."""

import re
import ssl
from urllib.parse import parse_qs

import httpx

from .integration_helpers import PX_TOKEN

TEMPLATE = 9000


class FakeProxmox:
    def __init__(self, *, node: str = "pve", pool: str = "sirdar"):
        self.node, self.pool = node, pool
        self.version = "9.0.10"
        self.vms: dict[int, dict] = {TEMPLATE: {
            "name": "ubuntu-2404-template", "template": 1, "status": "stopped", "tags": "",
            "config": {"agent": "1", "scsi0": "local-lvm:base-9000-disk-0,size=3584M"}}}
        self.pool_members: set[int] = {TEMPLATE}
        self.pool_storage = [{"id": "storage/pve/local-lvm", "type": "storage",
                              "storage": "local-lvm", "node": "pve"}]   # members without a vmid
        self.next_id = 120
        self.storage = {"active": 1, "enabled": 1, "content": "images,rootdir",
                        "avail": 500 * 1024 ** 3, "total": 900 * 1024 ** 3}
        self.bridges = {"vmbr0"}
        self.iface_types: dict[str, str] = {}   # iface -> type, default "bridge"
        self.answer: dict[tuple[str, str], object] = {}   # (method, path) -> raw data
        self.agent: dict[int, dict] = {}         # vmid -> {"ips": [...], "host_key": str}
        self.snaps: dict[int, list[dict]] = {}
        self.tasks: dict[str, str] = {}
        self.polls: dict[str, int] = {}
        self.running_polls = 0
        self.requests: list[tuple[str, str]] = []
        self.fail: dict[tuple[str, str], int] = {}
        self.task_result: dict[str, str] = {}
        self.tls_error = False
        self.rolled_back: list[tuple[int, str]] = []
        self._n = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def add_vm(self, vmid: int, name: str, *, status: str = "running", tags: str | None = None,
               ips: tuple[str, ...] = (), host_key: str | None = None,
               node: str | None = None) -> None:
        """`node`: where the VM lives (default this fake's node); a VM on
        another node shows only in /cluster/resources."""
        self.vms[vmid] = {"name": name, "template": 0, "status": status, "node": node or self.node,
                          "tags": f"sirdar;{name}" if tags is None else tags,
                          "config": {"agent": "1"}}
        self.pool_members.add(vmid)
        self.agent[vmid] = {"ips": list(ips), "host_key": host_key}

    def remove_vm(self, vmid: int) -> None:
        for table in (self.vms, self.agent, self.snaps):
            table.pop(vmid, None)
        self.pool_members.discard(vmid)

    def _task(self, action: str) -> str:
        self._n += 1
        upid = f"UPID:{self.node}:{self._n:08X}:00000000:00000000:{action}:100:sirdar@pve!sirdar:"
        self.tasks[upid] = self.task_result.get(action, "OK")
        self.polls[upid] = 0
        return upid

    def _members(self) -> list[dict]:
        return [*({"vmid": v, "type": "qemu", "id": f"qemu/{v}"}
                  for v in sorted(self.pool_members)), *self.pool_storage]

    @staticmethod
    def _ok(data) -> httpx.Response:
        return httpx.Response(200, json={"data": data})

    @staticmethod
    def _err(status: int) -> httpx.Response:
        return httpx.Response(status, json={"data": None, "message": "fake proxmox error"})

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.tls_error:
            raise httpx.ConnectError("handshake failed") from ssl.SSLCertVerificationError(
                "certificate verify failed")
        path = request.url.path.removeprefix("/api2/json")
        method = request.method
        self.requests.append((method, path))
        if request.headers.get("authorization") != f"PVEAPIToken={PX_TOKEN}":
            return self._err(401)
        if (method, path) in self.fail:
            return self._err(self.fail[(method, path)])
        if (method, path) in self.answer:
            return self._ok(self.answer[(method, path)])
        form = parse_qs(request.content.decode()) if request.content else {}
        n = f"/nodes/{self.node}"
        if path == "/version":
            return self._ok({"version": self.version, "release": "9.0"})
        if path == "/nodes":
            return self._ok([{"node": self.node, "status": "online"}])
        if path == "/cluster/nextid":
            return self._ok(str(self.next_id))
        if path == "/pools":                    # PVE 8.1+: ?poolid=<id>, a list
            wanted = request.url.params.get("poolid")
            pools = [{"poolid": self.pool, "members": self._members()}]
            return self._ok([p for p in pools if wanted in (None, p["poolid"])])
        if path == f"/pools/{self.pool}":       # the older (now deprecated) form
            return self._ok({"members": self._members()})
        if path == f"{n}/qemu":
            return self._ok([{"vmid": v, "name": d["name"], "status": d["status"],
                              "template": d["template"], "tags": d["tags"]}
                             for v, d in self.vms.items()
                             if d.get("node", self.node) == self.node])
        if path == "/cluster/resources":
            kind = request.url.params.get("type")
            return self._ok([{"id": f"qemu/{v}", "type": "qemu", "vmid": v,
                              "name": d["name"], "node": d.get("node", self.node),
                              "status": d["status"], "template": d["template"],
                              "tags": d["tags"]}
                             for v, d in self.vms.items() if kind in (None, "vm")])
        if path == f"{n}/storage/local-lvm/status":
            return self._ok(self.storage)
        bridge = re.fullmatch(rf"{n}/network/([^/]+)", path)
        if bridge:
            return (self._ok({"iface": bridge[1],
                              "type": self.iface_types.get(bridge[1], "bridge")})
                    if bridge[1] in self.bridges else self._err(500))
        task = re.fullmatch(rf"{n}/tasks/([^/]+)/status", path)
        if task:
            upid = task[1]
            if upid not in self.tasks:
                return self._err(404)
            self.polls[upid] += 1
            if self.polls[upid] <= self.running_polls:
                return self._ok({"status": "running"})
            return self._ok({"status": "stopped", "exitstatus": self.tasks[upid]})
        vm = re.fullmatch(rf"{n}/qemu/(\d+)(/.*)?", path)
        if vm:
            return self._vm(int(vm[1]), vm[2] or "", method, request, form)
        return self._err(404)

    def _vm(self, vmid: int, rest: str, method: str, request: httpx.Request,
            form: dict) -> httpx.Response:
        vm = self.vms.get(vmid)
        if vm is None or vm.get("node", self.node) != self.node:
            return self._err(500)        # Proxmox: "Configuration file ... does not exist"
        agent = self.agent.get(vmid)
        live = vm["status"] == "running"
        if rest == "/config":
            return self._ok(vm["config"])
        if rest == "/status/current":
            return self._ok({"status": vm["status"]})
        if rest == "/status/start" and method == "POST":
            vm["status"] = "running"
            return self._ok(self._task("qmstart"))
        if rest == "/agent/network-get-interfaces":
            if agent is None or not live:
                return self._err(500)              # "QEMU guest agent is not running"
            eth0 = [{"ip-address-type": "ipv4", "ip-address": ip, "prefix": 24}
                    for ip in agent["ips"]]
            eth0 += [{"ip-address-type": "ipv4", "ip-address": "169.254.10.1", "prefix": 16},
                     {"ip-address-type": "ipv6", "ip-address": "fe80::1", "prefix": 64}]
            return self._ok({"result": [
                {"name": "lo", "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "127.0.0.1", "prefix": 8}]},
                {"name": "eth0", "ip-addresses": eth0},
                {"name": "docker0", "ip-addresses": [
                    {"ip-address-type": "ipv4", "ip-address": "172.17.0.1", "prefix": 16}]}]})
        if rest == "/agent/file-read":
            if (agent is None or not live or agent.get("host_key") is None
                    or request.url.params.get("file") != "/etc/ssh/ssh_host_ed25519_key.pub"):
                return self._err(500)
            return self._ok({"content": agent["host_key"] + "\n"})
        if rest == "/snapshot" and method == "GET":
            return self._ok([*self.snaps.get(vmid, []),
                             {"name": "current", "description": "You are here!"}])
        if rest == "/snapshot" and method == "POST":
            self.snaps.setdefault(vmid, []).append({
                "name": form["snapname"][0], "description": form.get("description", [""])[0],
                "snaptime": 1_790_000_000, "vmstate": int(form.get("vmstate", ["0"])[0])})
            return self._ok(self._task("qmsnapshot"))
        snap = re.fullmatch(r"/snapshot/([^/]+)(/rollback)?", rest)
        if snap:
            name = snap[1]
            if not any(s["name"] == name for s in self.snaps.get(vmid, [])):
                return self._err(500)
            if snap[2] and method == "POST":
                vm["status"] = "stopped"
                self.rolled_back.append((vmid, name))
                return self._ok(self._task("qmrollback"))
            if not snap[2] and method == "DELETE":
                self.snaps[vmid] = [s for s in self.snaps[vmid] if s["name"] != name]
                return self._ok(self._task("qmdelsnapshot"))
        return self._err(404)
