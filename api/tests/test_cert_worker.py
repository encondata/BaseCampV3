"""The cert-worker: it renews only from the droplet the load balancer sends
traffic to, only inside 30 days, only while it holds the advisory lock; a
renewal uploads the new certificate, moves the load balancer to it and
deletes the old one. ACME itself is tested in Sirdar (the same acme.py);
here acme.issue is replaced. Tokens never reach a log or repr()."""

import asyncio
import base64
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from serversherpa.certs import acme, worker

TOKEN = "dop_v1_" + "ab" * 32
KEY_PEM = acme.new_key_pem()
NAMES = ("api.uat9.serversherpa.com", "portal.uat9.serversherpa.com")
NOW = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)


def _cfg(**over) -> worker.WorkerConfig:
    base = {"token": TOKEN, "lb_id": "lb-1", "names": NAMES, "env": "uat9",
            "directory": "https://acme.test/directory", "key_pem": KEY_PEM,
            "droplet_id": "4001", "port": 0}
    return worker.WorkerConfig(**{**base, **over})


class FakeDo:
    """The renewal token's view: one load balancer and its certificates."""

    def __init__(self, days_left: int, targets: list[int]):
        self.certs = {"old": {"id": "old", "name": "ss-uat9-202609010000",
                              "not_after": (NOW + timedelta(days=days_left))
                              .strftime("%Y-%m-%dT%H:%M:%SZ"), "dns_names": list(NAMES)}}
        self.lb = {"id": "lb-1", "name": "ss-uat9-lb", "region": {"slug": "nyc3"},
                   "size_unit": 1, "vpc_uuid": "vpc-1", "droplet_ids": targets,
                   "redirect_http_to_https": False, "ip": "203.0.113.9", "status": "active",
                   "created_at": "2026-09-01T00:00:00Z", "tag": "",
                   "sticky_sessions": {"type": "none"}, "http_idle_timeout_seconds": 90,
                   "health_check": {"protocol": "http", "port": 80, "path": "/healthz"},
                   "forwarding_rules": [
                       {"entry_protocol": "https", "entry_port": 443, "target_protocol": "http",
                        "target_port": 80, "certificate_id": "old"},
                       {"entry_protocol": "http", "entry_port": 80, "target_protocol": "http",
                        "target_port": 80}]}
        self.calls: list[tuple[str, str]] = []
        self.bodies: dict[tuple[str, str], dict] = {}
        self.fail: dict[tuple[str, str], int] = {}
        self.busy_reads = 0         # GETs of the load balancer before it is active again
        self.lb_puts: list[list[int]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        path, method = request.url.path.removeprefix("/v2"), request.method
        self.calls.append((method, path))
        if request.content:
            self.bodies[(method, path)] = json.loads(request.content)
        if (method, path) in self.fail:
            return httpx.Response(self.fail[(method, path)], json={
                "id": "server_error", "message": f"boom {TOKEN}"})
        if path == "/load_balancers/lb-1" and method == "GET":
            if self.busy_reads:
                self.busy_reads -= 1
                self.lb = {**self.lb, "status": "update_pending" if self.busy_reads else "active"}
            return httpx.Response(200, json={"load_balancer": self.lb})
        if path == "/load_balancers/lb-1" and method == "PUT":
            self.lb_puts.append(list(json.loads(request.content)["droplet_ids"]))
            self.lb = {**self.lb, **json.loads(request.content)}
            return httpx.Response(200, json={"load_balancer": self.lb})
        if path.startswith("/certificates/") and method == "GET":
            cert = self.certs.get(path.rsplit("/", 1)[1])
            return (httpx.Response(200, json={"certificate": cert}) if cert
                    else httpx.Response(404, json={"id": "not_found"}))
        if path == "/certificates" and method == "POST":
            body = json.loads(request.content)
            self.certs["new"] = {"id": "new", "name": body["name"], "dns_names": list(NAMES),
                                 "not_after": "2027-01-03T12:00:00Z"}
            return httpx.Response(201, json={"certificate": self.certs["new"]})
        if path.startswith("/certificates/") and method == "DELETE":
            self.certs.pop(path.rsplit("/", 1)[1], None)
            return httpx.Response(204)
        return httpx.Response(404, json={"id": "not_found"})


def _issued(chain: bool = True) -> acme.Issued:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, NAMES[0])])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(1)
            .not_valid_before(NOW).not_valid_after(NOW + timedelta(days=90))
            .sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    key_pem = key.private_bytes(serialization.Encoding.PEM,
                                serialization.PrivateFormat.TraditionalOpenSSL,
                                serialization.NoEncryption()).decode()
    return acme.Issued(key_pem=key_pem, leaf_pem=pem, chain_pem=pem if chain else "",
                       not_after=NOW,
                       names=NAMES)


@asynccontextmanager
async def _lock(got: bool = True):
    yield got


async def _nosleep(seconds):
    return None


async def _check(fake: FakeDo, monkeypatch, *, locked=False, chain=True, on_issue=None):
    async def fake_issue(client, names, kind, solve):
        assert kind == "http-01" and tuple(names) == NAMES
        fake.issued = True
        if on_issue:
            on_issue()
        return _issued(chain)
    fake.issued = False
    monkeypatch.setattr(acme, "issue", fake_issue)
    return await worker.check_once(
        _cfg(), challenges=worker.Challenges(), now=NOW, sleep=_nosleep,
        transports={"digitalocean": httpx.MockTransport(fake.handler)},
        try_lock=lambda: _lock(not locked))


def test_config_from_settings_hides_secrets():
    from serversherpa.config import get_settings
    settings = get_settings().model_copy(update={
        "cert_do_token": None, "cert_lb_id": "", "cert_names": ""})
    assert worker.config_from(settings) is None
    from pydantic import SecretStr
    settings = settings.model_copy(update={
        "cert_do_token": SecretStr(TOKEN), "cert_lb_id": "lb-1",
        "cert_names": ",".join(NAMES), "cert_env": "uat9", "cert_droplet_id": "4001",
        "cert_acme_key": SecretStr(base64.b64encode(KEY_PEM.encode()).decode())})
    cfg = worker.config_from(settings)
    assert (cfg.names, cfg.droplet_id, cfg.key_pem) == (NAMES, "4001", KEY_PEM)
    assert TOKEN not in repr(cfg) and "PRIVATE KEY" not in repr(cfg)


async def test_only_the_active_slot_renews(monkeypatch):
    fake = FakeDo(days_left=5, targets=[4002])
    assert await _check(fake, monkeypatch) == "not_active"
    assert ("POST", "/certificates") not in fake.calls


async def test_nothing_to_do_outside_30_days(monkeypatch):
    fake = FakeDo(days_left=45, targets=[4001])
    assert await _check(fake, monkeypatch) == "fresh"


async def test_another_worker_holds_the_lock(monkeypatch):
    fake = FakeDo(days_left=20, targets=[4001])
    assert await _check(fake, monkeypatch, locked=True) == "locked"


async def test_renewal_swaps_the_certificate(monkeypatch):
    fake = FakeDo(days_left=20, targets=[4001])
    assert await _check(fake, monkeypatch) == "renewed"
    https = next(r for r in fake.lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert https["certificate_id"] == "new" and fake.lb["droplet_ids"] == [4001]
    assert fake.certs["new"]["name"] == "ss-uat9-202610051200" and "old" not in fake.certs
    assert fake.calls.index(("PUT", "/load_balancers/lb-1")) < fake.calls.index(
        ("DELETE", "/certificates/old"))


async def test_the_challenge_server_answers_tokens():
    challenges = worker.Challenges()
    server = await challenges.start("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]

    async def get(path: str) -> bytes:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(f"GET {path} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        await writer.drain()
        data = await reader.read()
        writer.close()
        return data

    try:
        async with challenges.solver("http-01", NAMES[0], "tok123", "tok123.thumb"):
            assert (await get("/.well-known/acme-challenge/tok123")).endswith(b"tok123.thumb")
        assert b" 404 " in await get("/.well-known/acme-challenge/tok123")
        assert b" 404 " in await get("/anything-else")
    finally:
        server.close()
        await server.wait_closed()


async def test_the_advisory_lock_is_single(db):
    async with worker.advisory_lock() as first:
        assert first is True
        async with worker.advisory_lock() as second:
            assert second is False
    async with worker.advisory_lock() as again:
        assert again is True


async def test_the_load_balancer_keeps_what_the_worker_doesnt_manage(monkeypatch):
    fake = FakeDo(days_left=20, targets=[4001])
    assert await _check(fake, monkeypatch) == "renewed"
    body = fake.bodies[("PUT", "/load_balancers/lb-1")]
    assert body["sticky_sessions"] == {"type": "none"}
    assert body["http_idle_timeout_seconds"] == 90 and body["region"] == "nyc3"
    assert body["droplet_ids"] == [4001] and body["size_unit"] == 1
    assert not {"id", "ip", "status", "created_at", "tag"} & body.keys()


async def test_a_certificate_without_a_chain_leaves_the_chain_out(monkeypatch):
    fake = FakeDo(days_left=20, targets=[4001])
    assert await _check(fake, monkeypatch, chain=False) == "renewed"
    assert "certificate_chain" not in fake.bodies[("POST", "/certificates")]


async def test_no_certificate_at_all_is_renewed(monkeypatch):
    fake = FakeDo(days_left=20, targets=[4001])
    fake.certs.clear()
    assert await _check(fake, monkeypatch) == "renewed"
    assert ("DELETE", "/certificates/old") not in fake.calls


async def test_digitalocean_errors_are_our_copy(monkeypatch, caplog):
    fake = FakeDo(days_left=20, targets=[4001])
    fake.fail[("POST", "/certificates")] = 500
    with pytest.raises(worker.CertWorkerError) as raised:
        await _check(fake, monkeypatch)
    assert raised.value.reason == "DigitalOcean answered with HTTP 500."
    assert TOKEN not in repr(raised.value) and "boom" not in str(raised.value)
    assert ("PUT", "/load_balancers/lb-1") not in fake.calls


async def test_an_unusable_load_balancer_answer_is_our_copy(monkeypatch):
    fake = FakeDo(days_left=20, targets=[4001])
    orig = fake.handler

    def handler(request):
        if request.method == "GET" and request.url.path.endswith("/load_balancers/lb-1"):
            return httpx.Response(200, json={"oops": TOKEN})
        return orig(request)
    fake.handler = handler
    with pytest.raises(worker.CertWorkerError) as raised:
        await _check(fake, monkeypatch)
    assert TOKEN not in str(raised.value)


def test_ids_from_settings_are_checked():
    from pydantic import SecretStr

    from serversherpa.config import get_settings
    settings = get_settings().model_copy(update={
        "cert_do_token": SecretStr(TOKEN), "cert_lb_id": "../droplets",
        "cert_names": ",".join(NAMES), "cert_env": "uat9", "cert_droplet_id": "4001",
        "cert_acme_key": SecretStr(base64.b64encode(KEY_PEM.encode()).decode())})
    assert worker.config_from(settings) is None
    settings = settings.model_copy(update={
        "cert_lb_id": "lb-1", "cert_acme_key": SecretStr("not base64!")})
    assert worker.config_from(settings) is None


async def test_a_failed_check_logs_no_secret(monkeypatch, caplog):
    async def boom(cfg, **kw):
        raise RuntimeError(f"Bearer {TOKEN} {KEY_PEM}")
    monkeypatch.setattr(worker, "check_once", boom)
    caplog.set_level("DEBUG")
    assert await worker.check_logged(_cfg(), worker.Challenges()) is None
    assert "RuntimeError" in caplog.text
    assert TOKEN not in caplog.text and "PRIVATE KEY" not in caplog.text

    async def refused(cfg, **kw):
        raise worker.CertWorkerError("DigitalOcean answered with HTTP 403.")
    monkeypatch.setattr(worker, "check_once", refused)
    assert await worker.check_logged(_cfg(), worker.Challenges()) is None
    assert "HTTP 403" in caplog.text


async def test_a_renewal_logs_no_secret(monkeypatch, caplog):
    caplog.set_level("DEBUG")
    fake = FakeDo(days_left=20, targets=[4001])
    assert await _check(fake, monkeypatch) == "renewed"
    issued_key = fake.bodies[("POST", "/certificates")]["private_key"]
    for secret in (TOKEN, KEY_PEM, issued_key, "PRIVATE KEY"):
        assert secret not in caplog.text


async def test_run_once_without_settings_is_not_configured(monkeypatch):
    monkeypatch.setattr(worker, "config_from", lambda settings: None)
    assert await worker.run_forever(once=True) == "not_configured"


def test_the_lock_goes_through_the_apis_engine():
    """The engine carries the managed database's TLS (serversherpa.db.tls)."""
    from serversherpa.db import engine
    assert worker.get_engine is engine.get_engine


async def test_a_renewal_under_the_lock_looks_again(monkeypatch):
    """Another worker renewed between the first look and the lock."""
    fake = FakeDo(days_left=20, targets=[4001])

    @asynccontextmanager
    async def lock_after_renewal():
        fake.certs["old"]["not_after"] = "2027-01-03T12:00:00Z"
        yield True

    async def fake_issue(*a):
        raise AssertionError("issued twice")
    monkeypatch.setattr(acme, "issue", fake_issue)
    assert await worker.check_once(
        _cfg(), challenges=worker.Challenges(), now=NOW,
        transports={"digitalocean": httpx.MockTransport(fake.handler)},
        try_lock=lock_after_renewal) == "fresh"


async def test_a_foreign_certificate_is_never_deleted(monkeypatch):
    fake = FakeDo(days_left=20, targets=[4001])
    fake.certs["old"]["name"] = "someone-elses"
    assert await _check(fake, monkeypatch) == "renewed"
    assert ("DELETE", "/certificates/old") not in fake.calls


# ── review fixes: switches, the PUT, the lock connection, the challenge server, --once ──

async def test_two_targets_mean_a_switch_is_running(monkeypatch):
    fake = FakeDo(days_left=5, targets=[4001, 4002])
    assert await _check(fake, monkeypatch) == "switching"
    assert not fake.issued and ("POST", "/certificates") not in fake.calls


async def test_a_busy_load_balancer_means_a_switch_is_running(monkeypatch):
    fake = FakeDo(days_left=5, targets=[4001])
    fake.lb["status"] = "update_pending"
    assert await _check(fake, monkeypatch) == "switching"
    assert not fake.issued


async def test_a_switch_starting_under_the_lock_stops_the_renewal(monkeypatch):
    fake = FakeDo(days_left=5, targets=[4001])

    @asynccontextmanager
    async def lock_then_switch():
        fake.lb["droplet_ids"] = [4001, 4002]
        yield True

    async def fake_issue(*a):
        raise AssertionError("issued during a switch")
    monkeypatch.setattr(acme, "issue", fake_issue)
    assert await worker.check_once(
        _cfg(), challenges=worker.Challenges(), now=NOW, sleep=_nosleep,
        transports={"digitalocean": httpx.MockTransport(fake.handler)},
        try_lock=lock_then_switch) == "switching"


async def test_a_refused_put_deletes_the_uploaded_certificate(monkeypatch):
    fake = FakeDo(days_left=5, targets=[4001])
    fake.fail[("PUT", "/load_balancers/lb-1")] = 422
    with pytest.raises(worker.CertWorkerError):
        await _check(fake, monkeypatch)
    assert ("DELETE", "/certificates/new") in fake.calls and "new" not in fake.certs
    assert ("PUT", "/load_balancers/lb-1") in fake.calls
    assert "old" in fake.certs and fake.lb["droplet_ids"] == [4001]


async def test_the_put_waits_for_a_busy_load_balancer(monkeypatch):
    fake = FakeDo(days_left=5, targets=[4001])

    def busy():
        fake.busy_reads = 3
        fake.lb["status"] = "update_pending"
    assert await _check(fake, monkeypatch, on_issue=busy) == "renewed"
    assert fake.lb_puts == [[4001]] and fake.busy_reads == 0
    https = next(r for r in fake.lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert https["certificate_id"] == "new"


async def test_a_load_balancer_that_stays_busy_deletes_the_upload(monkeypatch):
    fake = FakeDo(days_left=5, targets=[4001])

    def busy():
        fake.busy_reads = 10_000
        fake.lb["status"] = "update_pending"
    with pytest.raises(worker.CertWorkerError):
        await _check(fake, monkeypatch, on_issue=busy)
    assert ("PUT", "/load_balancers/lb-1") not in fake.calls
    assert "new" not in fake.certs and "old" in fake.certs


async def test_a_switch_during_issuing_deletes_the_upload_and_never_puts(monkeypatch):
    fake = FakeDo(days_left=5, targets=[4001])

    def switch():
        fake.lb["droplet_ids"] = [4001, 4002]
    assert await _check(fake, monkeypatch, on_issue=switch) == "switching"
    assert ("PUT", "/load_balancers/lb-1") not in fake.calls and fake.lb_puts == []
    assert fake.lb["droplet_ids"] == [4001, 4002]
    assert ("DELETE", "/certificates/new") in fake.calls and "new" not in fake.certs
    assert "old" in fake.certs


async def test_the_lock_session_is_not_left_in_a_transaction(db):
    from sqlalchemy import text

    from serversherpa.db.engine import get_engine
    async with worker.advisory_lock() as got:
        assert got is True
        async with get_engine().connect() as other:
            states = (await other.execute(text(
                "SELECT a.state FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid "
                "WHERE l.locktype = 'advisory' AND l.granted "
                "AND l.database = (SELECT oid FROM pg_database "
                "WHERE datname = current_database())"))).scalars().all()
    assert states == ["idle"]


class _FakeConn:
    def __init__(self):
        self.options: dict = {}
        self.invalidated = False

    async def execution_options(self, **options):
        self.options.update(options)
        return self

    async def scalar(self, statement, params=None):
        assert "pg_try_advisory_lock" in str(statement)
        return True

    async def execute(self, statement, params=None):
        raise ConnectionError("the server went away")

    async def invalidate(self):
        self.invalidated = True


class _FakeEngine:
    def __init__(self, conn):
        self.conn = conn

    @asynccontextmanager
    async def connect(self):
        yield self.conn


async def test_a_failed_unlock_throws_the_connection_away(monkeypatch):
    conn = _FakeConn()
    monkeypatch.setattr(worker, "get_engine", lambda: _FakeEngine(conn))
    with pytest.raises(ConnectionError):
        async with worker.advisory_lock() as got:
            assert got is True
    assert conn.invalidated and conn.options == {"isolation_level": "AUTOCOMMIT"}


async def test_a_slow_request_is_dropped():
    challenges = worker.Challenges()
    challenges.read_seconds = 0.3
    server = await challenges.start("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"GET /.well-known/acme-challenge/x HTTP/1.1\r\n")
        await writer.drain()

        async def trickle():
            try:
                for _ in range(20):     # a header every 0.1 s, never the blank line
                    writer.write(b"X-Slow: 1\r\n")
                    await writer.drain()
                    await asyncio.sleep(0.1)
            except ConnectionError:
                pass
        trickler = asyncio.create_task(trickle())
        try:                            # closed unread: EOF or a reset, well before 1.5 s
            data = await asyncio.wait_for(reader.read(), 1.5)
        except ConnectionResetError:
            data = b""
        trickler.cancel()
        assert data == b""
        writer.close()
    finally:
        server.close()
        await server.wait_closed()


async def test_connections_past_the_cap_are_closed():
    challenges = worker.Challenges(max_connections=1)
    server = await challenges.start("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        _, first = await asyncio.open_connection("127.0.0.1", port)
        await asyncio.sleep(0.1)        # the first holds the only slot
        reader, second = await asyncio.open_connection("127.0.0.1", port)
        second.write(b"GET /anything HTTP/1.1\r\n\r\n")
        await second.drain()
        try:                            # closed unread: EOF or a reset
            data = await asyncio.wait_for(reader.read(), 1)
        except ConnectionResetError:
            data = b""
        assert data == b""
        first.close()
        second.close()
    finally:
        server.close()
        await server.wait_closed()


def test_once_prints_only_an_unknown_errors_type(monkeypatch):
    from typer.testing import CliRunner

    from serversherpa.cli import app

    async def boom(**kw):
        raise RuntimeError(f"Bearer {TOKEN}")
    monkeypatch.setattr(worker, "run_forever", boom)
    result = CliRunner().invoke(app, ["cert-worker", "--once"])
    assert result.exit_code == 1
    assert "RuntimeError" in result.output and TOKEN not in result.output
    assert result.exception is None or isinstance(result.exception, SystemExit)
