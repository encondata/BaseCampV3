"""Dashboard overview. Never carries the DigitalOcean token."""

from fastapi import APIRouter, Query

from sirdar_api.api.deps import AuthContext, require_permission
from sirdar_api.config import get_settings
from sirdar_api.dashboard.service import build_dashboard

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("")
async def get_dashboard(demo: bool = Query(default=False), refresh: bool = Query(default=False),
                        actor: AuthContext = require_permission("dashboard", "view")):
    return await build_dashboard(get_settings(), demo=demo, refresh=refresh)
