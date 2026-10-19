"""Network Zebra printers on the laptop's LAN (Label Station phase 1): a
subnet scan for the raw port 9100, a bounded raw query (`~HI`, `~HS`,
`^HWE:*.*`), and a raw send (ZPL, or a `~DY` font download).

The transport can only be aimed at a LAN printer: every address must be a
private IPv4 address (RFC 1918: 10/8, 172.16/12, 192.168/16) that isn't the
laptop's own address or a network/broadcast address, and the port is always
9100. Loopback, link-local, public and every IPv6 address are refused
(`allowed`). The subnet scan copies reader discovery's limits (64
connections at once, 0.5 s each); a query reads at most 64 KB and stops at
2 s idle or 5 s in all. One scan at a time; a new one cancels the running
one."""

import asyncio
import ipaddress
import logging
import uuid

from edge import hostnet
from edge.rfid import discovery

PORT = 9100
CONCURRENCY = discovery.CONCURRENCY
SCAN_TIMEOUT_S = discovery.TIMEOUT_S
CONNECT_TIMEOUT_S = 3.0   # a query or send to a chosen printer
MAX_READ = 65536          # a query's reply, at most
IDLE_S = 2.0              # a query ends after this long without new bytes
TOTAL_S = 5.0             # ... or this long in all
SEND_TIMEOUT_S = 30.0     # writing a job (a font can be a few MB)
PRIVATE_NETS = tuple(ipaddress.IPv4Network(n)
                     for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
log = logging.getLogger("edge.printers")


class PrinterError(Exception):
    """The printer couldn't be reached (`printer_unreachable`) or didn't take
    a job in time (`printer_timeout`)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _parse(value) -> ipaddress.IPv4Address | None:
    """A dotted-quad IPv4 address exactly as given (no spaces, no leading
    zeros, no IPv6), or None."""
    if not isinstance(value, str) or value != value.strip():
        return None
    try:
        return ipaddress.IPv4Address(value)
    except ValueError:
        return None


def lan_printer_ip(value, interfaces: list[hostnet.HostInterface]) -> str | None:
    """`value` as a printer address when it's a private LAN host that isn't
    the laptop, else None. Network and broadcast addresses are judged by the
    laptop's subnet holding the address; one outside every known subnet is
    judged as a /24 (the scan's own assumption for a large subnet)."""
    ip = _parse(value)
    if ip is None or not any(ip in net for net in PRIVATE_NETS):
        return None
    if any(str(ip) == itf.ipv4 for itf in interfaces):
        return None
    nets = [ipaddress.IPv4Interface(f"{itf.ipv4}/{itf.prefix}").network
            for itf in interfaces]
    holding = [n for n in nets if ip in n and n.prefixlen <= 30]
    for net in holding or [ipaddress.IPv4Interface(f"{ip}/24").network]:
        if ip in (net.network_address, net.broadcast_address):
            return None
    return str(ip)


async def tcp_connect(ip: str, port: int) -> bool:
    return await discovery.tcp_connect(ip, port, SCAN_TIMEOUT_S)


async def _close(writer) -> None:
    writer.close()
    try:
        await writer.wait_closed()
    except (OSError, asyncio.TimeoutError):
        pass


class Printers:
    """The edge's printer transport. Tests hand in `port`, `allow` (the
    address check; the real guard otherwise), `targets` (the scan's host
    list) and `connect` (the scan's probe)."""

    def __init__(self, data_dir, *, port: int = PORT, allow=None, targets=None,
                 connect=tcp_connect) -> None:
        self.data_dir = data_dir
        self.port = port
        self._allow = allow
        self._targets = targets
        self._connect = connect
        self._task: asyncio.Task | None = None
        self._snap = {"scan_id": None, "state": "done", "probed": 0, "total": 0,
                      "printers": []}

    # ── the guard ──

    def _interfaces(self) -> list[hostnet.HostInterface]:
        # stale or not: a stale file still names addresses that were the laptop's
        interfaces, _fresh = hostnet.read_host_network(self.data_dir)
        return interfaces

    def allowed(self, ip) -> bool:
        if self._allow is not None:
            return bool(self._allow(ip))
        return lan_printer_ip(ip, self._interfaces()) is not None

    # ── scan ──

    def _scan_targets(self) -> list[str]:
        if self._targets is not None:
            hosts = list(self._targets())
        else:
            interfaces, fresh = hostnet.read_host_network(self.data_dir)
            hosts = hostnet.scan_targets(interfaces) if fresh else []
        return [ip for ip in hosts if self.allowed(ip)]

    def start(self) -> str:
        if self._task and not self._task.done():
            self._task.cancel()
        targets = self._scan_targets()
        scan_id = uuid.uuid4().hex
        snap = {"scan_id": scan_id, "state": "running" if targets else "failed",
                "probed": 0, "total": len(targets), "printers": []}
        self._snap = snap  # each scan writes only its own dict
        self._task = asyncio.create_task(self._run(snap, targets)) if targets else None
        return scan_id

    def snapshot(self) -> dict:
        s = self._snap
        found = sorted(s["printers"], key=ipaddress.ip_address)
        return {**s, "printers": [{"ip": ip} for ip in found]}

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
                    up = bool(await asyncio.wait_for(self._connect(ip, self.port),
                                                     SCAN_TIMEOUT_S))
                except (asyncio.TimeoutError, OSError):
                    up = False
            if up:
                snap["printers"].append(ip)
        finally:
            snap["probed"] += 1

    async def _run(self, snap: dict, targets: list[str]) -> None:
        sem = asyncio.Semaphore(CONCURRENCY)
        try:
            results = await asyncio.gather(*(self._check(ip, sem, snap) for ip in targets),
                                           return_exceptions=True)
            failed = [r for r in results if isinstance(r, Exception)]
            if failed:
                log.debug("printer scan failed: %s", type(failed[0]).__name__)
            snap["state"] = "failed" if failed else "done"
        except asyncio.CancelledError:
            raise
        except Exception:
            snap["state"] = "failed"

    # ── query / send ──

    async def _open(self, ip: str):
        if not self.allowed(ip):  # the routes check first; never trust a caller
            raise PrinterError("bad_printer_ip")
        try:
            return await asyncio.wait_for(asyncio.open_connection(ip, self.port),
                                          CONNECT_TIMEOUT_S)
        except (OSError, asyncio.TimeoutError):
            raise PrinterError("printer_unreachable") from None

    async def query(self, ip: str, data: bytes) -> tuple[bytes, bool]:
        """Send `data`, then read the reply: (bytes, truncated). Ends at EOF,
        at MAX_READ bytes, after IDLE_S without new bytes, or at TOTAL_S."""
        reader, writer = await self._open(ip)
        loop = asyncio.get_running_loop()
        out = bytearray()
        truncated = False
        try:
            try:
                writer.write(data)
                await asyncio.wait_for(writer.drain(), TOTAL_S)
            except (OSError, asyncio.TimeoutError):
                raise PrinterError("printer_unreachable") from None
            deadline = loop.time() + TOTAL_S
            while True:
                left = deadline - loop.time()
                if left <= 0:
                    truncated = True
                    break
                try:
                    chunk = await asyncio.wait_for(reader.read(MAX_READ - len(out) + 1),
                                                   min(IDLE_S, left))
                except asyncio.TimeoutError:
                    truncated = loop.time() >= deadline
                    break
                except OSError:
                    break
                if not chunk:
                    break
                out += chunk
                if len(out) > MAX_READ:
                    del out[MAX_READ:]
                    truncated = True
                    break
        finally:
            await _close(writer)
        return bytes(out), truncated

    async def send(self, ip: str, *parts: bytes) -> None:
        """Write the parts in order on one connection."""
        reader, writer = await self._open(ip)
        try:
            for part in parts:
                writer.write(part)
            await asyncio.wait_for(writer.drain(), SEND_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise PrinterError("printer_timeout") from None
        except OSError:
            raise PrinterError("printer_unreachable") from None
        finally:
            await _close(writer)


def font_header(name: str, size: int) -> bytes:
    """`~DYE:NAME,B,T,<bytes>,,`: a binary TrueType download to E:, as Printer
    tools sends it (portal/src/labels/zebraCommands.ts downloadFontHeader)."""
    return f"~DYE:{name},B,T,{size},,".encode("ascii")
