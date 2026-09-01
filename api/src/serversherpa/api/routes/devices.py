"""Devices — the scanning-hardware fleet registry's read + delete
surface. The self-registration endpoint (pre-shared-token auth, upsert
by serial, doubles as the heartbeat) is deferred; nothing here may
block that shape. Hard delete, audited."""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import DeviceItem, DeviceLeaseItem
from serversherpa.db.models import (
    Device, DeviceDhcpLease, ProcessedScan, RawScan, Site, StatusValue,
)
from serversherpa.services.audit import audit

router = APIRouter(prefix="/devices", tags=["devices"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


@router.get("", response_model=list[DeviceItem])
async def list_devices(
    db: DbSession,
    actor: AuthContext = require_permission("scanning_hardware", "view"),
    device_type: str | None = None,
) -> list[dict]:
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
    query = (select(Device, Site.name, up_counts.c.connected,
                    StatusValue.label, StatusValue.color,
                    raw_24h.c.n, proc_24h.c.n)
             .outerjoin(Site, Device.site_id == Site.id)
             .outerjoin(up_counts, up_counts.c.device_id == Device.id)
             .outerjoin(StatusValue,
                        (StatusValue.record_type == "asset")
                        & (StatusValue.key == Device.scan_status))
             .outerjoin(raw_24h, raw_24h.c.device_id == Device.name)
             .outerjoin(proc_24h, proc_24h.c.device_id == Device.name)
             .order_by(Device.registered_at.desc(), Device.id))
    if device_type is not None:
        query = query.where(Device.device_type == device_type)
    rows = (await db.execute(query)).all()
    return [{
        "id": d.id, "device_type": d.device_type, "name": d.name,
        "serial": d.serial, "mac": d.mac,
        "site_id": d.site_id, "site_name": site_name,
        "wan_ip": d.wan_ip, "lan_ip": d.lan_ip,
        "model": d.model,
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
    } for d, site_name, connected, ss_label, ss_color, raw_n, proc_n in rows]


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
