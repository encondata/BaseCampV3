from fastapi import APIRouter

from sirdar_api.api.deps import AuthContext, require_permission
from sirdar_api.config import get_settings

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
async def read_settings(actor: AuthContext = require_permission("settings", "view")):
    s = get_settings()
    return {"env": s.env, "source_configured": s.source_database_url is not None,
            "session_ttl_seconds": s.session_ttl_seconds,
            "access_token_ttl_seconds": s.access_token_ttl_seconds,
            "max_failed_logins": s.max_failed_logins, "lockout_seconds": s.lockout_seconds}
