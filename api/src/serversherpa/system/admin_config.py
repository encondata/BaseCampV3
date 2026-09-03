"""Admin controls (read-only maintenance mode, worker pause, broadcast
banner) — the `admin` system_config section, read with defaults so a
missing row means "everything off". Kept tiny and import-light: the auth
dependency (api/deps.py) and every worker loop call into it."""

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.system.config_store import read_section

SECTION = "admin"


async def read_admin_config(db: AsyncSession) -> dict:
    return await read_section(db, SECTION)


async def workers_paused(sessionmaker) -> bool:
    """True only while read-only mode is on AND the pause sub-toggle is set."""
    async with sessionmaker() as db:
        cfg = await read_admin_config(db)
    return bool(cfg["read_only"] and cfg["pause_workers"])
