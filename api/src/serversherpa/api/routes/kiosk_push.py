"""The app's "This is my phone" switch and its push registration.

With the signed-in kiosk session, always on the caller's own phone (the
device the session is bound to, kiosk.own_device; never one named in the
request):
- `GET /kiosk/personal`: the Settings screen's state.
- `PUT /kiosk/personal` `{on}`: any admin (rank 60+) may claim a phone nobody
  owns; only its owner turns it off. Only a super admin, on the portal, takes
  a phone from its owner (PUT /devices/{id}/personal). Every change revokes
  the device's biometric keys (`reassigned`), deletes its push registration
  and is audited (`personal_set` / `personal_cleared`, `source: kiosk`).
- `POST /kiosk/push/registration` `{token}`: create or replace the phone's
  registration; returns its new push key, once.
- `DELETE /kiosk/push/registration`: the owner removes it.

With the push key instead of a session (`Authorization: PushKey
<registration id>.<key>`, the push_registration dependency):
- `PUT /kiosk/push/registration/token` `{token}`: FCM rotated the token while
  nobody was signed in. Read-only mode refuses it (423), like the station-key
  writes.

A wrong, unknown or dead key is one flat 401 `push_key_invalid`; refused
keys are capped per address (rate_limit_ip). The key and the token are never
logged.

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md
(decisions 4 and 14, "API: endpoints"). Registrations and keys:
services/push_registrations.py."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.api.deps import (
    AuthContext,
    DbSession,
    client_ip,
    enforce_read_only_config,
    rate_limit_ip,
    require_permission,
)
from serversherpa.api.routes.auth import RESET_WINDOW_SECONDS
from serversherpa.api.routes.kiosk import _inet_or_none, own_device
from serversherpa.api.schemas import NotificationInboxItemOut, NotificationInboxOut
from serversherpa.config import get_settings
from serversherpa.db.models import Device, Notification, Person, PushRegistration
from serversherpa.notifications import inbox_ops, push
from serversherpa.notifications.kinds import kind_info
from serversherpa.notifications.live import signal_inbox
from serversherpa.services import biometric, push_registrations
from serversherpa.services.audit import audit
from serversherpa.wiki.share_links import IpRateLimiter

router = APIRouter(prefix="/kiosk", tags=["kiosk"])

# Per-process, per-address (rate_limit_ip, /64 for IPv6) cap on refused push
# keys, with the guessed-secret limit and window of the password-reset checks
# (the kiosk override cap's numbers). A slot is reserved before the check and
# given back when the key is good, so only refusals count.
push_key_limiter = IpRateLimiter(
    limit=get_settings().password_reset_confirm_rate_limit, window_seconds=RESET_WINDOW_SECONDS)

# FCM registration tokens run to a few hundred characters
TOKEN_MAX_LENGTH = 4096


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _push_key_invalid() -> HTTPException:
    return HTTPException(status_code=401, detail={"code": "push_key_invalid"},
                         headers={"WWW-Authenticate": push_registrations.SCHEME})


def _refused(reason: str) -> HTTPException:
    return _err(422, "not_eligible", reason=reason)


class KioskPersonalIn(BaseModel):
    """PUT /kiosk/personal: "This is my phone" on or off."""

    on: bool


class KioskPersonalOut(BaseModel):
    """`on`: the phone is the caller's. `owner_name`: whoever owns it."""

    on: bool
    owner_name: str | None


class KioskPersonalStateOut(KioskPersonalOut):
    """GET /kiosk/personal, for the Settings screen. `push_registered`: the
    phone has a push registration of the caller's."""

    push_registered: bool


class KioskPushTokenIn(BaseModel):
    token: str = Field(min_length=1, max_length=TOKEN_MAX_LENGTH)


class KioskPushRegistrationOut(BaseModel):
    """The push key is shown this once; only its sha256 is kept."""

    registration_id: str
    push_key: str


async def push_registration(request: Request, db: DbSession) -> PushRegistration:
    """The live registration the request's `Authorization: PushKey
    <registration id>.<key>` proves (push_registrations.verify_key). No
    session is read. Anything else is one 401 `push_key_invalid`; over the
    per-address cap on refused keys, 429 `rate_limited` before any check."""
    bucket = rate_limit_ip(request)
    window = push_key_limiter.reserve(bucket)
    if window is None:
        raise _err(429, "rate_limited")
    registration = await push_registrations.verify_key(
        db, request.headers.get("authorization") or "")
    if registration is None:
        raise _push_key_invalid()
    push_key_limiter.release(bucket, window)
    return registration


async def _owner_name(db: DbSession, device: Device) -> str | None:
    if device.personal_person_id is None:
        return None
    person = await db.get(Person, device.personal_person_id)
    return person.display_name if person else None


async def _personal_out(db: DbSession, actor: AuthContext, device: Device) -> dict:
    return {"on": device.personal_person_id == actor.person.id,
            "owner_name": await _owner_name(db, device)}


def _claim_refusal(actor: AuthContext, device: Device) -> str | None:
    """Why the caller can't claim this phone from the app, or None. The
    portal's rule (push_registrations.refusal_for, shared stations, a known
    platform) plus rank 60+, no Zebra, and nobody owning it yet."""
    if actor.access.max_rank < GATE_BYPASS_RANK:
        return "not_admin"
    if device.sub_type == "zebra":
        return "zebra"
    if biometric.shared_station(device):
        return "shared_station"
    if biometric.platform_family(device.sub_type) is None:
        return "platform_unknown"
    if device.personal_person_id is not None:
        return "owned_by_other"
    return push_registrations.refusal_for(actor.person, actor.account, actor.access)


@router.get("/personal", response_model=KioskPersonalStateOut)
async def get_personal(
    db: DbSession, actor: AuthContext = require_permission("kiosk", "view"),
) -> dict:
    device = await own_device(db, actor)
    registered = await db.scalar(select(PushRegistration.id).where(
        PushRegistration.device_id == device.id,
        PushRegistration.person_id == actor.person.id))
    return {**await _personal_out(db, actor, device), "push_registered": registered is not None}


@router.put("/personal", response_model=KioskPersonalOut)
async def put_personal(
    body: KioskPersonalIn, request: Request, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> dict:
    """The "This is my phone" switch. Refusals are 422 `not_eligible` with a `reason`:
    not_admin, zebra, shared_station, platform_unknown, owned_by_other or
    the portal rule's codes on; not_owner off. On for the owner and off on a
    phone nobody owns change nothing."""
    device = await own_device(db, actor, lock=True)
    me, before = actor.person.id, device.personal_person_id
    after = me if body.on else None
    if after == before:
        await db.commit()                      # nothing to change; ends the lock
        return await _personal_out(db, actor, device)
    reason = _claim_refusal(actor, device) if body.on else (
        "not_owner" if before != me else None)
    if reason is not None:
        await db.rollback()
        raise _refused(reason)
    now = datetime.now(UTC)
    ip = _inet_or_none(client_ip(request) or "")    # audit_log.ip is INET
    await biometric.revoke_keys(db, device_id=device.id, reason="reassigned",
                                actor_id=me, ip=ip)
    await push_registrations.drop_for_device(db, device.id, reason="reassigned")
    device.personal_person_id = after
    device.personal_set_at = now if after else None
    device.personal_set_by = me if after else None
    device.updated_at = now
    audit(db, actor_id=me, entity_type="device", entity_id=str(device.id),
          action="personal_set" if after else "personal_cleared",
          changes={"person_id": {"from": str(before) if before else None,
                                 "to": str(after) if after else None},
                   "source": "kiosk"}, ip=ip)
    await db.commit()
    return await _personal_out(db, actor, device)


@router.post("/push/registration", response_model=KioskPushRegistrationOut)
async def post_push_registration(
    body: KioskPushTokenIn, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> KioskPushRegistrationOut:
    """Create or replace this phone's registration. The phone must be the
    caller's (403 not_personal_device; never a Zebra or a shared station)
    and the caller an admin (403 not_admin)."""
    device = await own_device(db, actor, lock=True)
    family = biometric.platform_family(device.sub_type)
    if (device.personal_person_id != actor.person.id or device.sub_type == "zebra"
            or biometric.shared_station(device) or family not in ("android", "ios")):
        raise _err(403, "not_personal_device")
    if actor.access.max_rank < GATE_BYPASS_RANK:
        raise _err(403, "not_admin")
    try:
        registration, raw = await push_registrations.register(
            db, device, actor.person.id, token=body.token, platform=family)
    except push_registrations.TokenConflict:
        await db.rollback()
        raise _err(409, "token_conflict") from None
    registration_id = str(registration.id)
    await db.commit()
    return KioskPushRegistrationOut(registration_id=registration_id, push_key=raw)


@router.delete("/push/registration", status_code=204)
async def delete_push_registration(
    db: DbSession, actor: AuthContext = require_permission("kiosk", "view"),
) -> None:
    """Remove this phone's registration. Only its own person may (403
    not_owner); none is a quiet 204."""
    device = await own_device(db, actor, lock=True)
    owner = await db.scalar(select(PushRegistration.person_id).where(
        PushRegistration.device_id == device.id))
    if owner is None:
        return
    if owner != actor.person.id:
        raise _err(403, "not_owner")
    await push_registrations.drop_for_device(db, device.id, reason="app_removed")
    await db.commit()


@router.put("/push/registration/token", status_code=204)
async def put_push_token(
    body: KioskPushTokenIn, request: Request, db: DbSession,
    registration: PushRegistration = Depends(push_registration),
) -> None:
    """The phone's FCM token rotated (push key, no session). Read-only mode
    refuses it with 423 like the station-key writes; the app sends it again
    on its next start. A registration deleted since the key was checked is
    the same 401 push_key_invalid; 409 token_conflict when another phone
    took the same token at the same moment."""
    await enforce_read_only_config(db, request)
    try:
        updated = await push_registrations.update_token(db, registration, body.token)
    except push_registrations.TokenConflict:
        await db.rollback()
        raise _err(409, "token_conflict") from None
    if not updated:
        await db.rollback()
        raise _push_key_invalid()
    await db.commit()


# ── the app's notifications ─────────────────────────────────────────
# The app's session reaches only /kiosk/*, so these mirror the portal's
# /notifications/inbox routes under /kiosk, over the same code
# (notifications/inbox_ops.py). Every route acts on the caller's own rows.

class KioskNotificationItemOut(NotificationInboxItemOut):
    """An inbox item for the app: adds the end of its snooze, if any."""

    push_snoozed_until: datetime | None = None


class KioskNotificationsOut(NotificationInboxOut):
    items: list[KioskNotificationItemOut]


class KioskSnoozeOut(BaseModel):
    snoozed_until: datetime


async def _admin_actor(
    actor: AuthContext = require_permission("kiosk", "view"),
) -> AuthContext:
    """The app's notification screens are for admins (rank 60+), as push is."""
    if actor.access.max_rank < GATE_BYPASS_RANK:
        raise _err(403, "not_admin")
    return actor


AdminActor = Annotated[AuthContext, Depends(_admin_actor)]


async def _snooze(db: DbSession, person_id: uuid.UUID, notification_id: uuid.UUID) -> dict:
    """Push the notification again in 5 minutes. 404 when it isn't the
    person's own; 409 `not_live` when it is read or hidden."""
    row = await db.scalar(select(Notification).where(
        Notification.id == notification_id, Notification.person_id == person_id))
    if row is None:
        raise inbox_ops.not_found()
    try:
        until = await push.snooze(db, row, now=datetime.now(UTC))
    except ValueError:
        raise _err(409, "not_live") from None
    await signal_inbox(db, person_id)
    await db.commit()
    return {"snoozed_until": until}


@router.get("/notifications", response_model=KioskNotificationsOut)
async def list_notifications(
    db: DbSession, actor: AdminActor, unread_only: bool = False,
    category: str | None = None, cursor: str | None = None,
    limit: int = inbox_ops.INBOX_LIMIT,
) -> KioskNotificationsOut:
    """The same query and response as GET /notifications/inbox, each item with
    its `push_snoozed_until`."""
    unread, total, page, next_cursor = await inbox_ops.list_page(
        db, actor.person.id, unread_only=unread_only, category=category,
        cursor=cursor, limit=limit)
    items = []
    for row in page:
        info = kind_info(row.kind)
        items.append(KioskNotificationItemOut.model_validate(row).model_copy(
            update={"category": info.category if info else None}))
    return KioskNotificationsOut(unread_count=unread, items=items,
                                 next_cursor=next_cursor, total=total)


@router.post("/notifications/{notification_id}/read", status_code=204)
async def read_notification(notification_id: uuid.UUID, db: DbSession,
                            actor: AdminActor) -> Response:
    await inbox_ops.mark_read(db, actor.person.id, notification_id)
    await db.commit()
    return Response(status_code=204)


@router.post("/notifications/{notification_id}/unread", status_code=204)
async def unread_notification(notification_id: uuid.UUID, db: DbSession,
                              actor: AdminActor) -> Response:
    await inbox_ops.mark_unread(db, actor.person.id, notification_id)
    await db.commit()
    return Response(status_code=204)


@router.post("/notifications/{notification_id}/snooze", response_model=KioskSnoozeOut)
async def snooze_notification(notification_id: uuid.UUID, db: DbSession,
                              actor: AdminActor) -> dict:
    return await _snooze(db, actor.person.id, notification_id)


@router.delete("/notifications/{notification_id}", status_code=204)
async def hide_notification(notification_id: uuid.UUID, db: DbSession,
                            actor: AdminActor) -> Response:
    await inbox_ops.hide(db, actor.person.id, notification_id)
    await db.commit()
    return Response(status_code=204)


# With the push key (no session): only the registration's own person's
# notifications, and only these two writes. Read-only mode refuses both (423).

@router.post("/push/notifications/{notification_id}/read", status_code=204)
async def push_read_notification(
    notification_id: uuid.UUID, request: Request, db: DbSession,
    registration: PushRegistration = Depends(push_registration),
) -> Response:
    await enforce_read_only_config(db, request)
    await inbox_ops.mark_read(db, registration.person_id, notification_id)
    await db.commit()
    return Response(status_code=204)


@router.post("/push/notifications/{notification_id}/snooze", response_model=KioskSnoozeOut)
async def push_snooze_notification(
    notification_id: uuid.UUID, request: Request, db: DbSession,
    registration: PushRegistration = Depends(push_registration),
) -> dict:
    await enforce_read_only_config(db, request)
    return await _snooze(db, registration.person_id, notification_id)
