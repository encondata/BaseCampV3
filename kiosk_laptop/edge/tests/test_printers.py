"""Network Zebra printers on port 9100 (Label Station phase 1, Task 2): the
subnet scan, raw query and send, font download to the printer, and the IP
guard that keeps the transport aimed at LAN printers only."""

import asyncio
import json
from datetime import UTC, datetime

import pytest
from tests.conftest import make_session

from edge import printers
from edge.printers import DockerPaths, Printers

HI_REPLY = b"\x02ZT411-300dpi,V92.21.39Z,12,8176KB\x03\r\n"


class FakePrinter:
    """A raw TCP printer on localhost: records what it receives and answers
    with `reply` (bytes, or a coroutine function(writer) for slow replies)."""

    def __init__(self, reply=b"", hold_open=True):
        self.reply = reply
        self.hold_open = hold_open
        self.received = bytearray()
        self.got_data = asyncio.Event()
        self.server = None
        self.port = None

    async def start(self):
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def _handle(self, reader, writer):
        try:
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                self.received += chunk
                self.got_data.set()
                if callable(self.reply):
                    await self.reply(writer)
                elif self.reply:
                    writer.write(self.reply)
                    await writer.drain()
                if not self.hold_open:
                    break
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            writer.close()

    async def close(self):
        self.server.close()
        await self.server.wait_closed()


def use_fake(app, fake, targets=None):
    """Aim the edge's printer transport at the fake: its port, and an allow
    check that admits loopback (the real guard never does)."""
    app.state.printers = Printers(app.state.settings.data_dir, port=fake.port,
                                  allow=lambda ip: ip == "127.0.0.1",
                                  targets=targets)


def write_host(app, ips=("10.0.0.5",), prefix=24):
    (app.state.settings.data_dir / "host-network.json").write_text(json.dumps(
        {"updated_at": datetime.now(UTC).isoformat(),
         "interfaces": [{"name": "en0", "ipv4": i, "prefix": prefix} for i in ips]}))


async def wait_done(client, app):
    for _ in range(300):
        body = (await client.get("/edge/printers/scan", headers=make_session(app))).json()
        if body["state"] != "running":
            return body
        await asyncio.sleep(0.01)
    raise AssertionError("scan did not finish")


@pytest.fixture
async def fake():
    printer = await FakePrinter(reply=HI_REPLY).start()
    yield printer
    await printer.close()


# ── session ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("method,path,body", [
    ("POST", "/edge/printers/scan", None),
    ("GET", "/edge/printers/scan", None),
    ("POST", "/edge/printers/query", {"ip": "10.0.0.9", "command": "~HI"}),
    ("POST", "/edge/printers/send", {"ip": "10.0.0.9", "zpl": "^XA^XZ"}),
    ("POST", "/edge/printers/send-font",
     {"ip": "10.0.0.9", "font_id": "f", "name": "A.TTF", "initiative_id": "m"}),
    ("GET", "/edge/label-station", None),
    ("PUT", "/edge/label-station", {}),
])
async def test_routes_need_a_session(client, method, path, body):
    r = await client.request(method, path, json=body)
    assert r.status_code == 401


# ── the IP guard ────────────────────────────────────────────────────

@pytest.mark.parametrize("ip", [
    "8.8.8.8",            # public
    "127.0.0.1",          # loopback
    "169.254.10.20",      # link-local
    "10.0.0.5",           # the laptop's own address
    "10.0.0.0",           # its subnet's network address
    "10.0.0.255",         # its subnet's broadcast address
    "192.168.7.0",        # a /24 network address on another subnet
    "192.168.7.255",      # a /24 broadcast address on another subnet
    "172.32.0.9",         # just past 172.16/12
    "100.64.0.9",         # carrier-grade NAT is not RFC 1918
    "224.0.0.1",          # multicast
    "0.0.0.0",
    "255.255.255.255",
    "::1",
    "fe80::1",
    "::ffff:10.0.0.9",    # IPv4-mapped IPv6
    "10.0.0.09",          # leading zeros
    " 10.0.0.9",
    "printer.local",
    "",
    None,
    12,
])
async def test_bad_printer_ips_are_422(app, client, ip):
    write_host(app)
    headers = make_session(app)
    for path, body in (("/edge/printers/query", {"ip": ip, "command": "~HI"}),
                       ("/edge/printers/send", {"ip": ip, "zpl": "^XA^XZ"})):
        r = await client.post(path, headers=headers, json=body)
        assert r.status_code == 422, (path, ip, r.text)
        assert r.json()["detail"]["code"] == "bad_printer_ip"


@pytest.mark.parametrize("ip", ["10.0.0.9", "172.16.4.4", "172.31.255.254", "192.168.1.50"])
def test_private_lan_addresses_pass_the_guard(app, ip):
    write_host(app)
    assert app.state.printers.allowed(ip)


def test_guard_without_host_info_still_refuses_non_lan(app):
    p = app.state.printers
    assert not p.allowed("8.8.8.8") and not p.allowed("127.0.0.1")
    assert not p.allowed("192.168.1.255") and p.allowed("192.168.1.20")


# ── the guard vs Docker's paths back to the laptop ─────────────────

DOCKER = DockerPaths(
    addresses=frozenset({"172.18.0.3",          # the container itself
                         "172.18.0.1",          # its default gateway (the bridge)
                         "192.168.65.254"}),    # host.docker.internal
    subnets=("172.18.0.0/16",))


def docker_printers(app, paths=DOCKER):
    return Printers(app.state.settings.data_dir, docker_paths=lambda: paths)


@pytest.mark.parametrize("ip", ["172.18.0.3", "172.18.0.1", "192.168.65.254", "172.18.5.5"])
def test_guard_refuses_docker_paths_to_the_laptop(app, ip):
    write_host(app)
    assert not docker_printers(app).allowed(ip)


@pytest.mark.parametrize("ip", ["172.17.5.5", "172.19.0.9", "192.168.65.20", "10.0.0.9"])
def test_guard_does_not_blanket_block_docker_ranges(app, ip):
    write_host(app)
    assert docker_printers(app).allowed(ip)


def test_a_container_subnet_that_is_the_lan_stays_open(app):
    # host networking: the container's subnet is the laptop's LAN
    write_host(app, ips=("10.0.0.5",), prefix=24)
    p = docker_printers(app, DockerPaths(addresses=frozenset({"10.0.0.5", "10.0.0.1"}),
                                         subnets=("10.0.0.0/24",)))
    assert p.allowed("10.0.0.9")
    assert not p.allowed("10.0.0.1")   # the gateway itself stays refused


async def test_docker_paths_bad_ip_is_422_on_the_routes(app, client):
    write_host(app)
    app.state.printers = docker_printers(app)
    r = await client.post("/edge/printers/query", headers=make_session(app),
                          json={"ip": "192.168.65.254", "command": "~HI"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_printer_ip"


def test_docker_paths_are_looked_up_once(app):
    calls = []

    def paths():
        calls.append(1)
        return DOCKER

    p = Printers(app.state.settings.data_dir, docker_paths=paths)
    p.allowed("10.0.0.9")
    p.allowed("10.0.0.10")
    assert calls == [1]


ROUTE = """Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0
"""

FIB = """Main:
  +-- 0.0.0.0/0 3 0 5
     |-- 0.0.0.0
        /0 universe UNICAST
  +-- 127.0.0.0/8 2 0 2
     |-- 127.0.0.1
        /32 host LOCAL
  +-- 172.18.0.0/16 2 0 2
     |-- 172.18.0.3
        /32 host LOCAL
     |-- 172.18.255.255
        /32 link BROADCAST
Local:
  +-- 172.18.0.0/16 2 0 2
     |-- 172.18.0.3
        /32 host LOCAL
"""


def test_route_table_gives_the_gateway_and_connected_subnets():
    gateway, subnets = printers.parse_route(ROUTE)
    assert gateway == "172.18.0.1" and subnets == ["172.18.0.0/16"]


def test_fib_trie_gives_the_container_addresses():
    assert printers.parse_fib_trie(FIB) == {"172.18.0.3"}


def test_discover_docker_paths_from_injected_sources():
    def resolve(name):
        return {"host.docker.internal": ["192.168.65.254"],
                "gateway.docker.internal": ["192.168.65.1"]}.get(name, [])

    paths = printers.discover_docker_paths(in_container=lambda: True, route=lambda: ROUTE,
                                           fib=lambda: FIB, resolve=resolve)
    assert paths.addresses == {"172.18.0.3", "172.18.0.1", "192.168.65.254", "192.168.65.1"}
    assert paths.subnets == ("172.18.0.0/16",)


def test_discover_docker_paths_outside_a_container_is_empty():
    def boom():
        raise AssertionError("not read outside a container")

    paths = printers.discover_docker_paths(in_container=lambda: False, route=boom, fib=boom,
                                           resolve=boom)
    assert paths == DockerPaths()


def test_discover_docker_paths_tolerates_missing_sources():
    def gone():
        raise OSError("no /proc")

    def unresolved(name):
        raise OSError("no such host")

    paths = printers.discover_docker_paths(in_container=lambda: True, route=gone, fib=gone,
                                           resolve=unresolved)
    assert paths == DockerPaths()


# ── scan ────────────────────────────────────────────────────────────

async def test_scan_finds_the_fake_printer(app, client, fake):
    other = await FakePrinter().start()
    await other.close()  # a closed port: nothing listens there now
    use_fake(app, fake, targets=lambda: ["127.0.0.1"])
    r = await client.post("/edge/printers/scan", headers=make_session(app))
    assert r.status_code == 200 and r.json()["scan_id"]
    body = await wait_done(client, app)
    assert body["state"] == "done"
    assert body["probed"] == body["total"] == 1
    assert body["printers"] == [{"ip": "127.0.0.1"}]


async def test_scan_probes_the_laptop_subnet_on_9100_minus_its_own_address(app, client):
    write_host(app, prefix=29)  # 10.0.0.0/29: hosts .1-.6, minus the laptop's .5
    seen = []

    async def connect(ip, port):
        seen.append((ip, port))
        return ip == "10.0.0.3"

    app.state.printers = Printers(app.state.settings.data_dir, connect=connect)
    await client.post("/edge/printers/scan", headers=make_session(app))
    body = await wait_done(client, app)
    assert body["state"] == "done" and body["total"] == 5 and body["probed"] == 5
    assert sorted(seen) == [(f"10.0.0.{n}", 9100) for n in (1, 2, 3, 4, 6)]
    assert body["printers"] == [{"ip": "10.0.0.3"}]


async def test_scan_concurrency_and_timeout_copy_reader_discovery():
    from edge.rfid import discovery
    assert printers.CONCURRENCY == discovery.CONCURRENCY
    assert printers.SCAN_TIMEOUT_S == discovery.TIMEOUT_S
    assert printers.PORT == 9100


async def test_scan_without_fresh_host_info_fails(app, client):
    await client.post("/edge/printers/scan", headers=make_session(app))
    body = (await client.get("/edge/printers/scan", headers=make_session(app))).json()
    assert body["state"] == "failed" and body["total"] == 0 and body["printers"] == []


async def test_scan_never_targets_a_public_subnet(app, client):
    write_host(app, ips=("8.8.8.5",), prefix=29)
    seen = []

    async def connect(ip, port):
        seen.append(ip)
        return True

    app.state.printers = Printers(app.state.settings.data_dir, connect=connect)
    await client.post("/edge/printers/scan", headers=make_session(app))
    body = await wait_done(client, app)
    assert seen == [] and body["printers"] == [] and body["total"] == 0


# ── query ───────────────────────────────────────────────────────────

async def test_query_returns_the_hi_reply(app, client, fake, monkeypatch):
    monkeypatch.setattr(printers, "IDLE_S", 0.2)
    use_fake(app, fake)
    r = await client.post("/edge/printers/query", headers=make_session(app),
                          json={"ip": "127.0.0.1", "command": "~HI"})
    assert r.status_code == 200, r.text
    assert r.json() == {"response": HI_REPLY.decode("latin-1"), "truncated": False}
    assert bytes(fake.received) == b"~HI"


async def test_query_ends_when_the_printer_closes(app, client):
    fake = await FakePrinter(reply=b"done", hold_open=False).start()
    use_fake(app, fake)
    loop = asyncio.get_running_loop()
    started = loop.time()
    r = await client.post("/edge/printers/query", headers=make_session(app),
                          json={"ip": "127.0.0.1", "command": "~HS"})
    assert r.json()["response"] == "done"
    assert loop.time() - started < 1.5  # didn't wait out the 2 s idle
    await fake.close()


async def test_a_reply_over_64_kb_is_cut_off(app, client, monkeypatch):
    monkeypatch.setattr(printers, "IDLE_S", 0.3)
    fake = await FakePrinter(reply=b"x" * 200_000).start()
    use_fake(app, fake)
    r = await client.post("/edge/printers/query", headers=make_session(app),
                          json={"ip": "127.0.0.1", "command": "^XA^HWE:*.*^XZ"})
    body = r.json()
    assert len(body["response"]) == printers.MAX_READ == 65536
    assert body["truncated"] is True
    await fake.close()


async def test_a_reply_that_never_stops_is_cut_off_at_the_total_limit(app, client, monkeypatch):
    monkeypatch.setattr(printers, "IDLE_S", 0.3)
    monkeypatch.setattr(printers, "TOTAL_S", 0.8)

    async def dribble(writer):
        for _ in range(100):
            writer.write(b"y")
            await writer.drain()
            await asyncio.sleep(0.05)

    fake = await FakePrinter(reply=dribble).start()
    use_fake(app, fake)
    loop = asyncio.get_running_loop()
    started = loop.time()
    r = await client.post("/edge/printers/query", headers=make_session(app),
                          json={"ip": "127.0.0.1", "command": "~HI"})
    elapsed = loop.time() - started
    assert r.status_code == 200
    assert 0 < len(r.json()["response"]) < 100 and r.json()["truncated"] is True
    assert elapsed < 2.0
    await fake.close()


async def test_at_most_four_printer_connections_at_once(app, client):
    active = {"now": 0, "max": 0}

    async def slow(writer):
        active["now"] += 1
        active["max"] = max(active["max"], active["now"])
        await asyncio.sleep(0.15)
        writer.write(b"ok")
        await writer.drain()
        active["now"] -= 1

    fake = await FakePrinter(reply=slow, hold_open=False).start()
    use_fake(app, fake)
    headers = make_session(app)
    results = await asyncio.gather(*(client.post("/edge/printers/query", headers=headers,
                                                 json={"ip": "127.0.0.1", "command": "~HS"})
                                     for _ in range(8)))
    assert all(r.status_code == 200 for r in results)
    assert printers.MAX_CONNECTIONS == 4 and active["max"] <= 4
    await fake.close()


async def test_read_limits_are_the_specified_values():
    assert (printers.MAX_READ, printers.IDLE_S, printers.TOTAL_S) == (65536, 2.0, 5.0)


async def test_unreachable_printer_is_502(app, client):
    fake = await FakePrinter().start()
    await fake.close()
    use_fake(app, fake)
    r = await client.post("/edge/printers/query", headers=make_session(app),
                          json={"ip": "127.0.0.1", "command": "~HI"})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "printer_unreachable"


@pytest.mark.parametrize("body", [{"ip": "127.0.0.1"}, {"ip": "127.0.0.1", "command": ""},
                                  {"ip": "127.0.0.1", "command": 5},
                                  {"ip": "127.0.0.1", "command": "x" * 5000}])
async def test_bad_query_bodies_are_422(app, client, fake, body):
    use_fake(app, fake)
    r = await client.post("/edge/printers/query", headers=make_session(app), json=body)
    assert r.status_code == 422


# ── send ────────────────────────────────────────────────────────────

async def test_send_delivers_the_bytes(app, client):
    fake = await FakePrinter().start()
    use_fake(app, fake)
    zpl = "^XA^CI28^FO50,50^A0N,30,30^FDCafé ✓^FS^XZ"
    r = await client.post("/edge/printers/send", headers=make_session(app),
                          json={"ip": "127.0.0.1", "zpl": zpl})
    assert r.status_code == 200 and r.json() == {"ok": True}
    await asyncio.wait_for(fake.got_data.wait(), 2)
    for _ in range(50):
        if len(fake.received) >= len(zpl.encode()):
            break
        await asyncio.sleep(0.01)
    assert bytes(fake.received) == zpl.encode("utf-8")
    await fake.close()


async def test_send_refuses_an_oversized_body_before_parsing(app, client, fake, monkeypatch):
    use_fake(app, fake)
    from edge.routes import printers as printer_routes
    monkeypatch.setattr(printer_routes, "MAX_ZPL", 1000)
    big = json.dumps({"ip": "127.0.0.1", "zpl": "^XA" + "x" * 80_000 + "^XZ"})
    r = await client.post("/edge/printers/send", headers=make_session(app), content=big)
    assert r.status_code == 413 and r.json()["detail"]["code"] == "request_too_large"
    # no Content-Length (a streamed body) is capped while reading
    async def chunks():
        yield big.encode()

    r = await client.post("/edge/printers/send", headers=make_session(app), content=chunks())
    assert r.status_code == 413
    assert fake.received == b""


async def test_send_rejects_an_empty_zpl(app, client, fake):
    use_fake(app, fake)
    r = await client.post("/edge/printers/send", headers=make_session(app),
                          json={"ip": "127.0.0.1", "zpl": ""})
    assert r.status_code == 422


# ── send-font ───────────────────────────────────────────────────────

FONT_ID = "11111111-2222-3333-4444-555555555555"
MOVE_ID = "99999999-8888-7777-6666-555555555555"
FONT_BYTES = bytes(range(256)) * 40 + b"\x00tail"


def _online(app):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)


async def test_send_font_streams_dy_with_the_exact_byte_length(app, client, cloud):
    fake = await FakePrinter().start()
    use_fake(app, fake)
    _online(app)
    route = cloud.get(f"/kiosk/labels/fonts/{FONT_ID}/content").respond(
        200, content=FONT_BYTES,
        headers={"content-type": "font/ttf",
                 "content-disposition": 'attachment; filename="SWISS.TTF"'})
    r = await client.post("/edge/printers/send-font", headers=make_session(app),
                          json={"ip": "127.0.0.1", "font_id": FONT_ID, "name": "SWISS.TTF",
                                "initiative_id": MOVE_ID})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}
    call = route.calls[-1].request
    assert call.url.params["initiative_id"] == MOVE_ID
    assert call.headers["authorization"] == "Bearer a1"
    header = f"~DYE:SWISS.TTF,B,T,{len(FONT_BYTES)},,".encode()
    for _ in range(100):
        if len(fake.received) >= len(header) + len(FONT_BYTES):
            break
        await asyncio.sleep(0.01)
    assert bytes(fake.received) == header + FONT_BYTES
    await fake.close()


async def test_send_font_passes_the_cloud_refusal_through(app, client, cloud, fake):
    use_fake(app, fake)
    _online(app)
    cloud.get(f"/kiosk/labels/fonts/{FONT_ID}/content").respond(
        404, json={"detail": {"code": "font_not_found"}})
    r = await client.post("/edge/printers/send-font", headers=make_session(app),
                          json={"ip": "127.0.0.1", "font_id": FONT_ID, "name": "SWISS.TTF",
                                "initiative_id": MOVE_ID})
    assert r.status_code == 404 and r.json()["detail"]["code"] == "font_not_found"
    assert fake.received == b""


async def test_send_font_name_must_match_the_cloud_font(app, client, cloud, fake):
    use_fake(app, fake)
    _online(app)
    cloud.get(f"/kiosk/labels/fonts/{FONT_ID}/content").respond(
        200, content=FONT_BYTES,
        headers={"content-disposition": 'attachment; filename="OTHER.TTF"'})
    r = await client.post("/edge/printers/send-font", headers=make_session(app),
                          json={"ip": "127.0.0.1", "font_id": FONT_ID, "name": "SWISS.TTF",
                                "initiative_id": MOVE_ID})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "font_name_mismatch"
    assert fake.received == b""


async def test_send_font_without_a_cloud_filename_is_refused(app, client, cloud, fake):
    use_fake(app, fake)
    _online(app)
    cloud.get(f"/kiosk/labels/fonts/{FONT_ID}/content").respond(200, content=FONT_BYTES)
    r = await client.post("/edge/printers/send-font", headers=make_session(app),
                          json={"ip": "127.0.0.1", "font_id": FONT_ID, "name": "SWISS.TTF",
                                "initiative_id": MOVE_ID})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "font_name_mismatch"
    assert fake.received == b""


@pytest.mark.parametrize("change", [
    {"name": "SWISS.TTF,B,T,1,,^XA"}, {"name": "../x.TTF"}, {"name": "SWISS.OTF"},
    {"name": ""}, {"font_id": "../../auth/me"}, {"initiative_id": "x&y=1"}, {"font_id": None},
])
async def test_send_font_bad_bodies_are_422(app, client, fake, change):
    use_fake(app, fake)
    _online(app)
    body = {"ip": "127.0.0.1", "font_id": FONT_ID, "name": "SWISS.TTF",
            "initiative_id": MOVE_ID, **change}
    r = await client.post("/edge/printers/send-font", headers=make_session(app), json=body)
    assert r.status_code == 422


async def test_send_font_without_a_cloud_session_is_403(app, client, fake):
    use_fake(app, fake)
    r = await client.post("/edge/printers/send-font", headers=make_session(app),
                          json={"ip": "127.0.0.1", "font_id": FONT_ID, "name": "SWISS.TTF",
                                "initiative_id": MOVE_ID})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "cloud_sign_in_required"


async def test_send_font_needs_an_online_session(app, client, fake):
    use_fake(app, fake)
    r = await client.post("/edge/printers/send-font", headers=make_session(app, offline=True),
                          json={"ip": "127.0.0.1", "font_id": FONT_ID, "name": "SWISS.TTF",
                                "initiative_id": MOVE_ID})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"


async def test_send_font_bad_ip_is_422_before_any_cloud_call(app, client, cloud):
    _online(app)
    route = cloud.get(f"/kiosk/labels/fonts/{FONT_ID}/content").respond(200, content=b"x")
    r = await client.post("/edge/printers/send-font", headers=make_session(app),
                          json={"ip": "8.8.8.8", "font_id": FONT_ID, "name": "SWISS.TTF",
                                "initiative_id": MOVE_ID})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_printer_ip"
    assert not route.called
