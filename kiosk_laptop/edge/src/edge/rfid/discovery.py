"""FX reader discovery on the laptop's subnets (spec §2.2): a TCP connect to
port 443 (64 at once, 0.5 s), then a quiet ZIOTC probe of each responder.
One scan at a time per edge; starting a new one cancels the running one."""

import asyncio
import ipaddress
import logging
import uuid

import httpx

from edge import hostnet
from edge.rfid import ziotc
from edge.rfid import pairing

PORT = 443
CONCURRENCY = 64
TIMEOUT_S = 0.5  # the TCP connect sweep only
PROBE_TIMEOUT = httpx.Timeout(5.0, connect=3.0)  # TLS + login + API calls
log = logging.getLogger("edge.rfid.discovery")


async def tcp_connect(ip: str, port: int = PORT, timeout: float = TIMEOUT_S) -> bool:
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
    def __init__(self, store, data_dir, *, connect=tcp_connect, probe=ziotc.probe,
                 identity=lambda: None) -> None:
        self.store = store
        self.data_dir = data_dir
        self._connect = connect
        self._probe = probe
        self._identity = identity  # this kiosk's Identity, to tell our own pairing apart
        self._task: asyncio.Task | None = None
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
        self._snap = snap  # each scan writes only its own dict, so a cancelled one can't leak in
        self._task = asyncio.create_task(self._run(snap, targets)) if targets else None
        return scan_id

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

    async def _check(self, ip: str, sem: asyncio.Semaphore, snap: dict) -> None:
        try:
            async with sem:
                try:
                    up = await asyncio.wait_for(self._connect(ip), TIMEOUT_S)
                except (asyncio.TimeoutError, OSError):
                    up = False
                if up:
                    try:
                        found = await self._probe(ip, quiet=True, with_config=True,
                                                  timeout=PROBE_TIMEOUT)
                    except Exception as exc:
                        log.debug("probe of %s failed: %s", ip, type(exc).__name__)
                        found = None
                    if found and found.get("serial"):
                        serial = str(found["serial"])
                        elsewhere = pairing.paired_with(
                            found.get("config"), self._identity(), serial,
                            pairing.stored_token(self.store, serial))
                        snap["readers"].append({
                            "ip": ip, "model": found.get("model"), "serial": serial,
                            "paired_with": elsewhere})
        finally:
            snap["probed"] += 1

    async def _run(self, snap: dict, targets: list[str]) -> None:
        sem = asyncio.Semaphore(CONCURRENCY)
        try:
            # return_exceptions: a failing child never leaves its siblings running
            results = await asyncio.gather(*(self._check(ip, sem, snap) for ip in targets),
                                           return_exceptions=True)
            failed = [r for r in results if isinstance(r, Exception)]
            if failed:
                log.debug("scan failed: %s", type(failed[0]).__name__)
            snap["state"] = "failed" if failed else "done"
        except asyncio.CancelledError:
            raise
        except Exception:
            snap["state"] = "failed"
