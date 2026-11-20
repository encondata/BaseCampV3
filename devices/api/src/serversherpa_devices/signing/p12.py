"""Opening the stored Apple Distribution .p12, in memory only.

The worker opens it to re-sign IPAs (resign.py) and the API opens it to sign
the add-device profile (profile.py). The .p12 and its password stay in the
caller's local variables: nothing here caches them or logs them."""

import warnings

from cryptography.hazmat.primitives.serialization import pkcs12

from serversherpa_devices.signing import SignError

P12_UNREADABLE = "The Apple certificate (.p12) can't be opened with its saved password."

# Keychain Access exports a .p12 in BER, and cryptography warns (on every
# load) that it fell back from DER to BER. The .p12 still opens, so the
# warning is only noise in the logs. (If cryptography ever refuses BER, the
# load raises, which is the unreadable-certificate path.)
warnings.filterwarnings(
    "ignore", message="PKCS#12 bundle could not be parsed as DER, falling back to parsing as BER")


def open_p12(p12: bytes, password: str) -> pkcs12.PKCS12KeyAndCertificates:
    """The .p12's key, certificate and any other certificates it holds.
    Raises SignError(P12_UNREADABLE) when the password doesn't open it
    (unreadable data looks the same) or it has no certificate and key."""
    try:
        stored = pkcs12.load_pkcs12(p12, password.encode() or None)
    except (ValueError, TypeError):
        raise SignError(P12_UNREADABLE) from None
    if stored.key is None or stored.cert is None:
        raise SignError(P12_UNREADABLE)
    return stored
