"""Devices — the scanning-hardware fleet registry's read + delete
surface. The self-registration endpoint (pre-shared-token auth, upsert
by serial, doubles as the heartbeat) is deferred; nothing here may
block that shape. Hard delete, audited."""

import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import DeviceItem
from serversherpa.db.models import Device, Site
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
    query = (select(Device, Site.name)
             .outerjoin(Site, Device.site_id == Site.id)
             .order_by(Device.registered_at.desc(), Device.id))
    if device_type is not None:
        query = query.where(Device.device_type == device_type)
    rows = (await db.execute(query)).all()
    return [{
        "id": d.id, "device_type": d.device_type, "name": d.name,
        "serial": d.serial, "mac": d.mac,
        "site_id": d.site_id, "site_name": site_name,
        "wan_ip": d.wan_ip, "lan_ip": d.lan_ip,
        "uptime_seconds": d.uptime_seconds,
        "last_seen_at": d.last_seen_at, "raw_info": d.raw_info,
        "registered_at": d.registered_at,
    } for d, site_name in rows]


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
