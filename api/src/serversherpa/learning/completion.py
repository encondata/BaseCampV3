"""Completion: a person's learning for one initiative (or for the general
set, `initiative_id` None) is complete when nothing in it is left open.
`check` runs after every sign-off, in the same transaction, and on the
first completion:

- writes a `worker_certifications` row (source `learning`), named
  "Onboarding: <initiative>" or "Learning: general", issued today and
  expiring on the earliest `signed_at + validity_days` among the signed
  documents (none when every one is valid forever);
- tells every learning manager (`learning_complete`);
- queues the worker's completion email with the time clock QR code.

An initiative completes once: its learning cert means it is done. The
general set can complete again when later general assignments are signed,
so there a cert counts only for what was signed before it, and the expiry
is taken from what was signed since.

Two sign-offs for the same person and scope serialize on `lock`, so the
last one always sees the other's row and the cert is written once.
Nothing here commits."""
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, Person, WorkerCertification
from serversherpa.learning.access import manager_ids
from serversherpa.learning.assign import OPEN_STATUSES
from serversherpa.learning.models import LearningAssignment, LearningDocument
from serversherpa.notifications.inbox import notify

GENERAL_NAME = "Learning: general"


def in_scope(column, initiative_id: uuid.UUID | None):
    return column.is_(None) if initiative_id is None else column == initiative_id


async def lock(db: AsyncSession, person_id: uuid.UUID, initiative_id: uuid.UUID | None) -> None:
    """Hold the person's learning for this scope until the transaction
    ends (sign-offs and the completion check take it in that order)."""
    key = f"learning-complete:{person_id}:{initiative_id or 'general'}"
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": key})


def _expires_on(signed: list[tuple[datetime, int | None]]) -> date | None:
    ends = [at.astimezone(UTC).date() + timedelta(days=days)
            for at, days in signed if days is not None]
    return min(ends) if ends else None


async def check(db: AsyncSession, person_id: uuid.UUID, initiative_id: uuid.UUID | None, *,
                actor: uuid.UUID | None = None) -> bool:
    """Complete the scope if nothing is open in it. True when this call
    completed it; False when something is open, nothing was ever signed,
    or it was already complete."""
    await lock(db, person_id, initiative_id)
    last_cert = await db.scalar(
        select(func.max(WorkerCertification.created_at))
        .where(WorkerCertification.person_id == person_id,
               WorkerCertification.source == "learning",
               in_scope(WorkerCertification.learning_initiative_id, initiative_id)))
    if last_cert is not None and initiative_id is not None:
        return False
    open_count = await db.scalar(
        select(func.count()).select_from(LearningAssignment)
        .where(LearningAssignment.person_id == person_id,
               in_scope(LearningAssignment.initiative_id, initiative_id),
               LearningAssignment.status.in_(OPEN_STATUSES))) or 0
    if open_count:
        return False
    signed_stmt = (
        select(LearningAssignment.signed_at, LearningDocument.validity_days)
        .join(LearningDocument, LearningDocument.id == LearningAssignment.document_id)
        .where(LearningAssignment.person_id == person_id,
               in_scope(LearningAssignment.initiative_id, initiative_id),
               LearningAssignment.status == "signed",
               LearningAssignment.signed_at.is_not(None)))
    if last_cert is not None:
        signed_stmt = signed_stmt.where(LearningAssignment.signed_at > last_cert)
    signed = [(at, days) for at, days in (await db.execute(signed_stmt)).all()]
    if not signed:
        return False

    person = await db.get(Person, person_id)
    initiative = await db.get(Initiative, initiative_id) if initiative_id else None
    now = datetime.now(UTC)
    cert = WorkerCertification(
        person_id=person_id, source="learning", learning_initiative_id=initiative_id,
        name=f"Onboarding: {initiative.name}" if initiative else GENERAL_NAME,
        issued_on=now.date(), expires_on=_expires_on(signed), created_by=actor,
        # its own clock, not the transaction's: the general set's next
        # completion compares sign-off times against it
        created_at=now)
    db.add(cert)
    await db.flush()

    if initiative is not None:
        title = f"{person.display_name} finished learning for {initiative.name}"
        link = f"/initiatives/{initiative.id}?tab=learning"
    else:
        title = f"{person.display_name} finished their assigned learning"
        link = f"/people/workers/{person_id}"
    for manager_id in await manager_ids(db, action="change"):
        await notify(db, manager_id, "learning_complete", title,
                     body="Every assigned document is signed.", link=link,
                     payload={"person_id": str(person_id),
                              "initiative_id": str(initiative_id) if initiative_id else None,
                              "certification_id": str(cert.id)})

    from serversherpa.learning import emails

    await emails.send_complete(db, person_id, initiative_id)
    return True
