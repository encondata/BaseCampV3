"""Self-signed certificates for the TLS pinning tests (Proxmox's own
pve-ssl.pem names the node's addresses the same way)."""

import datetime
import ipaddress

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def make_cert(cn: str = "pve.lab", ips: tuple[str, ...] = ("10.10.48.5", "127.0.0.1"),
              dns: tuple[str, ...] = ("pve", "localhost")) -> tuple[str, str]:
    """(certificate PEM, private key PEM), valid from yesterday for a year."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.datetime.now(datetime.UTC)
    sans = [x509.DNSName(d) for d in dns] + [x509.IPAddress(ipaddress.ip_address(i))
                                             for i in ips]
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    return (cert.public_bytes(serialization.Encoding.PEM).decode(),
            key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                              serialization.NoEncryption()).decode())
