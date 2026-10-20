"""Station keys (RFID, Label and Time Clock Stations): a per-device secret an
unattended laptop kiosk uses to call the station routes as itself. RFID and
Label Stations upload scans with it; a Time Clock key is refused there
(deps.station_device scopes each route by station type). Only the sha256 is stored; the raw key is returned
once, at issue, and never logged or audited. Spec §3.

Callers commit; audit rows ride the caller's transaction."""

import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Device
from serversherpa.services.audit import audit

TIMECLOCK = "timeclock"
# every laptop station type that may hold a station key
STATION_TYPES: tuple[str, ...] = ("rfid", "label", TIMECLOCK)
# the station types the scan-upload routes (sync, scans, heartbeat, sounds) serve
UPLOAD_STATION_TYPES: tuple[str, ...] = ("rfid", "label")


def _hash(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


async def issue(db: AsyncSession, device: Device, *,
                actor_id: uuid.UUID | None, via: str) -> str:
    """Mint a new key for `device`, replacing any old one. The key covers
    only the device's current setup move."""
    raw = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    device.station_key_hash = _hash(raw)
    device.station_key_initiative_id = device.current_initiative_id
    device.station_key_issued_at = now
    device.station_key_issued_by = actor_id
    device.station_key_issued_via = via
    device.updated_at = now
    audit(db, actor_id=actor_id, entity_type="device", entity_id=str(device.id),
          action="station_key_issue",
          changes={"initiative_id": (str(device.current_initiative_id)
                                     if device.current_initiative_id else None),
                   "via": via})
    await db.flush()
    return raw


async def revoke(db: AsyncSession, device: Device, *,
                 actor_id: uuid.UUID | None, reason: str) -> bool:
    """Clear the key and the move it covered. Returns whether a key existed; an
    audit row is written only then."""
    if device.station_key_hash is None:
        return False
    device.station_key_hash = None
    device.station_key_initiative_id = None
    device.station_key_issued_at = None
    device.station_key_issued_by = None
    device.station_key_issued_via = None
    device.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor_id, entity_type="device", entity_id=str(device.id),
          action="station_key_revoke", changes={"reason": reason})
    return True


async def verify(db: AsyncSession, serial: str, raw_key: str) -> Device | None:
    """The kiosk Device for `serial` when `raw_key` matches its key and the
    device is still a laptop station (any STATION_TYPES), else None (no device,
    not a kiosk, no key, a wrong key, or no longer `laptop` / a station type).
    Which routes a type may call is deps.station_device's job. Eligibility
    is checked only after the hash matches. Registration is not checked here;
    deps.station_device refuses a lapsed one with a 403 that keeps the key."""
    device = await db.scalar(select(Device).where(Device.serial == serial))
    if device is None or device.device_type != "kiosk" or not device.station_key_hash:
        return None
    if not hmac.compare_digest(_hash(raw_key), device.station_key_hash):
        return None
    if device.sub_type != "laptop" or device.station_type not in STATION_TYPES:
        return None
    return device
