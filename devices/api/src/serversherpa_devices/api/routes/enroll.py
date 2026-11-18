"""Add this iPhone. `router` (under /api) makes the link for a signed-in
person; `public_router` (at the app root) serves the .mobileconfig to
Safari and takes iOS's signed answer. Neither public route has a session:
the single-use token in the path is the only credential."""

import datetime as dt
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response
from pydantic import BaseModel, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import catalog, enroll
from serversherpa_devices.auth.deps import client_ip, require
from serversherpa_devices.auth.main_api import MainApiClient, Principal, get_main_api
from serversherpa_devices.config import get_settings
from serversherpa_devices.db.engine import get_db

router = APIRouter(tags=["enroll"])
public_router = APIRouter(prefix="/enroll", tags=["enroll"], include_in_schema=False)

Db = Annotated[AsyncSession, Depends(get_db)]
MainApi = Annotated[MainApiClient, Depends(get_main_api)]

EXPIRED_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Link expired</title>
</head>
<body style="font-family: -apple-system, system-ui, sans-serif; margin: 2rem 1rem;">
<p>This link has expired. Go back to Devices and tap Add this iPhone again.</p>
</body>
</html>
"""


class EnrollIn(BaseModel):
    device_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                                  max_length=60)]


class EnrollOut(BaseModel):
    url: str


def _expired() -> HTMLResponse:
    return HTMLResponse(EXPIRED_PAGE, status_code=410, headers={"Cache-Control": "no-store"})


def _unreadable() -> PlainTextResponse:
    return PlainTextResponse("This iPhone's answer couldn't be read.", status_code=400)


@router.post("/enroll", response_model=EnrollOut)
async def create_link(body: EnrollIn, db: Db,
                      principal: Annotated[Principal, Depends(require("view"))]):
    token, row = enroll.make_token(person_id=principal.person_id,
                                   person_name=principal.display_name,
                                   device_name=body.device_name)
    db.add(row)
    await db.commit()
    return {"url": f"/enroll/{token}.mobileconfig"}


@public_router.get("/{token}.mobileconfig")
async def get_mobileconfig(token: str, db: Db):
    if await enroll.live_token(db, token) is None:
        return _expired()
    return Response(
        enroll.mobileconfig(public_url=get_settings().public_url, token=token),
        media_type="application/x-apple-aspen-config",
        headers={"Content-Disposition": 'attachment; filename="add-this-iphone.mobileconfig"',
                 "Cache-Control": "no-store"})


@public_router.post("/{token}/callback")
async def callback(token: str, request: Request, db: Db, main_api: MainApi):
    try:
        answer = enroll.read_answer(await request.body())
    except enroll.EnrollError:
        return _unreadable()
    if answer.challenge is not None and answer.challenge != token:
        return _unreadable()

    # Locked: a second callback with this token waits, then finds it used.
    row = await enroll.live_token(db, token, lock=True)
    if row is None:
        await db.rollback()
        return _expired()
    device, changes = await enroll.record_device(db, row, answer)
    row.used_at = dt.datetime.now(dt.UTC)
    await catalog.queue_job(db, "register_device", {"device_id": str(device.id)})
    await db.commit()

    await main_api.audit(actor=row.person_id, entity_type="appdist_device",
                         entity_id=str(device.id), action="add", changes=changes,
                         ip=client_ip(request))
    public_url = get_settings().public_url.rstrip("/")
    return RedirectResponse(f"{public_url}/?added={device.id}", status_code=301)
