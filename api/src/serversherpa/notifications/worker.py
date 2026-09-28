"""The notification-worker loop — a separate process from the API
(`serversherpa notification-worker`). Today it runs the password-expiry
reminder sweep once an hour (notifications/password_reminders.py) and
logs a status line; the delivery pipeline (email, quiet hours, DND) is a
later task. Other DB touches are the heartbeat upsert, log writes and
read-only count queries."""

import asyncio
import logging
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import NotificationGroup, NotificationGroupMember
from serversherpa.notifications.password_reminders import run_reminders_once

logger = logging.getLogger("serversherpa.notifications.worker")
IDLE_LOG_SECONDS = 900   # one INFO status line every 15 min
REMINDER_INTERVAL_SECONDS = 3600


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
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("notification-worker")
    pause_state = {"paused": False}
    check_state = {}
    heartbeat = start_heartbeat("notification-worker", "worker",
                                meta_fn=lambda: dict(pause_state))

    logger.info("notification worker online — hourly password expiry "
                "reminders; no delivery pipeline yet")

    maker = get_sessionmaker()
    try:
        # monotonic()'s reference point is undefined — seed one full
        # interval in the past so the first loop iteration always logs.
        last_log = time.monotonic() - IDLE_LOG_SECONDS
        last_reminders = time.monotonic() - REMINDER_INTERVAL_SECONDS
        while True:
            # read-only mode's "also pause background services": idle (still
            # heart-beating as paused) until the flag clears — no work lost
            if await poll_workers_paused(maker, check_state):
                if not pause_state["paused"]:
                    logger.info("paused by read-only maintenance mode")
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            if pause_state["paused"]:
                logger.info("resumed")
            pause_state["paused"] = False
            now = time.monotonic()
            if now - last_reminders >= REMINDER_INTERVAL_SECONDS:
                sent = await run_reminders_once(maker)
                if sent:
                    logger.info("sent %d password expiry reminder(s)", sent)
                last_reminders = now
            if now - last_log >= IDLE_LOG_SECONDS:
                await run_once(maker)
                last_log = now
            await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
