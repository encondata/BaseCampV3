"""Test-only App Attest attestation objects: a fake root and intermediate
(P-384) and a credential certificate (P-256) whose nonce extension and
authData are encoded here, independently of the verifier's own parsing
(security/app_attest.py).

`make_attestation()` builds an object that passes every check; each keyword
argument breaks one thing, so a negative test names exactly what it changes.
The nonce is always computed over the authData the object carries (including
an `auth_data` override), so breaking authData doesn't also break the nonce."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256

import cbor2
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from pyasn1.codec.der import encoder
from pyasn1.type import tag, univ

APP_ATTEST_OID = x509.ObjectIdentifier("1.2.840.113635.100.8.2")
APP_ID = "Y2QYBG96U4.Server-Sherpas.ServerSherpa-Kiosk"
PRODUCTION = b"appattest" + b"\x00" * 7
DEVELOPMENT = b"appattestdevelop"
NOW = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)
CDH = sha256(b"client-data").digest()

_KEYS: dict[str, ec.EllipticCurvePrivateKey] = {}


def ec_key(name: str, curve: ec.EllipticCurve) -> ec.EllipticCurvePrivateKey:
    """One cached key per name (key generation is the slow part)."""
    if name not in _KEYS:
        _KEYS[name] = ec.generate_private_key(curve)
    return _KEYS[name]


def x963(public_key: ec.EllipticCurvePublicKey) -> bytes:
    """The uncompressed point, 04 || X || Y."""
    return public_key.public_bytes(serialization.Encoding.X962,
                                   serialization.PublicFormat.UncompressedPoint)


def nonce_extension(nonce: bytes) -> bytes:
    """Apple's extension value: SEQUENCE { [1] EXPLICIT OCTET STRING nonce }."""
    tagged = univ.OctetString(nonce).subtype(
        explicitTag=tag.Tag(tag.tagClassContext, tag.tagFormatConstructed, 1))
    s = univ.SequenceOf(componentType=univ.Any())
    s[0] = univ.Any(encoder.encode(tagged))
    return encoder.encode(s)


def cose_key(public_key: ec.EllipticCurvePublicKey) -> bytes:
    """The credential key as a COSE EC2 key (kty EC2, alg ES256, crv P-256)."""
    numbers = public_key.public_numbers()
    return cbor2.dumps({1: 2, 3: -7, -1: 1,
                        -2: numbers.x.to_bytes(32, "big"),
                        -3: numbers.y.to_bytes(32, "big")})


def build_auth_data(*, app_id: str, counter: int, aaguid: bytes, cred_id: bytes,
                    public_key: ec.EllipticCurvePublicKey) -> bytes:
    """rpIdHash (32) | flags (1) | signCount (4, BE) | aaguid (16) |
    credIdLen (2, BE) | credId | COSE key."""
    return (sha256(app_id.encode("utf-8")).digest()
            + b"\x40"
            + counter.to_bytes(4, "big")
            + aaguid
            + len(cred_id).to_bytes(2, "big")
            + cred_id
            + cose_key(public_key))


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def make_cert(*, subject: x509.Name, issuer: x509.Name, public_key, signing_key,
              serial: int, not_before: datetime, not_after: datetime, ca: bool,
              extensions: list[x509.ExtensionType] = ()) -> x509.Certificate:
    b = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer)
         .public_key(public_key).serial_number(serial)
         .not_valid_before(not_before).not_valid_after(not_after)
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    for ext in extensions:
        b = b.add_extension(ext, critical=False)
    return b.sign(signing_key, hashes.SHA384())


def der(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.DER)


ROOT_NAME = _name("Test App Attestation Root CA")
INTERMEDIATE_NAME = _name("Test App Attestation CA 1")


def make_root(key_name: str = "root", not_after: datetime | None = None) -> x509.Certificate:
    """The test root; the same key name gives the same key and subject, so a
    root made with another `not_after` still verifies the intermediate."""
    key = ec_key(key_name, ec.SECP384R1())
    return make_cert(subject=ROOT_NAME, issuer=ROOT_NAME, public_key=key.public_key(),
                     signing_key=key, serial=0x1001,
                     not_before=datetime(2020, 3, 18, tzinfo=UTC),
                     not_after=not_after or datetime(2045, 3, 15, tzinfo=UTC), ca=True)


@dataclass
class Built:
    obj: bytes                       # the CBOR attestation object
    root: x509.Certificate           # the root to pin (the default root)
    key_id: bytes                    # SHA-256 of the credential key's X9.63 point
    client_data_hash: bytes
    x5c: list[bytes]                 # the certificates the object carries


def make_attestation(*, fmt: str = "apple-appattest", x5c: list[bytes] | None = None,
                     aaguid: bytes = PRODUCTION, counter: int = 0, app_id: str = APP_ID,
                     cred_id: bytes | None = None, nonce_override: bytes | None = None,
                     no_extension: bool = False, cred_not_after: datetime | None = None,
                     root_key_name: str | None = None,
                     auth_data: bytes | None = None) -> Built:
    """credential certificate → intermediate → root; the object passes every
    check against `roots=[built.root]` at NOW with CDH.

    `root_key_name` signs the intermediate with another root (same subject
    name, different key); `built.root` stays the default root, so pinning it
    refuses the chain. `x5c` replaces the certificate list, and `auth_data`
    the whole authData."""
    pinned = make_root()
    signer = make_root(root_key_name) if root_key_name else pinned
    signer_key = ec_key(root_key_name or "root", ec.SECP384R1())
    inter_key = ec_key("intermediate", ec.SECP384R1())
    cred_key = ec_key("credential", ec.SECP256R1())

    key_id = sha256(x963(cred_key.public_key())).digest()
    auth = auth_data if auth_data is not None else build_auth_data(
        app_id=app_id, counter=counter, aaguid=aaguid,
        cred_id=key_id if cred_id is None else cred_id, public_key=cred_key.public_key())
    nonce = nonce_override if nonce_override is not None else sha256(auth + CDH).digest()

    inter = make_cert(subject=INTERMEDIATE_NAME, issuer=signer.subject,
                      public_key=inter_key.public_key(), signing_key=signer_key,
                      serial=0x2002, not_before=datetime(2020, 3, 18, tzinfo=UTC),
                      not_after=datetime(2030, 3, 13, tzinfo=UTC), ca=True)
    extensions = ([] if no_extension
                  else [x509.UnrecognizedExtension(APP_ATTEST_OID, nonce_extension(nonce))])
    cred = make_cert(subject=_name(key_id.hex()), issuer=INTERMEDIATE_NAME,
                     public_key=cred_key.public_key(), signing_key=inter_key, serial=0x3003,
                     not_before=NOW - timedelta(days=1),
                     not_after=cred_not_after or NOW + timedelta(days=90), ca=False,
                     extensions=extensions)

    certs = [der(cred), der(inter)] if x5c is None else x5c
    obj = cbor2.dumps({"fmt": fmt,
                       "attStmt": {"x5c": certs, "receipt": b""},
                       "authData": auth})
    return Built(obj=obj, root=pinned, key_id=key_id, client_data_hash=CDH, x5c=certs)
