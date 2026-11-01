"""Check delivery: what would happen right now if one person got a
notification of one registered kind, without writing anything. The email
answer is decide_email(), the same decision maybe_email() acts on, so the
tool and the sender cannot drift; the inbox answer is notify()'s rule.

Spec: docs/superpowers/specs/2026-10-31-notifications-phase0-design.md (section 9)"""

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import NotificationGroup, NotificationGroupMember, Person, UserAccount
from serversherpa.db.ordering import natural
from serversherpa.mail.outbox import email_enabled
from serversherpa.notifications.email import (
    _safe_timezone,
    decide_email,
    load_contact,
    personal_choice,
)
from serversherpa.notifications.email_rule import group_verdict
from serversherpa.notifications.kinds import CATEGORY_EMAIL_SOURCE, KINDS, KindInfo
from serversherpa.notifications.settings import effective_settings


async def check_delivery(db: AsyncSession, person_id: uuid.UUID, kind: str, *,
                         owner_copy: bool | None = None, now: datetime) -> dict:
    """The DeliveryCheckOut fields for this person and kind at `now` (aware).
    `kind` must be registered and the person must exist: the route answers
    422 and 404 before calling. For a kind the account owner always receives
    (owner_always), the owner's own copy is modeled unless `owner_copy` is
    False, which asks for an admin's copy (that one goes through groups).
    Reads only."""
    info = KINDS[kind]
    person = await db.get(Person, person_id)
    has_account = await db.scalar(select(UserAccount.person_id).where(
        UserAccount.person_id == person_id)) is not None
    contact = await load_contact(db, person_id)
    choice = personal_choice(info, contact)
    owner_notice = info.owner_always and owner_copy is not False
    decision = await decide_email(db, person_id, info, owner_notice=owner_notice,
                                  choice=choice, contact=contact, now=now)
    if not decision.queue:
        outcome = "not_sent"
    else:
        outcome = "held" if decision.send_at > now else "now"
    return {
        "person_id": person_id,
        "person_name": person.display_name,
        "kind": kind,
        "kind_label": info.label,
        "category": info.category,
        "email_source": CATEGORY_EMAIL_SOURCE[info.category],
        "owner_copy": owner_notice,
        "active": contact is not None and contact.active,
        "has_account": has_account,
        "choice": choice,
        # notify()'s rule: an off category drops the inbox row too, except
        # for a kind that is never emailed
        "inbox": "suppressed" if choice == "off" and info.email else "written",
        "email_enabled": email_enabled(),
        "outcome": outcome,
        "send_at": decision.send_at,
        "reason": decision.reason,
        "address": decision.address,
        "address_source": decision.address_source,
        "groups": await _groups(db, person_id, info, now),
    }


async def _groups(db: AsyncSession, person_id: uuid.UUID, info: KindInfo,
                  now: datetime) -> list[dict]:
    """Every group the person is in, paused or not, by name: its effective
    settings for them and its verdict on this kind right now. Only an enabled
    group that covers the category is asked (email_rule.group_verdict, as
    decide_email asks it); the others are `paused` or `not_subscribed`."""
    rows = (await db.execute(
        select(NotificationGroup, NotificationGroupMember)
        .join(NotificationGroupMember,
              NotificationGroupMember.group_id == NotificationGroup.id)
        .where(NotificationGroupMember.person_id == person_id)
        .order_by(natural(NotificationGroup.name), NotificationGroup.id))).all()
    out = []
    for group, member in rows:
        # the timezone decide_email would use: a stored one that no longer
        # resolves falls back to the house default
        s = _safe_timezone(effective_settings(group, member))
        subscribed = info.category in group.categories
        if not group.enabled:
            verdict, allowed_at = "paused", None
        elif not subscribed:
            verdict, allowed_at = "not_subscribed", None
        else:
            verdict, allowed_at = group_verdict(s, now, urgent=info.urgent)
        out.append({
            "group_id": group.id,
            "name": group.name,
            "enabled": group.enabled,
            "subscribed": subscribed,
            "email_channel": "email" in (s["channels"] or ()),
            "verdict": verdict,
            "allowed_at": allowed_at,
            "quiet_start": s["quiet_start"],
            "quiet_end": s["quiet_end"],
            "timezone": s["timezone"],
            "active_days": s["active_days"],
        })
    return out
