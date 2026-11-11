"""Dashboard overview. Never carries the DigitalOcean token. The
Environments page (gated on deploy) shows the same environment cards, so
deploy:view reads them too, without the infrastructure tree or demo data
(those stay dashboard:view's)."""

from fastapi import APIRouter, HTTPException, Query

from sirdar_api.api.deps import CurrentUser, DbSession
from sirdar_api.config import get_settings
from sirdar_api.dashboard.service import build_dashboard

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("")
async def get_dashboard(db: DbSession, actor: CurrentUser, demo: bool = Query(default=False),
                        refresh: bool = Query(default=False)):
    full = actor.access.can("dashboard", "view")
    if not full and not actor.access.can("deploy", "view"):
        raise HTTPException(status_code=403, detail={"code": "forbidden"})
    data = await build_dashboard(get_settings(), db=db, demo=demo and full, refresh=refresh)
    if not full:
        data["infrastructure"] = {"source": "none", "error": None, "tree": [], "accounts": []}
    return data
