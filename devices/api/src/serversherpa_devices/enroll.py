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
# Statuses a new enrollment sends back to the worker; registered and pending stay.
_RETRY = ("disabled", "failed")


class EnrollError(Exception):
    """iOS's answer can't be used. The message never carries what was sent."""


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def make_token(*, person_id: uuid.UUID, person_name: str,
               device_name: str) -> tuple[str, EnrollToken]:
    """A new token and its (unsaved) row."""
    token = secrets.token_urlsafe(32)
    row = EnrollToken(token_hash=hash_token(token), person_id=person_id,
                      person_name=person_name, device_name=device_name,
                      expires_at=dt.datetime.now(dt.UTC) + TOKEN_LIFETIME)
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
    if not isinstance(value, str) or len(value) > _FIELD_MAX:
        raise EnrollError(f"{key} isn't readable")
    return value


def read_answer(body: bytes) -> DeviceAnswer:
    """The attributes iOS signed. The signature isn't verified: the token
    (single use, tied to a signed-in person) is what's trusted."""
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


async def record_device(db: AsyncSession, token: EnrollToken,
                        answer: DeviceAnswer) -> tuple[IosDevice, dict]:
    """Add the device, or bring an existing one (same UDID) up to date: the
    token's name, the new product and OS, and a disabled or failed device
    goes back to pending. The row is locked until the caller commits.
    Returns the device and the audit changes (no UDID, no serial)."""
    fields = {"name": token.device_name, "product": answer.product,
              "os_version": answer.os_version, "serial": answer.serial}
    inserted = await db.scalar(
        insert(IosDevice).values(udid=answer.udid, added_by=token.person_id,
                                 added_by_name=token.person_name, status="pending", **fields)
        .on_conflict_do_nothing(index_elements=["udid"]).returning(IosDevice.id))
    device = await db.scalar(select(IosDevice).where(IosDevice.udid == answer.udid)
                             .with_for_update().execution_options(populate_existing=True))
    assert device is not None
    audited = ("name", "product", "os_version", "status")
    before = {k: None for k in audited} if inserted else {k: getattr(device, k) for k in audited}
    if not inserted:
        for key, value in fields.items():
            setattr(device, key, value)
        if device.status in _RETRY:
            device.status = "pending"
            device.error = None
    changes = {k: {"from": before[k], "to": getattr(device, k)}
               for k in audited if before[k] != getattr(device, k)}
    return device, changes
