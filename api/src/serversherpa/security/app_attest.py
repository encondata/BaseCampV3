"""iOS App Attest verification for kiosk biometric keys.

At enroll the iOS app attests a new App Attest key with
`DCAppAttestService.attestKey(_:clientDataHash:)`, where clientDataHash binds
the enroll nonce to the Secure Enclave sign-in key (`client_data_hash`).
`verify_app_attest` runs Apple's checks ("Validating apps that connect to
your server",
https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)
in Apple's order:

1. the object is CBOR, fmt "apple-appattest", and attStmt.x5c holds the
   credential certificate followed by the intermediate;
2. the credential certificate is signed by the intermediate, the
   intermediate by the pinned Apple App Attestation Root CA
   (security/app_attest_roots/, see its README), and every certificate's
   dates, the root's included, cover now;
3. SHA-256(authData || clientDataHash) is the nonce in the credential
   certificate's extension 1.2.840.113635.100.8.2;
4. SHA-256 of the credential key's uncompressed X9.63 point is the key id;
5. authData's rpIdHash is SHA-256 of the app id (team id + bundle id);
6. the sign count is 0;
7. the aaguid is production ("appattest" + seven zero bytes), or development
   ("appattestdevelop") when `allow_development` is set;
8. the credential id is the key id.

The receipt (and Apple's fraud-risk metric) is not used, and neither are
App Attest assertions: sign-ins are signed by the Secure Enclave key.
"""

import hmac
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from hashlib import sha256
from pathlib import Path

import cbor2
from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pyasn1.codec.der import decoder
from pyasn1.error import PyAsn1Error
from pyasn1.type import namedtype, tag, univ

from serversherpa.security.key_attestation import AttestationError

# Apple only attests apps signed by this team, so the id needs no setting.
KIOSK_IOS_APP_ID = "Y2QYBG96U4.Server-Sherpas.ServerSherpa-Kiosk"
APP_ATTEST_OID = x509.ObjectIdentifier("1.2.840.113635.100.8.2")
PRODUCTION_AAGUID = b"appattest" + b"\x00" * 7
DEVELOPMENT_AAGUID = b"appattestdevelop"
FORMAT = "apple-appattest"
ROOT_PEM = (Path(__file__).resolve().parent / "app_attest_roots"
            / "apple_app_attestation_root_ca.pem")

# authData layout: rpIdHash (32) | flags (1) | signCount (4) | aaguid (16) |
# credentialIdLength (2) | credentialId | credentialPublicKey (COSE)
_RP_ID_HASH = slice(0, 32)
_SIGN_COUNT = slice(33, 37)
_AAGUID = slice(37, 53)
_CRED_ID_LENGTH = slice(53, 55)
_CRED_ID_START = 55


class _NonceExtension(univ.Sequence):
    """Apple's extension value: SEQUENCE { [1] EXPLICIT OCTET STRING }."""
    componentType = namedtype.NamedTypes(
        namedtype.NamedType("nonce", univ.OctetString().subtype(
            explicitTag=tag.Tag(tag.tagClassContext, tag.tagFormatConstructed, 1))))


@dataclass(frozen=True)
class _AuthData:
    raw: bytes
    rp_id_hash: bytes
    sign_count: int
    aaguid: bytes
    credential_id: bytes


@lru_cache
def apple_app_attest_root() -> x509.Certificate:
    """The pinned Apple App Attestation Root CA."""
    return x509.load_pem_x509_certificate(ROOT_PEM.read_bytes())


def client_data_hash(nonce: str, public_key_x963: bytes) -> bytes:
    """SHA-256(UTF-8(nonce) || public_key_x963): what the app passes to
    attestKey, binding the attestation to this enrollment and this key."""
    return sha256(nonce.encode("utf-8") + public_key_x963).digest()


# ── step 1: structure ──────────────────────────────────────────────

def _decode_object(attestation: bytes) -> tuple[list[x509.Certificate], _AuthData]:
    try:
        obj = cbor2.loads(attestation)
    except (cbor2.CBORError, ValueError, TypeError, RecursionError) as exc:
        raise AttestationError("parse", "the attestation is not CBOR") from exc
    if not isinstance(obj, dict) or obj.get("fmt") != FORMAT:
        raise AttestationError("format", f"the attestation's fmt is not {FORMAT}")
    stmt, auth = obj.get("attStmt"), obj.get("authData")
    if not isinstance(stmt, dict) or not isinstance(auth, bytes):
        raise AttestationError("format", "no attStmt or authData")
    x5c = stmt.get("x5c")
    if not isinstance(x5c, list) or not x5c or not all(isinstance(c, bytes) for c in x5c):
        raise AttestationError("format", "attStmt.x5c is not a list of certificates")
    certs: list[x509.Certificate] = []
    for der in x5c:
        try:
            cert = x509.load_der_x509_certificate(der)
            cert.public_key()           # parsed lazily: a bad key must fail here
        except (ValueError, TypeError, x509.InvalidVersion, UnsupportedAlgorithm) as exc:
            raise AttestationError("parse", "a certificate is not DER X.509") from exc
        certs.append(cert)
    return certs, _auth_data(auth)


def _auth_data(raw: bytes) -> _AuthData:
    if len(raw) < _CRED_ID_START:
        raise AttestationError("parse", "authData is too short")
    end = _CRED_ID_START + int.from_bytes(raw[_CRED_ID_LENGTH], "big")
    if len(raw) < end:
        raise AttestationError("parse", "authData's credential id runs past its end")
    return _AuthData(raw=raw, rp_id_hash=raw[_RP_ID_HASH],
                     sign_count=int.from_bytes(raw[_SIGN_COUNT], "big"),
                     aaguid=raw[_AAGUID], credential_id=raw[_CRED_ID_START:end])


# ── step 2: chain ──────────────────────────────────────────────────

def _issued_by(cert: x509.Certificate, issuer: x509.Certificate) -> bool:
    try:
        cert.verify_directly_issued_by(issuer)
    except (InvalidSignature, ValueError, TypeError, UnsupportedAlgorithm):
        return False
    return True


def _check_chain(certs: list[x509.Certificate], roots, now: datetime) -> None:
    if len(certs) != 2:
        raise AttestationError("chain", "x5c must be the credential certificate "
                                        "and the intermediate")
    cred, intermediate = certs
    if not _issued_by(cred, intermediate):
        raise AttestationError("chain", "the credential certificate is not signed by "
                                        "the intermediate")
    # A pinned root is trusted for its key: the intermediate's signature must
    # verify under it (and name it as the issuer).
    anchor = next((r for r in roots if _issued_by(intermediate, r)), None)
    if anchor is None:
        raise AttestationError("root", "the intermediate is not signed by a pinned "
                                       "Apple root")
    for cert in (cred, intermediate, anchor):
        if not cert.not_valid_before_utc <= now <= cert.not_valid_after_utc:
            raise AttestationError("expired", f"{cert.subject.rfc4514_string()} is not "
                                              "valid now")


# ── step 3: nonce ──────────────────────────────────────────────────

def _nonce(cred: x509.Certificate) -> bytes:
    try:
        ext = cred.extensions.get_extension_for_oid(APP_ATTEST_OID)
    except x509.ExtensionNotFound:
        raise AttestationError("challenge", "the credential certificate has no "
                                            "nonce extension") from None
    except (ValueError, x509.DuplicateExtension) as exc:
        raise AttestationError("parse", "unreadable credential certificate "
                                        "extensions") from exc
    try:
        value, rest = decoder.decode(ext.value.value, asn1Spec=_NonceExtension())
    except PyAsn1Error as exc:
        raise AttestationError("parse", f"nonce extension: {exc}") from None
    if rest:
        raise AttestationError("parse", "nonce extension: trailing data")
    return value["nonce"].asOctets()


# ── verify ─────────────────────────────────────────────────────────

def verify_app_attest(attestation: bytes, *, key_id: bytes, client_data_hash: bytes,
                      app_id: str = KIOSK_IOS_APP_ID, allow_development: bool,
                      roots: list[x509.Certificate] | None = None,
                      now: datetime | None = None) -> None:
    """Verify an App Attest attestation object for a biometric enroll.

    `key_id`: the App Attest key identifier (32 raw bytes, the SHA-256 of
    the attested key). `client_data_hash`: what the app passed to attestKey
    (see `client_data_hash()`). `allow_development` also accepts Apple's
    development environment. `roots` replaces the pinned Apple root (tests).
    Raises AttestationError with a reason code."""
    now = now or datetime.now(UTC)
    roots = [apple_app_attest_root()] if roots is None else roots

    certs, auth = _decode_object(attestation)                       # 1
    _check_chain(certs, roots, now)                                 # 2
    cred = certs[0]

    expected = sha256(auth.raw + client_data_hash).digest()         # 3
    if not hmac.compare_digest(_nonce(cred), expected):
        raise AttestationError("challenge", "the nonce does not bind this authData "
                                            "and client data hash")

    key = cred.public_key()                                         # 4
    if not (isinstance(key, ec.EllipticCurvePublicKey)
            and isinstance(key.curve, ec.SECP256R1)):
        raise AttestationError("key_id", "the credential key is not EC P-256")
    point = key.public_bytes(serialization.Encoding.X962,
                             serialization.PublicFormat.UncompressedPoint)
    if not hmac.compare_digest(sha256(point).digest(), key_id):
        raise AttestationError("key_id", "the key id is not the credential key's hash")

    if not hmac.compare_digest(auth.rp_id_hash,                     # 5
                               sha256(app_id.encode("utf-8")).digest()):
        raise AttestationError("app_id", "the key was not made by the kiosk app")

    if auth.sign_count != 0:                                        # 6
        raise AttestationError("counter", "the sign count is not 0")

    if auth.aaguid == PRODUCTION_AAGUID:                            # 7
        pass
    elif auth.aaguid == DEVELOPMENT_AAGUID:
        if not allow_development:
            raise AttestationError("environment", "development-environment "
                                                  "attestations are not accepted")
    else:
        raise AttestationError("environment", "the aaguid is not an App Attest "
                                              "environment")

    if not hmac.compare_digest(auth.credential_id, key_id):         # 8
        raise AttestationError("key_id", "the credential id is not the key id")
