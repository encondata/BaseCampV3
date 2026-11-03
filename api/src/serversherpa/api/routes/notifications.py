"""Notification groups: a named list of people (name, description, Active or
Paused), its members, and the join and leave requests an admin approves. A group
decides nothing about delivery (a person's own switches and schedule do,
notifications/email.py), so it has no channels, quiet hours or member overrides;
what it hears about is its watches (listed, added, changed and removed here, each change
audited on the group), and it carries no categories.
This file also hosts the per-person in-app inbox routes (/inbox, mark-one-read,
mark-all-read), the company notification settings (/settings: anyone signed in
reads them, admins and above change them) and, for super admins and above, the
delivery log (/log), Check delivery (/check) and the kinds it picks from (/kinds)."""

import base64
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import AwareDatetime
from sqlalchemy import func, or_, select, tuple_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import aliased

from serversherpa.api.deps import (
    AuthContext, CurrentUser, DbSession, ensure_admin, ensure_super_admin,
    require_permission,
)
from serversherpa.api.schemas import (
    DeliveryCheckOut, DeliveryLogEntryOut, DeliveryLogPageOut,
    MembershipDecisionIn, MembershipRequestOut, NotificationGroupCreateIn,
    NotificationGroupDetailOut, NotificationGroupOut, NotificationGroupPatchIn,
    NotificationInboxItemOut, NotificationInboxOut, NotificationKindOut,
    NotificationKindSettingOut, NotificationMemberAddIn, NotificationMemberOut,
    NotificationRecipientOut, NotificationSettingsIn, NotificationSettingsOut, SwitchPair,
    WatchIn, WatchKindsIn, WatchOut,
)
from serversherpa.db.models import (
    EmailOutbox, Notification, NotificationGroup, NotificationGroupMember,
    NotificationLog, NotificationMembershipRequest, NotificationWatch, Person,
    SystemConfig, UserAccount,
)
from serversherpa.db.ordering import natural
from serversherpa.notifications import check as delivery_check
from serversherpa.notifications.company import (
    CONFIGURABLE_CATEGORIES, SECTION as COMPANY_SECTION, SECURITY_CATEGORY,
    CompanySettings, Switches, critical_eligible, is_critical, load_company_settings,
)
from serversherpa.notifications.delivery_log import EVENTS
from serversherpa.notifications.kinds import CATEGORY_KEYS, KINDS, kind_info
from serversherpa.notifications.requests import RequestError, decide_request
from serversherpa.notifications.watches import (
    EVERYTHING, WatchError, add_watch, clean_kinds, group_watches, thing_of, watch_view,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from serversherpa.services.storage import presign_get

router = APIRouter(prefix="/notifications", tags=["notifications"])

GROUP_FIELDS = ["name", "description", "enabled"]

# Every group field is NOT NULL: an explicit null in a PATCH body must 422 here,
# not IntegrityError at commit.
NON_NULLABLE_GROUP_FIELDS = frozenset(GROUP_FIELDS)


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


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
        enabled=group.enabled, member_count=member_count, created_at=group.created_at)


# ── members, recipients ────────────────────────────────────────────


def capabilities(person: Person, has_account: bool, *,
                 account_email: str | None) -> dict[str, bool]:
    """What a person is actually reachable on. Drives the recipients picker
    (GET /recipients). Email needs a profile email or a sign-in email
    (`account_email`, None without an account): the sender falls back to the
    sign-in one. Required and by name, so no caller can leave it out and
    misreport a sign-in-only person as unreachable."""
    return {"can_email": bool(person.email or account_email),
            "can_text": person.phone is not None,
            "can_push": has_account, "can_web": has_account}


def _member_out(member: NotificationGroupMember, person: Person,
                account_email: str | None) -> NotificationMemberOut:
    """`account_email` is the person's sign-in email, None without an account
    (every account has one)."""
    return NotificationMemberOut(
        person_id=person.id, display_name=person.display_name,
        job_title=person.job_title, avatar_url=presign_get(person.avatar_key),
        email=person.email, phone=person.phone, has_account=account_email is not None,
        added_at=member.added_at)


async def _account_email(db: DbSession, person_id: uuid.UUID) -> str | None:
    """The person's sign-in email; None when they have no account."""
    return await db.scalar(select(UserAccount.email).where(
        UserAccount.person_id == person_id))


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
        .order_by(natural(NotificationGroup.name)))).all()
    return [_out(group, count) for group, count in rows]


@router.post("/groups", response_model=NotificationGroupOut, status_code=201)
async def create_group(
    body: NotificationGroupCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "add"),
) -> NotificationGroupOut:
    exists = await db.scalar(select(NotificationGroup.id).where(
        NotificationGroup.name == body.name))
    if exists:
        raise _err(409, "group_exists")

    group = NotificationGroup(**body.model_dump(), created_by=actor.person.id)
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
        select(NotificationGroupMember, Person, UserAccount.email)
        .join(Person, Person.id == NotificationGroupMember.person_id)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(NotificationGroupMember.group_id == group_id)
        .order_by(natural(Person.last_name), natural(Person.first_name)))).all()
    members = [_member_out(member, person, account_email)
               for member, person, account_email in rows]
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
    await _get_group(db, group_id)          # 404 group_not_found
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
    return _member_out(member, person, await _account_email(db, person.id))


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


# ── a group's watches: what its members hear about ──────────────────
# A group watches what a person can (notifications/watches.py), and every member of an
# Active group hears it. notifications:view lists the watches, notifications:change edits
# them, and each edit is audited on the group. A WatchError becomes the same {"code"}
# answer as elsewhere here.

def _watch_target(watch: NotificationWatch) -> dict:
    """What a watch is on, as the audit records it: its kind of thing and the thing's id,
    or "everything" with no id."""
    thing = thing_of(watch)
    if thing is None:
        return {"thing": EVERYTHING, "thing_id": None}
    return {"thing": thing.type, "thing_id": str(thing.id)}


async def _get_watch(db: DbSession, group_id: uuid.UUID,
                     watch_id: uuid.UUID) -> NotificationWatch:
    """One of the group's watches. Another group's, a person's own or none is a 404."""
    watch = await db.get(NotificationWatch, watch_id)
    if watch is None or watch.group_id != group_id:
        raise _err(404, "watch_not_found")
    return watch


@router.get("/groups/{group_id}/watches", response_model=list[WatchOut])
async def list_group_watches(
    group_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "view"),
) -> list[WatchOut]:
    """What the group watches, newest first: the watches whose thing the asker can open now,
    as /auth/me/watches lists them. A global role is not row-scoped, but the wiki's grants and
    private items still hide things from it, so a watch on one it can't see is left out, name
    and all."""
    await _get_group(db, group_id)          # 404 group_not_found
    return [WatchOut.from_view(view)
            for view in await group_watches(db, group_id, actor.person.id)]


@router.post("/groups/{group_id}/watches", response_model=WatchOut, status_code=201)
async def add_group_watch(
    group_id: uuid.UUID,
    body: WatchIn,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> WatchOut:
    """Point the group at a thing the admin can open, or at chosen events everywhere. One
    watch per thing: adding again is a 409, and the events are changed on the watch that is
    there."""
    group = await _get_group(db, group_id)
    try:
        watch = await add_watch(
            db, thing=body.thing, thing_id=body.id, kinds=body.kinds,
            viewer_id=actor.person.id, viewer_access=actor.access,
            created_by=actor.person.id, group_id=group_id)
        view = await watch_view(db, watch, group=group)
    except WatchError as e:
        raise _err(e.status, e.code) from None
    audit(db, actor_id=actor.person.id, entity_type="notification_group",
          entity_id=str(group_id), action="watch.add",
          changes={**_watch_target(watch), "kinds": list(watch.kinds)})
    await db.commit()
    return WatchOut.from_view(view)


@router.patch("/groups/{group_id}/watches/{watch_id}", response_model=WatchOut)
async def update_group_watch(
    group_id: uuid.UUID,
    watch_id: uuid.UUID,
    body: WatchKindsIn,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> WatchOut:
    """Choose the events of one of the group's watches; none means every event that applies
    to a thing (an Everything watch has to name some). Choosing the events it already has
    changes nothing and is not audited."""
    group = await _get_group(db, group_id)
    watch = await _get_watch(db, group_id, watch_id)
    thing = thing_of(watch)
    before = list(watch.kinds)
    try:
        watch.kinds = clean_kinds(thing.type if thing is not None else EVERYTHING, body.kinds)
        view = await watch_view(db, watch, group=group)
    except WatchError as e:
        raise _err(e.status, e.code) from None
    if watch.kinds != before:
        audit(db, actor_id=actor.person.id, entity_type="notification_group",
              entity_id=str(group_id), action="watch.update",
              changes={**_watch_target(watch),
                       "kinds": {"from": before, "to": list(watch.kinds)}})
    await db.commit()
    return WatchOut.from_view(view)


@router.delete("/groups/{group_id}/watches/{watch_id}", status_code=204)
async def remove_group_watch(
    group_id: uuid.UUID,
    watch_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> None:
    """Stop the group watching this. Any watch of the group can go."""
    await _get_group(db, group_id)          # 404 group_not_found
    watch = await _get_watch(db, group_id, watch_id)
    audit(db, actor_id=actor.person.id, entity_type="notification_group",
          entity_id=str(group_id), action="watch.remove", changes=_watch_target(watch))
    await db.delete(watch)
    await db.commit()


# ── membership requests: approval (gated notifications:change) ───────
# Self-service creation/cancellation lives under /auth/me (routes/me.py),
# which imports `_request_out` from here so both routers share one shape.

def _request_out(req: NotificationMembershipRequest, group_name: str,
                  person_name: str,
                  decided_by_name: str | None = None) -> MembershipRequestOut:
    return MembershipRequestOut(
        id=req.id, group_id=req.group_id, group_name=group_name,
        person_id=req.person_id, person_name=person_name, action=req.action,
        status=req.status, note=req.note, decided_by_name=decided_by_name,
        decided_at=req.decided_at, decision_note=req.decision_note,
        created_at=req.created_at)


@router.get("/requests", response_model=list[MembershipRequestOut])
async def list_requests(
    db: DbSession,
    status: str = "pending",
    _actor: AuthContext = require_permission("notifications", "change"),
) -> list[MembershipRequestOut]:
    # one query: join group + requester + decider rather than resolving
    # names per row.
    Requester = aliased(Person)
    Decider = aliased(Person)
    rows = (await db.execute(
        select(NotificationMembershipRequest, NotificationGroup.name,
               Requester, Decider)
        .join(NotificationGroup,
              NotificationGroup.id == NotificationMembershipRequest.group_id)
        .join(Requester, Requester.id == NotificationMembershipRequest.person_id)
        .outerjoin(Decider, Decider.id == NotificationMembershipRequest.decided_by)
        .where(NotificationMembershipRequest.status == status)
        .order_by(NotificationMembershipRequest.created_at.desc()))).all()
    return [_request_out(req, group_name, requester.display_name,
                         decider.display_name if decider is not None else None)
            for req, group_name, requester, decider in rows]


async def _decide(db: DbSession, request_id: uuid.UUID, actor: Person, *,
                  approve: bool, note: str) -> MembershipRequestOut:
    try:
        req = await decide_request(db, request_id=request_id, actor=actor,
                                   approve=approve, note=note)
    except RequestError as e:
        raise _err(e.status, e.code) from None
    await db.commit()
    group = await db.get(NotificationGroup, req.group_id)
    person = await db.get(Person, req.person_id)
    return _request_out(req, group.name if group is not None else "",
                        person.display_name if person is not None else "",
                        actor.display_name)


@router.post("/requests/{request_id}/approve", response_model=MembershipRequestOut)
async def approve_request(
    request_id: uuid.UUID,
    body: MembershipDecisionIn,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> MembershipRequestOut:
    return await _decide(db, request_id, actor.person, approve=True, note=body.note)


@router.post("/requests/{request_id}/reject", response_model=MembershipRequestOut)
async def reject_request(
    request_id: uuid.UUID,
    body: MembershipDecisionIn,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> MembershipRequestOut:
    return await _decide(db, request_id, actor.person, approve=False, note=body.note)


@router.get("/recipients", response_model=list[NotificationRecipientOut])
async def list_recipients(
    db: DbSession,
    _actor: AuthContext = require_permission("notifications", "change"),
) -> list[NotificationRecipientOut]:
    rows = (await db.execute(
        select(Person, UserAccount.email)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.archived_at.is_(None),
               Person.source != KIOSK_MOVE_SOURCE)   # a move's hidden kiosk identity
        .order_by(natural(Person.last_name), natural(Person.first_name)))).all()
    out = []
    for person, account_email in rows:
        has_account = account_email is not None
        caps = capabilities(person, has_account, account_email=account_email)
        out.append(NotificationRecipientOut(
            person_id=person.id, display_name=person.display_name,
            job_title=person.job_title, avatar_url=presign_get(person.avatar_key),
            email=person.email, phone=person.phone, has_account=has_account,
            **caps))
    return out


# ── in-app inbox (any signed-in person; no resource permission) ──────

INBOX_LIMIT = 50        # default page size, and the bell's
INBOX_MAX_LIMIT = 100


def _own_live(user: CurrentUser, notification_id: uuid.UUID):
    return select(Notification).where(
        Notification.id == notification_id,
        Notification.person_id == user.person.id,
        Notification.dismissed_at.is_(None))


def _encode_inbox_cursor(created_at: datetime, id: uuid.UUID) -> str:
    """The cursor for the row a page ended on: base64url, unpadded, of
    "<created_at ISO>|<id>". Clients pass it back verbatim as `cursor`."""
    stamp = created_at.astimezone(UTC).isoformat()
    return base64.urlsafe_b64encode(f"{stamp}|{id}".encode()).decode().rstrip("=")


def _decode_inbox_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    """(created_at, id) of the row the previous page ended on. Anything
    `_encode_inbox_cursor` could not have made is a 422 `invalid_cursor`,
    including a timestamp with no UTC offset (it would be read as local time)."""
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        stamp, separator, row_id = raw.partition("|")
        created_at = datetime.fromisoformat(stamp)
        if not separator or created_at.tzinfo is None:
            raise ValueError(cursor)
        return created_at.astimezone(UTC), uuid.UUID(row_id)
    except (ValueError, OverflowError):
        raise _err(422, "invalid_cursor") from None


def _inbox_item(row: Notification) -> NotificationInboxItemOut:
    """The row as the API shows it, with its kind's registry category."""
    info = kind_info(row.kind)
    return NotificationInboxItemOut.model_validate(row).model_copy(
        update={"category": info.category if info else None})


@router.get("/inbox", response_model=NotificationInboxOut)
async def inbox(user: CurrentUser, db: DbSession, unread_only: bool = False,
                category: str | None = None, cursor: str | None = None,
                limit: int = INBOX_LIMIT) -> NotificationInboxOut:
    """The person's live (not hidden) notifications, newest first, a page at a
    time. `limit` is clamped to 1..100; `category` is a kinds-registry category
    (a kind the registry does not list belongs to none, so it only shows
    unfiltered); `cursor` is the previous page's `next_cursor`. The bell calls
    this with no parameters and gets its 50 newest."""
    if category is not None and category not in CATEGORY_KEYS:
        raise _err(422, "invalid_category")
    after = _decode_inbox_cursor(cursor) if cursor is not None else None
    limit = max(1, min(limit, INBOX_MAX_LIMIT))

    live = (Notification.person_id == user.person.id, Notification.dismissed_at.is_(None))
    filters = []
    if unread_only:
        filters.append(Notification.read_at.is_(None))
    if category is not None:
        filters.append(Notification.kind.in_(
            [kind for kind, info in KINDS.items() if info.category == category]))
    # Both counts in one statement over the live rows, so the bell's poll reads
    # the inbox twice (counts, page): the overall unread count, whatever the
    # filters, and the total the filters leave.
    unread, total = (await db.execute(
        select(func.count().filter(Notification.read_at.is_(None)),
               func.count().filter(*filters) if filters else func.count())
        .select_from(Notification).where(*live))).one()

    q = select(Notification).where(*live, *filters)
    if after is not None:
        # a row comparison on the full sort key: rows sharing a created_at are
        # neither skipped nor repeated across the page boundary
        q = q.where(tuple_(Notification.created_at, Notification.id) < tuple_(*after))
    rows = (await db.scalars(
        q.order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(limit + 1))).all()          # one past the page: is there another?
    page = rows[:limit]
    next_cursor = (_encode_inbox_cursor(page[-1].created_at, page[-1].id)
                   if len(rows) > limit else None)
    return NotificationInboxOut(
        unread_count=int(unread or 0), items=[_inbox_item(row) for row in page],
        next_cursor=next_cursor, total=int(total or 0))


@router.post("/inbox/{notification_id}/read", status_code=204)
async def inbox_mark_read(notification_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    row = await db.scalar(_own_live(user, notification_id))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "notification_not_found"})
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
        await db.commit()
    return Response(status_code=204)


@router.post("/inbox/{notification_id}/unread", status_code=204)
async def inbox_mark_unread(notification_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    row = await db.scalar(_own_live(user, notification_id))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "notification_not_found"})
    if row.read_at is not None:
        row.read_at = None
        await db.commit()
    return Response(status_code=204)


@router.delete("/inbox/{notification_id}", status_code=204)
async def inbox_hide(notification_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    """Soft dismiss: the row is kept (retention policy TBD), just hidden."""
    row = await db.scalar(select(Notification).where(
        Notification.id == notification_id, Notification.person_id == user.person.id))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "notification_not_found"})
    if row.dismissed_at is None:
        row.dismissed_at = datetime.now(UTC)
        await db.commit()
    return Response(status_code=204)


@router.post("/inbox/read-all", status_code=204)
async def inbox_mark_all_read(user: CurrentUser, db: DbSession) -> Response:
    rows = (await db.scalars(select(Notification).where(
        Notification.person_id == user.person.id, Notification.dismissed_at.is_(None),
        Notification.read_at.is_(None)))).all()
    now = datetime.now(UTC)
    for row in rows:
        row.read_at = now
    await db.commit()
    return Response(status_code=204)


@router.post("/inbox/clear-read", status_code=204)
async def inbox_clear_read(user: CurrentUser, db: DbSession) -> Response:
    rows = (await db.scalars(select(Notification).where(
        Notification.person_id == user.person.id, Notification.dismissed_at.is_(None),
        Notification.read_at.is_not(None)))).all()
    now = datetime.now(UTC)
    for row in rows:
        row.dismissed_at = now
    await db.commit()
    return Response(status_code=204)


# ── delivery log + Check delivery (super admin and above) ─────────────
# Gated notifications:view, then ensure_super_admin: every decision names
# people, and an email's entry shows the address it went to.

LOG_LIMIT = 100         # default page size
LOG_MAX_LIMIT = 500
_MAX_LOG_ID = 2**63 - 1     # notification_log.id is a bigint

# The same text as Person.display_name, NULL for an entry that names no
# person (`||` keeps the NULL where concat() would make it " ").
_PERSON_NAME = (func.coalesce(func.nullif(Person.preferred_name, ""), Person.first_name)
                + " " + Person.last_name)


def _decode_log_cursor(cursor: str) -> int:
    """The id the previous page ended on: `next_cursor` is that id as text.
    Anything else is a 422 `invalid_cursor`."""
    try:
        after = int(cursor)
    except ValueError:
        raise _err(422, "invalid_cursor") from None
    if not 1 <= after <= _MAX_LOG_ID:
        raise _err(422, "invalid_cursor")
    return after


def _log_entry(entry: NotificationLog, person_name: str | None, title: str | None,
               link: str | None, to_address: str | None,
               outbox_status: str | None) -> DeliveryLogEntryOut:
    """One row as the Delivery log shows it; the address and status come
    from the outbox row the entry points at."""
    info = kind_info(entry.kind) if entry.kind else None
    return DeliveryLogEntryOut(
        id=entry.id, at=entry.at, event=entry.event, channel=entry.channel,
        reason=entry.reason, kind=entry.kind,
        kind_label=info.label if info else entry.kind,
        category=entry.category, detail=entry.detail, process=entry.process,
        person_id=entry.person_id, person_name=person_name,
        notification_id=entry.notification_id, notification_title=title,
        notification_link=link, outbox_id=entry.outbox_id,
        to_address=to_address, outbox_status=outbox_status)


def _with_names(stmt):
    """`stmt` over the log, outer-joined to the person, notification and
    outbox email each entry points at (at most one of each)."""
    return (stmt.select_from(NotificationLog)
            .outerjoin(Person, Person.id == NotificationLog.person_id)
            .outerjoin(Notification, Notification.id == NotificationLog.notification_id)
            .outerjoin(EmailOutbox, EmailOutbox.id == NotificationLog.outbox_id))


@router.get("/log", response_model=DeliveryLogPageOut)
async def delivery_log(
    db: DbSession,
    cursor: str | None = None,
    limit: int = Query(LOG_LIMIT, ge=1, le=LOG_MAX_LIMIT),
    q: str = "",
    event: list[str] | None = Query(None),
    channel: str | None = None,
    category: str | None = None,
    since: AwareDatetime | None = None,
    person_id: uuid.UUID | None = None,
    notification_id: uuid.UUID | None = None,
    outbox_id: uuid.UUID | None = None,
    actor: AuthContext = require_permission("notifications", "view"),
) -> DeliveryLogPageOut:
    """Every notification and email decision, newest first, a page at a time
    (`cursor` is the previous page's `next_cursor`). `q` finds literal text in
    the person's name, the notification's title or the kind (the template,
    for mail that mirrors no notification); `event` may repeat, each one of
    the log's events; `since` is an aware time. Super admin and above."""
    ensure_super_admin(actor)
    if event and not set(event) <= set(EVENTS):
        raise _err(422, "invalid_event")
    after = _decode_log_cursor(cursor) if cursor is not None else None

    shown = []
    if event:
        shown.append(NotificationLog.event.in_(event))
    for column, value in ((NotificationLog.channel, channel),
                          (NotificationLog.category, category),
                          (NotificationLog.person_id, person_id),
                          (NotificationLog.notification_id, notification_id),
                          (NotificationLog.outbox_id, outbox_id)):
        if value is not None:
            shown.append(column == value)
    if since is not None:
        shown.append(NotificationLog.at >= since)
    if needle := q.strip():
        # literal text: its %, _ and backslashes are not wildcards
        escaped = needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        shown.append(or_(*(column.ilike(f"%{escaped}%", escape="\\") for column in
                           (_PERSON_NAME, Notification.title, NotificationLog.kind))))
    total = await db.scalar(_with_names(select(func.count())).where(*shown))

    query = _with_names(select(
        NotificationLog, _PERSON_NAME, Notification.title, Notification.link,
        EmailOutbox.to_address, EmailOutbox.status)).where(*shown)
    if after is not None:
        query = query.where(NotificationLog.id < after)
    rows = (await db.execute(
        query.order_by(NotificationLog.id.desc()).limit(limit + 1))).all()
    page = rows[:limit]                    # one past the page: is there another?
    return DeliveryLogPageOut(
        rows=[_log_entry(*row) for row in page],
        next_cursor=str(page[-1][0].id) if len(rows) > limit else None,
        total=int(total or 0))


@router.get("/check", response_model=DeliveryCheckOut)
async def check_delivery(
    db: DbSession,
    person_id: uuid.UUID,
    kind: str,
    owner_copy: bool | None = None,
    actor: AuthContext = require_permission("notifications", "view"),
) -> DeliveryCheckOut:
    """What would happen right now if this person got a notification of this
    registered kind: the inbox row, the email's outcome (now, held for their
    summary, or not sent) and why, the address, their switches for the
    category and where each comes from, their schedule, and whether the kind
    is critical. Writes nothing. For a kind the account owner always receives,
    `owner_copy=false` models an admin's copy instead of the owner's. Super
    admin and above."""
    ensure_super_admin(actor)
    if kind not in KINDS:
        raise _err(422, "invalid_kind")
    if await db.get(Person, person_id) is None:
        raise _err(404, "person_not_found")
    return DeliveryCheckOut(**await delivery_check.check_delivery(
        db, person_id, kind, owner_copy=owner_copy, now=datetime.now(UTC)))


def _kind_flags(company: CompanySettings) -> list[dict]:
    """Every registered kind in registry order with its flags: whether it is
    ever emailed, whether it is critical (account security always; any other
    kind once an admin marked it), whether that is locked (security), and what
    a watch can do with it (watchable, the things it reaches, everywhere)."""
    return [{"kind": kind, "label": info.label, "category": info.category,
             "email": info.email, "owner_always": info.owner_always,
             "critical": is_critical(kind, company),
             "locked": info.category == SECURITY_CATEGORY,
             "watchable": info.watchable, "everywhere": info.everywhere,
             "reaches": list(info.reaches)}
            for kind, info in KINDS.items()]


@router.get("/kinds", response_model=list[NotificationKindOut])
async def list_kinds(
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "view"),
) -> list[NotificationKindOut]:
    """The registered notification kinds in registry order, for Check
    delivery's picker, each with whether it is critical and whether that is
    locked. Super admin and above."""
    ensure_super_admin(actor)
    return [NotificationKindOut(**flags)
            for flags in _kind_flags(await load_company_settings(db))]


# ── company settings (anyone signed in reads; admin and above changes) ─────
# The switches a person follows until they change their own, and the kinds an
# admin marked critical (notifications/company.py). /me shows both.

def _stored_settings(company: CompanySettings) -> dict:
    """The settings in the shape the `notifications` section stores and the
    audit records: every configurable category, the marked kinds in registry
    order."""
    return {"defaults": {category: {"inbox": switches.inbox, "email": switches.email}
                         for category, switches in company.defaults.items()},
            "critical_kinds": [kind for kind in KINDS if kind in company.critical_kinds]}


def _settings_out(company: CompanySettings) -> NotificationSettingsOut:
    stored = _stored_settings(company)
    return NotificationSettingsOut(
        defaults={category: SwitchPair(**pair) for category, pair in stored["defaults"].items()},
        critical_kinds=stored["critical_kinds"],
        kinds=[NotificationKindSettingOut(**flags) for flags in _kind_flags(company)])


@router.get("/settings", response_model=NotificationSettingsOut)
async def get_notification_settings(
    _user: CurrentUser,
    db: DbSession,
) -> NotificationSettingsOut:
    """The company defaults, the critical kinds an admin marked, and every
    registered kind with its flags: what /me needs to say what a switch follows
    and which notifications skip quiet hours. Any signed-in person."""
    return _settings_out(await load_company_settings(db))


@router.put("/settings", response_model=NotificationSettingsOut)
async def put_notification_settings(
    body: NotificationSettingsIn,
    db: DbSession,
    actor: AuthContext = require_permission("notifications", "change"),
) -> NotificationSettingsOut:
    """Change the company defaults and/or the critical kinds, and answer with
    the whole settings. `defaults` merges per category; `critical_kinds`
    replaces the list (de-duplicated, in registry order). Admin and above.
    422 `invalid_category` for a default of a category that has none (account
    security included), `invalid_kind` for a critical kind that is
    unregistered, never emailed or account security. Frozen by read-only mode
    like every other write."""
    ensure_admin(actor)
    if body.defaults is not None and not body.defaults.keys() <= set(CONFIGURABLE_CATEGORIES):
        raise _err(422, "invalid_category")
    if body.critical_kinds is not None and not all(
            critical_eligible(kind) for kind in body.critical_kinds):
        raise _err(422, "invalid_kind")

    # The section's row, created if missing and locked for this transaction: a
    # partial save is read-merge-write, and two of them (a category each) must
    # not overwrite each other, nor two first saves collide on the insert.
    await db.execute(pg_insert(SystemConfig).values(section=COMPANY_SECTION, data={})
                     .on_conflict_do_nothing(index_elements=[SystemConfig.section]))
    row = await db.get(SystemConfig, COMPANY_SECTION, with_for_update=True,
                       populate_existing=True)

    before = await load_company_settings(db)
    defaults = dict(before.defaults)
    if body.defaults is not None:
        defaults.update({category: Switches(pair.inbox, pair.email)
                         for category, pair in body.defaults.items()})
    after = CompanySettings(
        defaults=defaults,
        critical_kinds=(before.critical_kinds if body.critical_kinds is None
                        else frozenset(body.critical_kinds)))

    old, new = _stored_settings(before), _stored_settings(after)
    row.data = new
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor.person.id
    changes = {key: {"from": old[key], "to": new[key]} for key in new if old[key] != new[key]}
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="system", entity_id=COMPANY_SECTION,
              action="notifications_config_update", changes=changes)
    await db.commit()
    return _settings_out(after)
