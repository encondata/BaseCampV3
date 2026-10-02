import asyncio
import json
from datetime import datetime, timezone

from edge.rfid.discovery import Discovery
from tests.conftest import make_session


def write_host(app, ips=("10.0.0.5",), prefix=29, stamp=None):
    stamp = stamp or datetime.now(timezone.utc).isoformat()
    (app.state.settings.data_dir / "host-network.json").write_text(json.dumps(
        {"updated_at": stamp, "interfaces": [{"name": "en0", "ipv4": i, "prefix": prefix}
                                              for i in ips]}))


def conn(name):
    return {"READER-GATEWAY": {"endpointConfig": {"data": {"event": {
        "connections": [{"name": name}]}}}}}


async def wait_done(disc):
    for _ in range(200):
        if disc.snapshot()["state"] != "running":
            return disc.snapshot()
        await asyncio.sleep(0.01)
    raise AssertionError("scan did not finish")


def make(app, up=None, found=None):
    async def connect(ip):
        if up is None:
            return True
        r = up(ip)
        if isinstance(r, BaseException):
            raise r
        return r

    async def probe(ip, **kw):
        assert kw["quiet"] is True
        return found(ip) if found else None
    return Discovery(app.state.store, app.state.settings.data_dir, connect=connect, probe=probe,
                     own_connection=lambda: "ServerSherpa Kiosk 0001 ")


async def test_progress_fx_kept_non_fx_dropped(app):
    write_host(app)  # 10.0.0.5/29 -> 6 hosts, minus own = 5
    seen = []

    def found(ip):
        seen.append(ip)
        if ip == "10.0.0.1":
            return {"ip": ip, "model": "FX9600", "serial": "S1",
                    "config": conn("ServerSherpa Kiosk 9999 (Dock)")}
        if ip == "10.0.0.2":
            return {"ip": ip, "model": "FX7500", "serial": "S2", "config": conn("ServerSherpa Kiosk 0001 (Me)")}
        if ip == "10.0.0.3":
            return {"ip": ip, "model": "FX9600", "serial": None}
        return None  # not FX
    disc = make(app, found=found)
    sid = disc.start()
    snap = await wait_done(disc)
    assert snap["scan_id"] == sid and snap["state"] == "done"
    assert snap["probed"] == snap["total"] == 5
    assert snap["host"] == {"ips": ["10.0.0.5"], "fresh": True}
    assert sorted((r["ip"], r["paired_with"]) for r in snap["readers"]) == [
        ("10.0.0.1", "ServerSherpa Kiosk 9999 (Dock)"), ("10.0.0.2", None)]


async def test_timeout_counts_as_probed(app):
    write_host(app)
    disc = make(app, up=lambda ip: asyncio.TimeoutError() if ip.endswith(".1") else False)
    disc.start()
    snap = await wait_done(disc)
    assert snap["state"] == "done" and snap["probed"] == snap["total"] == 5
    assert snap["readers"] == []


async def test_rescan_cancels_earlier(app):
    write_host(app)
    gate = asyncio.Event()

    async def connect(ip):
        await gate.wait()
        return False
    disc = Discovery(app.state.store, app.state.settings.data_dir, connect=connect,
                     probe=None)
    first = disc.start()
    task = disc._task
    await asyncio.sleep(0)
    second = disc.start()
    await asyncio.sleep(0)
    assert first != second
    await asyncio.sleep(0.05)
    assert task.cancelled()
    assert disc.snapshot()["scan_id"] == second and disc.snapshot()["probed"] == 0
    await disc.aclose()


async def test_stale_host_fails_without_scanning(app):
    write_host(app, stamp="2020-01-01T00:00:00+00:00")
    called = []

    async def connect(ip):
        called.append(ip)
        return False
    disc = Discovery(app.state.store, app.state.settings.data_dir, connect=connect, probe=None)
    disc.start()
    snap = disc.snapshot()
    assert snap["state"] == "failed" and snap["host"]["fresh"] is False and snap["total"] == 0
    assert called == []


async def test_endpoints_need_a_session(client):
    assert (await client.post("/edge/rfid/scan")).status_code == 401
    assert (await client.get("/edge/rfid/scan")).status_code == 401


async def test_endpoints_run_a_scan(app, client):
    write_host(app)
    app.state.discovery = make(app, up=lambda ip: False)
    h = make_session(app)
    sid = (await client.post("/edge/rfid/scan", headers=h)).json()["scan_id"]
    await wait_done(app.state.discovery)
    body = (await client.get("/edge/rfid/scan", headers=h)).json()
    assert body["scan_id"] == sid and body["state"] == "done"
