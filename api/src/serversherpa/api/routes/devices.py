"""Devices — the scanning-hardware fleet registry's read + delete
surface. The self-registration endpoint (pre-shared-token auth, upsert
by serial, doubles as the heartbeat) is deferred; nothing here may
block that shape. Hard delete, audited."""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    DeviceCreate, DeviceItem, DeviceLeaseItem, DevicePatch, DeviceRegisterIn,
)
from serversherpa.db.models import (
    Device, DeviceDhcpLease, Initiative, ProcessedScan, RawScan, Site,
    StatusValue,
)
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/devices", tags=["devices"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _device_query():
    up_counts = (select(DeviceDhcpLease.device_id,
                        func.count().label("connected"))
                 .where(DeviceDhcpLease.up.is_(True))
                 .group_by(DeviceDhcpLease.device_id).subquery())
    cutoff = datetime.now(UTC) - timedelta(hours=24)
    raw_24h = (select(RawScan.device_id, func.count().label("n"))
               .where(RawScan.scanned_at >= cutoff)
               .group_by(RawScan.device_id).subquery())
    proc_24h = (select(ProcessedScan.device_id, func.count().label("n"))
                .where(ProcessedScan.scanned_at >= cutoff)
                .group_by(ProcessedScan.device_id).subquery())
    return (select(Device, Site.name, up_counts.c.connected,
                   StatusValue.label, StatusValue.color,
                   raw_24h.c.n, proc_24h.c.n, Initiative.name)
            .outerjoin(Site, Device.site_id == Site.id)
            .outerjoin(up_counts, up_counts.c.device_id == Device.id)
            .outerjoin(StatusValue,
                       (StatusValue.record_type == "asset")
                       & (StatusValue.key == Device.scan_status))
            .outerjoin(raw_24h, raw_24h.c.device_id == Device.name)
            .outerjoin(proc_24h, proc_24h.c.device_id == Device.name)
            .outerjoin(Initiative,
                       Device.current_initiative_id == Initiative.id))


def _row_to_item(row) -> dict:
    (d, site_name, connected, ss_label, ss_color, raw_n, proc_n,
     initiative_name) = row
    return {
        "id": d.id, "device_type": d.device_type, "name": d.name,
        "serial": d.serial, "mac": d.mac,
        "site_id": d.site_id, "site_name": site_name,
        "wan_ip": d.wan_ip, "lan_ip": d.lan_ip,
        "model": d.model, "version": d.version,
        "sub_type": d.sub_type,
        "current_initiative_id": d.current_initiative_id,
        "current_initiative_name": initiative_name,
        "antennas_connected": d.antennas_connected,
        "connection_type": d.connection_type,
        "scan_status": d.scan_status,
        "scan_status_label": ss_label, "scan_status_color": ss_color,
        "tags_read_24h": (raw_n or 0) + (proc_n or 0),
        "vpn_status": d.vpn_status,
        "token_expires_at": d.token_expires_at,
        "connected_count": connected or 0,
        "uptime_seconds": d.uptime_seconds,
        "last_seen_at": d.last_seen_at, "raw_info": d.raw_info,
        "registered_at": d.registered_at,
    }


async def _item_for(db: DbSession, device_id: uuid.UUID) -> dict:
    """One device re-read through the same joined shape as the list."""
    row = (await db.execute(
        _device_query().where(Device.id == device_id))).one()
    return _row_to_item(row)


_PATCH_FIELDS = {"name", "sub_type", "mac", "lan_ip", "version",
                 "site_id", "current_initiative_id", "scan_status"}


async def _validate_device_values(db: DbSession, data: dict) -> None:
    if "scan_status" in data and data["scan_status"] is not None:
        keys = set((await db.scalars(select(StatusValue.key).where(
            StatusValue.record_type == "asset"))).all())
        if data["scan_status"] not in keys:
            raise _err(422, "bad_scan_status")
    if "current_initiative_id" in data \
            and data["current_initiative_id"] is not None:
        if await db.get(Initiative, data["current_initiative_id"]) is None:
            raise _err(422, "bad_initiative")


@router.get("", response_model=list[DeviceItem])
async def list_devices(
    db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "view"),
    device_type: str | None = None,
) -> list[dict]:
    query = _device_query().order_by(Device.registered_at.desc(), Device.id)
    if device_type is not None:
        query = query.where(Device.device_type == device_type)
    rows = (await db.execute(query)).all()
    return [_row_to_item(row) for row in rows]


@router.get("/{device_id}/leases", response_model=list[DeviceLeaseItem])
async def list_device_leases(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "view"),
) -> list[DeviceLeaseItem]:
    if await db.get(Device, device_id) is None:
        raise _err(404, "device_not_found")
    return (await db.scalars(
        select(DeviceDhcpLease)
        .where(DeviceDhcpLease.device_id == device_id)
        .order_by(DeviceDhcpLease.up.desc(),
                  DeviceDhcpLease.hostname.nulls_last(),
                  DeviceDhcpLease.mac))).all()


@router.post("", response_model=DeviceItem, status_code=201)
async def create_device(
    body: DeviceCreate, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "add"),
) -> dict:
    data = body.model_dump(exclude_unset=True)
    device_type = data.pop("device_type")
    vocab = set((await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "device_type"))).all())
    if device_type not in vocab:
        raise _err(422, "bad_device_type")
    unknown = set(data) - _PATCH_FIELDS
    if unknown:
        raise _err(422, "bad_field")
    await _validate_device_values(db, data)
    device = Device(device_type=device_type, **data)
    db.add(device)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="create",
          changes={k: (str(v) if v is not None else None)
                   for k, v in data.items()} | {"device_type": device_type})
    await db.commit()
    return await _item_for(db, device.id)


@router.patch("/{device_id}", response_model=DeviceItem)
async def patch_device(
    device_id: uuid.UUID, body: DevicePatch, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    data = body.model_dump(exclude_unset=True)
    unknown = set(data) - _PATCH_FIELDS
    if unknown:
        raise _err(422, "bad_field")
    if "name" in data and (data["name"] is None or not data["name"].strip()):
        raise _err(422, "bad_name")
    await _validate_device_values(db, data)
    before = snapshot(device, list(data))
    for key, value in data.items():
        setattr(device, key, value)
    device.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="update",
          changes=diff(before, snapshot(device, list(data))))
    await db.commit()
    return await _item_for(db, device.id)


@router.post("/{device_id}/register", response_model=DeviceItem)
async def register_device(
    device_id: uuid.UUID, db: DbSession,
    body: DeviceRegisterIn | None = None,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    days = 30 if body is None or body.days is None else body.days
    if not 1 <= days <= 365:
        raise _err(422, "bad_days")
    now = datetime.now(UTC)
    device.registered_at = now
    device.token_expires_at = now + timedelta(days=days)
    device.updated_at = now
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="register",
          changes={"days": days,
                   "token_expires_at": device.token_expires_at.isoformat()})
    await db.commit()
    return await _item_for(db, device.id)


@router.post("/{device_id}/deregister", response_model=DeviceItem)
async def deregister_device(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "change"),
) -> dict:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    device.token_expires_at = None
    device.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="deregister", changes={})
    await db.commit()
    return await _item_for(db, device.id)


@router.delete("/{device_id}", status_code=204)
async def delete_device(
    device_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "delete"),
) -> None:
    device = await db.get(Device, device_id)
    if device is None:
        raise _err(404, "device_not_found")
    audit(db, actor_id=actor.person.id, entity_type="device",
          entity_id=str(device.id), action="delete",
          changes={"name": device.name, "device_type": device.device_type,
                   "serial": device.serial})
    await db.delete(device)
    await db.commit()
