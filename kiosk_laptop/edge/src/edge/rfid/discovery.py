"""FX reader discovery on the laptop's subnets (spec §2.2): a TCP connect to
ports 443 and 80 (64 connections at once, 0.5 s), then `ziotc.discover` on
each responder — 443 (HTTPS) when it is open, else 80 (plain HTTP).

No password goes to a host until its unauthenticated answers look like a
Zebra reader, and then only the password index remembered for that IP; with
none remembered the card says "select it to connect" (`needs_connect`).
One scan at a time per edge; starting a new one cancels the running one."""

import asyncio
import ipaddress
import logging
import uuid

import httpx

from edge import hostnet
from edge.rfid import ziotc
from edge.rfid import pairing

PORTS = (443, 80)  # in order of preference: one card per IP
SCHEMES = {443: "https", 80: "http"}
CONCURRENCY = 64
TIMEOUT_S = 0.5  # the TCP connect sweep only
PROBE_TIMEOUT = httpx.Timeout(5.0, connect=3.0)  # TLS + login + API calls
log = logging.getLogger("edge.rfid.discovery")


async def tcp_connect(ip: str, port: int, timeout: float = TIMEOUT_S) -> bool:
    try:
        _r, writer = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout)
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return True


class Discovery:
    def __init__(self, store, data_dir, *, connect=tcp_connect, probe=ziotc.discover,
                 identity=lambda: None, transport=lambda ip: None) -> None:
        self.store = store
        self.data_dir = data_dir
        self._connect = connect  # connect(ip, port) -> bool
        self._probe = probe
        self._identity = identity  # this kiosk's Identity, to tell our own pairing apart
        self._transport = transport  # tests hand in a fake reader's transport
        self._task: asyncio.Task | None = None
        # where the latest scan found each reader: (scheme, port) by IP
        self._endpoints: dict[str, tuple[str, int]] = {}
        self._snap = {"scan_id": None, "state": "done", "probed": 0, "total": 0,
                      "readers": [], "host": {"ips": [], "fresh": False}}

    def start(self) -> str:
        if self._task and not self._task.done():
            self._task.cancel()
        interfaces, fresh = hostnet.read_host_network(self.data_dir)
        scan_id = uuid.uuid4().hex
        targets = hostnet.scan_targets(interfaces) if fresh else []
        snap = {"scan_id": scan_id, "state": "running" if targets else "failed", "probed": 0,
                "total": len(targets), "readers": [],
                "host": {"ips": [i.ipv4 for i in interfaces] if fresh else [], "fresh": fresh}}
        endpoints: dict[str, tuple[str, int]] = {}
        # each scan writes only its own dicts, so a cancelled one can't leak in
        self._snap, self._endpoints = snap, endpoints
        self._task = asyncio.create_task(self._run(snap, endpoints, targets)) if targets else None
        return scan_id

    def endpoint_for(self, ip: str) -> tuple[str, int] | None:
        """(scheme, port) the latest scan reached this IP on, or None."""
        return self._endpoints.get(ip)

    def snapshot(self) -> dict:
        s = self._snap
        readers = sorted(s["readers"], key=lambda r: ipaddress.ip_address(r["ip"]))
        return {**s, "readers": [dict(r) for r in readers], "host": dict(s["host"])}

    async def aclose(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _open(self, ip: str, port: int, sem: asyncio.Semaphore) -> bool:
        async with sem:
            try:
                return bool(await asyncio.wait_for(self._connect(ip, port), TIMEOUT_S))
            except (asyncio.TimeoutError, OSError):
                return False

    async def _check(self, ip: str, sem: asyncio.Semaphore, snap: dict,
                     endpoints: dict) -> None:
        try:
            # both ports at once; return_exceptions so neither is left running
            results = await asyncio.gather(*(self._open(ip, port, sem) for port in PORTS),
                                           return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException):
                    raise result
            port = next((p for p, up in zip(PORTS, results) if up), None)
            if port is None:
                return
            scheme = SCHEMES[port]
            async with sem:
                try:
                    found = await self._probe(
                        ip, scheme=scheme, port=port,
                        password_index=pairing.password_first(self.store, ip),
                        transport=self._transport(ip), timeout=PROBE_TIMEOUT)
                except Exception as exc:
                    log.debug("probe of %s failed: %s", ip, type(exc).__name__)
                    found = None
            if not found:
                return
            if found.get("needs_connect"):
                endpoints[ip] = (scheme, port)
                snap["readers"].append({"ip": ip, "scheme": scheme, "port": port,
                                        "model": None, "serial": None, "paired_with": None,
                                        "needs_connect": True})
            elif found.get("serial"):
                serial = str(found["serial"])
                elsewhere = pairing.paired_with(
                    found.get("config"), self._identity(), serial,
                    pairing.stored_token(self.store, serial))
                endpoints[ip] = (scheme, port)
                snap["readers"].append({
                    "ip": ip, "scheme": scheme, "port": port, "model": found.get("model"),
                    "serial": serial, "paired_with": elsewhere, "needs_connect": False})
        finally:
            snap["probed"] += 1

    async def _run(self, snap: dict, endpoints: dict, targets: list[str]) -> None:
        sem = asyncio.Semaphore(CONCURRENCY)
        try:
            # return_exceptions: a failing child never leaves its siblings running
            results = await asyncio.gather(*(self._check(ip, sem, snap, endpoints)
                                             for ip in targets),
                                           return_exceptions=True)
            failed = [r for r in results if isinstance(r, Exception)]
            if failed:
                log.debug("scan failed: %s", type(failed[0]).__name__)
            snap["state"] = "failed" if failed else "done"
        except asyncio.CancelledError:
            raise
        except Exception:
            snap["state"] = "failed"
