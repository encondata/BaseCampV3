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
from serversherpa.notifications.inbox import notify
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
        await db.flush()
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
    await db.execute(text(
        "UPDATE notifications SET payload = payload || "
        "jsonb_build_object('state', 'resolved', 'resolved_by', CAST(:by AS text)) "
        "WHERE kind = :kind AND payload ->> 'target_person_id' = CAST(:pid AS text) "
        "AND payload ->> 'state' = 'open'"),
        {"by": resolved_by, "kind": KIND, "pid": str(person_id)})
