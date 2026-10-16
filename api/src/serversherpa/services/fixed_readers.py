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
    except Exception as exc:  # noqa: BLE001 - a reader never fails the heartbeat
        log.warning("kiosk reader report dropped (%s), serial=%s",
                    type(exc).__name__, serial)
    return None


async def _upsert(db: AsyncSession, kiosk: Device, r: KioskReaderReport,
                  actor_id: uuid.UUID | None) -> Device | None:
    now = datetime.now(UTC)
    reader = await db.scalar(select(Device).where(Device.serial == r.serial))
    if reader is not None and (
            reader.device_type != "fixed_reader"
            or not (reader.raw_info or {}).get("via_kiosk_id")):
        # Another family's row, or a fixed reader not created through a
        # kiosk (hand-made / another source): never taken over.
        log.warning("kiosk reader report ignored (serial not claimable), serial=%s",
                    r.serial)
        return None
    created = reader is None
    before: dict = {}
    if created:
        reader = Device(device_type="fixed_reader", serial=r.serial,
                        name=r.name or f"FX9600 {r.serial}", raw_info={})
        db.add(reader)
    else:
        before = {"site_id": reader.site_id,
                  "initiative_id": reader.current_initiative_id,
                  "via_kiosk": (reader.raw_info or {}).get("via_kiosk_name")}
    present = r.model_fields_set
    # Only fields the report carries are applied; an absent field keeps
    # what is stored (a partial snapshot must not wipe good data).
    for src, col, conv in (
            ("model", "model", None), ("firmware", "version", None),
            ("mac", "mac", None), ("ip", "lan_ip", str),
            ("uptime_seconds", "uptime_seconds", None),
            ("antennas_connected", "antennas_connected", None)):
        v = getattr(r, src)
        if src in present and v is not None:
            if col == "mac":
                other = await db.scalar(select(Device.id).where(
                    Device.mac == v, Device.id != reader.id))
                if other is not None:
                    log.warning("kiosk reader mac not set (held by device %s), "
                                "serial=%s", other, r.serial)
                    continue
            setattr(reader, col, conv(v) if conv else v)
    reader.connection_type = "local_api"
    reader.scan_status = kiosk.scan_status
    reader.site_id = kiosk.site_id
    reader.current_initiative_id = kiosk.current_initiative_id
    if r.reachable is not False:
        taken = r.taken_at
        if taken is not None and taken.tzinfo is None:
            taken = taken.replace(tzinfo=UTC)
        reader.last_seen_at = min(taken, now) if taken else now
    raw = dict(reader.raw_info or {})
    for src, key in (("make", "make"), ("reading", "reading"),
                     ("tags_24h", "reported_tags_24h"),
                     ("antennas_total", "antennas_total")):
        v = getattr(r, src)
        if src in present and v is not None:
            raw[key] = v
    raw["reachable"] = r.reachable
    raw["reported_at"] = (r.taken_at or now).isoformat()
    raw["via_kiosk_id"] = str(kiosk.id)
    raw["via_kiosk_name"] = kiosk.name
    reader.raw_info = raw
    reader.updated_at = now
    await db.flush()
    if created:
        audit(db, actor_id=actor_id, entity_type="device", entity_id=str(reader.id),
              action="self_register",
              changes={"serial": r.serial, "name": reader.name, "via_kiosk": kiosk.name})
    else:
        after = {"site_id": reader.site_id,
                 "initiative_id": reader.current_initiative_id,
                 "via_kiosk": kiosk.name}
        if (before["site_id"], before["initiative_id"]) != (
                after["site_id"], after["initiative_id"]):
            j = lambda v: str(v) if isinstance(v, uuid.UUID) else v  # noqa: E731
            audit(db, actor_id=actor_id, entity_type="device",
                  entity_id=str(reader.id), action="reader_reassigned",
                  changes={k: {"from": j(before[k]), "to": j(after[k])}
                           for k in ("site_id", "initiative_id", "via_kiosk")})
    return reader
