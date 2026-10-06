"""The live certificate check: a TLS handshake that reads the served leaf's
expiry without trusting it, and a cache that checks every hostname at most
once an hour (five minutes after a failure), bounded to 16 in flight."""

import asyncio
import socket
import ssl
import time
from datetime import UTC, datetime, timedelta

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from sirdar_api.dashboard import certcheck
from sirdar_api.dashboard.certcheck import Checker, HostCert

NOT_AFTER = datetime(2027, 3, 1, 12, 0, tzinfo=UTC)


def _self_signed(tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "staging.example.test")])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(UTC) - timedelta(days=1))
            .not_valid_after(NOT_AFTER).sign(key, hashes.SHA256()))
    cert_path, key_path = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                           serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    return cert_path, key_path


async def _serve(handler, ctx=None):
    server = await asyncio.start_server(handler, "127.0.0.1", 0, ssl=ctx)
    return server, server.sockets[0].getsockname()[1]


async def test_reads_a_self_signed_certificate_without_verifying_it(tmp_path):
    cert_path, key_path = _self_signed(tmp_path)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert_path, key_path)

    async def handler(reader, writer):
        writer.close()
    server, port = await _serve(handler, ctx)
    async with server:
        got = await certcheck.check("127.0.0.1", port=port, timeout=2.0)
    assert got == HostCert("127.0.0.1", NOT_AFTER, None)


async def test_a_server_that_never_handshakes_times_out():
    async def handler(reader, writer):
        await asyncio.sleep(0.5)
        writer.close()
    server, port = await _serve(handler)
    async with server:
        start = time.monotonic()
        got = await certcheck.check("127.0.0.1", port=port, timeout=0.2)
        took = time.monotonic() - start
    assert got == HostCert("127.0.0.1", None, "Timed out")
    assert took < 0.35                 # about the timeout: no second wait, no close handshake


async def test_a_refused_connection_is_couldnt_connect():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    got = await certcheck.check("127.0.0.1", port=port, timeout=1.0)
    assert got == HostCert("127.0.0.1", None, "Couldn't connect")


class _Fake:
    def __init__(self, fail: set[str] = frozenset(), delay: float = 0):
        self.calls: list[str] = []
        self.fail, self.delay = fail, delay
        self.in_flight = self.peak = 0

    async def __call__(self, hostname, **kw):
        self.calls.append(hostname)
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        await asyncio.sleep(self.delay)
        self.in_flight -= 1
        if hostname in self.fail:
            return HostCert(hostname, None, "Timed out")
        return HostCert(hostname, NOT_AFTER, None)


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


async def test_successes_are_cached_for_an_hour_and_failures_for_five_minutes():
    fake, clock = _Fake(fail={"down.example"}), _Clock()
    checker = Checker(check=fake, clock=clock)
    first = await checker.check_all(["up.example", "down.example"])
    assert first["up.example"].not_after == NOT_AFTER
    assert first["down.example"].error == "Timed out"
    await checker.check_all(["up.example", "down.example"])
    assert sorted(fake.calls) == ["down.example", "up.example"]
    clock.now += 301
    await checker.check_all(["up.example", "down.example"])
    assert sorted(fake.calls) == ["down.example", "down.example", "up.example"]
    clock.now += 3300
    await checker.check_all(["up.example"])
    assert fake.calls.count("up.example") == 2


async def test_refresh_bypasses_the_cache():
    fake = _Fake()
    checker = Checker(check=fake)
    await checker.check_all(["a.example"])
    await checker.check_all(["a.example"], refresh=True)
    assert fake.calls == ["a.example", "a.example"]


async def test_at_most_sixteen_checks_in_flight_and_each_hostname_once():
    fake = _Fake(delay=0.01)
    checker = Checker(check=fake)
    hosts = [f"h{i}.example" for i in range(40)]
    got = await checker.check_all(hosts + hosts[:5])
    assert set(got) == set(hosts)
    assert len(fake.calls) == 40
    assert 1 < fake.peak <= 16


@pytest.mark.parametrize("exc, copy", [
    (TimeoutError(), "Timed out"),
    (ConnectionRefusedError("raw detail"), "Couldn't connect"),
    (RuntimeError("raw detail"), "Couldn't connect"),
])
async def test_a_check_that_raises_is_our_own_copy(exc, copy):
    async def boom(hostname, **kw):
        raise exc
    got = await Checker(check=boom).check_all(["x.example"])
    assert got["x.example"] == HostCert("x.example", None, copy)


async def test_concurrent_callers_share_checks_and_one_limit():
    fake = _Fake(delay=0.02)
    checker = Checker(check=fake)
    hosts = [f"h{i}.example" for i in range(40)]
    results = await asyncio.gather(*(checker.check_all(hosts) for _ in range(3)))
    assert all(set(r) == set(hosts) for r in results)
    assert len(fake.calls) == 40
    assert 1 < fake.peak <= 16


async def test_a_slow_check_times_out_for_this_response_and_fills_the_cache_later():
    async def slow(hostname, **kw):
        await asyncio.sleep(0.3)
        return HostCert(hostname, NOT_AFTER, None)
    fast = _Fake()
    calls: list[str] = []

    async def mixed(hostname, **kw):
        calls.append(hostname)
        return await (slow if hostname == "slow.example" else fast)(hostname)
    checker = Checker(check=mixed, deadline=0.1)
    start = time.monotonic()
    got = await checker.check_all(["slow.example", "fast.example"])
    assert time.monotonic() - start < 0.25
    assert got["slow.example"] == HostCert("slow.example", None, "Timed out")
    assert got["fast.example"].not_after == NOT_AFTER
    await asyncio.sleep(0.35)
    again = await checker.check_all(["slow.example", "fast.example"])
    assert again["slow.example"].not_after == NOT_AFTER
    assert sorted(calls) == ["fast.example", "slow.example"]      # the cache answered


async def test_expired_cache_entries_are_pruned():
    clock = _Clock()
    checker = Checker(check=_Fake(), clock=clock)
    await checker.check_all(["old.example"])
    clock.now += 3601
    await checker.check_all(["new.example"])
    assert set(checker._cache) == {"new.example"}


def test_hostnames_resolve_on_sirdars_own_executor():
    assert certcheck._DNS is not None and certcheck._DNS._max_workers <= 8


async def test_tests_never_dial_a_real_host(no_real_hosts):
    with pytest.raises(AssertionError):
        await certcheck.check("portal.example.com", timeout=0.2)
    assert no_real_hosts == ["certcheck:portal.example.com"]
    no_real_hosts.clear()
