"""Android key attestation for kiosk biometric keys.

At enroll the app sends the new key's certificate chain
(`KeyStore.getCertificateChain`, leaf first, DER). `verify_attestation`
accepts it only when:

- it has 3 to 6 certificates, each signed by the next; the last one, and
  only the last one, is a root, and it carries the public key of a pinned
  Google hardware attestation root (security/attestation_roots/, see its
  README);
- no certificate is expired (see `_check_validity` for Google's two
  exceptions) and no serial is on Google's revocation list;
- the leaf, and only the leaf, has the KeyDescription extension
  (OID 1.3.6.1.4.1.11129.2.1.17), and it says:
  - attestationChallenge == the enroll nonce;
  - attestation and KeyMint security level TrustedEnvironment or StrongBox;
  - hardware enforced: algorithm EC, curve P-256, purpose SIGN, userAuthType
    exactly biometric (no password bit); no noAuthRequired and no authTimeout
    anywhere (auth on every use);
  - attestationApplicationId: package com.serversherpa.kiosk, signed with a
    certificate whose SHA-256 is on the allowlist;
  - rootOfTrust: deviceLocked and verifiedBootState Verified.

The KeyDescription schema follows Google's
(https://source.android.com/docs/security/features/keystore/attestation#schema)
for attestation versions 3 (Keymaster 4) through 300 and later KeyMint
versions, whose layout is the same. AuthorizationList entries are read
tag by tag: the tags the checks need are decoded with their pyasn1 type,
and every other tag is skipped, so a newer KeyMint's extra tags don't break
parsing.
"""

import hmac
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Literal

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from pyasn1.codec.ber import decoder
from pyasn1.error import PyAsn1Error
from pyasn1.type import namedtype, tag, univ

from serversherpa.security.attestation_status import AttestationStatus

KEY_DESCRIPTION_OID = x509.ObjectIdentifier("1.3.6.1.4.1.11129.2.1.17")
KIOSK_PACKAGE = b"com.serversherpa.kiosk"
ROOTS_DIR = Path(__file__).resolve().parent / "attestation_roots"
MIN_ATTESTATION_VERSION = 3
# Google's RSA root's subject (SERIALNUMBER=...): chains under it from
# factory-provisioned devices stay trusted after they expire.
FACTORY_ROOT_SERIAL = "f92009e853b6b045"
FACTORY_CHAIN_LENGTH = 4          # leaf, batch, intermediate, root
MAX_CHAIN_LENGTH = 6              # remote-provisioned chains run longer

Reason = Literal["chain", "root", "expired", "revoked", "challenge", "security_level",
                 "key_properties", "user_auth", "package", "boot_state", "parse"]


class AttestationError(Exception):
    """The chain was refused; `reason` is one of the Reason codes."""

    def __init__(self, reason: Reason, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class AttestedKey:
    public_key_der: bytes          # the leaf's SubjectPublicKeyInfo, DER
    security_level: Literal["tee", "strongbox"]


# ── KeyDescription schema (Google's, pyasn1) ───────────────────────

class SecurityLevel(univ.Enumerated):
    SOFTWARE, TRUSTED_ENVIRONMENT, STRONGBOX = 0, 1, 2


class VerifiedBootState(univ.Enumerated):
    VERIFIED = 0


class AuthorizationList(univ.SequenceOf):
    """Every entry is `[tag] EXPLICIT <type> OPTIONAL`. Read as raw entries
    so unknown tags can be skipped; see `_authorization_list`."""
    componentType = univ.Any()


class KeyDescription(univ.Sequence):
    componentType = namedtype.NamedTypes(
        namedtype.NamedType("attestationVersion", univ.Integer()),
        namedtype.NamedType("attestationSecurityLevel", SecurityLevel()),
        namedtype.NamedType("keyMintVersion", univ.Integer()),
        namedtype.NamedType("keyMintSecurityLevel", SecurityLevel()),
        namedtype.NamedType("attestationChallenge", univ.OctetString()),
        namedtype.NamedType("uniqueId", univ.OctetString()),
        namedtype.NamedType("softwareEnforced", AuthorizationList()),
        namedtype.NamedType("hardwareEnforced", AuthorizationList()),
    )


class RootOfTrust(univ.Sequence):
    componentType = namedtype.NamedTypes(
        namedtype.NamedType("verifiedBootKey", univ.OctetString()),
        namedtype.NamedType("deviceLocked", univ.Boolean()),
        namedtype.NamedType("verifiedBootState", VerifiedBootState()),
        # absent before attestation version 3
        namedtype.OptionalNamedType("verifiedBootHash", univ.OctetString()),
    )


class AttestationPackageInfo(univ.Sequence):
    componentType = namedtype.NamedTypes(
        namedtype.NamedType("package_name", univ.OctetString()),
        namedtype.NamedType("version", univ.Integer()),
    )


class AttestationApplicationId(univ.Sequence):
    componentType = namedtype.NamedTypes(
        namedtype.NamedType("package_infos",
                            univ.SetOf(componentType=AttestationPackageInfo())),
        namedtype.NamedType("signature_digests",
                            univ.SetOf(componentType=univ.OctetString())),
    )


# KeyMint tags the checks read, with the type inside the explicit tag.
PURPOSE, ALGORITHM, EC_CURVE = 1, 2, 10
NO_AUTH_REQUIRED, USER_AUTH_TYPE, AUTH_TIMEOUT = 503, 504, 505
ROOT_OF_TRUST, ATTESTATION_APPLICATION_ID = 704, 709
_KNOWN_TAGS = {
    PURPOSE: lambda: univ.SetOf(componentType=univ.Integer()),
    ALGORITHM: univ.Integer,
    EC_CURVE: univ.Integer,
    NO_AUTH_REQUIRED: univ.Null,
    USER_AUTH_TYPE: univ.Integer,
    AUTH_TIMEOUT: univ.Integer,
    ROOT_OF_TRUST: RootOfTrust,
    ATTESTATION_APPLICATION_ID: univ.OctetString,
}
# KeyMint enum values
KEY_PURPOSE_SIGN = 2
ALGORITHM_EC = 3
EC_CURVE_P_256 = 1
AUTHENTICATOR_FINGERPRINT = 2     # HardwareAuthenticatorType: strong biometric


def _decode(substrate: bytes, spec):
    value, rest = decoder.decode(substrate, asn1Spec=spec)
    if rest:
        raise PyAsn1Error("trailing data")
    return value


def _context_tag(entry: bytes) -> int | None:
    """The tag number of an explicitly tagged context-specific entry, or None
    for anything else (which is then skipped)."""
    if not entry or entry[0] & 0xE0 != 0xA0:          # context class, constructed
        return None
    number = entry[0] & 0x1F
    if number != 0x1F:
        return number
    number = 0
    for byte in entry[1:6]:                            # high-tag-number form
        number = (number << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return number
    return None


def _authorization_list(entries) -> dict[int, object]:
    """The known tags of one AuthorizationList, decoded; unknown tags skipped.
    A known tag that doesn't decode as its type is a parse error."""
    found: dict[int, object] = {}
    for entry in entries:
        raw = entry.asOctets()
        number = _context_tag(raw)
        if number not in _KNOWN_TAGS:
            continue
        if number in found:
            raise AttestationError("parse", f"tag {number} appears twice")
        spec = _KNOWN_TAGS[number]().subtype(
            explicitTag=tag.Tag(tag.tagClassContext, tag.tagFormatConstructed, number))
        try:
            found[number] = _decode(raw, spec)
        except PyAsn1Error as exc:
            raise AttestationError("parse", f"tag {number}: {exc}") from None
    return found


# ── roots ──────────────────────────────────────────────────────────

@lru_cache
def google_roots() -> tuple[x509.Certificate, ...]:
    """The pinned Google hardware attestation roots."""
    return tuple(x509.load_pem_x509_certificate(p.read_bytes())
                 for p in sorted(ROOTS_DIR.glob("*.pem")))


def _spki(cert: x509.Certificate) -> bytes:
    return cert.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def factory_root_spkis(roots) -> set[bytes]:
    """The public keys of the pinned roots that sign factory-provisioned
    chains: Google's RSA root, subject SERIALNUMBER=f92009e853b6b045 (all four
    of its certificates share one key). The EC root is RKP only."""
    return {_spki(r) for r in roots
            if any(a.value == FACTORY_ROOT_SERIAL
                   for a in r.subject.get_attributes_for_oid(NameOID.SERIAL_NUMBER))}


def _has_serial_number_attr(name: x509.Name) -> bool:
    return bool(name.get_attributes_for_oid(NameOID.SERIAL_NUMBER))


def _has_key_description(cert: x509.Certificate) -> bool:
    try:
        cert.extensions.get_extension_for_oid(KEY_DESCRIPTION_OID)
    except x509.ExtensionNotFound:
        return False
    return True


# ── checks ─────────────────────────────────────────────────────────

def _check_chain(certs: list[x509.Certificate], roots) -> None:
    if len(certs) < 3:
        raise AttestationError("chain", "need the leaf, an intermediate and the root")
    if len(certs) > MAX_CHAIN_LENGTH:
        raise AttestationError("chain", f"more than {MAX_CHAIN_LENGTH} certificates")
    top = certs[-1]
    pinned = {_spki(r) for r in roots}
    if _spki(top) not in pinned:
        raise AttestationError("root", "the chain does not end at a pinned Google root")
    # Exactly one anchor, at the end: a root (or any copy, reissue or
    # cross-certificate of a pinned key) inside the chain would change its
    # shape, e.g. make a remote-provisioned chain look factory-provisioned.
    for cert in certs[:-1]:
        if cert.subject == cert.issuer or _spki(cert) in pinned:
            raise AttestationError("chain", "a root certificate appears below the anchor")
    for cert, issuer in zip(certs, certs[1:] + [top], strict=True):
        try:
            cert.verify_directly_issued_by(issuer)
        except (InvalidSignature, ValueError, TypeError) as exc:
            raise AttestationError(
                "chain", f"{cert.subject.rfc4514_string()} is not signed by "
                         f"{issuer.subject.rfc4514_string()}") from exc
    try:
        extended = any(_has_key_description(c) for c in certs[1:])
    except (ValueError, x509.DuplicateExtension) as exc:
        raise AttestationError("parse", "unreadable certificate extensions") from exc
    if extended:
        raise AttestationError("chain", "a certificate above the leaf has a KeyDescription")


def _check_validity(certs: list[x509.Certificate], roots, now: datetime) -> None:
    """No certificate may be expired, with Google's two exceptions:

    - the root is the trust anchor (pinned by its key), so its own dates
      aren't checked: Google's 2016 RSA root certificate expired on
      2026-05-24 and older devices still send it;
    - a factory-provisioned chain (exactly leaf, batch, intermediate and
      root; the root has the pinned RSA root's key and the intermediate just
      below it has a SERIALNUMBER subject) is trusted after it expires: Google
      says those devices can't rotate their keys and stay trustworthy unless
      revoked. Remote-provisioned chains keep their dates checked.

    The leaf's notBefore comes from the device clock, so only its notAfter
    is checked (Google's verifier skips the leaf entirely)."""
    factory = (len(certs) == FACTORY_CHAIN_LENGTH
               and _spki(certs[-1]) in factory_root_spkis(roots)
               and _has_serial_number_attr(certs[-2].subject))
    for index, cert in enumerate(certs[:-1]):
        if index > 0 and now < cert.not_valid_before_utc:
            raise AttestationError("expired",
                                   f"{cert.subject.rfc4514_string()} is not valid yet")
        if now > cert.not_valid_after_utc and not factory:
            raise AttestationError("expired", f"{cert.subject.rfc4514_string()} expired")


def _check_revocation(certs: list[x509.Certificate], status: AttestationStatus) -> None:
    for cert in certs:
        if format(cert.serial_number, "x") in status.revoked_serials:
            raise AttestationError("revoked", f"serial {cert.serial_number:x} is revoked")


def _key_description(leaf: x509.Certificate) -> KeyDescription:
    try:
        ext = leaf.extensions.get_extension_for_oid(KEY_DESCRIPTION_OID)
    except x509.ExtensionNotFound:
        raise AttestationError("parse", "the leaf has no KeyDescription") from None
    except (ValueError, x509.DuplicateExtension) as exc:
        raise AttestationError("parse", "unreadable leaf extensions") from exc
    try:
        return _decode(ext.value.value, KeyDescription())
    except PyAsn1Error as exc:
        raise AttestationError("parse", f"KeyDescription: {exc}") from None


def _security_level(kd: KeyDescription) -> Literal["tee", "strongbox"]:
    levels = {int(kd["attestationSecurityLevel"]), int(kd["keyMintSecurityLevel"])}
    if not levels <= {SecurityLevel.TRUSTED_ENVIRONMENT, SecurityLevel.STRONGBOX}:
        raise AttestationError("security_level", "not a hardware-backed key")
    return "strongbox" if levels == {SecurityLevel.STRONGBOX} else "tee"


def _check_key_properties(leaf: x509.Certificate, hw: dict) -> None:
    key = leaf.public_key()
    if not (isinstance(key, ec.EllipticCurvePublicKey)
            and isinstance(key.curve, ec.SECP256R1)):
        raise AttestationError("key_properties", "the key is not EC P-256")
    if ALGORITHM not in hw or int(hw[ALGORITHM]) != ALGORITHM_EC:
        raise AttestationError("key_properties", "algorithm is not hardware-enforced EC")
    if EC_CURVE not in hw or int(hw[EC_CURVE]) != EC_CURVE_P_256:
        raise AttestationError("key_properties", "curve is not hardware-enforced P-256")
    if PURPOSE not in hw or KEY_PURPOSE_SIGN not in {int(p) for p in hw[PURPOSE]}:
        raise AttestationError("key_properties", "SIGN is not a hardware-enforced purpose")


def _check_user_auth(sw: dict, hw: dict) -> None:
    if NO_AUTH_REQUIRED in sw or NO_AUTH_REQUIRED in hw:
        raise AttestationError("user_auth", "the key needs no user authentication")
    if AUTH_TIMEOUT in sw or AUTH_TIMEOUT in hw:
        raise AttestationError("user_auth", "the key has an auth timeout, not auth per use")
    # exactly biometric: a password bit (or ANY) would let a PIN use the key
    if USER_AUTH_TYPE not in hw or int(hw[USER_AUTH_TYPE]) != AUTHENTICATOR_FINGERPRINT:
        raise AttestationError("user_auth", "only a strong biometric may unlock the key")


def _check_package(sw: dict, hw: dict, digests: set[str]) -> None:
    raw = sw.get(ATTESTATION_APPLICATION_ID, hw.get(ATTESTATION_APPLICATION_ID))
    if raw is None:
        raise AttestationError("package", "no attestationApplicationId")
    try:
        app_id = _decode(raw.asOctets(), AttestationApplicationId())
    except PyAsn1Error as exc:
        raise AttestationError("parse", f"attestationApplicationId: {exc}") from None
    names = {info["package_name"].asOctets() for info in app_id["package_infos"]}
    if KIOSK_PACKAGE not in names:
        raise AttestationError("package", "the key was not made by the kiosk app")
    signed = {d.asOctets().hex() for d in app_id["signature_digests"]}
    if not signed & digests:
        raise AttestationError("package", "the kiosk app's signing key is not allowed")


def _check_boot_state(hw: dict) -> None:
    rot = hw.get(ROOT_OF_TRUST)
    if rot is None:
        raise AttestationError("boot_state", "no hardware root of trust")
    if not bool(rot["deviceLocked"]):
        raise AttestationError("boot_state", "the bootloader is unlocked")
    if int(rot["verifiedBootState"]) != VerifiedBootState.VERIFIED:
        raise AttestationError("boot_state", "verified boot state is not Verified")


def _normalize_digest(value: str) -> str:
    return value.replace(":", "").replace(" ", "").strip().lower()


def verify_attestation(chain_der: list[bytes], *, nonce: bytes, digests: set[str],
                       status: AttestationStatus,
                       roots: list[x509.Certificate] | None = None,
                       now: datetime | None = None) -> AttestedKey:
    """Verify an attestation chain (leaf first) for a biometric enroll.

    `digests`: allowed SHA-256 digests (hex) of the kiosk app's signing
    certificates. `status`: Google's revocation list; whether it is fresh
    enough is the caller's check. `roots` replaces the pinned Google roots
    (tests). Raises AttestationError with a reason code."""
    now = now or datetime.now(UTC)
    roots = google_roots() if roots is None else roots
    certs: list[x509.Certificate] = []
    for der in chain_der:
        try:
            certs.append(x509.load_der_x509_certificate(der))
        except (ValueError, TypeError) as exc:
            raise AttestationError("parse", "a certificate is not DER X.509") from exc

    _check_chain(certs, roots)
    _check_validity(certs, roots, now)
    _check_revocation(certs, status)

    leaf = certs[0]                     # never read the extension of any other cert
    kd = _key_description(leaf)
    if int(kd["attestationVersion"]) < MIN_ATTESTATION_VERSION:
        raise AttestationError("parse", f"attestation version {kd['attestationVersion']}"
                                        " is older than this verifier supports")
    sw = _authorization_list(kd["softwareEnforced"])
    hw = _authorization_list(kd["hardwareEnforced"])

    if not hmac.compare_digest(kd["attestationChallenge"].asOctets(), nonce):
        raise AttestationError("challenge", "the challenge is not the enroll nonce")
    level = _security_level(kd)
    _check_key_properties(leaf, hw)
    _check_user_auth(sw, hw)
    _check_package(sw, hw, {_normalize_digest(d) for d in digests})
    _check_boot_state(hw)
    return AttestedKey(public_key_der=_spki(leaf), security_level=level)
