"""Add this iPhone: one-time enroll tokens, the Profile Service .mobileconfig
that asks iOS for the device's attributes, reading iOS's signed answer, and
recording the device.

A token is 32 random URL-safe bytes; only its SHA-256 is stored. A UDID is
never put in a URL, a log line or an audit row."""

import datetime as dt
import hashlib
import plistlib
import re
import secrets
import uuid
from dataclasses import dataclass

from asn1crypto import cms
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices.db.models import EnrollToken, IosDevice

TOKEN_LIFETIME = dt.timedelta(minutes=15)
DEVICE_ATTRIBUTES = ["UDID", "PRODUCT", "VERSION", "SERIAL", "DEVICE_NAME"]
_UDID = re.compile(r"[A-Za-z0-9-]{1,64}")
_FIELD_MAX = 200
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class EnrollError(Exception):
    """iOS's answer can't be used. The message never carries what was sent."""


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def has_control_characters(value: str) -> bool:
    """C0 controls (NUL included) and DEL: Postgres text refuses NUL."""
    return _CONTROL.search(value) is not None


def make_token(*, person_id: uuid.UUID, person_name: str, device_name: str,
               can_reenable: bool, can_update_existing: bool) -> tuple[str, EnrollToken]:
    """A new token and its (unsaved) row. The flags are what the creator may
    do to an iPhone that's already listed (see record_device)."""
    token = secrets.token_urlsafe(32)
    row = EnrollToken(token_hash=hash_token(token), person_id=person_id,
                      person_name=person_name, device_name=device_name,
                      expires_at=dt.datetime.now(dt.UTC) + TOKEN_LIFETIME,
                      can_reenable=can_reenable, can_update_existing=can_update_existing)
    return token, row


async def live_token(db: AsyncSession, token: str, *, lock: bool = False) -> EnrollToken | None:
    """The token's row when it exists, hasn't expired and hasn't been used."""
    query = select(EnrollToken).where(EnrollToken.token_hash == hash_token(token))
    row = await db.scalar(query.with_for_update() if lock else query)
    if row is None or row.used_at is not None or row.expires_at <= dt.datetime.now(dt.UTC):
        return None
    return row


def mobileconfig(*, public_url: str, token: str) -> bytes:
    """The Profile Service payload: iOS sends the device's attributes to the
    callback URL, signed, with `Challenge` echoed back."""
    return plistlib.dumps({
        "PayloadType": "Profile Service",
        "PayloadVersion": 1,
        "PayloadUUID": str(uuid.uuid4()).upper(),
        "PayloadIdentifier": "com.serversherpa.devices.enroll",
        "PayloadDisplayName": "ServerSherpa Devices — add this iPhone",
        "PayloadOrganization": "ServerSherpa",
        "PayloadDescription": "Sends this iPhone's identifier to ServerSherpa Devices "
                              "so it can install ServerSherpa apps.",
        "PayloadContent": {
            "URL": f"{public_url.rstrip('/')}/enroll/{token}/callback",
            "DeviceAttributes": DEVICE_ATTRIBUTES,
            "Challenge": token,
        },
    })


@dataclass(frozen=True)
class DeviceAnswer:
    udid: str
    product: str
    os_version: str
    serial: str | None
    challenge: str | None


def _text(found: dict, key: str) -> str | None:
    value = found.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > _FIELD_MAX or has_control_characters(value):
        raise EnrollError(f"{key} isn't readable")
    return value


def read_answer(body: bytes) -> DeviceAnswer:
    """The attributes iOS signed.

    The CMS signature is deliberately not verified. iOS signs with a device
    identity certificate whose chain this service has no reliable anchor for,
    and a valid signature would only prove "some Apple device", not which
    one or whose. What authenticates the answer is the token in the path:
    256 random bits, single use, 15 minutes, issued to a signed-in person
    holding `view`. Whoever holds it may enroll one iPhone in that person's
    name, which is exactly what the link is for."""
    try:
        info = cms.ContentInfo.load(body)
        if info["content_type"].native != "signed_data":
            raise EnrollError("not signed data")
        content = info["content"]["encap_content_info"]["content"].native
        found = plistlib.loads(content)
    except EnrollError:
        raise
    # asn1crypto parses lazily and plistlib uses expat: any failure means unreadable.
    except Exception:  # noqa: BLE001
        raise EnrollError("not a signed plist") from None
    if not isinstance(found, dict):
        raise EnrollError("not a dictionary")
    udid = _text(found, "UDID")
    if not udid or not _UDID.fullmatch(udid):
        raise EnrollError("UDID missing or unreadable")
    return DeviceAnswer(udid=udid, product=_text(found, "PRODUCT") or "",
                        os_version=_text(found, "VERSION") or "",
                        serial=_text(found, "SERIAL") or None,
                        challenge=_text(found, "CHALLENGE"))


@dataclass(frozen=True)
class Enrollment:
    device: IosDevice
    # Audit changes: name, product, os_version, status only (no UDID, no serial).
    changes: dict
    # A disabled iPhone the token's creator may not bring back: nothing changed.
    refused: bool = False


async def record_device(db: AsyncSession, token: EnrollToken,
                        answer: DeviceAnswer) -> Enrollment:
    """Add the device, or update an existing one (same UDID). The row is
    locked until the caller commits.

    For an existing device:
    - disabled: back to pending only when the token's creator held `delete`
      (`can_reenable`); otherwise the row is left exactly as it is (refused);
    - failed: back to pending (a retry);
    - registered or pending: status kept;
    - name, product, OS and serial change only when the token's creator
      added the device or held `change` (`can_update_existing`)."""
    fields = {"name": token.device_name, "product": answer.product,
              "os_version": answer.os_version, "serial": answer.serial}
    inserted = await db.scalar(
        insert(IosDevice).values(udid=answer.udid, added_by=token.person_id,
                                 added_by_name=token.person_name, status="pending", **fields)
        .on_conflict_do_nothing(index_elements=["udid"]).returning(IosDevice.id))
    device = await db.scalar(select(IosDevice).where(IosDevice.udid == answer.udid)
                             .with_for_update().execution_options(populate_existing=True))
    if device is None:   # can't happen: inserted, or the conflicting row exists
        raise RuntimeError("enrolled device row not found")
    audited = ("name", "product", "os_version", "status")
    before = {k: None for k in audited} if inserted else {k: getattr(device, k) for k in audited}
    if not inserted:
        if device.status == "disabled" and not token.can_reenable:
            return Enrollment(device=device, changes={}, refused=True)
        if token.person_id == device.added_by or token.can_update_existing:
            for key, value in fields.items():
                if value is not None or key != "serial":   # an absent serial keeps the known one
                    setattr(device, key, value)
        if device.status in ("disabled", "failed"):
            device.status = "pending"
            device.error = None
    changes = {k: {"from": before[k], "to": getattr(device, k)}
               for k in audited if before[k] != getattr(device, k)}
    return Enrollment(device=device, changes=changes)
