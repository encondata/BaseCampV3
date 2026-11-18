"""Admin inbox cards for password-reset requests made while email isn't
configured (POST /auth/password-reset/request). One open card per target
person per approver: a repeat request bumps the existing copies (count,
unread again, back to the top) instead of piling up. Cards carry the
person's name and a link to their user page — never the email typed on the
login page. Resolved by the admin reset-password route or a completed
self-service reset. Adds to the caller's session — never commits."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification, Person
from serversherpa.notifications.company import load_company_settings
from serversherpa.notifications.email import load_contact
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info
from serversherpa.notifications.live import signal_inbox, signal_inboxes
from serversherpa.notifications.push import maybe_push, on_rows_read
from serversherpa.notifications.requests import approver_ids

KIND = "password_reset_request"
BODY = ("Email isn't set up, so they can't reset it themselves. "
        "Set a temporary password from their user page.")


async def open_or_bump(db: AsyncSession, person: Person) -> int:
    now = datetime.now(UTC)
    existing = (await db.scalars(
        select(Notification).where(
            Notification.kind == KIND,
            Notification.payload["target_person_id"].astext == str(person.id),
            Notification.payload["state"].astext == "open"))).all()
    if existing:
        for card in existing:
            card.payload = {**card.payload,
                            "count": int(card.payload.get("count", 1)) + 1,
                            "last_requested_at": now.isoformat()}
            card.read_at = None
            card.dismissed_at = None
            card.created_at = now
            await signal_inbox(db, card.person_id)
        await db.flush()
        # A bumped card is unread and back on top: it pushes again, by the
        # same rules as a new one (notify() loads these the same way).
        info = kind_info(KIND)
        company = await load_company_settings(db)
        for card in existing:
            contact = await load_contact(db, card.person_id)
            await maybe_push(db, card, info=info, contact=contact, company=company)
        return len(existing)
    title = f"{person.first_name} {person.last_name} asked for a password reset"
    payload = {"target_person_id": str(person.id), "state": "open", "count": 1,
               "last_requested_at": now.isoformat()}
    recipients = await approver_ids(db, exclude=person.id, resource="users", action="change")
    for approver in recipients:
        await notify(db, approver, KIND, title, body=BODY,
                     link=f"/people/users/{person.id}", payload=dict(payload))
    return len(recipients)


async def resolve(db: AsyncSession, person_id: uuid.UUID, resolved_by: str) -> None:
    """Mark every open card for this person resolved, and read for every
    approver: nothing is left to act on. A card already read keeps its first
    read time; the card still says who resolved it."""
    where = ("WHERE kind = :kind AND payload ->> 'target_person_id' = CAST(:pid AS text) "
             "AND payload ->> 'state' = 'open'")
    params = {"by": resolved_by, "kind": KIND, "pid": str(person_id)}
    newly_read = [(r.id, r.person_id) for r in await db.execute(text(
        "SELECT id, person_id FROM notifications " + where + " AND read_at IS NULL"),
        params)]
    changed = await db.scalars(text(
        "UPDATE notifications SET payload = payload || "
        "jsonb_build_object('state', 'resolved', 'resolved_by', CAST(:by AS text)), "
        "read_at = COALESCE(read_at, now()) "
        + where + " RETURNING person_id"), params)
    await signal_inboxes(db, changed.all())
    await on_rows_read(db, newly_read)
