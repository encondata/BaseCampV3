"""Trust-on-first-use pinning of a server's TLS certificate (Proxmox's
pve-ssl.pem, ESXi's rui.crt), the TLS twin of known_hosts: the user sees the
fingerprint, Sirdar stores the certificate itself, and every later
connection trusts that certificate and nothing else.

Fingerprints are SHA-256 over the DER bytes, colon-separated uppercase hex:
the format Proxmox shows under Node › System › Certificates.

A pin is exactly one certificate. Every function here parses the PEM
strictly (one BEGIN CERTIFICATE block, nothing else around it) and works on
that one certificate's DER bytes, so the fingerprint the user checked is
always of the only certificate a pinned context trusts: a leaf followed by
an extra CA can't slip the CA in."""

import asyncio
import hashlib
import re
import ssl

from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding
from cryptography.x509.oid import NameOID

from sirdar_api.deploy import ConnectFailed

FETCH_TIMEOUT = 10


_BEGIN = "-----BEGIN CERTIFICATE-----"
_END = "-----END CERTIFICATE-----"
_HEX64_RE = re.compile(r"[0-9A-F]{64}")
_COLON_RE = re.compile(r"([0-9A-F]{2}:){31}[0-9A-F]{2}")


def load_one(pem: str) -> x509.Certificate:
    """The single certificate in `pem`. ValueError for anything else: no
    certificate, two or more, another PEM block, or text around it."""
    if not isinstance(pem, str):
        raise ValueError("not a PEM certificate")
    text = pem.strip()
    if (text.count("-----BEGIN") != 1 or text.count("-----END") != 1
            or text.count(_BEGIN) != 1 or not text.startswith(_BEGIN)
            or not text.endswith(_END)):
        raise ValueError("not exactly one PEM certificate")
    try:
        return x509.load_pem_x509_certificate(text.encode())
    except ValueError:
        raise ValueError("not a PEM certificate") from None


def _der(pem: str) -> bytes:
    return load_one(pem).public_bytes(Encoding.DER)


def _colons(hex_upper: str) -> str:
    return ":".join(hex_upper[i:i + 2] for i in range(0, len(hex_upper), 2))


def fingerprint_of(pem: str) -> str:
    """ValueError when `pem` isn't exactly one PEM certificate."""
    return _colons(hashlib.sha256(_der(pem)).hexdigest().upper())


def normalize_fingerprint(value) -> str:
    """A SHA-256 fingerprint as typed or pasted (colons or not, any case) in
    the colon form. ValueError when it isn't one."""
    text = str(value or "").strip().upper()
    if _COLON_RE.fullmatch(text):
        return text
    if _HEX64_RE.fullmatch(text):
        return _colons(text)
    raise ValueError("not a SHA-256 fingerprint")


def _common_name(name: x509.Name) -> str:
    found = name.get_attributes_for_oid(NameOID.COMMON_NAME)
    return str(found[0].value) if found else name.rfc4514_string()


def describe(pem: str) -> dict:
    """What the trust prompt shows: subject, issuer, expiry and names."""
    cert = load_one(pem)
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
    """The server's leaf certificate as a canonical single-certificate PEM."""
    try:
        pem = await asyncio.to_thread(_read_certificate, host, port)
        return load_one(pem).public_bytes(Encoding.PEM).decode()
    except (OSError, ssl.SSLError, ValueError):
        raise ConnectFailed(f"Couldn't reach {host}:{port} over TLS.") from None


def pinned_context(pem: str, *, check_hostname: bool = True) -> ssl.SSLContext:
    """A client context whose only trust anchor is this certificate. Partial
    chains are allowed so a leaf can anchor itself. The host name is checked
    against the certificate's names unless check_hostname is False (ESXi's
    default certificate names only its host name, and the pin alone decides:
    verification itself stays on). ValueError unless `pem` is exactly one
    certificate (only its DER bytes are loaded)."""
    der = _der(pem)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)          # CERT_REQUIRED, check_hostname
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.check_hostname = check_hostname                    # verify_mode stays CERT_REQUIRED
    ctx.load_verify_locations(cadata=der)
    if ctx.cert_store_stats()["x509"] != 1:                # not an assert: survives -O
        raise ValueError("the pinned context must trust exactly one certificate")
    ctx.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx
