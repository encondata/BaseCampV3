"""One person's audit history: rows they acted in, plus rows about their
person / account / sign-ins (admin resets, failed logins against their
email — those carry actor NULL and entity_id = the typed email).

Shared by /auth/me/activity and /users/{id}/activity so the "about this
person" rule has one home. Returns plain dicts shaped like MyActivityItem;
the routes wrap them."""

import uuid

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AuditLog, Person
from serversherpa.services.entity_refs import resolve_entity_refs

ABOUT_ENTITY_TYPES = ("person", "user_account", "auth")


async def person_activity(
    db: AsyncSession, person_id: uuid.UUID, login_email: str | None, *, limit: int = 50,
) -> list[dict]:
    identities = [str(person_id)]
    if login_email:
        identities.append(login_email)
    rows = (await db.execute(
        select(AuditLog, Person)
        .outerjoin(Person, Person.id == AuditLog.actor_person_id)
        .where(or_(
            AuditLog.actor_person_id == person_id,
            and_(AuditLog.entity_type.in_(ABOUT_ENTITY_TYPES),
                 AuditLog.entity_id.in_(identities)),
        ))
        .order_by(AuditLog.at.desc())
        .limit(limit)
    )).all()
    refs = await resolve_entity_refs(db, {
        (log.entity_type, log.entity_id) for log, _ in rows
        if log.entity_id is not None})
    return [{
        "id": log.id, "at": log.at, "action": log.action,
        "entity_type": log.entity_type, "entity_id": log.entity_id,
        "ip": str(log.ip) if log.ip else None,
        "by_me": log.actor_person_id == person_id,
        "actor_name": (actor.display_name
                       if actor is not None and log.actor_person_id != person_id
                       else None),
        "changes": log.changes or {},
        "entity_name": refs.get((log.entity_type, log.entity_id or ""), {}).get("name"),
        "entity_summary": refs.get((log.entity_type, log.entity_id or ""), {})
                              .get("summary", {}),
    } for log, actor in rows]
