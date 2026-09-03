"""Admin controls (read-only maintenance mode, worker pause, broadcast
banner) — the `admin` system_config section, read with defaults so a
missing row means "everything off". Kept tiny and import-light: the auth
dependency (api/deps.py) and every worker loop call into it."""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.system.config_store import read_section

logger = logging.getLogger(__name__)

SECTION = "admin"


async def read_admin_config(db: AsyncSession) -> dict:
    return await read_section(db, SECTION)


async def workers_paused(sessionmaker) -> bool:
    """True only while read-only mode is on AND the pause sub-toggle is set."""
    async with sessionmaker() as db:
        cfg = await read_admin_config(db)
    return bool(cfg["read_only"] and cfg["pause_workers"])


async def poll_workers_paused(sessionmaker, state: dict) -> bool:
    """`workers_paused()` for the worker loops: a DB blip must never kill
    the host process (same rule as registry.heartbeat_loop). On error,
    treat as "not paused", log the failure once per outage (the next
    successful read re-arms the warning) and carry on."""
    try:
        paused = await workers_paused(sessionmaker)
    except Exception:
        if not state.get("pause_check_failed"):
            logger.warning("could not read admin config for the pause "
                           "check — assuming not paused", exc_info=True)
        state["pause_check_failed"] = True
        return False
    state["pause_check_failed"] = False
    return paused
