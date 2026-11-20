"""The Apple team settings (the apple_settings row): reading an uploaded
distribution certificate, the unsealed credentials the worker uses, and the
unsealed certificate alone, which the API signs the add-device profile with."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

import httpx
from cryptography import x509
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices.apple.asc import AscClient, normalize_serial
from serversherpa_devices.db.models import AppleSettings
from serversherpa_devices.services.secrets import unseal

DISTRIBUTION_PREFIXES = ("Apple Distribution", "iPhone Distribution")
WRONG_PASSWORD = "The certificate password is wrong."
NO_IDENTITY = "The certificate file (.p12) has no certificate and private key."


class AppleSettingsError(Exception):
    """An uploaded part can't be used; `message` is for the admin."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class Certificate:
    name: str                 # the common name, e.g. "Apple Distribution: …"
    serial: str               # normalize_serial form
    expires_at: dt.datetime


def _common_name(cert: x509.Certificate) -> str:
    names = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    value = names[0].value if names else ""
    return value if isinstance(value, str) else value.decode(errors="replace")


def read_certificate(p12: bytes, password: str) -> Certificate:
    """The distribution certificate in a .p12. Raises AppleSettingsError
    for a wrong password (which unreadable data looks the same as), a file
    without a certificate and key, or any other kind of certificate."""
    try:
        key, cert, _ = pkcs12.load_key_and_certificates(p12, password.encode())
    except (ValueError, TypeError):
        raise AppleSettingsError(WRONG_PASSWORD) from None
    if key is None or cert is None:
        raise AppleSettingsError(NO_IDENTITY)
    name = _common_name(cert)
    if not name.startswith(DISTRIBUTION_PREFIXES):
        raise AppleSettingsError(
            f"The certificate isn't an Apple Distribution certificate ({name or 'no name'}).")
    return Certificate(name=name, serial=normalize_serial(format(cert.serial_number, "X")),
                       expires_at=cert.not_valid_after_utc)


def is_configured(row: AppleSettings | None) -> bool:
    return row is not None and row.p12_enc is not None


@dataclass(frozen=True)
class AppleCredentials:
    team_id: str
    issuer_id: str
    key_id: str
    # Never in a repr, so a log line or an assertion diff can't print them.
    p8: bytes = field(repr=False)
    p12: bytes = field(repr=False)
    p12_password: str = field(repr=False)
    asc_certificate_id: str

    def client(self, *, http: httpx.AsyncClient | None = None) -> AscClient:
        return AscClient(self.key_id, self.issuer_id, self.p8, http=http)


@dataclass(frozen=True)
class StoredCertificate:
    """The distribution certificate's .p12 and its password, unsealed."""
    p12: bytes = field(repr=False)
    password: str = field(repr=False)


def _certificate(row: AppleSettings) -> StoredCertificate:
    return StoredCertificate(p12=unseal(row.p12_enc),
                             password=unseal(row.p12_password_enc).decode())


async def load_credentials(db: AsyncSession) -> AppleCredentials | None:
    """The saved settings, unsealed; None when they aren't filled in.
    Raises secrets.SecretError when they were sealed under another key."""
    row = await db.get(AppleSettings, 1)
    if not is_configured(row) or None in (
            row.team_id, row.issuer_id, row.key_id, row.p8_enc, row.p12_password_enc,
            row.asc_certificate_id):
        return None
    cert = _certificate(row)
    return AppleCredentials(
        team_id=row.team_id, issuer_id=row.issuer_id, key_id=row.key_id,
        p8=unseal(row.p8_enc), p12=cert.p12, p12_password=cert.password,
        asc_certificate_id=row.asc_certificate_id)


async def load_certificate(db: AsyncSession) -> StoredCertificate | None:
    """The saved .p12 and its password, unsealed (nothing else is); None
    when they aren't saved. Raises secrets.SecretError when they were sealed
    under another key, UnicodeDecodeError for a password that isn't UTF-8."""
    row = await db.get(AppleSettings, 1)
    if not is_configured(row) or row.p12_password_enc is None:
        return None
    return _certificate(row)
