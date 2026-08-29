"""Notification groups CRUD. A group carries the default delivery
channels, quiet hours, active days, and DND behavior for its members.
Task 2 adds member endpoints (with per-member overrides); the React UI
is a later task still — this file is groups-only.

CHANNELS/DAYS are the source of truth other modules (the future
notification sender, Task 2's member validation) should import from."""

import uuid
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    NotificationGroupCreateIn, NotificationGroupOut, NotificationGroupPatchIn,
)
from serversherpa.db.models import NotificationGroup, NotificationGroupMember
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/notifications", tags=["notifications"])

CHANNELS: tuple[str, ...] = ("email", "text", "push", "web")
DAYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

GROUP_FIELDS = ["name", "description", "channels", "quiet_start", "quiet_end",
                "timezone", "active_days", "dnd_behavior", "urgent_bypass",
                "enabled"]


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def validate_settings(body) -> None:
    """Shared settings validation for group create/patch (and Task 2's
    member override patch) — duck-typed on whichever of these attributes
    the given body carries, so callers can pass any object that has some
    subset of them."""
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

    quiet_start = getattr(body, "quiet_start", None)
    quiet_end = getattr(body, "quiet_end", None)
    if (quiet_start is None) != (quiet_end is None):
        raise _err(422, "invalid_quiet_hours")
    if quiet_start is not None and quiet_start == quiet_end:
        raise _err(422, "invalid_quiet_hours")


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
    validate_settings(body)
    data = body.model_dump(exclude_unset=True)

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
