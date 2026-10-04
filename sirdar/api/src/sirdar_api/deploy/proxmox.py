"""Proxmox VE API client (phase 5): what Sirdar reads and does on the
Proxmox host besides Terraform's create and destroy — the connection test,
VM ids, the guest agent (the VM's address and SSH host key), VM snapshots
and power. Every request goes through the pinned certificate
(tls_pin.pinned_context) with the API token in the Authorization header;
tests pass an httpx MockTransport (outbound.transports()["proxmox"]).
Errors are ProxmoxError with our own copy, never Proxmox's text or the
token."""

import asyncio
import functools
import ssl
import time
from collections.abc import Awaitable, Callable
from urllib.parse import quote, urlsplit

import httpx

from sirdar_api.deploy import Check, ConnectFailed, ConnectResult, tls_pin
from sirdar_api.deploy.integrations import ProxmoxConfig

DEFAULT_PORT = 8006
TIMEOUT = httpx.Timeout(30.0, connect=10.0)
TASK_POLL_SECONDS = 2.0
TASK_TIMEOUT_SECONDS = 15 * 60
TLS_CHANGED = ("The Proxmox server's certificate isn't the one Sirdar trusts. If it was "
               "renewed on purpose, trust the new one in Settings › Integrations › Proxmox.")
_GB = 1024 ** 3
_SKIPPED_IFACES = ("docker", "br-", "veth")
_BRIDGE_TYPES = ("bridge", "OVSBridge")
MALFORMED = "Proxmox answered in a way Sirdar doesn't understand."


class ProxmoxError(Exception):
    """`reason` is our own copy; `status` the HTTP status, if any."""

    def __init__(self, reason: str, status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class AgentNotReady(ProxmoxError):
    """The guest agent didn't answer (still booting, or not installed)."""


def split_url(url: str) -> tuple[str, int]:
    parts = urlsplit(url)
    return parts.hostname or "", parts.port or DEFAULT_PORT


def _tls_refused(exc: BaseException) -> bool:
    """Whether a transport error came from a certificate the pin refused."""
    seen: BaseException | None = exc
    for _ in range(8):
        if seen is None:
            return False
        if isinstance(seen, ssl.SSLCertVerificationError):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def _parsed(parse):
    """Decorator: a payload that isn't the shape we read (KeyError,
    TypeError, ValueError, AttributeError) is a ProxmoxError, never a crash."""
    @functools.wraps(parse)
    async def wrapper(*args, **kwargs):
        try:
            return await parse(*args, **kwargs)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise ProxmoxError(MALFORMED) from None
    return wrapper


def _duration(seconds: int) -> str:
    if seconds < 120:
        return f"{seconds} second{'' if seconds == 1 else 's'}"
    return f"{seconds // 60} minutes"


def _reason(status: int, what: str) -> str:
    if status == 401:
        return "Proxmox rejected the API token."
    if status == 403:
        return f"The API token isn't allowed to {what}. Check its privileges (see the README)."
    return f"Proxmox couldn't {what} (HTTP {status})."


def _list(data) -> list:
    """A JSON list from Proxmox (TypeError, so MALFORMED, when it isn't)."""
    if data is None:
        return []
    if not isinstance(data, list):
        raise TypeError("expected a list")
    return data


def _dict(data) -> dict:
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise TypeError("expected an object")
    return data


class Proxmox:
    def __init__(self, cfg: ProxmoxConfig, *, transport: httpx.AsyncBaseTransport | None = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 task_poll: float = TASK_POLL_SECONDS,
                 task_timeout: int = TASK_TIMEOUT_SECONDS):
        self._cfg = cfg
        self._sleep = sleep
        self._poll = task_poll
        self._task_timeout = task_timeout
        self._node = quote(cfg.node, safe="")
        host, port = split_url(cfg.url)
        self._where = f"{host}:{port}"
        if transport is None:
            transport = httpx.AsyncHTTPTransport(verify=tls_pin.pinned_context(cfg.tls_cert_pem))
        self._client = httpx.AsyncClient(
            base_url=f"{cfg.url}/api2/json", transport=transport, timeout=TIMEOUT,
            headers={"Authorization": f"PVEAPIToken={cfg.token}"}, follow_redirects=False)

    async def __aenter__(self) -> "Proxmox":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _call(self, method: str, path: str, what: str, *, params: dict | None = None,
                    data: dict | None = None, agent: bool = False):
        try:
            resp = await self._client.request(method, path, params=params, data=data)
        except httpx.HTTPError as e:
            if _tls_refused(e):
                raise ProxmoxError(TLS_CHANGED) from None
            raise ProxmoxError(f"Couldn't reach Proxmox at {self._where}.") from None
        if resp.status_code >= 400:
            if agent and resp.status_code == 500:
                raise AgentNotReady("The VM's guest agent isn't answering yet.", 500)
            raise ProxmoxError(_reason(resp.status_code, what), resp.status_code)
        try:
            return resp.json()["data"]
        except (ValueError, KeyError, TypeError):
            raise ProxmoxError(MALFORMED) from None

    def _vm(self, vmid: int) -> str:
        return f"/nodes/{self._node}/qemu/{int(vmid)}"

    @_parsed
    async def version(self) -> str:
        data = await self._call("GET", "/version", "read its version")
        return str((data or {}).get("version", ""))

    @_parsed
    async def nodes(self) -> list[str]:
        data = await self._call("GET", "/nodes", "list the nodes")
        return [str(n["node"]) for n in _list(data)]

    @_parsed
    async def next_vmid(self) -> int:
        return int(await self._call("GET", "/cluster/nextid", "reserve a VM id"))

    @_parsed
    async def pool_vmids(self) -> set[int]:
        """The pool's VM ids (storage members have no vmid). GET /pools?poolid=
        (PVE 8.1+); the older GET /pools/{id} only when that form answers 400
        or 501."""
        pool = self._cfg.pool
        try:
            data = await self._call("GET", "/pools", "read the pool", params={"poolid": pool})
            found = [p for p in _list(data) if p["poolid"] == pool]
            if not found:
                raise ProxmoxError(f"Proxmox has no pool named {pool}.")
            members = found[0].get("members") or []
        except ProxmoxError as e:
            if e.status not in (400, 501):
                raise
            data = await self._call("GET", f"/pools/{quote(pool, safe='')}", "read the pool")
            members = (data or {}).get("members") or []
        return {int(m["vmid"]) for m in _list(members) if m.get("vmid") is not None}

    @_parsed
    async def vms(self) -> dict[int, dict]:
        data = await self._call("GET", f"/nodes/{self._node}/qemu", "list the VMs")
        return {int(v["vmid"]): {
            "name": str(v.get("name") or ""), "status": str(v.get("status") or ""),
            "template": bool(v.get("template")),
            "tags": tuple(t for t in str(v.get("tags") or "").replace(",", ";").split(";") if t)}
            for v in _list(data)}

    @_parsed
    async def find_vm(self, vmid: int) -> dict | None:
        """VM `vmid` wherever it is in the cluster (GET /cluster/resources?
        type=vm), or None when no node has it: {name, node, status, tags}."""
        data = await self._call("GET", "/cluster/resources", "list the cluster's VMs",
                                params={"type": "vm"})
        for v in _list(data):
            if v.get("type") == "qemu" and int(v["vmid"]) == int(vmid):
                return {"name": str(v.get("name") or ""), "node": str(v.get("node") or ""),
                        "status": str(v.get("status") or ""),
                        "tags": tuple(t for t in str(v.get("tags") or "")
                                      .replace(",", ";").split(";") if t)}
        return None

    @_parsed
    async def vm_config(self, vmid: int) -> dict:
        return _dict(await self._call("GET", f"{self._vm(vmid)}/config",
                                      "read the VM's settings"))

    @_parsed
    async def status(self, vmid: int) -> str:
        data = await self._call("GET", f"{self._vm(vmid)}/status/current", "read the VM's state")
        return str(_dict(data).get("status", ""))

    @_parsed
    async def storage_status(self) -> dict:
        path = f"/nodes/{self._node}/storage/{quote(self._cfg.storage, safe='')}/status"
        return _dict(await self._call("GET", path, "read the storage"))

    @_parsed
    async def bridge(self) -> dict:
        path = f"/nodes/{self._node}/network/{quote(self._cfg.bridge, safe='')}"
        return _dict(await self._call("GET", path, "read the network bridge"))

    @_parsed
    async def agent_ipv4(self, vmid: int) -> list[str]:
        """The VM's IPv4 addresses in the agent's interface order, without
        loopback, Docker's own interfaces (docker0, br-*, veth*) and
        link-local addresses."""
        data = await self._call("GET", f"{self._vm(vmid)}/agent/network-get-interfaces",
                                "ask the guest agent for the VM's addresses", agent=True)
        found: list[str] = []
        for iface in _list(_dict(data).get("result") or []):
            name = str(iface.get("name", ""))
            if name == "lo" or name.startswith(_SKIPPED_IFACES):
                continue
            for addr in _list(iface.get("ip-addresses") or []):
                ip = str(addr.get("ip-address", ""))
                if (addr.get("ip-address-type") == "ipv4" and ip
                        and not ip.startswith("169.254.") and ip not in found):
                    found.append(ip)
        return found

    @_parsed
    async def agent_file(self, vmid: int, path: str) -> str:
        data = await self._call("GET", f"{self._vm(vmid)}/agent/file-read",
                                "read a file through the guest agent", params={"file": path},
                                agent=True)
        return str(_dict(data).get("content", ""))

    @_parsed
    async def snapshots(self, vmid: int) -> list[dict]:
        data = await self._call("GET", f"{self._vm(vmid)}/snapshot", "list the VM snapshots")
        return [s for s in _list(data) if s["name"] != "current"]

    async def take_snapshot(self, vmid: int, name: str, description: str) -> None:
        upid = await self._call("POST", f"{self._vm(vmid)}/snapshot", "take a VM snapshot",
                                data={"snapname": name, "description": description,
                                      "vmstate": 0})
        await self.wait(upid, "take a VM snapshot")

    async def rollback(self, vmid: int, name: str) -> None:
        path = f"{self._vm(vmid)}/snapshot/{quote(name, safe='')}/rollback"
        await self.wait(await self._call("POST", path, "restore the VM snapshot"),
                        "restore the VM snapshot")

    async def delete_snapshot(self, vmid: int, name: str) -> None:
        path = f"{self._vm(vmid)}/snapshot/{quote(name, safe='')}"
        await self.wait(await self._call("DELETE", path, "delete a VM snapshot"),
                        "delete a VM snapshot")

    async def start(self, vmid: int) -> None:
        await self.wait(await self._call("POST", f"{self._vm(vmid)}/status/start",
                                         "start the VM"), "start the VM")

    async def wait(self, upid, what: str) -> None:
        """Until Proxmox's task `upid` stops; its exit status must be OK."""
        if not isinstance(upid, str) or not upid.startswith("UPID:"):
            raise ProxmoxError(f"Proxmox didn't return a task id ({what}), so Sirdar "
                               "can't follow it.")
        deadline = time.monotonic() + self._task_timeout
        path = f"/nodes/{self._node}/tasks/{quote(str(upid), safe='')}/status"
        while True:
            data = await self._call("GET", path, f"follow the task ({what})")
            if not isinstance(data, dict):
                raise ProxmoxError(MALFORMED)
            if data.get("status") == "stopped":
                exit_status = str(data.get("exitstatus") or "")
                if exit_status == "OK" or exit_status.startswith("WARNINGS"):
                    return
                raise ProxmoxError(f"Proxmox couldn't {what}: its task ended with an error. "
                                   "See the task log in Proxmox.")
            if time.monotonic() >= deadline:
                raise ProxmoxError(f"Proxmox didn't finish ({what}) in "
                                   f"{_duration(int(self._task_timeout))}.")
            await self._sleep(self._poll)


async def test_connection(cfg: ProxmoxConfig, *,
                          transport: httpx.AsyncBaseTransport | None = None) -> ConnectResult:
    """Read-only: the version, then one check each for the node, the pool,
    the template, the storage and the bridge."""
    checks: list[Check] = []
    async with Proxmox(cfg, transport=transport) as api:
        try:
            version = await api.version()
        except ProxmoxError as e:
            raise ConnectFailed(e.reason) from None
        checks.append(Check("Proxmox", "pass", f"Version {version}"))

        async def node() -> Check:
            names = await api.nodes()
            if cfg.node in names:
                return Check("Node", "pass", cfg.node)
            return Check("Node", "fail",
                         f"No node named {cfg.node} (found {', '.join(names) or 'none'}).")

        async def pool() -> Check:
            return Check("Pool", "pass", f"{cfg.pool} · {len(await api.pool_vmids())} VMs")

        async def template() -> Check:
            vm = (await api.vms()).get(cfg.template_vmid)
            if vm is None:
                return Check("Template", "fail", f"VM {cfg.template_vmid} isn't visible to the "
                                                 f"token. Is it in the {cfg.pool} pool?")
            label = f"{vm['name']} ({cfg.template_vmid})"
            if not vm["template"]:
                return Check("Template", "fail",
                             f"VM {cfg.template_vmid} ({vm['name']}) isn't a template.")
            agent = str((await api.vm_config(cfg.template_vmid)).get("agent", ""))
            if agent.startswith("1") or "enabled=1" in agent:
                return Check("Template", "pass", label)
            return Check("Template", "warn", f"{label} · its guest agent option is off; Sirdar "
                                             "turns it on in each VM")

        async def storage() -> Check:
            s = await api.storage_status()
            if not s.get("active") or "images" not in str(s.get("content", "")).split(","):
                return Check("Storage", "fail", f"{cfg.storage} isn't active or can't hold VM "
                                                "disks.")
            return Check("Storage", "pass",
                         f"{cfg.storage} · {int(s.get('avail', 0)) / _GB:.0f} GB free")

        async def bridge() -> Check:
            try:
                iface = await api.bridge()
            except ProxmoxError as e:
                if e.status == 403:
                    return Check("Bridge", "warn", f"{cfg.bridge} · can't check it (the token "
                                                   "can't read the node's network)")
                if e.status in (404, 500):
                    return Check("Bridge", "fail", f"No bridge named {cfg.bridge} on "
                                                   f"{cfg.node}.")
                raise
            if iface.get("type") not in _BRIDGE_TYPES:
                return Check("Bridge", "fail", f"{cfg.bridge} isn't a bridge.")
            return Check("Bridge", "pass",
                         cfg.bridge + (f" · VLAN {cfg.vlan_tag}" if cfg.vlan_tag else ""))

        for label, check in (("Node", node), ("Pool", pool), ("Template", template),
                             ("Storage", storage), ("Bridge", bridge)):
            try:
                checks.append(await check())
            except ProxmoxError as e:
                checks.append(Check(label, "fail", e.reason))
    facts = {"url": cfg.url, "node": cfg.node, "version": version,
             "fingerprint": cfg.tls_fingerprint, "token_id": cfg.token_id}
    return ConnectResult(ok=not any(c.status == "fail" for c in checks), target="proxmox",
                         checks=checks, facts=facts)


test_connection.__test__ = False  # not a pytest test, despite the name
