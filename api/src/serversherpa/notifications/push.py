"""Push delivery for in-app notifications: decides whether a notification that
`notify()` just wrote also goes to the person's phone, queues it in the push
outbox and records the decision in the delivery log. Adds to the caller's
session — never commits.

The decision is one function, `decide_push()`, shared by `maybe_push()` and the
read-only Check delivery tool so the two cannot drift (the same shape as
email.decide_email). Its checks run in a fixed order and the first that fails
names the reason: push_not_set_up, unregistered_kind, security_category,
category_off (Inbox off), category_no_push, recipient_inactive, not_admin,
no_phone, quiet_hours. A critical kind skips quiet hours and days off only.

Logs carry ids and codes only: never a registration token or the push key.

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import resolve_access
from serversherpa.config import get_settings
from serversherpa.db.models import Device, Notification, PushOutbox, PushRegistration
from serversherpa.notifications.company import CompanySettings, is_critical
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.email import (
    Contact,
    EffectiveSwitches,
    _kind_name,
    contact_schedule,
    effective_switches,
)
from serversherpa.notifications.kinds import KindInfo
from serversherpa.notifications.schedule import state_at
from serversherpa.push.fcm import b64_account_valid
from serversherpa.services.biometric import shared_station

# How long the phone's Snooze action waits before the notification pushes again.
SNOOZE = timedelta(minutes=5)


@dataclass(frozen=True)
class PushDecision:
    """Whether one notification is pushed to the person's phones now, and why
    not. `reason` is the not-queued code (None when queued), `phones` how many
    live phones the person has (0 until the decision reached that check),
    `critical` whether the kind skipped quiet hours, and `switches` the
    recipient's effective switches."""
    queue: bool
    reason: str | None
    phones: int
    critical: bool
    switches: EffectiveSwitches


def _now() -> datetime:
    """The clock for push decisions (a seam for tests)."""
    return datetime.now(UTC)


def push_enabled() -> bool:
    """Whether the server has a push key configured (SS_FCM_SERVICE_ACCOUNT_FILE or
    SS_FCM_SERVICE_ACCOUNT_B64)."""
    s = get_settings()
    b64 = s.fcm_service_account_b64.get_secret_value()
    return s.fcm_service_account_file != "" or (
        b64 != "" and b64_account_valid(b64)
    )


async def live_registrations(db: AsyncSession, person_id: uuid.UUID,
                             now: datetime) -> list[PushRegistration]:
    """The person's phones that can receive a push now: a registration that
    still belongs to the device's personal owner, on a device whose sign-in has
    not expired, that is not a Zebra handheld and not a shared station."""
    rows = (await db.execute(
        select(PushRegistration, Device)
        .join(Device, Device.id == PushRegistration.device_id)
        .where(Device.personal_person_id == person_id,
               PushRegistration.person_id == person_id,
               Device.token_expires_at > now)
        .order_by(PushRegistration.created_at, PushRegistration.id))).all()
    return [registration for registration, device in rows
            if device.sub_type != "zebra" and not shared_station(device)]


async def decide_push(db: AsyncSession, person_id: uuid.UUID, info: KindInfo | None, *,
                      contact: Contact | None, company: CompanySettings,
                      now: datetime) -> PushDecision:
    """Whether a notification of kind `info` for this person is pushed to
    their phones at `now` (aware), and why not. Writes nothing."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    switches = effective_switches(info, contact, company)

    def refused(reason: str, phones: int = 0) -> PushDecision:
        return PushDecision(False, reason, phones, False, switches)

    if not push_enabled():
        return refused("push_not_set_up")
    if info is None:
        return refused("unregistered_kind")
    if info.category == "security":
        return refused("security_category")
    if not switches.inbox:
        return refused("category_off")
    if not switches.push:
        return refused("category_no_push")
    if contact is None or not contact.active:
        return refused("recipient_inactive")
    if (await resolve_access(db, person_id)).max_rank < GATE_BYPASS_RANK:
        return refused("not_admin")
    phones = len(await live_registrations(db, person_id, now))
    if phones == 0:
        return refused("no_phone")
    kind = _kind_name(info)
    critical = kind is not None and is_critical(kind, company)
    if not critical and state_at(contact_schedule(contact), now) != "open":
        return refused("quiet_hours", phones)
    return PushDecision(True, None, phones, critical, switches)


async def _drop_queued_clears(db: AsyncSession, notification: Notification) -> None:
    """Drop the `clear` rows still queued for this notification (reason
    `alerted_again`): the notification is being pushed again."""
    dropped = (await db.execute(
        update(PushOutbox)
        .where(PushOutbox.notification_id == notification.id,
               PushOutbox.message_type == "clear", PushOutbox.state == "queued")
        .values(state="dropped", last_error="alerted_again", handled_at=_now())
        .returning(PushOutbox.id))).scalars().all()
    for outbox_id in dropped:
        record(db, "push_dropped", channel="push", person_id=notification.person_id,
               notification_id=notification.id, kind=notification.kind,
               reason="alerted_again",
               detail={"push_outbox_id": str(outbox_id), "message_type": "clear"})


async def queue_push(db: AsyncSession, notification: Notification, *, reason: str,
                     send_at: datetime) -> PushOutbox:
    """Queue the one pending push for this notification, or move the one that
    is already queued to a new reason and time. Never queues a second.

    The queued row is locked (FOR UPDATE) and read fresh: when the worker is
    sending it right now this waits for the worker, and a row the worker has
    since sent or dropped no longer matches, so a new row is queued instead of
    moving one that will never send again (a lost Snooze).

    A `clear` still queued for this notification is dropped: it would remove
    the alert this push puts back on the phone."""
    await _drop_queued_clears(db, notification)
    row = await db.scalar(
        select(PushOutbox).where(
            PushOutbox.notification_id == notification.id,
            PushOutbox.message_type == "notification",
            PushOutbox.state == "queued")
        .with_for_update()
        .execution_options(populate_existing=True))
    if row is not None and row.state == "queued":
        row.reason = reason
        row.send_at = send_at
        return row
    # created_at is set here: Postgres's now() is frozen per transaction, so a
    # burst of notify() calls would share one value (see delivery_log.record).
    row = PushOutbox(notification_id=notification.id, person_id=notification.person_id,
                     send_at=send_at, reason=reason, state="queued",
                     message_type="notification", created_at=datetime.now(UTC))
    db.add(row)
    await db.flush()
    return row


async def maybe_push(db: AsyncSession, notification: Notification, *,
                     info: KindInfo | None, contact: Contact | None,
                     company: CompanySettings) -> None:
    """Queue the push now, or not, as decide_push() says. The decision lands
    in the delivery log as `push_queued`, or `push_not_queued` with the
    reason, except when push is not set up on the server at all: that would
    log one row for every notification and says nothing about this one."""
    now = _now()
    decision = await decide_push(db, notification.person_id, info, contact=contact,
                                 company=company, now=now)
    category = info.category if info else None
    if not decision.queue:
        if decision.reason == "push_not_set_up":
            return
        record(db, "push_not_queued", channel="push", person_id=notification.person_id,
               notification_id=notification.id, kind=notification.kind,
               category=category, reason=decision.reason)
        return
    row = await queue_push(db, notification, reason="new", send_at=now.astimezone(UTC))
    # notification_log's outbox column points at the email outbox, so the push
    # row's id goes in the detail.
    detail = {"phones": decision.phones, "push_outbox_id": str(row.id)}
    if decision.critical:
        detail["critical"] = True
    record(db, "push_queued", channel="push", person_id=notification.person_id,
           notification_id=notification.id, kind=notification.kind,
           category=category, detail=detail)


async def snooze(db: AsyncSession, notification: Notification, *, now: datetime) -> datetime:
    """Push this notification again in SNOOZE: set `push_snoozed_until`, move
    the one queued notification row to reason "snooze" at now + SNOOZE (a
    second snooze restarts the wait) and log `push_snoozed`. Returns the
    until time. A read or hidden notification can't be snoozed: ValueError
    ("not_live")."""
    if notification.read_at is not None or notification.dismissed_at is not None:
        raise ValueError("not_live")
    until = now + SNOOZE
    notification.push_snoozed_until = until
    row = await queue_push(db, notification, reason="snooze", send_at=until)
    record(db, "push_snoozed", channel="push", person_id=notification.person_id,
           notification_id=notification.id, kind=notification.kind,
           detail={"push_outbox_id": str(row.id), "until": until.isoformat()})
    return until


async def on_read_or_hidden(db: AsyncSession, notification_ids: list[uuid.UUID],
                            person_id: uuid.UUID) -> None:
    """These notifications were just read or hidden: cancel any push still
    queued for them (state dropped, reason "read"), end their snooze, and, when
    push is set up and the person has a live phone, queue one `clear` message
    each so the phone removes the shade entry. Cheap when nothing is queued
    and push is not set up: one UPDATE ... RETURNING, plus one for snoozes."""
    ids = list(dict.fromkeys(notification_ids))
    if not ids:
        return
    now = _now()
    cancelled = (await db.execute(
        update(PushOutbox)
        .where(PushOutbox.notification_id.in_(ids), PushOutbox.state == "queued",
               PushOutbox.message_type == "notification")
        .values(state="dropped", last_error="read", handled_at=now)
        .returning(PushOutbox.id, PushOutbox.notification_id))).all()
    for outbox_id, notification_id in cancelled:
        record(db, "push_dropped", channel="push", person_id=person_id,
               notification_id=notification_id, reason="read",
               detail={"push_outbox_id": str(outbox_id)})
    if cancelled:
        await db.execute(
            update(Notification)
            .where(Notification.id.in_([n for _, n in cancelled]),
                   Notification.push_snoozed_until.is_not(None))
            .values(push_snoozed_until=None))
    if not push_enabled():
        return
    if not await live_registrations(db, person_id, now):
        return
    already = set(await db.scalars(select(PushOutbox.notification_id).where(
        PushOutbox.notification_id.in_(ids), PushOutbox.message_type == "clear",
        PushOutbox.state == "queued")))
    for notification_id in ids:
        if notification_id in already:
            continue
        row = PushOutbox(notification_id=notification_id, person_id=person_id,
                         send_at=now, reason="clear", state="queued",
                         message_type="clear", created_at=datetime.now(UTC))
        db.add(row)
        await db.flush()
        record(db, "push_queued", channel="push", person_id=person_id,
               notification_id=notification_id, reason="clear",
               detail={"push_outbox_id": str(row.id), "message_type": "clear"})


async def on_rows_read(db: AsyncSession, rows) -> None:
    """on_read_or_hidden() for (notification id, person id) pairs, such as
    the rows of a bulk UPDATE ... RETURNING: grouped by person."""
    by_person: dict[uuid.UUID, list[uuid.UUID]] = {}
    for notification_id, person_id in rows:
        by_person.setdefault(person_id, []).append(notification_id)
    for person_id, ids in by_person.items():
        await on_read_or_hidden(db, ids, person_id)
