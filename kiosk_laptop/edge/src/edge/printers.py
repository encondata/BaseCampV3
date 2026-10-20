"""Network Zebra printers on the laptop's LAN (Label Station phase 1): a
subnet scan for the raw port 9100, a bounded raw query (`~HI`, `~HS`,
`^HWE:*.*`), and a raw send (ZPL, or a `~DY` font download).

The transport can only be aimed at a LAN printer: every address must be a
private IPv4 address (RFC 1918: 10/8, 172.16/12, 192.168/16) that isn't the
laptop's own address or a network/broadcast address, and the port is always
9100. Loopback, link-local, public and every IPv6 address are refused
(`allowed`), and so is every address the laptop owns: host-network.json's
`self_addresses` lists all of them, Docker bridges (docker0, br-*), WSL and
Hyper-V switches included, while its `interfaces` stay LAN-only.

The edge runs in a container, so the laptop is also reachable through
Docker's own private addresses (the bridge gateway, Docker Desktop's
`host.docker.internal`, which forwards to the host's loopback). Those are
refused too (`DockerPaths`, looked up once): the container's own addresses
and connected subnets (unless a subnet is one of the laptop's LAN subnets,
as under host networking), its default gateway, and whatever
`host.docker.internal` / `gateway.docker.internal` resolve to. Other Docker
ranges (172.17/16 and the like) are not blocked wholesale: a LAN may use
them, except Docker Desktop's VM range 192.168.65.0/24 in a container where
`host.docker.internal` doesn't resolve (so its address there is unknown),
unless that range is one of the laptop's LAN subnets.

The lookup fails closed. In a container (/.dockerenv or /run/.containerenv)
a lookup that can't find the default gateway or read the container's own
addresses isn't kept: it's logged and retried on the next use, and until one
succeeds every query, send and font download is refused with 503
`printer_guard_unavailable` (the scan still runs, against the addresses
known). The two name lookups get 1 s in all, and the lookup never runs on
the event loop (`guard_ready` runs it in a thread). A query or send waits at
most 10 s for one of the four connections (503 `printer_busy`).

The subnet scan copies reader discovery's limits (64
connections at once, 0.5 s each); a query reads at most 64 KB and stops at
2 s idle or 5 s in all. One scan at a time; a new one cancels the running
one."""

import asyncio
import concurrent.futures
import contextlib
import ipaddress
import logging
import socket
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from edge import hostnet
from edge.rfid import discovery

PORT = 9100
CONCURRENCY = discovery.CONCURRENCY
SCAN_TIMEOUT_S = discovery.TIMEOUT_S
# A found printer is asked `~HI` so the list can show what it is: one short
# exchange per printer, read to the frame end (ETX), capped and timed.
IDENTIFY_TIMEOUT_S = 1.5
IDENTIFY_MAX = 512
_NOMINAL_DPI = {6: 150, 8: 203, 12: 300, 24: 600}
CONNECT_TIMEOUT_S = 3.0   # a query or send to a chosen printer
MAX_READ = 65536          # a query's reply, at most
IDLE_S = 2.0              # a query ends after this long without new bytes
TOTAL_S = 5.0             # ... or this long in all
SEND_TIMEOUT_S = 30.0     # writing a job (a font can be a few MB)
MAX_CONNECTIONS = 4       # queries and sends open at once (the scan has its own limit)
BUSY_S = 10.0             # a query or send waits this long for a connection slot
RESOLVE_TIMEOUT_S = 1.0   # the Docker name lookups, in all
GUARD_LOOKUP_S = 3.0      # the whole Docker lookup, run in a thread
DOCKER_NAMES = ("host.docker.internal", "gateway.docker.internal")
DESKTOP_NAME = "host.docker.internal"
DESKTOP_NET = ipaddress.IPv4Network("192.168.65.0/24")   # Docker Desktop's VM range
CONTAINER_MARKERS = (".dockerenv", "run/.containerenv")
PRIVATE_NETS = tuple(ipaddress.IPv4Network(n)
                     for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
log = logging.getLogger("edge.printers")


class PrinterError(Exception):
    """The printer couldn't be reached (`printer_unreachable`), didn't take
    a job in time (`printer_timeout`), every connection stayed busy
    (`printer_busy`), or the guard can't see Docker's paths back to the
    laptop yet (`printer_guard_unavailable`)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class DockerPaths:
    """Addresses and subnets that lead from the container back to the laptop.
    `complete` is False in a container whose default gateway or own
    addresses couldn't be read (the guard is then unavailable); `desktop`:
    `host.docker.internal` resolved."""
    addresses: frozenset = frozenset()   # dotted-quad strings
    subnets: tuple = ()                  # CIDR strings
    in_container: bool = False
    complete: bool = True
    desktop: bool = False

    @property
    def unavailable(self) -> bool:
        return self.in_container and not self.complete


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


def _in_container(root: Path = Path("/")) -> bool:
    """Docker (/.dockerenv) or Podman (/run/.containerenv)."""
    return any((root / marker).exists() for marker in CONTAINER_MARKERS)


def resolve_names(names, resolve, timeout: float = RESOLVE_TIMEOUT_S) -> dict[str, list[str]]:
    """Each name's IPv4 addresses; a name that fails or isn't answered within
    `timeout` (for all of them together) is left out. Never raises; a
    lookup still hanging is abandoned to its thread."""
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(names) or 1,
                                                 thread_name_prefix="docker-dns")
    try:
        futures = {pool.submit(resolve, name): name for name in names}
        done, _pending = concurrent.futures.wait(futures, timeout=timeout)
        found = {}
        for future in done:
            try:
                found[futures[future]] = [ip for ip in future.result() if _parse(ip) is not None]
            except (OSError, UnicodeError, ValueError, TypeError):
                log.debug("%s does not resolve", futures[future])
        return found
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def discover_docker_paths(*, in_container=_in_container,
                          route=lambda: Path("/proc/net/route").read_text(),
                          fib=lambda: Path("/proc/net/fib_trie").read_text(),
                          resolve=_resolve_v4) -> DockerPaths:
    """The container's paths back to the laptop; empty outside a container.
    Never raises: a source that can't be read adds nothing, and a container
    whose default gateway or own addresses can't be read is `complete=False`.
    Blocking (file reads and up to RESOLVE_TIMEOUT_S of name lookups): run it
    off the event loop."""
    if not in_container():
        return DockerPaths()
    addresses: set[str] = set()
    subnets: list[str] = []
    complete = True
    try:
        gateway, subnets = parse_route(route())
        if gateway:
            addresses.add(gateway)
        else:
            complete = False
    except (OSError, ValueError) as exc:
        complete = False
        log.debug("route table unreadable: %s", type(exc).__name__)
    try:
        own = parse_fib_trie(fib())
        if own:
            addresses |= own
        else:
            complete = False
    except (OSError, ValueError) as exc:
        complete = False
        log.debug("fib_trie unreadable: %s", type(exc).__name__)
    names = resolve_names(DOCKER_NAMES, resolve)
    for found in names.values():
        addresses.update(found)
    return DockerPaths(addresses=frozenset(addresses), subnets=tuple(subnets), in_container=True,
                       complete=complete, desktop=bool(names.get(DESKTOP_NAME)))


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
                   docker: DockerPaths | None = None,
                   own: frozenset = frozenset()) -> str | None:
    """`value` as a printer address when it's a private LAN host that isn't
    the laptop, else None. Network and broadcast addresses are judged by the
    laptop's subnet holding the address; one outside every known subnet is
    judged as a /24 (the scan's own assumption for a large subnet). Docker's
    paths back to the laptop are refused (`DockerPaths`), and so is every
    address in `own` (host-network.json's `self_addresses`)."""
    docker = docker or DockerPaths()
    ip = _parse(value)
    if ip is None or not any(ip in net for net in PRIVATE_NETS):
        return None
    if any(str(ip) == itf.ipv4 for itf in interfaces) or str(ip) in docker.addresses \
            or str(ip) in own:
        return None
    nets = [ipaddress.IPv4Interface(f"{itf.ipv4}/{itf.prefix}").network
            for itf in interfaces]
    # Docker Desktop's VM range, when its host address there is unknown
    if docker.in_container and not docker.desktop and ip in DESKTOP_NET \
            and not any(n.overlaps(DESKTOP_NET) for n in nets):
        return None
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


def parse_host_identification(reply: bytes) -> dict | None:
    """`~HI`'s `STX model,firmware,dots/mm,memory ETX` as {model, firmware,
    dpi}; None when the reply isn't one. Mirrors the kiosk's
    parseHostIdentification (portal/src/labels/zebraUsb.ts)."""
    text = reply.decode("latin-1")
    frames = text.split("\x02")[1:]
    if not frames:
        return None
    parts = [p.strip() for p in frames[-1].split("\x03")[0].split(",")]
    if len(parts) < 4 or not parts[0]:
        return None
    try:
        dpmm = int(parts[2])
    except ValueError:
        return None
    return {"model": parts[0], "firmware": parts[1] or None,
            "dpi": _NOMINAL_DPI.get(dpmm, round(dpmm * 25.4))}


async def identify_printer(ip: str, port: int) -> dict | None:
    """Ask a just-found printer `~HI`; None when it doesn't answer one."""
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(ip, port),
                                                IDENTIFY_TIMEOUT_S)
    except (TimeoutError, OSError):
        return None
    out = bytearray()
    try:
        writer.write(b"~HI")
        async with asyncio.timeout(IDENTIFY_TIMEOUT_S):
            await writer.drain()
            while b"\x03" not in out and len(out) < IDENTIFY_MAX:
                chunk = await reader.read(IDENTIFY_MAX - len(out))
                if not chunk:
                    break
                out += chunk
    except (TimeoutError, OSError):
        pass
    finally:
        await _close(writer)
    return parse_host_identification(bytes(out))


async def _close(writer) -> None:
    writer.close()
    try:
        await writer.wait_closed()
    except (TimeoutError, OSError):
        pass


class Printers:
    """The edge's printer transport. Tests hand in `port`, `allow` (the
    address check; the real guard otherwise), `targets` (the scan's host
    list), `connect` (the scan's probe), `docker_paths` (the lookup of
    Docker's paths back to the laptop, kept once complete) and
    `in_container` (whether there is anything to look up)."""

    def __init__(self, data_dir, *, port: int = PORT, allow=None, targets=None,
                 connect=tcp_connect, identify=identify_printer,
                 docker_paths=discover_docker_paths,
                 in_container=_in_container) -> None:
        self.data_dir = data_dir
        self.port = port
        self._allow = allow
        self._docker_lookup = docker_paths
        self._in_container = in_container
        self._docker: DockerPaths | None = None   # kept: a complete lookup
        self._last: DockerPaths | None = None     # the latest incomplete one
        self._io = asyncio.Semaphore(MAX_CONNECTIONS)
        self._targets = targets
        self._connect = connect
        self._identify = identify
        self._task: asyncio.Task | None = None
        self._snap = {"scan_id": None, "state": "done", "probed": 0, "total": 0,
                      "printers": []}

    # ── the guard ──

    def _interfaces(self) -> list[hostnet.HostInterface]:
        # stale or not: a stale file still names addresses that were the laptop's
        interfaces, _fresh = hostnet.read_host_network(self.data_dir)
        return interfaces

    def _note(self, paths: DockerPaths) -> DockerPaths:
        if paths.unavailable:
            # not kept: the next use looks again
            self._last = paths
            log.warning("printer guard unavailable: Docker's gateway or the container's "
                        "addresses couldn't be read; printer traffic is refused until they can")
        else:
            self._docker = paths
        return paths

    def docker_paths(self) -> DockerPaths:
        """Docker's paths back to the laptop: kept once a lookup is complete,
        looked up again on each use until then. Blocking; on the event loop
        it never looks up (the last result, or unavailable in a container,
        until `guard_ready` has run the lookup in a thread)."""
        if self._docker is not None:
            return self._docker
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return self._note(self._docker_lookup())  # discover_docker_paths never raises
        if self._last is not None:
            return self._last
        return DockerPaths(in_container=True, complete=False) if self._in_container() \
            else DockerPaths()

    async def guard_ready(self) -> DockerPaths:
        """Runs the lookup in a thread (bounded) unless a complete one is kept."""
        if self._allow is not None or self._docker is not None:
            return self._docker or DockerPaths()
        try:
            paths = await asyncio.wait_for(asyncio.to_thread(self._docker_lookup), GUARD_LOOKUP_S)
        except TimeoutError:
            paths = DockerPaths(in_container=True, complete=False)
        return self._note(paths)

    async def check(self, ip) -> None:
        """For query/send/font: PrinterError `printer_guard_unavailable` while
        the guard can't see Docker's paths, `bad_printer_ip` when refused."""
        if self._allow is None and (await self.guard_ready()).unavailable:
            raise PrinterError("printer_guard_unavailable")
        if not self.allowed(ip):
            raise PrinterError("bad_printer_ip")

    def allowed(self, ip, *, scan: bool = False) -> bool:
        """The guard. Refuses everything (but the scan, which uses the
        addresses known) while the Docker lookup is unavailable."""
        if self._allow is not None:
            return bool(self._allow(ip))
        docker = self.docker_paths()
        if docker.unavailable and not scan:
            return False
        own = hostnet.read_self_addresses(self.data_dir)
        return lan_printer_ip(ip, self._interfaces(), docker, own) is not None

    # ── scan ──

    def _scan_targets(self) -> list[str]:
        if self._targets is not None:
            hosts = list(self._targets())
        else:
            interfaces, fresh = hostnet.read_host_network(self.data_dir)
            hosts = hostnet.scan_targets(interfaces) if fresh else []
        return [ip for ip in hosts if self.allowed(ip, scan=True)]

    def start(self) -> str:
        if self._task and not self._task.done():
            self._task.cancel()
        targets = self._scan_targets()
        scan_id = uuid.uuid4().hex
        snap = {"scan_id": scan_id, "state": "running" if targets else "failed",
                "probed": 0, "total": len(targets), "printers": [], "info": {}}
        self._snap = snap  # each scan writes only its own dict
        self._task = asyncio.create_task(self._run(snap, targets)) if targets else None
        return scan_id

    def snapshot(self) -> dict:
        s = self._snap
        found = sorted(s["printers"], key=ipaddress.ip_address)
        info = s.get("info", {})
        blank = {"model": None, "firmware": None, "dpi": None}
        return {k: v for k, v in s.items() if k != "info"} | {
            "printers": [{"ip": ip, **(info.get(ip) or blank)} for ip in found]}

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
                # what it is, for choosing the right printer; still listed if it won't say
                try:
                    snap["info"][ip] = await self._identify(ip, self.port)
                except Exception:  # noqa: BLE001 - a bad answer never drops a found printer
                    snap["info"][ip] = None
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
        await self.check(ip)  # the routes check first; never trust a caller
        try:
            return await asyncio.wait_for(asyncio.open_connection(ip, self.port),
                                          CONNECT_TIMEOUT_S)
        except (TimeoutError, OSError):
            raise PrinterError("printer_unreachable") from None

    @contextlib.asynccontextmanager
    async def _slot(self):
        """One of MAX_CONNECTIONS, waited for at most BUSY_S (`printer_busy`)."""
        try:
            await asyncio.wait_for(self._io.acquire(), BUSY_S)
        except TimeoutError:
            raise PrinterError("printer_busy") from None
        try:
            yield
        finally:
            self._io.release()

    async def query(self, ip: str, data: bytes, *,
                    complete: Callable[[bytes], bool] | None = None) -> tuple[bytes, bool]:
        """Send `data`, then read the reply: (bytes, truncated). Ends when
        `complete(reply)` says it is whole, at EOF, at MAX_READ bytes, after
        IDLE_S without new bytes, or at TOTAL_S."""
        async with self._slot():
            return await self._query(ip, data, complete)

    async def _query(self, ip: str, data: bytes,
                     complete: Callable[[bytes], bool] | None = None) -> tuple[bytes, bool]:
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
                if complete is not None and complete(bytes(out)):
                    break
        finally:
            await _close(writer)
        return bytes(out), truncated

    async def send(self, ip: str, *parts: bytes) -> None:
        """Write the parts in order on one connection."""
        async with self._slot():
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
