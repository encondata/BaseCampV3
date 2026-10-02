"""/edge/rfid/* — reader discovery for Kiosk Setup (spec §2.2)."""

from fastapi import APIRouter, Depends, Request

from edge.deps import require_session

router = APIRouter(prefix="/edge/rfid", dependencies=[Depends(require_session)])


@router.post("/scan")
async def start_scan(request: Request) -> dict:
    return {"scan_id": request.app.state.discovery.start()}


@router.get("/scan")
async def scan(request: Request) -> dict:
    return request.app.state.discovery.snapshot()
