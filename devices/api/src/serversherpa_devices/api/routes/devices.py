"""The Devices page: the iPhones added for Ad Hoc installs, the Apple team's
device count per class, and disabling an iPhone. No answer, URL, log line
or audit row carries a UDID."""

import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import catalog
from serversherpa_devices.api.routes import api_error
from serversherpa_devices.apple.settings import is_configured
from serversherpa_devices.auth.deps import client_ip, require
from serversherpa_devices.auth.main_api import MainApiClient, Principal, get_main_api
from serversherpa_devices.db.engine import get_db
from serversherpa_devices.db.models import AppleDeviceCount, AppleSettings, IosDevice, Job

router = APIRouter(tags=["devices"])

Db = Annotated[AsyncSession, Depends(get_db)]
MainApi = Annotated[MainApiClient, Depends(get_main_api)]
# Counts older than this are checked with Apple again when the page loads.
COUNTS_FRESH_FOR = dt.timedelta(minutes=1)


class DeviceOut(BaseModel):
    id: uuid.UUID
    name: str
    product: str
    os_version: str
    added_by_name: str
    added_at: dt.datetime
    status: str
    error: str | None


class CountOut(BaseModel):
    device_class: str
    count: int
    synced_at: dt.datetime


class DevicesOut(BaseModel):
    devices: list[DeviceOut]
    counts: list[CountOut]


def _device_out(device: IosDevice) -> DeviceOut:
    return DeviceOut.model_validate(device, from_attributes=True)


async def _queue_sync_if_stale(db: AsyncSession, counts: list[AppleDeviceCount]) -> None:
    """One sync_devices job when the counts are old (or were never taken)
    and Apple is set up; none while one is already waiting or running."""
    if not is_configured(await db.get(AppleSettings, 1)):
        return
    last = max((c.synced_at for c in counts), default=None)
    if last is not None and dt.datetime.now(dt.UTC) - last <= COUNTS_FRESH_FOR:
        return
    pending = await db.scalar(select(func.count()).select_from(Job).where(
        Job.kind == "sync_devices", Job.status.in_(("queued", "running"))))
    if pending:
        return
    await catalog.enqueue(db, "sync_devices", {})
    await db.commit()


@router.get("/devices", response_model=DevicesOut)
async def list_devices(db: Db, _: Annotated[Principal, Depends(require("view"))]):
    devices = (await db.scalars(
        select(IosDevice).order_by(IosDevice.added_at.desc(), IosDevice.name))).all()
    counts = list((await db.scalars(
        select(AppleDeviceCount)
        .order_by(AppleDeviceCount.device_class != "IPHONE", AppleDeviceCount.device_class))).all())
    out = {"devices": [_device_out(d) for d in devices],
           "counts": [CountOut.model_validate(c, from_attributes=True) for c in counts]}
    await _queue_sync_if_stale(db, counts)
    return out


@router.post("/devices/{device_id}/disable", response_model=DeviceOut)
async def disable_device(device_id: uuid.UUID, request: Request, db: Db, main_api: MainApi,
                         principal: Annotated[Principal, Depends(require("delete"))]):
    device = await db.scalar(select(IosDevice).where(IosDevice.id == device_id)
                             .with_for_update())
    if device is None:
        raise api_error(404, "not_found", "That iPhone isn't on the list.")
    if device.status == "disabled":
        return _device_out(device)
    before = device.status
    # It stops installing now; the worker disables it at Apple and rebuilds
    # the profiles without it.
    device.status = "disabled"
    await catalog.enqueue(db, "disable_device", {"device_id": str(device.id)})
    out = _device_out(device)
    await db.commit()
    await main_api.audit(actor=principal.person_id, entity_type="appdist_device",
                         entity_id=str(device_id), action="disable",
                         changes={"status": {"from": before, "to": "disabled"}},
                         ip=client_ip(request))
    return out
