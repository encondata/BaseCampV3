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
from datetime import UTC, datetime

from sqlalchemy import select
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
from serversherpa.services.biometric import shared_station


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
    """Whether the server has a push key configured (SS_FCM_SERVICE_ACCOUNT_FILE)."""
    return get_settings().fcm_service_account_file != ""


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


async def queue_push(db: AsyncSession, notification: Notification, *, reason: str,
                     send_at: datetime) -> PushOutbox:
    """Queue the one pending push for this notification, or move the one that
    is already queued to a new reason and time. Never queues a second."""
    row = await db.scalar(select(PushOutbox).where(
        PushOutbox.notification_id == notification.id,
        PushOutbox.message_type == "notification",
        PushOutbox.state == "queued"))
    if row is not None:
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
    """Queue the push now, or not, as decide_push() says. Either way the
    decision lands in the delivery log: `push_queued` or `push_not_queued`
    with the reason."""
    now = _now()
    decision = await decide_push(db, notification.person_id, info, contact=contact,
                                 company=company, now=now)
    category = info.category if info else None
    if not decision.queue:
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
