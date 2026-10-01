"""The laptop's own network addresses, as written by the installer's host
helper into `<data dir>/host-network.json` (spec §2.1). The edge treats a
missing, unparseable or stale (> 5 minutes) file as "unknown"."""

import ipaddress
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

FILE_NAME = "host-network.json"
STALE_AFTER_S = 300
REFRESH_S = 30
MAX_TARGETS = 512
BASE_HOSTS = ("localhost", "127.0.0.1", "[::1]")


@dataclass
class HostInterface:
    name: str
    ipv4: str
    prefix: int


def _parse_time(value) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def read_host_network(data_dir, *, now: datetime | None = None) -> tuple[list[HostInterface], bool]:
    """(interfaces, fresh). Missing or unparseable file -> ([], False)."""
    try:
        data = json.loads((Path(data_dir) / FILE_NAME).read_text())
        stamp = _parse_time(data["updated_at"])
        found = []
        for item in data["interfaces"]:
            ip = ipaddress.IPv4Address(item["ipv4"])
            prefix = int(item["prefix"])
            if not 0 <= prefix <= 32:
                continue
            found.append(HostInterface(str(item.get("name", "")), str(ip), prefix))
    except (OSError, ValueError, KeyError, TypeError):
        return [], False
    if stamp is None:
        return [], False
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return found, abs((now - stamp).total_seconds()) <= STALE_AFTER_S


def laptop_ip_for(reader_ip: str, interfaces: list[HostInterface]) -> str | None:
    try:
        target = ipaddress.IPv4Address(reader_ip)
    except ValueError:
        return None
    for itf in interfaces:
        if target in ipaddress.IPv4Interface(f"{itf.ipv4}/{itf.prefix}").network:
            return itf.ipv4
    return None


def scan_targets(interfaces: list[HostInterface]) -> list[str]:
    """Host IPs to scan: each interface's subnet (the /24 holding the laptop
    when the subnet is larger than /23), deduplicated, at most 512 per
    interface, never the laptop's own addresses."""
    own = {itf.ipv4 for itf in interfaces}
    out: list[str] = []
    seen: set[str] = set()
    for itf in interfaces:
        prefix = itf.prefix if itf.prefix >= 23 else 24
        net = ipaddress.IPv4Interface(f"{itf.ipv4}/{prefix}").network
        count = 0
        for host in net.hosts():
            if count >= MAX_TARGETS:
                break
            ip = str(host)
            if ip in own:
                continue
            count += 1
            if ip not in seen:
                seen.add(ip)
                out.append(ip)
    return out


class DynamicHosts:
    """Allowed Host names: the fixed ones plus the laptop's fresh IPs,
    re-read from the file at most every 30 s. `clock` returns epoch seconds."""

    def __init__(self, data_dir, extra=(), *, clock=time.time):
        self._dir = Path(data_dir)
        self._base = {*BASE_HOSTS, *extra}
        self._clock = clock
        self._checked: float | None = None
        self._ips: set[str] = set()

    def allowed(self) -> set[str]:
        t = self._clock()
        if self._checked is None or t - self._checked >= REFRESH_S:
            self._checked = t
            interfaces, fresh = read_host_network(
                self._dir, now=datetime.fromtimestamp(t, timezone.utc))
            self._ips = {i.ipv4 for i in interfaces} if fresh else set()
        return self._base | self._ips
