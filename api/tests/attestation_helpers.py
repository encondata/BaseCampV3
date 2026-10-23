"""Test-only Android key attestation chains: a fake root and intermediate
and a leaf whose KeyDescription extension is encoded with pyasn1 here,
independently of the verifier's own schema (security/key_attestation.py).

`make_chain()` builds a chain that passes every check; each keyword argument
breaks one thing, so a negative test names exactly what it changes."""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from hashlib import sha256

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID
from pyasn1.codec.der import encoder
from pyasn1.type import tag, univ

KEY_DESCRIPTION_OID = x509.ObjectIdentifier("1.3.6.1.4.1.11129.2.1.17")
PACKAGE = b"com.serversherpa.kiosk"
SIGNING_CERT = b"the kiosk app's signing certificate"
DIGEST = sha256(SIGNING_CERT).hexdigest()
NONCE = b"enroll-nonce-0123456789abcdef"
NOW = datetime(2026, 10, 23, 12, 0, tzinfo=UTC)

# KeyMint tag numbers (Google's AuthorizationList schema)
PURPOSE, ALGORITHM, KEY_SIZE, EC_CURVE = 1, 2, 3, 10
NO_AUTH_REQUIRED, USER_AUTH_TYPE, AUTH_TIMEOUT = 503, 504, 505
CREATION_DATETIME, ORIGIN, ROOT_OF_TRUST = 701, 702, 704
APPLICATION_ID = 709
# values
SIGN, VERIFY = 2, 3
EC, RSA = 3, 1
P_256 = 1
PASSWORD, FINGERPRINT = 1, 2
SOFTWARE, TEE, STRONGBOX = 0, 1, 2
VERIFIED, UNVERIFIED = 0, 2

_KEYS: dict[str, ec.EllipticCurvePrivateKey] = {}


def ec_key(name: str) -> ec.EllipticCurvePrivateKey:
    """One cached P-256 key per name (key generation is the slow part)."""
    if name not in _KEYS:
        _KEYS[name] = ec.generate_private_key(ec.SECP256R1())
    return _KEYS[name]


# ── pyasn1 encoding ────────────────────────────────────────────────

def explicit(number: int, value) -> bytes:
    """One AuthorizationList entry: [number] EXPLICIT value."""
    tagged = value.subtype(
        explicitTag=tag.Tag(tag.tagClassContext, tag.tagFormatConstructed, number))
    if isinstance(value, univ.SetOf):         # subtype() drops a SET OF's members
        for i, member in enumerate(value):
            tagged[i] = member
    return encoder.encode(tagged)


def seq(parts: list[bytes]) -> bytes:
    """A SEQUENCE of already-encoded elements."""
    s = univ.SequenceOf(componentType=univ.Any())
    for i, p in enumerate(parts):
        s[i] = univ.Any(p)
    return encoder.encode(s)


def set_of_ints(values) -> univ.SetOf:
    s = univ.SetOf(componentType=univ.Integer())
    for i, v in enumerate(sorted(values)):
        s[i] = v
    return s


def root_of_trust(*, locked: bool = True, state: int = VERIFIED) -> bytes:
    return seq([encoder.encode(univ.OctetString(b"\x11" * 32)),
                encoder.encode(univ.Boolean(locked)),
                encoder.encode(univ.Enumerated(state)),
                encoder.encode(univ.OctetString(b"\x22" * 32))])


def application_id(packages=(PACKAGE,), digests=(SIGNING_CERT,)) -> bytes:
    infos = univ.SetOf(componentType=univ.Any())
    for i, name in enumerate(packages):
        infos[i] = univ.Any(seq([encoder.encode(univ.OctetString(name)),
                                 encoder.encode(univ.Integer(42))]))
    sigs = univ.SetOf(componentType=univ.OctetString())
    for i, cert in enumerate(digests):
        sigs[i] = sha256(cert).digest()
    return seq([encoder.encode(infos), encoder.encode(sigs)])


def default_hw() -> dict[int, bytes]:
    """The hardware-enforced list of a good StrongBox biometric key."""
    return {
        PURPOSE: explicit(PURPOSE, set_of_ints({SIGN})),
        ALGORITHM: explicit(ALGORITHM, univ.Integer(EC)),
        KEY_SIZE: explicit(KEY_SIZE, univ.Integer(256)),
        EC_CURVE: explicit(EC_CURVE, univ.Integer(P_256)),
        USER_AUTH_TYPE: explicit(USER_AUTH_TYPE, univ.Integer(FINGERPRINT)),
        ORIGIN: explicit(ORIGIN, univ.Integer(0)),
        ROOT_OF_TRUST: explicit(ROOT_OF_TRUST, univ.Any(root_of_trust())),
    }


def default_sw() -> dict[int, bytes]:
    """The software-enforced list: Keystore adds the application id here."""
    return {
        CREATION_DATETIME: explicit(CREATION_DATETIME, univ.Integer(1_792_000_000_000)),
        APPLICATION_ID: explicit(APPLICATION_ID, univ.OctetString(application_id())),
    }


def key_description(*, challenge: bytes = NONCE, version: int = 300,
                    attestation_level: int = STRONGBOX, keymint_level: int = STRONGBOX,
                    sw: dict[int, bytes] | None = None,
                    hw: dict[int, bytes] | None = None) -> bytes:
    sw = default_sw() if sw is None else sw
    hw = default_hw() if hw is None else hw
    return seq([
        encoder.encode(univ.Integer(version)),
        encoder.encode(univ.Enumerated(attestation_level)),
        encoder.encode(univ.Integer(version)),
        encoder.encode(univ.Enumerated(keymint_level)),
        encoder.encode(univ.OctetString(challenge)),
        encoder.encode(univ.OctetString(b"")),
        seq([sw[k] for k in sorted(sw)]),
        seq([hw[k] for k in sorted(hw)]),
    ])


# ── certificates ───────────────────────────────────────────────────

def _name(cn: str, serial_attr: str | None = None) -> x509.Name:
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, cn)]
    if serial_attr:
        attrs.append(x509.NameAttribute(NameOID.SERIAL_NUMBER, serial_attr))
    return x509.Name(attrs)


def make_cert(*, subject: x509.Name, issuer: x509.Name, public_key, signing_key,
              serial: int, not_before: datetime, not_after: datetime,
              ca: bool, extensions: list[x509.ExtensionType] = ()) -> x509.Certificate:
    b = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer)
         .public_key(public_key).serial_number(serial)
         .not_valid_before(not_before).not_valid_after(not_after)
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    for ext in extensions:
        b = b.add_extension(ext, critical=False)
    return b.sign(signing_key, hashes.SHA256())


@dataclass
class Chain:
    der: list[bytes]
    root: x509.Certificate
    certs: list[x509.Certificate] = field(default_factory=list)
    leaf_public_der: bytes = b""


def make_chain(*, kd: bytes | None = None, leaf_key=None, root_key_name: str = "root",
               factory: bool = False, intermediate_not_after: datetime | None = None,
               leaf_not_after: datetime | None = None,
               root_not_after: datetime | None = None,
               intermediate_extension: bytes | None = None,
               leaf_extension: bool = True) -> Chain:
    """root → intermediate → leaf. `factory` gives the root and intermediate a
    SERIALNUMBER attribute, the shape of a factory-provisioned chain under
    Google's RSA root."""
    root_key, inter_key = ec_key(root_key_name), ec_key("intermediate")
    leaf_key = leaf_key or ec_key("leaf")
    root_name = _name("Test Attestation Root", "f92009e853b6b045" if factory else None)
    inter_name = _name("Test Attestation Intermediate", "c6047571d8f0d17c" if factory else None)
    long_ago = datetime(2020, 1, 1, tzinfo=UTC)
    root = make_cert(subject=root_name, issuer=root_name, public_key=root_key.public_key(),
                     signing_key=root_key, serial=0x1001, not_before=long_ago,
                     not_after=root_not_after or datetime(2040, 1, 1, tzinfo=UTC), ca=True)
    inter_ext = ([x509.UnrecognizedExtension(KEY_DESCRIPTION_OID, intermediate_extension)]
                 if intermediate_extension is not None else [])
    inter = make_cert(subject=inter_name, issuer=root_name,
                      public_key=inter_key.public_key(), signing_key=root_key,
                      serial=0x2bad2002, not_before=long_ago,
                      not_after=intermediate_not_after or datetime(2036, 1, 1, tzinfo=UTC),
                      ca=True, extensions=inter_ext)
    leaf_ext = ([x509.UnrecognizedExtension(KEY_DESCRIPTION_OID,
                                            kd if kd is not None else key_description())]
                if leaf_extension else [])
    leaf = make_cert(subject=_name("Android Keystore Key"), issuer=inter_name,
                     public_key=leaf_key.public_key(), signing_key=inter_key,
                     serial=1, not_before=datetime(1970, 1, 1, tzinfo=UTC),
                     not_after=leaf_not_after or datetime(2048, 1, 1, tzinfo=UTC),
                     ca=False, extensions=leaf_ext)
    certs = [leaf, inter, root]
    return Chain(
        der=[c.public_bytes(serialization.Encoding.DER) for c in certs], root=root,
        certs=certs,
        leaf_public_der=leaf_key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))


def rsa_leaf_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)
