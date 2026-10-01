import dataclasses
import json
from datetime import datetime, timedelta, timezone

import httpx

from edge.app import create_app
from edge.hostnet import (DynamicHosts, HostInterface, laptop_ip_for, read_host_network,
                          scan_targets)

NOW = datetime(2026, 10, 1, 18, 0, 0, tzinfo=timezone.utc)


def write(dirpath, updated_at=NOW, interfaces=None):
    interfaces = interfaces if interfaces is not None else [
        {"name": "en0", "ipv4": "10.10.48.57", "prefix": 24}]
    (dirpath / "host-network.json").write_text(json.dumps(
        {"updated_at": updated_at.strftime("%Y-%m-%dT%H:%M:%SZ"), "interfaces": interfaces}))


def test_fresh_stale_missing(tmp_path):
    assert read_host_network(tmp_path, now=NOW) == ([], False)
    write(tmp_path, NOW - timedelta(seconds=60))
    itfs, fresh = read_host_network(tmp_path, now=NOW)
    assert fresh and itfs == [HostInterface("en0", "10.10.48.57", 24)]
    write(tmp_path, NOW - timedelta(seconds=301))
    assert read_host_network(tmp_path, now=NOW)[1] is False
    (tmp_path / "host-network.json").write_text("{nope")
    assert read_host_network(tmp_path, now=NOW) == ([], False)


def test_laptop_ip_for():
    itfs = [HostInterface("en0", "10.10.48.57", 24), HostInterface("en1", "192.168.1.5", 24)]
    assert laptop_ip_for("192.168.1.90", itfs) == "192.168.1.5"
    assert laptop_ip_for("10.10.48.2", itfs) == "10.10.48.57"
    assert laptop_ip_for("172.16.0.1", itfs) is None


def test_scan_targets_sizes():
    t24 = scan_targets([HostInterface("a", "10.10.48.57", 24)])
    assert len(t24) == 253 and "10.10.48.57" not in t24 and "10.10.48.1" in t24
    t22 = scan_targets([HostInterface("a", "10.10.50.7", 22)])
    assert len(t22) == 253 and all(ip.startswith("10.10.50.") for ip in t22)
    t30 = scan_targets([HostInterface("a", "10.0.0.1", 30)])
    assert t30 == ["10.0.0.2"]
    assert len(scan_targets([HostInterface("a", "10.0.0.1", 23)])) == 509


def test_scan_targets_dedupes():
    itfs = [HostInterface("a", "10.0.0.5", 24), HostInterface("b", "10.0.0.6", 24)]
    out = scan_targets(itfs)
    assert len(out) == len(set(out)) and "10.0.0.5" not in out and "10.0.0.6" not in out


def test_dynamic_hosts_refresh(tmp_path):
    t = [NOW.timestamp()]
    hosts = DynamicHosts(tmp_path, ["edge.test"], clock=lambda: t[0])
    assert hosts.allowed() == {"localhost", "127.0.0.1", "[::1]", "edge.test"}
    write(tmp_path, datetime.fromtimestamp(t[0], timezone.utc))
    t[0] += 10
    assert "10.10.48.57" not in hosts.allowed()  # within 30 s: not re-read
    t[0] += 21
    write(tmp_path, datetime.fromtimestamp(t[0], timezone.utc))
    assert "10.10.48.57" in hosts.allowed()
    t[0] += 400  # file now stale
    assert "10.10.48.57" not in hosts.allowed()


async def test_app_accepts_lan_ip_and_rejects_unknown(settings, cloud):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    write(settings.data_dir, datetime.now(timezone.utc))
    app = create_app(dataclasses.replace(settings))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://edge.test") as c:
        r = await c.get("/edge/identity", headers={"host": "10.10.48.57:8090"})
        assert r.status_code == 200
        r = await c.get("/edge/identity", headers={"host": "10.10.48.99:8090"})
        assert r.status_code == 400


async def test_lan_access_flag(settings, cloud):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    write(settings.data_dir, datetime.now(timezone.utc))
    transport = httpx.ASGITransport(app=create_app(settings))
    async with httpx.AsyncClient(transport=transport, base_url="http://edge.test") as c:
        r = await c.get("/config.js", headers={"host": "10.10.48.57:8090"})
        assert '"lanAccess": true' in r.text
        for host in ("localhost:8090", "127.0.0.1:8090", "[::1]:8090"):
            r = await c.get("/config.js", headers={"host": host})
            assert '"lanAccess": false' in r.text
