"""Kiosk-attached fixed readers: an RFID Station's heartbeat may carry a
`reader` snapshot, which upserts one `fixed_reader` Device keyed by serial.

apply_reader_report never raises out to the heartbeat route: a bad or
unacceptable report is dropped and (at most) its serial is logged."""

import logging
import uuid
from datetime import UTC, datetime
from ipaddress import IPv4Address
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Device
from serversherpa.services.audit import audit

log = logging.getLogger(__name__)

_Str64 = Annotated[str, StringConstraints(max_length=64)]
_Count = Annotated[int, Field(ge=0)]


class KioskReaderReport(BaseModel):
    model_config = ConfigDict(extra="ignore")

    serial: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    make: _Str64 | None = None
    model: _Str64 | None = None
    name: _Str64 | None = None
    firmware: _Str64 | None = None
    mac: Annotated[str, StringConstraints(
        pattern=r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")] | None = None
    ip: IPv4Address | None = None
    uptime_seconds: _Count | None = None
    antennas_connected: _Count | None = None
    antennas_total: _Count | None = None
    tags_24h: _Count | None = None
    reading: bool | None = None
    reachable: bool | None = None
    taken_at: datetime | None = None


def _safe_serial(report: object) -> str | None:
    if isinstance(report, dict) and isinstance(report.get("serial"), str):
        return report["serial"][:64]
    return None


async def apply_reader_report(
    db: AsyncSession, *, kiosk: Device, report: dict, actor_id: uuid.UUID | None,
) -> Device | None:
    serial = _safe_serial(report)
    try:
        if kiosk.station_type != "rfid" or not kiosk.rfid_reader_serial:
            return None
        parsed = KioskReaderReport.model_validate(report)
        if parsed.serial.lower() != kiosk.rfid_reader_serial.lower():
            return None
        # A savepoint: a failure here (e.g. a unique-serial race) rolls back
        # only the reader, never the kiosk's own heartbeat changes.
        async with db.begin_nested():
            return await _upsert(db, kiosk, parsed, actor_id)
    except ValidationError:
        log.warning("kiosk reader report dropped (invalid), serial=%s", serial)
    except Exception:  # noqa: BLE001 - a reader never fails the heartbeat
        log.warning("kiosk reader report dropped (error), serial=%s", serial,
                    exc_info=False)
    return None


async def _upsert(db: AsyncSession, kiosk: Device, r: KioskReaderReport,
                  actor_id: uuid.UUID | None) -> Device | None:
    now = datetime.now(UTC)
    reader = await db.scalar(select(Device).where(Device.serial == r.serial))
    if reader is not None and reader.device_type != "fixed_reader":
        log.warning("kiosk reader report ignored (serial held by %s), serial=%s",
                    reader.device_type, r.serial)
        return None
    created = reader is None
    if created:
        reader = Device(device_type="fixed_reader", serial=r.serial,
                        name=r.name or f"FX9600 {r.serial}", raw_info={})
        db.add(reader)
    reader.model = r.model
    reader.version = r.firmware
    reader.mac = r.mac
    reader.lan_ip = str(r.ip) if r.ip is not None else None
    reader.uptime_seconds = r.uptime_seconds
    reader.antennas_connected = r.antennas_connected
    reader.connection_type = "local_api"
    reader.scan_status = kiosk.scan_status
    reader.site_id = kiosk.site_id
    reader.current_initiative_id = kiosk.current_initiative_id
    if r.reachable is not False:
        reader.last_seen_at = now
    reader.raw_info = {
        **(reader.raw_info or {}),
        "make": r.make, "reading": r.reading, "reachable": r.reachable,
        "reported_tags_24h": r.tags_24h, "antennas_total": r.antennas_total,
        "reported_at": (r.taken_at or now).isoformat(),
        "via_kiosk_id": str(kiosk.id), "via_kiosk_name": kiosk.name,
    }
    reader.updated_at = now
    await db.flush()
    if created:
        audit(db, actor_id=actor_id, entity_type="device", entity_id=str(reader.id),
              action="self_register",
              changes={"serial": r.serial, "name": reader.name, "via_kiosk": kiosk.name})
    return reader
