"""The notification-worker loop — a separate process from the API
(`serversherpa notification-worker`). PLACEHOLDER ONLY: heartbeat +
periodic status logs. It does not read or mutate any notification
delivery state; the only DB touches are the heartbeat upsert, log
writes, and read-only count queries for the status line. The
actual delivery pipeline (channel dispatch, quiet hours, DND) is a
later task."""

import asyncio
import logging
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import NotificationGroup, NotificationGroupMember

logger = logging.getLogger("serversherpa.notifications.worker")
IDLE_LOG_SECONDS = 900   # one INFO status line every 15 min


async def status_counts(db: AsyncSession) -> tuple[int, int]:
    """(enabled_group_count, member_count_across_enabled_groups) —
    read-only."""
    group_count = await db.scalar(
        select(func.count()).select_from(NotificationGroup)
        .where(NotificationGroup.enabled.is_(True)))
    member_count = await db.scalar(
        select(func.count()).select_from(NotificationGroupMember)
        .join(NotificationGroup,
              NotificationGroupMember.group_id == NotificationGroup.id)
        .where(NotificationGroup.enabled.is_(True)))
    return group_count or 0, member_count or 0


async def run_once(maker) -> None:
    """One status pass: query counts, log the idle line."""
    async with maker() as db:
        groups, members = await status_counts(db)
    logger.info(
        "idle — %d enabled group(s), %d member(s); "
        "delivery pipeline not implemented", groups, members)


async def run_forever(poll_seconds: float = 5.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("notification-worker")
    heartbeat = start_heartbeat("notification-worker", "worker")

    logger.info("notification worker online — placeholder: "
                "status/logs only, no delivery yet")

    maker = get_sessionmaker()
    try:
        # monotonic()'s reference point is undefined — seed one full
        # interval in the past so the first loop iteration always logs.
        last_log = time.monotonic() - IDLE_LOG_SECONDS
        while True:
            now = time.monotonic()
            if now - last_log >= IDLE_LOG_SECONDS:
                await run_once(maker)
                last_log = now
            await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
