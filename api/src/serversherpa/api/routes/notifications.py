"""Notification groups CRUD. A group carries the default delivery
channels, quiet hours, active days, and DND behavior for its members.
Task 2 adds member endpoints (with per-member overrides); the React UI
is a later task still — this file is groups-only.

CHANNELS/DAYS are the source of truth other modules (the future
notification sender, Task 2's member validation) should import from."""

import uuid
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, CurrentUser, DbSession, require_permission
from serversherpa.api.schemas import (
    NotificationEffectiveSettings, NotificationGroupCreateIn,
    NotificationGroupDetailOut, NotificationGroupOut, NotificationGroupPatchIn,
    NotificationInboxItemOut, NotificationInboxOut, NotificationMemberAddIn,
    NotificationMemberOut, NotificationMemberOverrides, NotificationRecipientOut,
)
from serversherpa.db.models import (
    Notification, NotificationGroup, NotificationGroupMember, Person, UserAccount,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.storage import presign_get

router = APIRouter(prefix="/notifications", tags=["notifications"])

CHANNELS: tuple[str, ...] = ("email", "text", "push", "web")
DAYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

GROUP_FIELDS = ["name", "description", "channels", "quiet_start", "quiet_end",
                "timezone", "active_days", "dnd_behavior", "urgent_bypass",
                "enabled"]

# Every group column except quiet_start/quiet_end is NOT NULL — an explicit
# null in a PATCH body must 422 here, not IntegrityError at commit.
NON_NULLABLE_GROUP_FIELDS = frozenset(GROUP_FIELDS) - {"quiet_start", "quiet_end"}


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _validate_quiet_hours(quiet_start, quiet_end) -> None:
    """Both-or-neither, and (if both) not-equal. Callers pass whichever
    pair of values is authoritative for their case — the raw body for a
    create, or the merged (incoming-over-existing) state for a patch."""
    if (quiet_start is None) != (quiet_end is None):
        raise _err(422, "invalid_quiet_hours")
    if quiet_start is not None and quiet_start == quiet_end:
        raise _err(422, "invalid_quiet_hours")


def validate_settings(body, *, check_quiet_hours: bool = True) -> None:
    """Shared settings validation for group create/patch (and Task 2's
    member override patch) — duck-typed on whichever of these attributes
    the given body carries, so callers can pass any object that has some
    subset of them.

    check_quiet_hours is disabled by patch_group, which validates quiet
    hours itself against the merged (incoming + existing) state instead
    of the raw, possibly-partial patch body."""
    channels = getattr(body, "channels", None)
    if channels is not None and not set(channels) <= set(CHANNELS):
        raise _err(422, "invalid")

    active_days = getattr(body, "active_days", None)
    if active_days is not None and (
            not active_days or not set(active_days) <= set(DAYS)):
        raise _err(422, "invalid_days")

    dnd_behavior = getattr(body, "dnd_behavior", None)
    if dnd_behavior is not None and dnd_behavior not in ("defer", "skip"):
        raise _err(422, "invalid")

    timezone = getattr(body, "timezone", None)
    if timezone is not None:
        try:
            ZoneInfo(timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise _err(422, "invalid_timezone")

    if check_quiet_hours:
        _validate_quiet_hours(getattr(body, "quiet_start", None),
                               getattr(body, "quiet_end", None))


async def _get_group(db: DbSession, group_id: uuid.UUID) -> NotificationGroup:
    group = await db.get(NotificationGroup, group_id)
    if group is None:
        raise _err(404, "group_not_found")
    return group


async def _member_count(db: DbSession, group_id: uuid.UUID) -> int:
    return await db.scalar(
        select(func.count()).select_from(NotificationGroupMember)
        .where(NotificationGroupMember.group_id == group_id)) or 0


def _out(group: NotificationGroup, member_count: int) -> NotificationGroupOut:
    return NotificationGroupOut(
        id=group.id, name=group.name, description=group.description,
        channels=group.channels, quiet_start=group.quiet_start,
        quiet_end=group.quiet_end, timezone=group.timezone,
        active_days=group.active_days, dnd_behavior=group.dnd_behavior,
        urgent_bypass=group.urgent_bypass, enabled=group.enabled,
        member_count=member_count, created_at=group.created_at)


# ── members, overrides, recipients ─────────────────────────────────

# channel name -> the capabilities() key that gates it
CHANNEL_CAPABILITY = {"email": "can_email", "text": "can_text",
                       "push": "can_push", "web": "can_web"}


def capabilities(person: Person, has_account: bool) -> dict[str, bool]:
    """What a person is actually reachable on, independent of any group's
    aspirational channel list. Drives both the recipients picker and the
    per-member channel-override validation below."""
    return {"can_email": person.email is not None,
            "can_text": person.phone is not None,
            "can_push": has_account, "can_web": has_account}


def effective_settings(group: NotificationGroup,
                        member: NotificationGroupMember) -> dict:
    """Merge a member's overrides onto the group defaults — the single
    implementation of inheritance, reused by the member detail payload and
    (eventually) the notification sender."""
    if member.quiet_mode is None:
        quiet_start, quiet_end = group.quiet_start, group.quiet_end
    elif member.quiet_mode == "none":
        quiet_start, quiet_end = None, None
    else:  # "custom"
        quiet_start, quiet_end = member.quiet_start, member.quiet_end
    return {
        "channels": member.channels if member.channels is not None
                    else group.channels,
        "quiet_start": quiet_start,
        "quiet_end": quiet_end,
        "timezone": member.timezone if member.timezone is not None
                    else group.timezone,
        "active_days": member.active_days if member.active_days is not None
                        else group.active_days,
        "dnd_behavior": member.dnd_behavior if member.dnd_behavior is not None
                        else group.dnd_behavior,
        "urgent_bypass": member.urgent_bypass if member.urgent_bypass is not None
                          else group.urgent_bypass,
    }


def _member_out(group: NotificationGroup, member: NotificationGroupMember,
                 person: Person, has_account: bool) -> NotificationMemberOut:
    caps = capabilities(person, has_account)
    return NotificationMemberOut(
        person_id=person.id, display_name=person.display_name,
        job_title=person.job_title, avatar_url=presign_get(person.avatar_key),
        email=person.email, phone=person.phone, has_account=has_account,
        **caps,
        overrides=NotificationMemberOverrides(
            channels=member.channels, quiet_mode=member.quiet_mode,
            quiet_start=member.quiet_start, quiet_end=member.quiet_end,
            timezone=member.timezone, active_days=member.active_days,
            dnd_behavior=member.dnd_behavior, urgent_bypass=member.urgent_bypass),
        effective=NotificationEffectiveSettings(
            **effective_settings(group, member)),
        added_at=member.added_at)


async def _has_account(db: DbSession, person_id: uuid.UUID) -> bool:
    return await db.scalar(select(UserAccount.person_id).where(
        UserAccount.person_id == person_id)) is not None


async def _get_member(db: DbSession, group_id: uuid.UUID,
                       person_id: uuid.UUID) -> NotificationGroupMember:
    member = await db.get(NotificationGroupMember, (group_id, person_id))
    if member is None:
        raise _err(404, "member_not_found")
    return member


@router.get("/groups", response_model=list[NotificationGroupOut])
async def list_groups(
    db: DbSession,
    _actor: AuthContext = require_permission("notifications", "view"),
) -> list[NotificationGroupOut]:
    # single query: outer-join + group-by avoids one count query per group
    rows = (await db.execute(
        select(NotificationGroup, func.count(NotificationGroupMember.person_id))
        .outerjoin(NotificationGroupMember,
                   NotificationGroupMember.group_id == NotificationGroup.id)
        .group_by(NotificationGroup.id)
        .order_by(NotificationGroup.name))).all()
    return [_out(group, count) for group, count in rows]


@router.post("/groups", response_model=NotificationGroupOut, status_code=201)
async def create_group(
    body: NotificationGroupCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "add"),
) -> NotificationGroupOut:
    validate_settings(body)
    exists = await db.scalar(select(NotificationGroup.id).where(
        NotificationGroup.name == body.name))
    if exists:
        raise _err(409, "group_exists")

    data = body.model_dump(exclude_none=True)
    group = NotificationGroup(**data, created_by=actor.person.id)
    db.add(group)
    await db.flush()
    initial = snapshot(group, GROUP_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value not in (None, "")}
    audit(db, actor_id=actor.person.id, entity_type="notification_group",
          entity_id=str(group.id), action="group.create", changes=changes)
    await db.commit()
    return _out(group, 0)


@router.patch("/groups/{group_id}", response_model=NotificationGroupOut)
async def patch_group(
    group_id: uuid.UUID,
    body: NotificationGroupPatchIn,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> NotificationGroupOut:
    group = await _get_group(db, group_id)
    validate_settings(body, check_quiet_hours=False)

    fields_set = body.model_fields_set
    effective_start = (body.quiet_start if "quiet_start" in fields_set
                        else group.quiet_start)
    effective_end = (body.quiet_end if "quiet_end" in fields_set
                      else group.quiet_end)
    _validate_quiet_hours(effective_start, effective_end)

    data = body.model_dump(exclude_unset=True)
    if any(data[field] is None
           for field in NON_NULLABLE_GROUP_FIELDS & data.keys()):
        raise _err(422, "invalid")

    if "name" in data:
        exists = await db.scalar(select(NotificationGroup.id).where(
            NotificationGroup.name == data["name"],
            NotificationGroup.id != group_id))
        if exists:
            raise _err(409, "group_exists")

    fields = list(data.keys())
    before = snapshot(group, fields)
    for field, value in data.items():
        setattr(group, field, value)
    changes = diff(before, snapshot(group, fields))
    if changes:
        group.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="notification_group",
              entity_id=str(group_id), action="group.update", changes=changes)
    await db.commit()
    return _out(group, await _member_count(db, group_id))


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(
    group_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "delete"),
) -> None:
    group = await _get_group(db, group_id)
    audit(db, actor_id=actor.person.id, entity_type="notification_group",
          entity_id=str(group_id), action="group.delete",
          changes={"name": {"from": group.name, "to": None}})
    await db.delete(group)   # members cascade
    await db.commit()


@router.get("/groups/{group_id}", response_model=NotificationGroupDetailOut)
async def get_group(
    group_id: uuid.UUID,
    db: DbSession,
    _actor: AuthContext = require_permission("notifications", "view"),
) -> NotificationGroupDetailOut:
    group = await _get_group(db, group_id)
    rows = (await db.execute(
        select(NotificationGroupMember, Person, UserAccount.person_id)
        .join(Person, Person.id == NotificationGroupMember.person_id)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(NotificationGroupMember.group_id == group_id)
        .order_by(Person.last_name, Person.first_name))).all()
    members = [_member_out(group, member, person, account_id is not None)
               for member, person, account_id in rows]
    return NotificationGroupDetailOut(
        **_out(group, len(members)).model_dump(), members=members)


@router.post("/groups/{group_id}/members", response_model=NotificationMemberOut,
             status_code=201)
async def add_member(
    group_id: uuid.UUID,
    body: NotificationMemberAddIn,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> NotificationMemberOut:
    group = await _get_group(db, group_id)
    person = await db.get(Person, body.person_id)
    if person is None or person.archived_at is not None:
        raise _err(404, "person_not_found")

    existing = await db.get(NotificationGroupMember, (group_id, person.id))
    if existing is not None:
        raise _err(409, "member_exists")

    member = NotificationGroupMember(group_id=group_id, person_id=person.id,
                                      added_by=actor.person.id)
    db.add(member)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="notification_group",
          entity_id=str(group_id), action="member.add",
          changes={"person_id": str(person.id)})
    await db.commit()
    has_account = await _has_account(db, person.id)
    return _member_out(group, member, person, has_account)


@router.patch("/groups/{group_id}/members/{person_id}",
              response_model=NotificationMemberOut)
async def patch_member(
    group_id: uuid.UUID,
    person_id: uuid.UUID,
    body: NotificationMemberOverrides,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> NotificationMemberOut:
    member = await _get_member(db, group_id, person_id)
    group = await _get_group(db, group_id)
    person = await db.get(Person, person_id)
    has_account = await _has_account(db, person_id)
    validate_settings(body, check_quiet_hours=False)

    fields_set = body.model_fields_set

    quiet_mode = body.quiet_mode if "quiet_mode" in fields_set else member.quiet_mode
    if quiet_mode is not None and quiet_mode not in ("none", "custom"):
        raise _err(422, "invalid")
    effective_start = (body.quiet_start if "quiet_start" in fields_set
                        else member.quiet_start)
    effective_end = (body.quiet_end if "quiet_end" in fields_set
                      else member.quiet_end)
    if quiet_mode == "custom":
        if effective_start is None or effective_end is None:
            raise _err(422, "invalid_quiet_hours")
        if effective_start == effective_end:
            raise _err(422, "invalid_quiet_hours")

    if "channels" in fields_set and body.channels is not None:
        caps = capabilities(person, has_account)
        allowed = {ch for ch, cap_key in CHANNEL_CAPABILITY.items() if caps[cap_key]}
        if not set(body.channels) <= allowed:
            raise _err(422, "channel_unavailable")

    data = body.model_dump(exclude_unset=True)
    fields = list(data.keys())
    before = snapshot(member, fields)
    for field, value in data.items():
        setattr(member, field, value)
    changes = diff(before, snapshot(member, fields))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="notification_group",
              entity_id=str(group_id), action="member.update", changes=changes)
    await db.commit()
    return _member_out(group, member, person, has_account)


@router.delete("/groups/{group_id}/members/{person_id}", status_code=204)
async def remove_member(
    group_id: uuid.UUID,
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> None:
    member = await _get_member(db, group_id, person_id)
    audit(db, actor_id=actor.person.id, entity_type="notification_group",
          entity_id=str(group_id), action="member.remove",
          changes={"person_id": str(person_id)})
    await db.delete(member)
    await db.commit()


@router.get("/recipients", response_model=list[NotificationRecipientOut])
async def list_recipients(
    db: DbSession,
    _actor: AuthContext = require_permission("notifications", "change"),
) -> list[NotificationRecipientOut]:
    rows = (await db.execute(
        select(Person, UserAccount.person_id)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.archived_at.is_(None))
        .order_by(Person.last_name, Person.first_name))).all()
    out = []
    for person, account_id in rows:
        has_account = account_id is not None
        caps = capabilities(person, has_account)
        out.append(NotificationRecipientOut(
            person_id=person.id, display_name=person.display_name,
            job_title=person.job_title, avatar_url=presign_get(person.avatar_key),
            email=person.email, phone=person.phone, has_account=has_account,
            **caps))
    return out


# ── in-app inbox (any signed-in person; no resource permission) ──────

INBOX_LIMIT = 50


@router.get("/inbox", response_model=NotificationInboxOut)
async def inbox(user: CurrentUser, db: DbSession,
                unread_only: bool = False) -> NotificationInboxOut:
    base = select(Notification).where(Notification.person_id == user.person.id)
    unread = await db.scalar(
        select(func.count()).select_from(Notification).where(
            Notification.person_id == user.person.id, Notification.read_at.is_(None)))
    q = base.order_by(Notification.created_at.desc()).limit(INBOX_LIMIT)
    if unread_only:
        q = q.where(Notification.read_at.is_(None))
    items = (await db.scalars(q)).all()
    return NotificationInboxOut(unread_count=int(unread or 0), items=items)


@router.post("/inbox/{notification_id}/read", status_code=204)
async def inbox_mark_read(notification_id: uuid.UUID, user: CurrentUser,
                          db: DbSession) -> Response:
    row = await db.scalar(select(Notification).where(
        Notification.id == notification_id,
        Notification.person_id == user.person.id))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "notification_not_found"})
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
        await db.commit()
    return Response(status_code=204)


@router.post("/inbox/read-all", status_code=204)
async def inbox_mark_all_read(user: CurrentUser, db: DbSession) -> Response:
    rows = (await db.scalars(select(Notification).where(
        Notification.person_id == user.person.id,
        Notification.read_at.is_(None)))).all()
    now = datetime.now(UTC)
    for row in rows:
        row.read_at = now
    await db.commit()
    return Response(status_code=204)
