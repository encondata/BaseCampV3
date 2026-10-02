import asyncio
import json
from datetime import datetime, timezone

from edge.rfid import pairing
from edge.rfid.discovery import Discovery
from tests.conftest import make_session


def write_host(app, ips=("10.0.0.5",), prefix=29, stamp=None):
    stamp = stamp or datetime.now(timezone.utc).isoformat()
    (app.state.settings.data_dir / "host-network.json").write_text(json.dumps(
        {"updated_at": stamp, "interfaces": [{"name": "en0", "ipv4": i, "prefix": prefix}
                                              for i in ips]}))


def conn(name, url="http://10.0.0.7:8091/rfid/x/theirs"):
    return {"READER-GATEWAY": {"endpointConfig": {"data": {"event": {
        "connections": [{"name": name, "options": {"URL": url}}]}}}}}


def own(app):
    return pairing.own_prefix(app.state.identity) + "(Me)"


def store_token(app, serial, token):
    pairing.remember(app.state.store, serial=serial, ip="10.0.0.2", model="FX7500",
                     versions={}, password_index=0, token=token)


async def wait_done(disc):
    for _ in range(200):
        if disc.snapshot()["state"] != "running":
            return disc.snapshot()
        await asyncio.sleep(0.01)
    raise AssertionError("scan did not finish")


def make(app, up=None, found=None):
    async def connect(ip, port):
        if up is None:
            return port == 443
        r = up(ip)
        if isinstance(r, BaseException):
            raise r
        return r

    async def probe(ip, **kw):
        assert kw["scheme"] == "https" and kw["port"] == 443
        return found(ip) if found else None
    return Discovery(app.state.store, app.state.settings.data_dir, connect=connect, probe=probe,
                     identity=lambda: app.state.identity)


async def test_progress_fx_kept_non_fx_dropped(app):
    write_host(app)  # 10.0.0.5/29 -> 6 hosts, minus own = 5
    store_token(app, "S2", "ourtoken")
    seen = []

    def found(ip):
        seen.append(ip)
        if ip == "10.0.0.1":
            return {"ip": ip, "model": "FX9600", "serial": "S1",
                    "config": conn("ServerSherpa Kiosk 9999 (Dock)")}
        if ip == "10.0.0.2":
            return {"ip": ip, "model": "FX7500", "serial": "S2", "config": conn(own(app), "http://10.0.0.5:8091/rfid/S2/ourtoken")}
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

    async def connect(ip, port):
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

    async def connect(ip, port):
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


async def test_probe_uses_the_long_timeout(app):
    import httpx
    write_host(app)
    timeouts = []

    async def probe(ip, **kw):
        timeouts.append(kw["timeout"])
    disc = Discovery(app.state.store, app.state.settings.data_dir,
                     connect=lambda ip, port: asyncio.sleep(0, True), probe=probe)
    disc.start()
    await wait_done(disc)
    assert timeouts and all(t == httpx.Timeout(5.0, connect=3.0) for t in timeouts)


async def test_a_failure_leaves_no_child_running(app):
    write_host(app)
    running = 0

    async def connect(ip, port):
        nonlocal running
        if ip.endswith(".1"):
            raise ValueError("boom")
        running += 1
        await asyncio.sleep(0.05)
        running -= 1
        return False
    disc = Discovery(app.state.store, app.state.settings.data_dir, connect=connect, probe=None)
    disc.start()
    snap = await wait_done(disc)
    assert snap["state"] == "failed" and snap["probed"] == snap["total"]
    assert running == 0 and all(t.done() for t in asyncio.all_tasks() if t is not asyncio.current_task()
                                and "_check" in repr(t))


async def test_readers_sorted_numerically_by_ip(app):
    write_host(app, ips=("10.0.0.200",), prefix=24)
    disc = make(app, found=lambda ip: {"ip": ip, "model": "FX9600", "serial": "S" + ip}
                if ip in ("10.0.0.9", "10.0.0.100", "10.0.0.20") else None)
    disc.start()
    snap = await wait_done(disc)
    assert [r["ip"] for r in snap["readers"]] == ["10.0.0.9", "10.0.0.20", "10.0.0.100"]


async def test_rescan_does_not_leak_old_results(app):
    write_host(app)
    gate = asyncio.Event()

    async def probe(ip, **kw):
        await gate.wait()
        return {"ip": ip, "model": "FX9600", "serial": "OLD"}
    disc = Discovery(app.state.store, app.state.settings.data_dir,
                     connect=lambda ip, port: asyncio.sleep(0, True), probe=probe)
    disc.start()
    await asyncio.sleep(0.02)  # old scan is parked inside probe
    async def quiet(ip, **kw):
        return None
    disc._probe = quiet
    disc.start()
    gate.set()
    snap = await wait_done(disc)
    await asyncio.sleep(0.05)
    snap = disc.snapshot()
    assert snap["readers"] == [] and snap["probed"] == snap["total"] == 5


async def test_scan_uses_the_same_ours_rule_as_pairing(app):
    """Ours = our name prefix AND a URL carrying our stored token for that serial."""
    write_host(app)
    store_token(app, "TWIN", "ourtoken")
    configs = {
        # a twin kiosk sharing our last 4, with its own token
        "10.0.0.1": ("TWIN", conn(own(app), "http://10.0.0.8:8091/rfid/TWIN/theirtoken")),
        # our own stale connection, but this laptop has no token for the reader
        "10.0.0.2": ("STALE", conn(own(app), "http://10.0.0.5:8091/rfid/STALE/lost")),
    }
    disc = make(app, found=lambda ip: {"ip": ip, "model": "FX9600", "serial": configs[ip][0],
                                       "config": configs[ip][1]} if ip in configs else None)
    disc.start()
    snap = await wait_done(disc)
    assert {r["ip"]: r["paired_with"] for r in snap["readers"]} == {
        "10.0.0.1": own(app), "10.0.0.2": own(app)}


# ── final fix round: both ports, fingerprint before credentials (D1) ──

from tests.fake_reader import FakeNas, FakeReader, RoutingTransport  # noqa: E402


def lan(app, hosts):
    """A /29 around 10.0.0.5 whose hosts are fakes, scanned with the real
    ziotc.discover; returns the routing transport."""
    write_host(app)
    routing = RoutingTransport(hosts)
    app.state.reader_transport = routing

    async def connect(ip, port):
        return port in routing.open_ports(ip)
    app.state.discovery = Discovery(app.state.store, app.state.settings.data_dir,
                                    connect=connect, identity=lambda: app.state.identity,
                                    transport=lambda ip: routing)
    return routing


async def scan(app):
    app.state.discovery.start()
    return {r["ip"]: r for r in (await wait_done(app.state.discovery))["readers"]}


async def test_a_generic_401_host_gets_no_credentials(app):
    nas = FakeNas()
    lan(app, {"10.0.0.1": nas})
    # even a remembered index for that IP isn't sent: it isn't a Zebra candidate
    pairing.remember(app.state.store, serial="OLD", ip="10.0.0.1", model="FX9600",
                     versions={}, password_index=0)
    assert await scan(app) == {}
    assert nas.requests >= 1 and nas.credential_attempts == 0


async def test_a_zebra_candidate_with_no_remembered_index_needs_connect(app):
    reader = FakeReader()
    lan(app, {"10.0.0.2": reader})
    cards = await scan(app)
    assert cards == {"10.0.0.2": {"ip": "10.0.0.2", "scheme": "https", "port": 443,
                                  "model": None, "serial": None, "paired_with": None,
                                  "needs_connect": True}}
    assert reader.login_attempts == []


async def test_only_the_remembered_index_is_tried(app):
    reader = FakeReader(password_index=3)
    lan(app, {"10.0.0.3": reader})
    pairing.remember(app.state.store, serial="84248dee5721", ip="10.0.0.3", model="FX9600",
                     versions={}, password_index=1)
    cards = await scan(app)
    assert reader.login_attempts == [1]  # the stale index alone, never the list
    assert cards["10.0.0.3"]["needs_connect"] is True
    pairing.remember(app.state.store, serial="84248dee5721", ip="10.0.0.3", model="FX9600",
                     versions={}, password_index=3)
    reader.login_attempts.clear()
    cards = await scan(app)
    assert reader.login_attempts == [3]
    assert cards["10.0.0.3"]["needs_connect"] is False
    assert (cards["10.0.0.3"]["model"], cards["10.0.0.3"]["serial"]) == ("FX9600", "84248dee5721")


async def test_an_http_only_reader_is_found_and_connected_over_http(app, client):
    reader = FakeReader(ports=(80,))
    routing = lan(app, {"10.0.0.4": reader})
    cards = await scan(app)
    assert (cards["10.0.0.4"]["scheme"], cards["10.0.0.4"]["port"]) == ("http", 80)
    r = await client.post("/edge/rfid/connect", headers=make_session(app),
                          json={"ip": "10.0.0.4"})
    assert r.status_code == 200, r.text
    assert r.json()["serial"] == "84248dee5721"
    sent = routing.hosts["10.0.0.4"].requests
    assert sent and all(req.url.scheme == "http" for req in sent)
    row = app.state.store.one("SELECT scheme, port FROM rfid_readers WHERE serial = ?",
                              ("84248dee5721",))
    assert (row["scheme"], row["port"]) == ("http", 80)


async def test_443_is_preferred_when_both_are_open(app):
    reader = FakeReader(ports=(443, 80))
    routing = lan(app, {"10.0.0.6": reader})
    cards = await scan(app)
    assert list(cards) == ["10.0.0.6"]
    assert (cards["10.0.0.6"]["scheme"], cards["10.0.0.6"]["port"]) == ("https", 443)
    assert all(req.url.scheme == "https" for req in routing.hosts["10.0.0.6"].requests)
    assert app.state.discovery.endpoint_for("10.0.0.6") == ("https", 443)
