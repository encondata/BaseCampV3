"""Notification-group membership requests: a person asks to join or leave
a group; anyone with notifications:change approves or rejects it. This
module owns the whole lifecycle — create (+ approver fan-out), cancel,
decide (+ membership side-effect + requester notification), and resolving
approvers' copies of the request notification once it's no longer pending.

Like notify()/audit(), every function here adds to the CALLER's session
and never commits — the API routes (Task 2) own the transaction boundary.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    NotificationGroup, NotificationGroupMember, NotificationMembershipRequest,
    Person, PersonRole, RolePermission, UserAccount,
)
from serversherpa.notifications.inbox import notify
from serversherpa.services.audit import audit


class RequestError(Exception):
    """Raised for every rule violation in this module. `.code` is one of
    the spec's error codes; `.status` is the HTTP status the route should
    answer with (defaults to 409 — most of these are conflicts)."""

    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


def _display_name(person: Person) -> str:
    name = getattr(person, "display_name", None)
    if name:
        return name
    return f"{person.first_name} {person.last_name}"


async def approver_ids(db: AsyncSession, *, exclude: uuid.UUID) -> list[uuid.UUID]:
    """Distinct people who can decide a request: a non-revoked PersonRole
    whose role has RolePermission('notifications', 'change'), and who have
    a UserAccount (so there's someone to receive the notification), minus
    the requester."""
    rows = await db.scalars(
        select(PersonRole.person_id).distinct()
        .join(RolePermission, RolePermission.role == PersonRole.role)
        .join(UserAccount, UserAccount.person_id == PersonRole.person_id)
        .where(
            PersonRole.revoked_at.is_(None),
            RolePermission.resource == "notifications",
            RolePermission.action == "change",
            PersonRole.person_id != exclude,
        ))
    return list(rows.all())


async def is_member(db: AsyncSession, group_id: uuid.UUID,
                    person_id: uuid.UUID) -> bool:
    return await db.get(NotificationGroupMember, (group_id, person_id)) is not None


async def _pending_request(db: AsyncSession, group_id: uuid.UUID,
                           person_id: uuid.UUID) -> NotificationMembershipRequest | None:
    return await db.scalar(select(NotificationMembershipRequest).where(
        NotificationMembershipRequest.group_id == group_id,
        NotificationMembershipRequest.person_id == person_id,
        NotificationMembershipRequest.status == "pending"))


async def create_request(db: AsyncSession, *, person: Person, group: NotificationGroup,
                         action: str, note: str) -> NotificationMembershipRequest:
    if not group.enabled:
        raise RequestError("group_not_found", 404)

    member = await is_member(db, group.id, person.id)
    if action == "join" and member:
        raise RequestError("already_member")
    if action == "leave" and not member:
        raise RequestError("not_a_member")
    if await _pending_request(db, group.id, person.id) is not None:
        raise RequestError("request_pending")

    req = NotificationMembershipRequest(
        group_id=group.id, person_id=person.id, action=action, note=note)
    db.add(req)
    await db.flush()

    audit(db, actor_id=person.id, entity_type="notification_group",
          entity_id=str(group.id), action="request.create",
          changes={"request_id": str(req.id), "person_id": str(person.id),
                   "action": action, "note": note})

    verb = "join" if action == "join" else "leave"
    requester_name = _display_name(person)
    title = f"{requester_name} asks to {verb} {group.name}"
    payload = {
        "request_id": str(req.id), "group_id": str(group.id),
        "group_name": group.name, "person_id": str(person.id),
        "person_name": requester_name, "action": action, "state": "pending",
    }
    for approver_id in await approver_ids(db, exclude=person.id):
        await notify(db, approver_id, "membership_request", title,
                     body=note, link="/system/notifications", payload=payload)

    return req


async def cancel_request(db: AsyncSession, *, request_id: uuid.UUID,
                         person_id: uuid.UUID) -> None:
    req = await db.get(NotificationMembershipRequest, request_id)
    if req is None or req.status != "pending" or req.person_id != person_id:
        raise RequestError("request_not_found", 404)

    req.status = "cancelled"
    audit(db, actor_id=person_id, entity_type="notification_group",
          entity_id=str(req.group_id), action="request.cancel",
          changes={"request_id": str(req.id), "person_id": str(person_id),
                   "action": req.action, "note": req.note})
    await resolve_copies(db, req.id, "cancelled", None)


async def decide_request(db: AsyncSession, *, request_id: uuid.UUID, actor: Person,
                         approve: bool, note: str) -> NotificationMembershipRequest:
    req = await db.get(NotificationMembershipRequest, request_id)
    if req is None:
        raise RequestError("request_not_found", 404)
    if req.status != "pending":
        raise RequestError("already_decided")

    group = await db.get(NotificationGroup, req.group_id)

    if approve:
        if req.action == "join":
            if not await is_member(db, req.group_id, req.person_id):
                db.add(NotificationGroupMember(
                    group_id=req.group_id, person_id=req.person_id,
                    added_by=actor.id))
        else:
            existing = await db.get(
                NotificationGroupMember, (req.group_id, req.person_id))
            if existing is not None:
                await db.delete(existing)
        await db.flush()

    req.status = "approved" if approve else "rejected"
    req.decided_by = actor.id
    req.decided_at = datetime.now(UTC)
    req.decision_note = note

    audit(db, actor_id=actor.id, entity_type="notification_group",
          entity_id=str(req.group_id),
          action="request.approve" if approve else "request.reject",
          changes={"request_id": str(req.id), "person_id": str(req.person_id),
                   "action": req.action, "note": note})

    verb = "join" if req.action == "join" else "leave"
    outcome = "approved" if approve else "rejected"
    group_name = group.name if group is not None else ""
    await notify(
        db, req.person_id, "membership_decided",
        f"Your request to {verb} {group_name} was {outcome}",
        body=note, link="/me/notifications",
        payload={"request_id": str(req.id), "group_id": str(req.group_id),
                 "action": req.action, "status": req.status})

    await resolve_copies(db, req.id, req.status, _display_name(actor))
    return req


async def resolve_copies(db: AsyncSession, request_id: uuid.UUID, state: str,
                         decided_by: str | None) -> None:
    """Update every approver's copy of the `membership_request` notification
    so the popover stops rendering Approve/Reject and shows the outcome."""
    await db.execute(text(
        "UPDATE notifications SET payload = payload || "
        "jsonb_build_object('state', CAST(:state AS text), "
        "'decided_by', CAST(:decided_by AS text)) "
        "WHERE kind = 'membership_request' "
        "AND payload ->> 'request_id' = CAST(:request_id AS text)"),
        {"state": state, "decided_by": decided_by, "request_id": str(request_id)})
