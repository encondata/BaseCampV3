"""Trust-on-first-use pinning of a server's TLS certificate (Proxmox's
self-signed pve-ssl.pem), the TLS twin of known_hosts: the user sees the
fingerprint, Sirdar stores the certificate itself, and every later
connection trusts that certificate and nothing else.

Fingerprints are SHA-256 over the DER bytes, colon-separated uppercase hex:
the format Proxmox shows under Node › System › Certificates."""

import asyncio
import hashlib
import ssl

from cryptography import x509
from cryptography.x509.oid import NameOID

from sirdar_api.deploy import ConnectFailed

FETCH_TIMEOUT = 10


def fingerprint_of(pem: str) -> str:
    """ValueError when `pem` isn't a PEM certificate."""
    der = ssl.PEM_cert_to_DER_cert(pem)
    digest = hashlib.sha256(der).hexdigest().upper()
    return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))


def _common_name(name: x509.Name) -> str:
    found = name.get_attributes_for_oid(NameOID.COMMON_NAME)
    return str(found[0].value) if found else name.rfc4514_string()


def describe(pem: str) -> dict:
    """What the trust prompt shows: subject, issuer, expiry and names."""
    cert = x509.load_pem_x509_certificate(pem.encode())
    try:
        sans = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        names = ([str(v) for v in sans.get_values_for_type(x509.DNSName)]
                 + [str(v) for v in sans.get_values_for_type(x509.IPAddress)])
    except x509.ExtensionNotFound:
        names = []
    return {"subject": _common_name(cert.subject), "issuer": _common_name(cert.issuer),
            "not_after": cert.not_valid_after_utc.isoformat(), "names": names}


def _read_certificate(host: str, port: int) -> str:
    """The server's certificate, unverified (that is what pinning decides).
    Tests replace this function (conftest's no_real_hosts guard)."""
    return ssl.get_server_certificate((host, port), timeout=FETCH_TIMEOUT)


async def fetch_certificate(host: str, port: int) -> str:
    try:
        return await asyncio.to_thread(_read_certificate, host, port)
    except (OSError, ssl.SSLError, ValueError):
        raise ConnectFailed(f"Couldn't reach {host}:{port} over TLS.") from None


def pinned_context(pem: str) -> ssl.SSLContext:
    """A client context whose only trust anchor is this certificate. Partial
    chains are allowed so a leaf can anchor itself; the host name is still
    checked against the certificate's names."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)          # CERT_REQUIRED, check_hostname
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_verify_locations(cadata=pem)
    ctx.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx
