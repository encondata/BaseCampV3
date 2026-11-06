"""The notification-worker loop — a separate process from the API
(`serversherpa notification-worker`). Each poll it delivers the email
outbox (mail/delivery.py); once an hour it runs the password-expiry
reminder sweep (notifications/password_reminders.py); every minute the
learning sweep (learning/scheduler.py: scheduled invites, reminders,
overdue notices), the project plan sweep (plans/reminders.py: due-date
reminders and the owner's overdue digest), the device check
(notifications/device_check.py: covered devices that stop checking in
are announced, except for the longest threshold after the worker starts
and after read-only mode), the asset-watch check
(notifications/asset_watch_check.py: a watched asset whose watch is due
tells its person once, and the watch ends), the event sweep
(notifications/event_sweep.py: announced events become notifications for
the people they reach) and then the summary sweep
(notifications/summary.py: email held for a person's quiet hours or day
off goes out as one summary); once a day it refreshes
Google's Android attestation revocation list
(security/attestation_status.py, retried hourly after a failure); every 15
minutes it logs a status line (how much email is held for a summary, and
whether email delivery is on). A person's schedule is applied when a
notification's email is decided (notifications/email.py): email that has
to wait is held (notifications/held.py) until the summary sweep sends it."""

import asyncio
import logging
import time
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import NotificationHeld
from serversherpa.learning.scheduler import run_learning_once
from serversherpa.mail import email_enabled
from serversherpa.mail.delivery import deliver_once
from serversherpa.notifications.asset_watch_check import run_asset_watches_once
from serversherpa.notifications.device_check import keep_quiet, run_device_check_once
from serversherpa.notifications.event_sweep import run_events_once
from serversherpa.notifications.password_reminders import run_reminders_once
from serversherpa.notifications.summary import run_summaries_once
from serversherpa.plans.reminders import run_plan_reminders_once
from serversherpa.security import attestation_status

logger = logging.getLogger("serversherpa.notifications.worker")
IDLE_LOG_SECONDS = 900   # one INFO status line every 15 min
REMINDER_INTERVAL_SECONDS = 3600
LEARNING_INTERVAL_SECONDS = 60
PLANS_INTERVAL_SECONDS = 60
DEVICE_CHECK_INTERVAL_SECONDS = 60
ASSET_WATCH_INTERVAL = 60
EVENTS_INTERVAL_SECONDS = 60
SUMMARY_INTERVAL_SECONDS = 60
ATTESTATION_STATUS_INTERVAL_SECONDS = 86_400
ATTESTATION_STATUS_RETRY_SECONDS = 3600


async def held_count(db: AsyncSession) -> int:
    """How many notification emails are held for a summary (rows of
    notification_held, whoever they wait for) — read-only."""
    return await db.scalar(select(func.count()).select_from(NotificationHeld)) or 0


async def run_once(maker) -> None:
    """One status pass: count the held email, log the idle line."""
    async with maker() as db:
        held = await held_count(db)
    logger.info(
        "idle — %d email(s) waiting for a summary; email delivery %s",
        held, "on" if email_enabled() else "off (SMTP not configured)")


async def run_attestation_refresh(maker) -> bool:
    """Refresh the cached attestation revocation list. A failure is logged and
    reported (False), never raised: the loop retries after
    ATTESTATION_STATUS_RETRY_SECONDS, and the old list stays until then."""
    try:
        async with maker() as db:
            await attestation_status.refresh_attestation_status(db)
            await db.commit()
    except Exception:
        logger.warning("could not refresh the attestation revocation list — retrying "
                       "in an hour", exc_info=True)
        return False
    return True


async def run_learning(maker, state: dict) -> None:
    """One learning sweep; a failure is logged once per outage, never raised
    (each initiative's own failures are already counted inside)."""
    try:
        out = await run_learning_once(maker)
        state["failed"] = False
    except Exception as exc:
        # the class only: the text of a DB error can carry SQL parameters
        if not state["failed"]:
            logger.warning("could not run the learning sweep — retrying (%s)",
                           type(exc).__name__)
        state["failed"] = True
        return
    if out["invites"] or out["reminders"] or out["overdue"]:
        logger.info("learning: %d invite(s), %d reminder(s), %d overdue notice(s)",
                    out["invites"], out["reminders"], out["overdue"])


async def run_plans(maker, state: dict) -> None:
    """One project plan sweep; a failure is logged once per outage, never
    raised (each plan's own failures are already counted inside)."""
    try:
        out = await run_plan_reminders_once(maker)
        state["failed"] = False
    except Exception as exc:  # noqa: BLE001 — a DB blip must never kill the loop
        # the class only: the text of a DB error can carry SQL parameters
        if not state["failed"]:
            logger.warning("could not run the plan reminder sweep — retrying (%s)",
                           type(exc).__name__)
        state["failed"] = True
        return
    if out["reminders"] or out["digests"]:
        logger.info("plans: %d reminder(s), %d overdue digest(s)",
                    out["reminders"], out["digests"])


async def run_device_check(maker, state: dict) -> None:
    """One device check; a failure is logged once per outage, never raised.
    `state` also carries the check's quiet window from one check to the next."""
    try:
        announced = await run_device_check_once(maker, state=state)
        state["failed"] = False
    except Exception as exc:  # noqa: BLE001 — the loop must never stop
        # the class only: the text of a DB error can carry SQL parameters
        if not state["failed"]:
            logger.warning("could not run the device check — retrying (%s)",
                           type(exc).__name__)
        state["failed"] = True
        return
    if announced:
        logger.info("announced %d device(s) offline", announced)


async def run_asset_watches(maker, state: dict) -> None:
    """One asset-watch check; a failure is logged once per outage, never raised."""
    try:
        ended = await run_asset_watches_once(maker)
        state["failed"] = False
    except Exception as exc:  # noqa: BLE001 — the loop must never stop
        # the class only: the text of a DB error can carry SQL parameters
        if not state["failed"]:
            logger.warning("could not run the asset-watch check — retrying (%s)",
                           type(exc).__name__)
        state["failed"] = True
        return
    if ended:
        logger.info("ended %d asset watch(es)", ended)


async def run_events(maker, state: dict) -> None:
    """One event sweep; a failure is logged once per outage, never raised
    (each event's own failure is already logged inside)."""
    try:
        written = await run_events_once(maker)
        state["failed"] = False
    except Exception as exc:  # noqa: BLE001 — the loop must never stop
        # the class only: the text of a DB error can carry SQL parameters
        if not state["failed"]:
            logger.warning("could not run the event sweep — retrying (%s)",
                           type(exc).__name__)
        state["failed"] = True
        return
    if written:
        logger.info("wrote %d notification(s) from events", written)


async def run_summaries(maker, state: dict) -> None:
    """One summary sweep; a failure is logged once per outage, never raised
    (each person's own failure is already logged inside)."""
    try:
        queued = await run_summaries_once(maker)
        state["failed"] = False
    except Exception as exc:  # noqa: BLE001 — the loop must never stop
        # the class only: the text of a DB error can carry SQL parameters
        if not state["failed"]:
            logger.warning("could not run the summary sweep — retrying (%s)",
                           type(exc).__name__)
        state["failed"] = True
        return
    if queued:
        logger.info("queued %d notification summary email(s)", queued)


async def run_forever(poll_seconds: float = 5.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("notification-worker")
    pause_state = {"paused": False}
    check_state = {}
    deliver_state = {"failed": False}
    learning_state = {"failed": False}
    plans_state = {"failed": False}
    devices_state = {"failed": False}
    asset_watches_state = {"failed": False}
    events_state = {"failed": False}
    summary_state = {"failed": False}
    heartbeat = start_heartbeat("notification-worker", "worker",
                                meta_fn=lambda: dict(pause_state))

    logger.info("notification worker online — email outbox every %.0fs, hourly "
                "password expiry reminders, learning, plan, event and summary sweeps "
                "and the device and asset-watch checks every minute, daily attestation "
                "revocation list", poll_seconds)

    maker = get_sessionmaker()
    try:
        # monotonic()'s reference point is undefined — seed one full
        # interval in the past so the first loop iteration always logs.
        last_log = time.monotonic() - IDLE_LOG_SECONDS
        last_reminders = time.monotonic() - REMINDER_INTERVAL_SECONDS
        last_learning = time.monotonic() - LEARNING_INTERVAL_SECONDS
        last_plans = time.monotonic() - PLANS_INTERVAL_SECONDS
        last_devices = time.monotonic() - DEVICE_CHECK_INTERVAL_SECONDS
        last_asset_watches = time.monotonic() - ASSET_WATCH_INTERVAL
        last_events = time.monotonic() - EVENTS_INTERVAL_SECONDS
        last_summaries = time.monotonic() - SUMMARY_INTERVAL_SECONDS
        last_attestation = time.monotonic() - ATTESTATION_STATUS_INTERVAL_SECONDS
        # The device check's quiet window lives in this process, so a worker that has just
        # started can't tell whether read-only mode ended a moment ago: keep the check quiet for
        # the longest threshold from now, as after a pause. Clearing still runs meanwhile.
        keep_quiet(devices_state, datetime.now(UTC))
        while True:
            # read-only mode's "also pause background services": idle (still
            # heart-beating as paused) until the flag clears — no work lost
            if await poll_workers_paused(maker, check_state):
                if not pause_state["paused"]:
                    logger.info("paused by read-only maintenance mode")
                pause_state["paused"] = True
                # The device check doesn't run while paused, so it can't see read-only mode
                # for itself: keep it quiet for a while after the pause, as it would.
                keep_quiet(devices_state, datetime.now(UTC))
                await asyncio.sleep(poll_seconds)
                continue
            if pause_state["paused"]:
                logger.info("resumed")
            pause_state["paused"] = False
            try:
                await deliver_once(maker)
                deliver_state["failed"] = False
            except Exception:
                # a DB blip must never kill the loop: log once per outage
                if not deliver_state["failed"]:
                    logger.warning("could not deliver the email outbox — retrying",
                                   exc_info=True)
                deliver_state["failed"] = True
            now = time.monotonic()
            if now - last_reminders >= REMINDER_INTERVAL_SECONDS:
                sent = await run_reminders_once(maker)
                if sent:
                    logger.info("sent %d password expiry reminder(s)", sent)
                last_reminders = now
            if now - last_learning >= LEARNING_INTERVAL_SECONDS:
                await run_learning(maker, learning_state)
                last_learning = now
            if now - last_plans >= PLANS_INTERVAL_SECONDS:
                await run_plans(maker, plans_state)
                last_plans = now
            # before the event sweep, so what it announces goes out this tick
            if now - last_devices >= DEVICE_CHECK_INTERVAL_SECONDS:
                await run_device_check(maker, devices_state)
                last_devices = now
            # before the summaries too, so an email it holds can join a summary due now
            if now - last_asset_watches >= ASSET_WATCH_INTERVAL:
                await run_asset_watches(maker, asset_watches_state)
                last_asset_watches = now
            # before the summaries, so an email it holds can join a summary due now
            if now - last_events >= EVENTS_INTERVAL_SECONDS:
                await run_events(maker, events_state)
                last_events = now
            if now - last_summaries >= SUMMARY_INTERVAL_SECONDS:
                await run_summaries(maker, summary_state)
                last_summaries = now
            if now - last_attestation >= ATTESTATION_STATUS_INTERVAL_SECONDS:
                if await run_attestation_refresh(maker):
                    last_attestation = now
                else:
                    last_attestation = (now - ATTESTATION_STATUS_INTERVAL_SECONDS
                                        + ATTESTATION_STATUS_RETRY_SECONDS)
            if now - last_log >= IDLE_LOG_SECONDS:
                await run_once(maker)
                last_log = now
            await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
