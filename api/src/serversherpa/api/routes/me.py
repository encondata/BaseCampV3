"""Self-service endpoints: my profile (view/edit), my active sessions, and
(Task 2) my notification-group memberships/overrides/join-leave requests."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError

from serversherpa.api.deps import CurrentUser, DbSession, require_password_length
from serversherpa.api.routes.notifications import (
    _get_group, _member_count, _request_out, apply_member_overrides,
    effective_settings,
)
from serversherpa.api.schemas import (
    ChangePasswordIn,
    MembershipRequestCreateIn,
    MembershipRequestOut,
    MyActivityItem,
    MyNotificationGroupOut,
    MyPendingRequestOut,
    NotificationEffectiveSettings,
    NotificationMemberOverrides,
    PersonDetail,
    ProfileUpdateIn,
    SessionItem,
)
from serversherpa.db.models import (
    AuditLog, AuthSession, NotificationGroup, NotificationGroupMember,
    NotificationMembershipRequest, Person,
)
from serversherpa.config import get_settings
from serversherpa.notifications.requests import RequestError, cancel_request, create_request
from serversherpa.security.passwords import hash_password, verify_password
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.auth import revoke_family
from serversherpa.services.storage import presign_get

router = APIRouter(prefix="/auth/me", tags=["me"])


def _detail(person, account=None) -> PersonDetail:
    out = PersonDetail.model_validate(person)
    out.avatar_url = presign_get(person.avatar_key)
    if account is not None:
        out.password_updated_at = account.password_updated_at
    return out


@router.get("/profile", response_model=PersonDetail)
async def get_profile(user: CurrentUser) -> PersonDetail:
    return _detail(user.person, user.account)


ABOUT_ME_ENTITY_TYPES = ("person", "user_account", "auth")


@router.get("/activity", response_model=list[MyActivityItem])
async def my_activity(user: CurrentUser, db: DbSession) -> list[MyActivityItem]:
    """The signed-in user's history: rows they acted in, plus rows about
    their person/account/auth identity (admin resets, failed logins against
    their email — those carry actor NULL and entity_id = the typed email)."""
    from sqlalchemy import and_, or_

    me = user.person.id
    identities = [str(me)]
    if user.account.email:
        identities.append(user.account.email)
    rows = (await db.execute(
        select(AuditLog, Person)
        .outerjoin(Person, Person.id == AuditLog.actor_person_id)
        .where(or_(
            AuditLog.actor_person_id == me,
            and_(AuditLog.entity_type.in_(ABOUT_ME_ENTITY_TYPES),
                 AuditLog.entity_id.in_(identities)),
        ))
        .order_by(AuditLog.at.desc())
        .limit(50)
    )).all()
    from serversherpa.services.entity_refs import resolve_entity_refs
    refs = await resolve_entity_refs(db, {
        (log.entity_type, log.entity_id) for log, _ in rows
        if log.entity_id is not None})
    return [MyActivityItem(
        id=log.id, at=log.at, action=log.action, entity_type=log.entity_type,
        entity_id=log.entity_id, ip=str(log.ip) if log.ip else None,
        by_me=log.actor_person_id == me,
        actor_name=(actor.display_name
                    if actor is not None and log.actor_person_id != me
                    else None),
        changes=log.changes or {},
        entity_name=refs.get((log.entity_type, log.entity_id or ""), {}).get("name"),
        entity_summary=refs.get((log.entity_type, log.entity_id or ""), {}).get("summary", {}),
    ) for log, actor in rows]


@router.patch("/profile", response_model=PersonDetail)
async def update_profile(
    body: ProfileUpdateIn, user: CurrentUser, db: DbSession
) -> PersonDetail:
    data = body.model_dump(exclude_unset=True)
    for required in ("first_name", "last_name", "country"):
        if required in data and data[required] is None:
            raise HTTPException(status_code=422, detail={"code": f"{required}_required"})

    fields = list(data.keys())
    before = snapshot(user.person, fields)
    for field, value in data.items():
        setattr(user.person, field, value)
    user.person.updated_at = datetime.now(UTC)

    changes = diff(before, snapshot(user.person, fields))
    if changes:
        audit(db, actor_id=user.person.id, entity_type="person",
              entity_id=str(user.person.id), action="update",
              changes=changes)

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # partial unique index on people.email
        raise HTTPException(status_code=409, detail={"code": "email_in_use"}) from None

    return _detail(user.person, user.account)


@router.get("/sessions", response_model=list[SessionItem])
async def list_sessions(user: CurrentUser, db: DbSession) -> list[SessionItem]:
    now = datetime.now(UTC)

    live = (await db.scalars(
        select(AuthSession).where(
            AuthSession.person_id == user.person.id,
            AuthSession.revoked_at.is_(None),
            AuthSession.rotated_at.is_(None),
            AuthSession.expires_at > now,
        )
    )).all()

    family_ids = [s.family_id for s in live]
    starts = dict((await db.execute(
        select(AuthSession.family_id, func.min(AuthSession.created_at))
        .where(AuthSession.family_id.in_(family_ids or [uuid.uuid4()]))
        .group_by(AuthSession.family_id)
    )).all())

    items = [
        SessionItem(
            family_id=s.family_id,
            started_at=starts.get(s.family_id, s.created_at),
            last_active_at=s.created_at,
            expires_at=s.expires_at,
            ip_address=str(s.ip_address) if s.ip_address is not None else None,
            user_agent=s.user_agent,
            current=s.family_id == user.session.family_id,
        )
        for s in live
    ]
    # current login first, then most recently active
    items.sort(key=lambda i: (not i.current, i.last_active_at), reverse=False)
    items.sort(key=lambda i: i.last_active_at, reverse=True)
    items.sort(key=lambda i: not i.current)
    return items


@router.delete("/sessions/{family_id}", status_code=204)
async def revoke_session(
    family_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> None:
    owned = await db.scalar(
        select(AuthSession.id).where(
            AuthSession.family_id == family_id,
            AuthSession.person_id == user.person.id,
        ).limit(1)
    )
    if owned is None:
        raise HTTPException(status_code=404, detail={"code": "session_not_found"})
    await revoke_family(db, family_id, reason="logout")
    audit(db, actor_id=user.person.id, entity_type="auth",
          entity_id=str(user.person.id), action="session.revoke",
          changes={"family_id": {"from": str(family_id), "to": None}})
    await db.commit()


@router.post("/password", status_code=204)
async def change_password(
    body: ChangePasswordIn, user: CurrentUser, db: DbSession
) -> None:
    """Self-service password change. Requires the current password; on
    success every OTHER login (family) is revoked — a stolen session
    can't ride through a password rotation."""
    require_password_length(body.new_password)
    pepper = get_settings().password_pepper.get_secret_value()
    account = user.account

    if account.password_hash is None or not verify_password(
            account.password_hash, body.current_password, pepper=pepper):
        raise HTTPException(status_code=403,
                            detail={"code": "invalid_current_password"})
    if verify_password(account.password_hash, body.new_password, pepper=pepper):
        raise HTTPException(status_code=422, detail={"code": "same_as_current"})

    now = datetime.now(UTC)
    account.password_hash = hash_password(body.new_password, pepper=pepper)
    account.password_updated_at = now
    account.must_change_password = False
    account.updated_at = now

    await db.execute(
        update(AuthSession)
        .where(AuthSession.person_id == account.person_id,
               AuthSession.family_id != user.session.family_id,
               AuthSession.revoked_at.is_(None))
        .values(revoked_at=now, revoke_reason="password_change")
    )
    audit(db, actor_id=user.person.id, entity_type="user_account",
          entity_id=str(user.person.id), action="password.change")
    await db.commit()


# ── notification groups: self-service (any signed-in person) ─────────
# Approval lives under /notifications/requests (routes/notifications.py,
# gated notifications:change); this reuses that module's group/member
# helpers and its `_request_out` so both routers share one payload shape.

def _my_group_out(group: NotificationGroup, member_count: int,
                  member: NotificationGroupMember | None,
                  pending: NotificationMembershipRequest | None,
                  ) -> MyNotificationGroupOut:
    return MyNotificationGroupOut(
        id=group.id, name=group.name, description=group.description,
        channels=group.channels, quiet_start=group.quiet_start,
        quiet_end=group.quiet_end, timezone=group.timezone,
        active_days=group.active_days, dnd_behavior=group.dnd_behavior,
        urgent_bypass=group.urgent_bypass, member_count=member_count,
        is_member=member is not None,
        overrides=(NotificationMemberOverrides(
            channels=member.channels, quiet_mode=member.quiet_mode,
            quiet_start=member.quiet_start, quiet_end=member.quiet_end,
            timezone=member.timezone, active_days=member.active_days,
            dnd_behavior=member.dnd_behavior, urgent_bypass=member.urgent_bypass)
            if member is not None else None),
        effective=(NotificationEffectiveSettings(**effective_settings(group, member))
                   if member is not None else None),
        pending_request=(MyPendingRequestOut(
            id=pending.id, action=pending.action, note=pending.note,
            created_at=pending.created_at) if pending is not None else None))


async def _my_pending(db: DbSession, group_id: uuid.UUID,
                      person_id: uuid.UUID) -> NotificationMembershipRequest | None:
    return await db.scalar(select(NotificationMembershipRequest).where(
        NotificationMembershipRequest.group_id == group_id,
        NotificationMembershipRequest.person_id == person_id,
        NotificationMembershipRequest.status == "pending"))


@router.get("/notification-groups", response_model=list[MyNotificationGroupOut])
async def list_my_groups(
    user: CurrentUser, db: DbSession, q: str = "",
) -> list[MyNotificationGroupOut]:
    conditions = [NotificationGroup.enabled.is_(True)]
    if q:
        needle = f"%{q}%"
        conditions.append(or_(NotificationGroup.name.ilike(needle),
                              NotificationGroup.description.ilike(needle)))
    rows = (await db.execute(
        select(NotificationGroup, func.count(NotificationGroupMember.person_id))
        .outerjoin(NotificationGroupMember,
                   NotificationGroupMember.group_id == NotificationGroup.id)
        .where(*conditions)
        .group_by(NotificationGroup.id)
        .order_by(NotificationGroup.name))).all()

    # one query for the caller's memberships, one for their pending
    # requests — no per-group lookup.
    memberships = {m.group_id: m for m in (await db.scalars(
        select(NotificationGroupMember).where(
            NotificationGroupMember.person_id == user.person.id)))}
    pending = {r.group_id: r for r in (await db.scalars(
        select(NotificationMembershipRequest).where(
            NotificationMembershipRequest.person_id == user.person.id,
            NotificationMembershipRequest.status == "pending")))}

    return [_my_group_out(group, count, memberships.get(group.id),
                          pending.get(group.id))
            for group, count in rows]


@router.patch("/notification-groups/{group_id}/overrides",
              response_model=MyNotificationGroupOut)
async def update_my_overrides(
    group_id: uuid.UUID, body: NotificationMemberOverrides,
    user: CurrentUser, db: DbSession,
) -> MyNotificationGroupOut:
    member = await db.get(NotificationGroupMember, (group_id, user.person.id))
    if member is None:
        raise HTTPException(status_code=404, detail={"code": "not_a_member"})
    group = await _get_group(db, group_id)

    # CurrentUser always has a UserAccount (that's how they signed in), so
    # push/web channels are always reachable for the caller.
    changes = apply_member_overrides(member, body, user.person, True)
    if changes:
        audit(db, actor_id=user.person.id, entity_type="notification_group",
              entity_id=str(group_id), action="member.self_override",
              changes=changes)
    await db.commit()
    count = await _member_count(db, group_id)
    pending = await _my_pending(db, group_id, user.person.id)
    return _my_group_out(group, count, member, pending)


@router.post("/notification-groups/{group_id}/requests",
             response_model=MembershipRequestOut, status_code=201)
async def create_my_request(
    group_id: uuid.UUID, body: MembershipRequestCreateIn,
    user: CurrentUser, db: DbSession,
) -> MembershipRequestOut:
    group = await db.get(NotificationGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail={"code": "group_not_found"})
    try:
        req = await create_request(db, person=user.person, group=group,
                                   action=body.action, note=body.note)
        await db.commit()
    except RequestError as e:
        raise HTTPException(status_code=e.status, detail={"code": e.code}) from None
    except IntegrityError:
        # the partial unique index (one pending request per group+person)
        # loses a create/create race — same outward result as the ordinary
        # pending-duplicate rule check inside create_request.
        await db.rollback()
        raise HTTPException(status_code=409, detail={"code": "request_pending"}) from None
    return _request_out(req, group.name, user.person.display_name)


@router.delete("/notification-groups/requests/{request_id}", status_code=204)
async def cancel_my_request(
    request_id: uuid.UUID, user: CurrentUser, db: DbSession,
) -> None:
    try:
        await cancel_request(db, request_id=request_id, person_id=user.person.id)
    except RequestError as e:
        raise HTTPException(status_code=e.status, detail={"code": e.code}) from None
    await db.commit()
