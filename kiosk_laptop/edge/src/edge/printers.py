"""Network Zebra printers on the laptop's LAN (Label Station phase 1): a
subnet scan for the raw port 9100, a bounded raw query (`~HI`, `~HS`,
`^HWE:*.*`), and a raw send (ZPL, or a `~DY` font download).

The transport can only be aimed at a LAN printer: every address must be a
private IPv4 address (RFC 1918: 10/8, 172.16/12, 192.168/16) that isn't the
laptop's own address or a network/broadcast address, and the port is always
9100. Loopback, link-local, public and every IPv6 address are refused
(`allowed`).

The edge runs in a container, so the laptop is also reachable through
Docker's own private addresses (the bridge gateway, Docker Desktop's
`host.docker.internal`, which forwards to the host's loopback). Those are
refused too (`DockerPaths`, looked up once): the container's own addresses
and connected subnets (unless a subnet is one of the laptop's LAN subnets,
as under host networking), its default gateway, and whatever
`host.docker.internal` / `gateway.docker.internal` resolve to. Other Docker
ranges (172.17/16 and the like) are not blocked wholesale: a LAN may use
them. The subnet scan copies reader discovery's limits (64
connections at once, 0.5 s each); a query reads at most 64 KB and stops at
2 s idle or 5 s in all. One scan at a time; a new one cancels the running
one."""

import asyncio
import ipaddress
import logging
import socket
import uuid
from dataclasses import dataclass
from pathlib import Path

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
MAX_CONNECTIONS = 4       # queries and sends open at once (the scan has its own limit)
DOCKER_NAMES = ("host.docker.internal", "gateway.docker.internal")
PRIVATE_NETS = tuple(ipaddress.IPv4Network(n)
                     for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
log = logging.getLogger("edge.printers")


class PrinterError(Exception):
    """The printer couldn't be reached (`printer_unreachable`) or didn't take
    a job in time (`printer_timeout`)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class DockerPaths:
    """Addresses and subnets that lead from the container back to the laptop."""
    addresses: frozenset = frozenset()   # dotted-quad strings
    subnets: tuple = ()                  # CIDR strings


def _hex_ip(value: str) -> ipaddress.IPv4Address:
    # /proc/net/route writes addresses as little-endian hex
    return ipaddress.IPv4Address(int.from_bytes(bytes.fromhex(value), "little"))


def parse_route(text: str) -> tuple[str | None, list[str]]:
    """(default gateway, connected subnets) from /proc/net/route."""
    gateway, subnets = None, []
    for line in text.splitlines()[1:]:
        cols = line.split()
        if len(cols) < 8:
            continue
        try:
            dest, gw, mask = _hex_ip(cols[1]), _hex_ip(cols[2]), _hex_ip(cols[7])
        except ValueError:
            continue
        if int(dest) == 0 and int(mask) == 0:
            if int(gw) and gateway is None:
                gateway = str(gw)
        elif int(gw) == 0:
            try:
                net = ipaddress.IPv4Network(f"{dest}/{mask}")
            except ValueError:
                continue
            if str(net) not in subnets:
                subnets.append(str(net))
    return gateway, subnets


def parse_fib_trie(text: str) -> set[str]:
    """The container's own IPv4 addresses (`/32 host LOCAL`) from
    /proc/net/fib_trie, loopback left out."""
    found, last = set(), None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("|--"):
            last = stripped[3:].strip()
        elif stripped.startswith("/32 host LOCAL") and last:
            try:
                ip = ipaddress.IPv4Address(last)
            except ValueError:
                continue
            if not ip.is_loopback:
                found.add(str(ip))
    return found


def _resolve_v4(name: str) -> list[str]:
    infos = socket.getaddrinfo(name, None, socket.AF_INET, socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


def _in_container() -> bool:
    return Path("/.dockerenv").exists()


def discover_docker_paths(*, in_container=_in_container,
                          route=lambda: Path("/proc/net/route").read_text(),
                          fib=lambda: Path("/proc/net/fib_trie").read_text(),
                          resolve=_resolve_v4) -> DockerPaths:
    """The container's paths back to the laptop; empty outside a container.
    Never raises: a source that can't be read adds nothing."""
    if not in_container():
        return DockerPaths()
    addresses: set[str] = set()
    subnets: list[str] = []
    try:
        gateway, subnets = parse_route(route())
        if gateway:
            addresses.add(gateway)
    except (OSError, ValueError) as exc:
        log.debug("route table unreadable: %s", type(exc).__name__)
    try:
        addresses |= parse_fib_trie(fib())
    except (OSError, ValueError) as exc:
        log.debug("fib_trie unreadable: %s", type(exc).__name__)
    for name in DOCKER_NAMES:
        try:
            found = resolve(name)
        except (OSError, UnicodeError):
            log.debug("%s does not resolve", name)
            continue
        addresses.update(ip for ip in found if _parse(ip) is not None)
    return DockerPaths(addresses=frozenset(addresses), subnets=tuple(subnets))


def _parse(value) -> ipaddress.IPv4Address | None:
    """A dotted-quad IPv4 address exactly as given (no spaces, no leading
    zeros, no IPv6), or None."""
    if not isinstance(value, str) or value != value.strip():
        return None
    try:
        return ipaddress.IPv4Address(value)
    except ValueError:
        return None


def lan_printer_ip(value, interfaces: list[hostnet.HostInterface],
                   docker: DockerPaths | None = None) -> str | None:
    """`value` as a printer address when it's a private LAN host that isn't
    the laptop, else None. Network and broadcast addresses are judged by the
    laptop's subnet holding the address; one outside every known subnet is
    judged as a /24 (the scan's own assumption for a large subnet). Docker's
    paths back to the laptop are refused (`DockerPaths`)."""
    docker = docker or DockerPaths()
    ip = _parse(value)
    if ip is None or not any(ip in net for net in PRIVATE_NETS):
        return None
    if any(str(ip) == itf.ipv4 for itf in interfaces) or str(ip) in docker.addresses:
        return None
    nets = [ipaddress.IPv4Interface(f"{itf.ipv4}/{itf.prefix}").network
            for itf in interfaces]
    for cidr in docker.subnets:
        net = ipaddress.IPv4Network(cidr)
        if ip in net and net not in nets:
            return None
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
    except (TimeoutError, OSError):
        pass


class Printers:
    """The edge's printer transport. Tests hand in `port`, `allow` (the
    address check; the real guard otherwise), `targets` (the scan's host
    list), `connect` (the scan's probe) and `docker_paths` (the lookup of
    Docker's paths back to the laptop, run once)."""

    def __init__(self, data_dir, *, port: int = PORT, allow=None, targets=None,
                 connect=tcp_connect, docker_paths=discover_docker_paths) -> None:
        self.data_dir = data_dir
        self.port = port
        self._allow = allow
        self._docker_lookup = docker_paths
        self._docker: DockerPaths | None = None
        self._io = asyncio.Semaphore(MAX_CONNECTIONS)
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

    def docker_paths(self) -> DockerPaths:
        """Looked up on first use (or at startup) and kept."""
        if self._docker is None:
            self._docker = self._docker_lookup()  # discover_docker_paths never raises
        return self._docker

    def allowed(self, ip) -> bool:
        if self._allow is not None:
            return bool(self._allow(ip))
        return lan_printer_ip(ip, self._interfaces(), self.docker_paths()) is not None

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
                except (TimeoutError, OSError):
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
        except Exception:  # noqa: BLE001 - as reader discovery: never leave a scan "running"
            snap["state"] = "failed"

    # ── query / send ──

    async def _open(self, ip: str):
        if not self.allowed(ip):  # the routes check first; never trust a caller
            raise PrinterError("bad_printer_ip")
        try:
            return await asyncio.wait_for(asyncio.open_connection(ip, self.port),
                                          CONNECT_TIMEOUT_S)
        except (TimeoutError, OSError):
            raise PrinterError("printer_unreachable") from None

    async def query(self, ip: str, data: bytes) -> tuple[bytes, bool]:
        """Send `data`, then read the reply: (bytes, truncated). Ends at EOF,
        at MAX_READ bytes, after IDLE_S without new bytes, or at TOTAL_S."""
        async with self._io:
            return await self._query(ip, data)

    async def _query(self, ip: str, data: bytes) -> tuple[bytes, bool]:
        reader, writer = await self._open(ip)
        loop = asyncio.get_running_loop()
        out = bytearray()
        truncated = False
        try:
            try:
                writer.write(data)
                await asyncio.wait_for(writer.drain(), TOTAL_S)
            except (TimeoutError, OSError):
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
                except TimeoutError:
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
        async with self._io:
            await self._send(ip, *parts)

    async def _send(self, ip: str, *parts: bytes) -> None:
        _reader, writer = await self._open(ip)
        try:
            for part in parts:
                writer.write(part)
            await asyncio.wait_for(writer.drain(), SEND_TIMEOUT_S)
        except TimeoutError:
            raise PrinterError("printer_timeout") from None
        except OSError:
            raise PrinterError("printer_unreachable") from None
        finally:
            await _close(writer)


def font_header(name: str, size: int) -> bytes:
    """`~DYE:NAME,B,T,<bytes>,,`: a binary TrueType download to E:, as Printer
    tools sends it (portal/src/labels/zebraCommands.ts downloadFontHeader)."""
    return f"~DYE:{name},B,T,{size},,".encode("ascii")
