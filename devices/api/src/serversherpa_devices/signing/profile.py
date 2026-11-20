"""Signing the add-device profile, so iOS shows it as Verified rather than
"Not Signed".

The profile's plist goes into a CMS (PKCS#7) SignedData, DER, content
attached, SHA-256, signed with the team's Apple Distribution certificate.
For iOS to build the path to Apple's root, the SignedData also carries the
WWDR intermediate that issued the certificate: from the .p12 when it has
it, otherwise the matching one bundled in wwdr/ (see its README).

The API opens the .p12 here, in memory, for each download; the key never
leaves this call's local variables."""

from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs7

from serversherpa_devices.signing.p12 import open_p12

WWDR_DIR = Path(__file__).resolve().parent / "wwdr"


def bundled_intermediates() -> list[x509.Certificate]:
    """Apple's WWDR intermediates shipped with the package (public certificates)."""
    found: list[x509.Certificate] = []
    for path in sorted(WWDR_DIR.glob("*.pem")):
        found.extend(x509.load_pem_x509_certificates(path.read_bytes()))
    return found


def _issued(leaf: x509.Certificate, issuer: x509.Certificate) -> bool:
    """`issuer`'s subject is `leaf`'s issuer and its key signed `leaf`."""
    try:
        leaf.verify_directly_issued_by(issuer)
    except Exception:  # noqa: BLE001 - wrong name, wrong key, or a key type it can't check
        return False
    return True


def chain_for(leaf: x509.Certificate, held: list[x509.Certificate],
              bundled: list[x509.Certificate]) -> list[x509.Certificate]:
    """The certificates to carry besides the leaf: those the .p12 holds,
    plus the bundled intermediate that issued the leaf when the .p12 has
    none that did."""
    extra = [c for c in held if c != leaf]
    if not any(_issued(leaf, c) for c in extra):
        extra += [c for c in bundled if _issued(leaf, c)][:1]
    return extra


def sign_profile(profile: bytes, *, p12: bytes, password: str,
                 intermediates: list[x509.Certificate] | None = None) -> bytes:
    """`profile` as a DER CMS SignedData signed with the .p12's certificate
    and key. `intermediates` defaults to the bundled WWDR ones. Raises
    SignError when the .p12 can't be opened; cryptography's own errors
    (TypeError, ValueError, UnsupportedAlgorithm) for a key it can't sign
    with."""
    stored = open_p12(p12, password)
    leaf = stored.cert.certificate
    held = [c.certificate for c in stored.additional_certs]
    builder = (pkcs7.PKCS7SignatureBuilder().set_data(profile)
               .add_signer(leaf, stored.key, hashes.SHA256()))
    for cert in chain_for(leaf, held, bundled_intermediates() if intermediates is None
                          else intermediates):
        builder = builder.add_certificate(cert)
    # Binary: the plist's bytes exactly as they are, no S/MIME line-ending rewrite.
    return builder.sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.Binary])
