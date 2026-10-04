import asyncio
import hashlib
import ssl
from datetime import UTC, datetime

import pytest

from sirdar_api.deploy import ConnectFailed, tls_pin

from .tls_helpers import make_ca, make_cert


def test_the_fingerprint_is_sha256_in_proxmox_s_format():
    pem, _ = make_cert()
    der = ssl.PEM_cert_to_DER_cert(pem)
    expected = ":".join(f"{b:02X}" for b in hashlib.sha256(der).digest())
    assert tls_pin.fingerprint_of(pem) == expected
    assert len(expected) == 95


def test_something_that_isn_t_a_certificate():
    with pytest.raises(ValueError):
        tls_pin.fingerprint_of("not a certificate")


def test_describe_names_the_certificate():
    pem, _ = make_cert(cn="pve.lab")
    d = tls_pin.describe(pem)
    assert (d["subject"], d["issuer"]) == ("pve.lab", "pve.lab")
    assert set(d["names"]) == {"pve", "localhost", "10.10.48.5", "127.0.0.1"}
    assert datetime.fromisoformat(d["not_after"]) > datetime.now(UTC)


async def _tls_server(tmp_path, pem: str, key: str):
    (tmp_path / "cert.pem").write_text(pem)
    (tmp_path / "key.pem").write_text(key)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(tmp_path / "cert.pem", tmp_path / "key.pem")

    async def handle(reader, writer):
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0, ssl=ctx)
    return server, server.sockets[0].getsockname()[1]


async def test_the_pinned_certificate_is_the_only_one_trusted(tmp_path):
    pem, key = make_cert()
    impostor, _ = make_cert(cn="impostor")
    server, port = await _tls_server(tmp_path, pem, key)
    async with server:
        _, writer = await asyncio.open_connection("127.0.0.1", port,
                                                  ssl=tls_pin.pinned_context(pem))
        writer.close()
        with pytest.raises(ssl.SSLCertVerificationError):
            await asyncio.open_connection("127.0.0.1", port,
                                          ssl=tls_pin.pinned_context(impostor))


async def test_the_host_must_be_named_in_the_certificate(tmp_path):
    pem, key = make_cert(ips=("10.10.48.5",), dns=("pve",))
    server, port = await _tls_server(tmp_path, pem, key)
    async with server:
        with pytest.raises(ssl.SSLCertVerificationError):
            await asyncio.open_connection("127.0.0.1", port, ssl=tls_pin.pinned_context(pem))


async def test_fetch_reads_the_live_certificate(tmp_path):
    pem, key = make_cert()
    server, port = await _tls_server(tmp_path, pem, key)
    async with server:
        live = await tls_pin.fetch_certificate("127.0.0.1", port)
    assert tls_pin.fingerprint_of(live) == tls_pin.fingerprint_of(pem)


async def test_fetch_says_when_nothing_answers():
    with pytest.raises(ConnectFailed) as e:
        await tls_pin.fetch_certificate("127.0.0.1", 9)
    assert e.value.reason == "Couldn't reach 127.0.0.1:9 over TLS."


async def test_the_guard_refuses_a_real_host(no_real_hosts):
    with pytest.raises(AssertionError):
        await tls_pin.fetch_certificate("10.10.48.5", 8006)
    assert no_real_hosts == ["tls:10.10.48.5"]
    no_real_hosts.clear()


def test_a_pem_with_two_certificates_is_refused():
    """The pin is exactly one certificate: a leaf plus an extra CA would pass
    the fingerprint check on the leaf and then trust the CA as well."""
    leaf, _ = make_cert()
    ca, _ = make_ca()
    for pem in (leaf + ca, ca + leaf, leaf + leaf):
        with pytest.raises(ValueError):
            tls_pin.fingerprint_of(pem)
        with pytest.raises(ValueError):
            tls_pin.describe(pem)
        with pytest.raises(ValueError):
            tls_pin.pinned_context(pem)


@pytest.mark.parametrize("extra", ["junk\n", "-----BEGIN PRIVATE KEY-----\nAAAA\n"])
def test_text_around_the_certificate_is_refused(extra):
    pem, _ = make_cert()
    for bad in (pem + extra, extra + pem):
        with pytest.raises(ValueError):
            tls_pin.fingerprint_of(bad)
        with pytest.raises(ValueError):
            tls_pin.pinned_context(bad)


def test_surrounding_whitespace_is_fine():
    pem, _ = make_cert()
    assert tls_pin.fingerprint_of(f"\n  {pem}\n\n") == tls_pin.fingerprint_of(pem)


def test_the_pinned_context_trusts_exactly_one_certificate():
    pem, _ = make_cert()
    assert tls_pin.pinned_context(pem).cert_store_stats()["x509"] == 1


@pytest.mark.parametrize("value", [
    "ab" * 32, ("AB" * 32), ":".join(["ab"] * 32), "  " + ":".join(["Ab"] * 32) + " "])
def test_fingerprints_normalize_to_the_colon_form(value):
    assert tls_pin.normalize_fingerprint(value) == ":".join(["AB"] * 32)


@pytest.mark.parametrize("value", [
    "", "AB:CD", "ab" * 31, "ab" * 33, "zz" * 32, "AB:" * 31 + "A:B", "AB-" * 31 + "AB", None])
def test_a_malformed_fingerprint_is_refused(value):
    with pytest.raises(ValueError):
        tls_pin.normalize_fingerprint(value)


async def test_a_leaf_issued_by_a_ca_can_be_pinned_alone(tmp_path):
    """Proxmox's shape: pve-ssl.pem is signed by pve-root-ca.pem and the
    server sends both. Pinning only the leaf is enough, and the CA isn't
    trusted for anything else."""
    ca = make_ca()
    leaf, leaf_key = make_cert(ca=ca)
    sibling, sibling_key = make_cert(cn="other", ca=ca)
    server, port = await _tls_server(tmp_path, leaf + ca[0], leaf_key)
    async with server:
        _, writer = await asyncio.open_connection("127.0.0.1", port,
                                                  ssl=tls_pin.pinned_context(leaf))
        writer.close()
        live = await tls_pin.fetch_certificate("127.0.0.1", port)
        assert tls_pin.fingerprint_of(live) == tls_pin.fingerprint_of(leaf)
    other_dir = tmp_path / "other"
    other_dir.mkdir()
    server, port = await _tls_server(other_dir, sibling + ca[0], sibling_key)
    async with server:
        with pytest.raises(ssl.SSLCertVerificationError):
            await asyncio.open_connection("127.0.0.1", port, ssl=tls_pin.pinned_context(leaf))
