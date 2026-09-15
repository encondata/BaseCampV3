"""Users directory — people who can log in. Staff/admin only."""

from datetime import UTC, datetime

import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.effective import effective_cells
from serversherpa.access.resolver import can_touch_rank
from serversherpa.access.resources import REGISTRY
from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import (
    AuthContext, DbSession, require_password_length, require_permission,
)
from serversherpa.api.routes.notifications import effective_settings
from serversherpa.api.schemas import (
    AccountCreateIn,
    OrgRefOut,
    PartnerRef,
    PersonDetail,
    PersonRef,
    ProfileUpdateIn,
    ResetPasswordIn,
    RolesUpdateIn,
    UserAccessBlock,
    UserAccessGroupRow,
    UserCreateIn,
    UserDetailAccount,
    UserDetailOut,
    UserDetailPerson,
    UserItem,
    UserNotificationGroup,
    UserOverrideRow,
    UserRoleGrant,
    UserSessionRow,
    UserWorkerCard,
)
from serversherpa.config import get_settings
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, AuthSession, Client, NotificationGroup,
    NotificationGroupMember, Partner, PermissionOverride, Person, PersonRole,
    ResourceGroupGate, Role, UserAccount, WorkerLevel, WorkerProfile,
)
from serversherpa.security.passwords import hash_password
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.sessions import live_session_rows
from serversherpa.services.storage import presign_get
from serversherpa.status.labels import level_colors, level_fields, status_fields, status_labels
from sqlalchemy.exc import IntegrityError as _IntegrityError  # noqa: F401 (re-exported name kept)

router = APIRouter(prefix="/users", tags=["users"])


def _status(account: UserAccount, now: datetime) -> str:
    if account.disabled_at is not None:
        return "disabled"
    if account.locked_until is not None and account.locked_until > now:
        return "locked"
    return "active"


@router.get("", response_model=list[UserItem])
async def list_users(
    db: DbSession,
    actor: AuthContext = require_permission("users", "view"),
) -> list[UserItem]:
    now = datetime.now(UTC)

    query = (
        select(Person, UserAccount)
        .join(UserAccount, UserAccount.person_id == Person.id)
        .order_by(Person.last_name, Person.first_name)
    )
    cond = scope_conditions("users", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    rows = (await db.execute(query)).all()

    person_ids = [p.id for p, _ in rows]
    role_rows = (await db.execute(
        select(PersonRole.person_id, PersonRole.role, Role.rank)
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.person_id.in_(person_ids or [None]),
               PersonRole.revoked_at.is_(None))
        .order_by(PersonRole.role)
    )).all()
    roles_by_person: dict = {}
    rank_by_person: dict = {}
    for pid, role, rank in role_rows:
        roles_by_person.setdefault(pid, []).append(role)
        rank_by_person[pid] = max(rank_by_person.get(pid, 0), rank)

    return [  # noqa: C416 — explicit construction keeps the mapping obvious
        UserItem(
            person_id=person.id,
            first_name=person.first_name,
            last_name=person.last_name,
            preferred_name=person.preferred_name,
            display_name=person.display_name,
            job_title=person.job_title,
            phone=person.phone,
            contact_email=person.email,
            login_email=account.email,
            roles=roles_by_person.get(person.id, []),
            status=_status(account, now),
            must_change_password=account.must_change_password,
            last_login_at=account.last_login_at,
            account_created_at=account.created_at,
            archived_at=person.archived_at,
            max_rank=rank_by_person.get(person.id, 0),
            avatar_url=presign_get(person.avatar_key),
        )
        for person, account in rows
    ]


async def _person_refs(db: DbSession, ids: set) -> dict:
    """id -> PersonRef for a batch of granter/adder/setter ids (None dropped)."""
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    people = await db.scalars(select(Person).where(Person.id.in_(wanted)))
    return {p.id: PersonRef(id=p.id, display_name=p.display_name) for p in people}


async def _org_refs(db: DbSession, client_ids: set, partner_ids: set) -> dict:
    """(kind, id) -> OrgRefOut."""
    out: dict = {}
    if client_ids:
        for cid, name in (await db.execute(
                select(Client.id, Client.name).where(Client.id.in_(client_ids)))).all():
            out[("client", cid)] = OrgRefOut(kind="client", id=cid, name=name)
    if partner_ids:
        for pid, name in (await db.execute(
                select(Partner.id, Partner.name).where(Partner.id.in_(partner_ids)))).all():
            out[("partner", pid)] = OrgRefOut(kind="partner", id=pid, name=name)
    return out


@router.get("/{person_id}", response_model=UserDetailOut)
async def get_user_detail(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("users", "view"),
) -> UserDetailOut:
    """Everything the user detail page shows, in one payload. Row visibility
    matches the list (users:view + scope). The access block keeps the
    Explorer's rank-60 rule; sessions need users:change and a global actor."""
    query = (select(Person, UserAccount)
             .join(UserAccount, UserAccount.person_id == Person.id)
             .where(Person.id == person_id))
    cond = scope_conditions("users", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    row = (await db.execute(query)).first()
    if row is None:
        raise _err(404, "user_not_found")
    person, account = row
    now = datetime.now(UTC)

    # ── roles: active grants with rank, org, granter ──
    grant_rows = (await db.execute(
        select(PersonRole, Role)
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.person_id == person_id, PersonRole.revoked_at.is_(None))
        .order_by(Role.rank.desc(), Role.name))).all()
    orgs = await _org_refs(
        db, {g.client_id for g, _ in grant_rows if g.client_id},
        {g.partner_id for g, _ in grant_rows if g.partner_id})

    # ── worker card ──
    worker: UserWorkerCard | None = None
    profile = await db.get(WorkerProfile, person_id)
    if profile is not None:
        partner = await db.get(Partner, profile.partner_id) if profile.partner_id else None
        level_row = await db.get(WorkerLevel, profile.level) if profile.level else None
        worker = UserWorkerCard(
            trade=profile.trade,
            level_title=level_row.title if level_row else None,
            partner=PartnerRef(id=partner.id, name=partner.name) if partner else None,
            **level_fields(profile.level, await level_colors(db)),
            **status_fields(profile.status, await status_labels(db, "worker")),
        )

    # ── notification groups (enabled only; channels = effective) ──
    ng_rows = (await db.execute(
        select(NotificationGroup, NotificationGroupMember)
        .join(NotificationGroupMember,
              NotificationGroupMember.group_id == NotificationGroup.id)
        .where(NotificationGroupMember.person_id == person_id,
               NotificationGroup.enabled.is_(True))
        .order_by(NotificationGroup.name))).all()
    notification_groups = [
        UserNotificationGroup(id=g.id, name=g.name,
                              channels=effective_settings(g, m)["channels"],
                              added_at=m.added_at)
        for g, m in ng_rows]

    # ── access block (rank-60 rule, same as /access/effective) ──
    access_block: UserAccessBlock | None = None
    can_see_access = actor.access.can("access", "view") and (
        actor.access.max_rank >= GATE_BYPASS_RANK or person_id == actor.person.id)
    override_rows: list[PermissionOverride] = []
    group_member_rows: list = []
    if can_see_access:
        eff = await effective_cells(db, person_id)
        group_member_rows = (await db.execute(
            select(AccessGroup, AccessGroupMember)
            .join(AccessGroupMember, AccessGroupMember.group_id == AccessGroup.id)
            .where(AccessGroupMember.person_id == person_id)
            .order_by(AccessGroup.name))).all()
        gates_by_group: dict = {}
        if group_member_rows:
            gids = [g.id for g, _ in group_member_rows]
            for res, gid in (await db.execute(
                    select(ResourceGroupGate.resource, ResourceGroupGate.group_id)
                    .where(ResourceGroupGate.group_id.in_(gids)))).all():
                gates_by_group.setdefault(gid, []).append(res)
        override_rows = list(await db.scalars(
            select(PermissionOverride)
            .where(PermissionOverride.person_id == person_id)
            .order_by(PermissionOverride.resource, PermissionOverride.action)))
        scope_orgs_map = await _org_refs(db, set(eff.access.client_ids),
                                         set(eff.access.partner_ids))

    # one batched name lookup for every "who did it" column
    refs = await _person_refs(
        db,
        {g.granted_by for g, _ in grant_rows}
        | {m.added_by for _, m in group_member_rows}
        | {o.set_by for o in override_rows})

    if can_see_access:
        access_block = UserAccessBlock(
            groups=[UserAccessGroupRow(
                id=g.id, name=g.name, description=g.description,
                gate_count=len(gates_by_group.get(g.id, [])),
                gated_pages=sorted(REGISTRY[r].label for r in gates_by_group.get(g.id, [])
                                   if r in REGISTRY),
                added_by=refs.get(m.added_by), added_at=m.added_at)
                for g, m in group_member_rows],
            overrides=[UserOverrideRow(
                resource=o.resource,
                resource_label=REGISTRY[o.resource].label if o.resource in REGISTRY
                               else o.resource,
                action=o.action, allow=o.allow, set_by=refs.get(o.set_by), set_at=o.set_at)
                for o in override_rows],
            scope=eff.scope,
            scope_orgs=[scope_orgs_map[k] for k in sorted(scope_orgs_map, key=str)],
            cells=eff.cells,
        )

    # ── sessions (admin view) ──
    sessions: list[UserSessionRow] | None = None
    if actor.access.can("users", "change") and actor.access.is_global:
        sessions = [UserSessionRow(**r) for r in await live_session_rows(db, person_id)]

    person_out = UserDetailPerson.model_validate(person)
    person_out.avatar_url = presign_get(person.avatar_key)
    return UserDetailOut(
        person=person_out,
        account=UserDetailAccount(
            login_email=account.email, status=_status(account, now),
            must_change_password=account.must_change_password,
            last_login_at=account.last_login_at, created_at=account.created_at,
            password_updated_at=account.password_updated_at),
        roles=[UserRoleGrant(
            role=role.name, label=role.label or role.name, rank=role.rank,
            scope_anchor=role.scope_anchor,
            org=(orgs.get(("client", g.client_id)) if g.client_id
                 else orgs.get(("partner", g.partner_id)) if g.partner_id else None),
            granted_by=refs.get(g.granted_by), granted_at=g.granted_at)
            for g, role in grant_rows],
        max_rank=max((role.rank for _, role in grant_rows), default=0),
        worker=worker,
        notification_groups=notification_groups,
        access=access_block,
        sessions=sessions,
    )


@router.post("", response_model=UserItem, status_code=201)
async def create_user(
    body: UserCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("users", "add"),
) -> UserItem:
    await _require_global(actor)
    if body.create_account and (not body.login_email or not body.temp_password):
        raise HTTPException(status_code=422, detail={"code": "login_details_required"})
    if body.create_account and body.temp_password:
        require_password_length(body.temp_password)

    desired = set(body.roles)
    current: set[str] = set()
    role_rows = {r.name: r for r in await db.scalars(
        select(Role).where(Role.name.in_(desired or {""})))}
    for name in desired:
        role = role_rows.get(name)
        if role is None:
            raise _err(422, "unknown_role")
        if role.scope_anchor in ("client", "partner"):
            # org-anchored roles need a client/partner selection, which
            # arrives through the org-contact flows, not this endpoint
            raise _err(422, "role_requires_org")
        if name not in current and not can_touch_rank(
                actor.access.max_rank, role.rank):
            raise _err(403, "rank_too_low")

    now = datetime.now(UTC)
    person = Person(
        first_name=body.first_name,
        last_name=body.last_name,
        preferred_name=body.preferred_name,
        email=body.contact_email,
        phone=body.phone,
        job_title=body.job_title,
        source="manual",
        created_by=actor.person.id,
    )
    db.add(person)
    await db.flush()

    account: UserAccount | None = None
    if body.create_account:
        account = UserAccount(
            person_id=person.id,
            email=body.login_email,
            password_hash=hash_password(
                body.temp_password,
                pepper=get_settings().password_pepper.get_secret_value()),
            must_change_password=body.must_change_password,
            password_updated_at=now,
            created_by=actor.person.id,
        )
        db.add(account)

    for role in dict.fromkeys(body.roles):  # dedupe, keep order
        db.add(PersonRole(person_id=person.id, role=role, granted_by=actor.person.id))

    audit(db, actor_id=actor.person.id, entity_type="person",
          entity_id=str(person.id), action="create",
          changes={"first_name": {"from": None, "to": person.first_name},
                   "last_name": {"from": None, "to": person.last_name},
                   "roles": {"from": None, "to": list(dict.fromkeys(body.roles))},
                   "account": {"from": None, "to": bool(body.create_account)}})

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail={"code": "email_in_use"}) from None

    return UserItem(
        person_id=person.id,
        first_name=person.first_name,
        last_name=person.last_name,
        preferred_name=person.preferred_name,
        display_name=person.display_name,
        job_title=person.job_title,
        phone=person.phone,
        contact_email=person.email,
        login_email=account.email if account else None,
        roles=list(dict.fromkeys(body.roles)),
        status="active" if account else "no_account",
        must_change_password=account.must_change_password if account else False,
        last_login_at=None,
        account_created_at=account.created_at if account else None,
        archived_at=None,
    )


# ── admin account management ───────────────────────────────────────
#
# Guard rails: you can never target your own account here (self-service
# endpoints exist for that, and it prevents lock-yourself-out mistakes);
# acting on — or granting a role to — a person whose max rank is not
# strictly below the actor's own rank requires the actor to hold the top
# rank (rank management is "strictly below", except at the very top).


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _actor_can_touch(db: DbSession, actor: AuthContext,
                           person_id: uuid.UUID) -> None:
    target_rank = (await db.scalar(
        select(func.max(Role.rank))
        .join(PersonRole, PersonRole.role == Role.name)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None)))) or 0
    if not can_touch_rank(actor.access.max_rank, target_rank):
        raise _err(403, "rank_too_low")


async def _require_global(actor: AuthContext) -> None:
    """The "users" resource is visible (per resources.py) to "self"-anchored
    actors too, purely so a per-person override can let an external
    contact see their own /external row via users:view. That visibility
    grant is not scope-aware — a users:change/add/delete override handed
    to a non-global actor would otherwise pass require_permission() here
    and reach these endpoints, which enforce rank only (no row scope) and
    so would let e.g. a worker reset any lower-ranked person's password.
    Every mutating endpoint in this router is therefore global-actor-only,
    full stop."""
    if not actor.access.is_global:
        raise _err(403, "forbidden")


async def _load_target(
    db: DbSession, actor: AuthContext, person_id: uuid.UUID,
) -> tuple[Person, UserAccount, set[str]]:
    await _require_global(actor)
    if person_id == actor.person.id:
        raise _err(403, "cannot_target_self")
    person = await db.get(Person, person_id)
    account = await db.get(UserAccount, person_id)
    if person is None or account is None:
        raise _err(404, "user_not_found")
    target_roles = set(await db.scalars(
        select(PersonRole.role).where(PersonRole.person_id == person_id,
                                      PersonRole.revoked_at.is_(None))))
    await _actor_can_touch(db, actor, person_id)
    return person, account, target_roles


async def _revoke_all_sessions(db: DbSession, person_id: uuid.UUID, reason: str) -> None:
    from datetime import UTC as _UTC, datetime as _dt
    await db.execute(
        update(AuthSession)
        .where(AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=_dt.now(_UTC), revoke_reason=reason)
    )


@router.post("/{person_id}/account", status_code=201)
async def create_account(
    person_id: uuid.UUID,
    body: AccountCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("users", "add"),
) -> dict:
    """Create a login account for an existing person (no-account contacts
    promoted to portal users). `_load_target` doesn't fit here — it
    requires an account row, which is exactly what's missing."""
    await _require_global(actor)
    require_password_length(body.temp_password)
    if person_id == actor.person.id:
        raise _err(403, "cannot_target_self")
    person = await db.get(Person, person_id)
    if person is None:
        raise _err(404, "person_not_found")
    if person.archived_at is not None:
        raise _err(422, "person_archived")
    if await db.get(UserAccount, person_id) is not None:
        raise _err(409, "account_exists")
    await _actor_can_touch(db, actor, person_id)

    db.add(UserAccount(
        person_id=person.id,
        email=body.login_email,
        password_hash=hash_password(
            body.temp_password,
            pepper=get_settings().password_pepper.get_secret_value()),
        must_change_password=body.must_change_password,
        password_updated_at=datetime.now(UTC),
        created_by=actor.person.id,
    ))
    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="account.create",
          changes={"login_email": {"from": None, "to": body.login_email},
                   "must_change_password":
                   {"from": None, "to": body.must_change_password}})
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise _err(409, "email_in_use") from None
    return {"status": "created"}


@router.post("/{person_id}/reset-password", status_code=204)
async def reset_password(
    person_id: uuid.UUID,
    body: ResetPasswordIn,
    db: DbSession,
    actor: AuthContext = require_permission("users", "change"),
) -> None:
    require_password_length(body.temp_password)
    _, account, _ = await _load_target(db, actor, person_id)
    now = datetime.now(UTC)
    account.password_hash = hash_password(
        body.temp_password,
        pepper=get_settings().password_pepper.get_secret_value())
    account.password_updated_at = now
    account.must_change_password = body.must_change_password
    account.failed_login_count = 0
    account.locked_until = None
    account.updated_at = now
    await _revoke_all_sessions(db, person_id, "password_change")
    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="password.reset",
          changes={"must_change_password":
                   {"from": None, "to": body.must_change_password}})
    await db.commit()


@router.post("/{person_id}/disable", status_code=204)
async def disable_account(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("users", "change"),
) -> None:
    _, account, _ = await _load_target(db, actor, person_id)
    now = datetime.now(UTC)
    account.disabled_at = now
    account.updated_at = now
    await _revoke_all_sessions(db, person_id, "account_disabled")
    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="account.disable")
    await db.commit()


@router.post("/{person_id}/enable", status_code=204)
async def enable_account(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("users", "change"),
) -> None:
    _, account, _ = await _load_target(db, actor, person_id)
    account.disabled_at = None
    account.failed_login_count = 0
    account.locked_until = None
    account.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="account.enable")
    await db.commit()


@router.post("/{person_id}/unlock", status_code=204)
async def unlock_account(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("users", "change"),
) -> None:
    _, account, _ = await _load_target(db, actor, person_id)
    account.locked_until = None
    account.failed_login_count = 0
    account.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="user_account",
          entity_id=str(person_id), action="account.unlock")
    await db.commit()


@router.put("/{person_id}/roles", response_model=list[str])
async def set_roles(
    person_id: uuid.UUID,
    body: RolesUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("access", "change"),
) -> list[str]:
    _, _, current = await _load_target(db, actor, person_id)
    desired = set(body.roles)

    # Need scope_anchor for `current` roles too (not just `desired`) so the
    # revoke step below can tell org-anchored grants apart from global ones.
    role_rows = {r.name: r for r in await db.scalars(
        select(Role).where(Role.name.in_(desired | current or {""})))}
    for name in desired:
        role = role_rows.get(name)
        if role is None:
            raise _err(422, "unknown_role")
        if role.scope_anchor in ("client", "partner"):
            raise _err(422, "role_requires_org")
        if name not in current and not can_touch_rank(
                actor.access.max_rank, role.rank):
            raise _err(403, "rank_too_low")

    now = datetime.now(UTC)
    # Org-anchored grants (client/partner contacts) are managed entirely
    # through the org-contact flows, not here — `desired` can never
    # legally contain one (rejected above), so plain `current - desired`
    # would silently revoke a person's untouched contact-role grant just
    # because this call's payload only carries their non-org-anchored
    # roles. Exclude client/partner-anchored roles from what's eligible
    # for revocation via this endpoint.
    revocable_current = {
        name for name in current
        if role_rows.get(name) is None or role_rows[name].scope_anchor not in ("client", "partner")
    }
    for role in revocable_current - desired:
        await db.execute(
            update(PersonRole)
            .where(PersonRole.person_id == person_id, PersonRole.role == role,
                   PersonRole.revoked_at.is_(None))
            .values(revoked_at=now, revoked_by=actor.person.id, updated_at=now)
        )
    for role in desired - current:
        db.add(PersonRole(person_id=person_id, role=role, granted_by=actor.person.id))
    audit(db, actor_id=actor.person.id, entity_type="person",
          entity_id=str(person_id), action="role.set",
          changes={"roles": {"from": sorted(current), "to": sorted(desired)}})
    await db.commit()
    return sorted(desired)


@router.patch("/{person_id}/profile", response_model=PersonDetail)
async def admin_update_profile(
    person_id: uuid.UUID,
    body: ProfileUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("users", "change"),
) -> PersonDetail:
    person, _, _ = await _load_target(db, actor, person_id)
    data = body.model_dump(exclude_unset=True)
    for required in ("first_name", "last_name", "country"):
        if required in data and data[required] is None:
            raise _err(422, f"{required}_required")
    fields = list(data.keys())
    before = snapshot(person, fields)
    for field, value in data.items():
        setattr(person, field, value)
    person.updated_at = datetime.now(UTC)
    changes = diff(before, snapshot(person, fields))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="person",
              entity_id=str(person_id), action="update",
              changes=changes)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise _err(409, "email_in_use") from None
    out = PersonDetail.model_validate(person)
    out.avatar_url = presign_get(person.avatar_key)
    return out
