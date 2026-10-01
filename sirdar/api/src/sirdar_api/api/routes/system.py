from fastapi import APIRouter
from sqlalchemy import func, select

from sirdar_api.api.deps import DbSession
from sirdar_api.api.schemas import SystemStatusOut
from sirdar_api.db.models import User

router = APIRouter(tags=["system"])


@router.get("/system/status", response_model=SystemStatusOut)
async def system_status(db: DbSession):
    """Public: the shared Login reads banners from here; needs_setup tells
    the Sirdar login page to show the first-run instructions."""
    count = await db.scalar(select(func.count()).select_from(User))
    return SystemStatusOut(needs_setup=count == 0)
