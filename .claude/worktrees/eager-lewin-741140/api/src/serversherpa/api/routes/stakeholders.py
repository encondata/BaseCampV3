"""Stakeholders — clients and partners. One implementation, two org types:
the tables share their shape, and contacts are scoped role grants
(client role @ client, vendor role @ partner) so people↔org linkage
rides the existing person_roles machinery.
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import can_touch_rank
from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    ContactAddIn,
    ContactItem,
    ContactUpdateIn,
    ExternalDirectoryOut,
    ExternalLinkItem,
    ExternalPersonItem,
    ManagerRef,
    OrgCreateIn,
    OrgItem,
    OrgUpdateIn,
    PersonListItem,
    WorkerItem,
)
from serversherpa.db.models import (
    Client,
    ContactProfile,
    Partner,
    Person,
    PersonRole,
    Role,
    UserAccount,
    WorkerProfile,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.storage import presign_get


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _normalize_functions(raw: list[str]) -> list[str]:
    """Trim, drop empties, dedupe case-insensitively (order-preserving,
    first-seen casing kept — matches the TagInput's own dedupe), and
    enforce the per-tag length cap and total-tag cap — 422
    invalid_functions beyond."""
    out: list[str] = []
    seen: set[str] = set()
    for tag in raw:
        t = tag.strip()
        if not t or len(t) > 40:
            raise _err(422, "invalid_functions")
        key = t.lower()
        if key not in seen:
            seen.add(key)
            out.append(t)
    if len(out) > 12:
        raise _err(422, "invalid_functions")
    return out


def _make_org_router(  # noqa: C901 — one cohesive factory beats two copies
    *, prefix: str, model: type, contact_role: str, scope_col: str,
    resource: str,
) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[prefix.strip("/")])
    is_partner = model is Partner
    entity_type = "partner" if is_partner else "client"
    # contact_role is the viewer-tier role name ("client_viewer" /
    # "vendor_viewer") — derive the owner/admin/viewer sibling role names
    # from it so "contact" always means "holds any of the three".
    _prefix = contact_role.rsplit("_", 1)[0]
    tier_roles = {tier: f"{_prefix}_{tier}" for tier in ("owner", "admin", "viewer")}
    tier_role_names = list(tier_roles.values())

    def _tier_of(role_name: str) -> str:
        return role_name.rsplit("_", 1)[-1]

    async def _target_max_rank(db: AsyncSession, person_id: uuid.UUID) -> int:
        return (await db.scalar(
            select(func.max(Role.rank))
            .join(PersonRole, PersonRole.role == Role.name)
            .where(PersonRole.person_id == person_id,
                   PersonRole.revoked_at.is_(None)))) or 0

    async def _check_rank(
        db: AsyncSession, actor: AuthContext, person_id: uuid.UUID,
        role_name: str | None = None,
    ) -> None:
        """Target-person rank check always applies; the new-role rank check
        only applies when a role_name is given (i.e. a tier is changing —
        metadata-only edits skip it per the design spec)."""
        if role_name is not None:
            role = await db.get(Role, role_name)
            if role is None or not can_touch_rank(actor.access.max_rank, role.rank):
                raise _err(403, "rank_too_low")
        target_rank = await _target_max_rank(db, person_id)
        if not can_touch_rank(actor.access.max_rank, target_rank):
            raise _err(403, "rank_too_low")

    async def _get_org(
        db: AsyncSession, org_id: uuid.UUID, actor: AuthContext | None = None,
    ):
        org = await db.get(model, org_id)
        if org is None:
            raise _err(404, "org_not_found")
        if actor is not None:
            cond = scope_conditions(resource, actor.access, actor.person.id)
            if cond is not None:
                visible = await db.scalar(
                    select(model.id).where(model.id == org_id, cond))
                if visible is None:
                    raise _err(404, "org_not_found")
        return org

    async def _contact_counts(db: AsyncSession, org_ids: list[uuid.UUID]) -> dict:
        col = getattr(PersonRole, scope_col)
        rows = (await db.execute(
            select(col, func.count())
            .where(col.in_(org_ids or [uuid.uuid4()]),
                   PersonRole.role.in_(tier_role_names),
                   PersonRole.revoked_at.is_(None))
            .group_by(col)
        )).all()
        return dict(rows)

    async def _managers(db: AsyncSession, ids: set[uuid.UUID]) -> dict:
        if not ids:
            return {}
        rows = (await db.scalars(select(Person).where(Person.id.in_(ids)))).all()
        return {p.id: ManagerRef(id=p.id, display_name=p.display_name) for p in rows}

    def _item(org, counts: dict, managers: dict) -> OrgItem:
        return OrgItem(
            id=org.id,
            name=org.name,
            code=org.code,
            partner_types=getattr(org, "partner_types", None) or [],
            status=org.status,
            tier=org.tier,
            phone=org.phone,
            website=org.website,
            address_line1=org.address_line1,
            address_line2=org.address_line2,
            city=org.city,
            region=org.region,
            postal_code=org.postal_code,
            country=org.country,
            notes=org.notes,
            account_manager=managers.get(org.account_manager),
            contact_count=counts.get(org.id, 0),
            logo_url=presign_get(org.logo_key),
            archived_at=org.archived_at,
            created_at=org.created_at,
        )

    async def _item_for(db: AsyncSession, org) -> OrgItem:
        counts = await _contact_counts(db, [org.id])
        managers = await _managers(
            db, {org.account_manager} if org.account_manager else set())
        return _item(org, counts, managers)

    @router.get("", response_model=list[OrgItem])
    async def list_orgs(
        db: DbSession,
        actor: AuthContext = require_permission(resource, "view"),
    ) -> list[OrgItem]:
        query = select(model).order_by(model.name)
        cond = scope_conditions(resource, actor.access, actor.person.id)
        if cond is not None:
            query = query.where(cond)
        orgs = (await db.scalars(query)).all()
        counts = await _contact_counts(db, [o.id for o in orgs])
        managers = await _managers(
            db, {o.account_manager for o in orgs if o.account_manager})
        return [_item(o, counts, managers) for o in orgs]

    @router.get("/{org_id}", response_model=OrgItem)
    async def get_org(
        org_id: uuid.UUID,
        db: DbSession,
        actor: AuthContext = require_permission(resource, "view"),
    ) -> OrgItem:
        org = await _get_org(db, org_id, actor)
        return await _item_for(db, org)

    async def _apply(db: AsyncSession, org, data: dict, actor: AuthContext):
        """Apply field updates only — the CALLER commits, so audit rows added
        after _apply always ride the same transaction as the mutation."""
        if "account_manager_id" in data:
            manager_id = data.pop("account_manager_id")
            if manager_id is not None and await db.get(Person, manager_id) is None:
                raise _err(422, "manager_not_found")
            org.account_manager = manager_id
        if not is_partner:
            data.pop("partner_types", None)
        elif data.get("partner_types") is None:
            data.pop("partner_types", None)
        for field, value in data.items():
            setattr(org, field, value)
        org.updated_at = datetime.now(UTC)

    async def _commit_or_409(db: AsyncSession) -> None:
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise _err(409, "name_or_code_in_use") from None

    @router.post("", response_model=OrgItem, status_code=201)
    async def create_org(
        body: OrgCreateIn,
        db: DbSession,
        actor: AuthContext = require_permission(resource, "add"),
    ) -> OrgItem:
        org = model(name=body.name, source="manual", created_by=actor.person.id)
        db.add(org)
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            raise _err(409, "name_or_code_in_use") from None
        data = body.model_dump(exclude_unset=True, exclude={"name"})
        data.setdefault("country", "US")
        if data["country"] is None:
            data["country"] = "US"
        await _apply(db, org, data, actor)
        audit(db, actor_id=actor.person.id, entity_type=entity_type,
              entity_id=str(org.id), action="create",
              changes={"name": {"from": None, "to": org.name}})
        await _commit_or_409(db)
        return await _item_for(db, org)

    @router.patch("/{org_id}", response_model=OrgItem)
    async def update_org(
        org_id: uuid.UUID,
        body: OrgUpdateIn,
        db: DbSession,
        actor: AuthContext = require_permission(resource, "change"),
    ) -> OrgItem:
        org = await _get_org(db, org_id, actor)
        data = body.model_dump(exclude_unset=True)
        for required in ("name", "status", "tier", "country"):
            if required in data and data[required] is None:
                raise _err(422, f"{required}_required")
        fields = []
        for key in data:
            if key == "account_manager_id":
                fields.append("account_manager")
            elif key == "partner_types" and not is_partner:
                continue
            else:
                fields.append(key)
        before = snapshot(org, fields)
        await _apply(db, org, data, actor)
        changes = diff(before, snapshot(org, fields))
        if changes:
            audit(db, actor_id=actor.person.id, entity_type=entity_type,
                  entity_id=str(org.id), action="update",
                  changes=changes)
        await _commit_or_409(db)
        return await _item_for(db, org)

    @router.post("/{org_id}/archive", status_code=204)
    async def archive_org(
        org_id: uuid.UUID,
        db: DbSession,
        actor: AuthContext = require_permission(resource, "change"),
    ) -> None:
        org = await _get_org(db, org_id, actor)
        org.archived_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type=entity_type,
              entity_id=str(org_id), action="archive")
        await db.commit()

    @router.post("/{org_id}/unarchive", status_code=204)
    async def unarchive_org(
        org_id: uuid.UUID,
        db: DbSession,
        actor: AuthContext = require_permission(resource, "change"),
    ) -> None:
        org = await _get_org(db, org_id, actor)
        org.archived_at = None
        audit(db, actor_id=actor.person.id, entity_type=entity_type,
              entity_id=str(org_id), action="restore")
        await db.commit()

    # ── contacts: scoped role grants ───────────────────────────────

    @router.get("/{org_id}/contacts", response_model=list[ContactItem])
    async def list_contacts(
        org_id: uuid.UUID,
        db: DbSession,
        actor: AuthContext = require_permission(resource, "view"),
    ) -> list[ContactItem]:
        await _get_org(db, org_id, actor)
        col = getattr(PersonRole, scope_col)
        prof_col = getattr(ContactProfile, scope_col)
        rows = (await db.execute(
            select(Person, PersonRole.granted_at, PersonRole.role,
                   UserAccount.person_id, ContactProfile.org_title,
                   ContactProfile.functions)
            .join(PersonRole, PersonRole.person_id == Person.id)
            .outerjoin(UserAccount, UserAccount.person_id == Person.id)
            .outerjoin(ContactProfile,
                       (ContactProfile.person_id == Person.id) & (prof_col == org_id))
            .where(col == org_id,
                   PersonRole.role.in_(tier_role_names),
                   PersonRole.revoked_at.is_(None))
            .order_by(Person.last_name, Person.first_name)
        )).all()
        return [
            ContactItem(
                person_id=person.id,
                display_name=person.display_name,
                email=person.email,
                phone=person.phone,
                job_title=person.job_title,
                avatar_url=presign_get(person.avatar_key),
                has_account=account_id is not None,
                granted_at=granted_at,
                tier=_tier_of(role),
                org_title=org_title,
                functions=list(functions or []),
            )
            for person, granted_at, role, account_id, org_title, functions in rows
        ]

    @router.post("/{org_id}/contacts", status_code=201)
    async def add_contact(
        org_id: uuid.UUID,
        body: ContactAddIn,
        db: DbSession,
        actor: AuthContext = require_permission(resource, "change"),
    ) -> dict:
        await _get_org(db, org_id, actor)
        if await db.get(Person, body.person_id) is None:
            raise _err(404, "person_not_found")
        role_name = tier_roles[body.tier]
        await _check_rank(db, actor, body.person_id, role_name)

        col = getattr(PersonRole, scope_col)
        existing = await db.scalar(
            select(PersonRole.id).where(
                PersonRole.person_id == body.person_id,
                PersonRole.role.in_(tier_role_names),
                col == org_id,
                PersonRole.revoked_at.is_(None)))
        if existing is not None:
            raise _err(409, "already_a_contact")

        grant = PersonRole(
            person_id=body.person_id,
            role=role_name,
            granted_by=actor.person.id,
            **{scope_col: org_id},
        )
        db.add(grant)
        audit(db, actor_id=actor.person.id, entity_type=entity_type,
              entity_id=str(org_id), action="contact.add",
              changes={"person_id": {"from": None, "to": str(body.person_id)},
                       "tier": {"from": None, "to": body.tier}})
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise _err(409, "already_a_contact") from None
        return {"status": "granted"}

    @router.patch("/{org_id}/contacts/{person_id}")
    async def update_contact(
        org_id: uuid.UUID,
        person_id: uuid.UUID,
        body: ContactUpdateIn,
        db: DbSession,
        actor: AuthContext = require_permission(resource, "change"),
    ) -> dict:
        await _get_org(db, org_id, actor)
        col = getattr(PersonRole, scope_col)
        current = (await db.scalars(
            select(PersonRole).where(
                PersonRole.person_id == person_id,
                PersonRole.role.in_(tier_role_names),
                col == org_id,
                PersonRole.revoked_at.is_(None))
        )).one_or_none()
        if current is None:
            raise _err(404, "contact_not_found")

        data = body.model_dump(exclude_unset=True)
        if "functions" in data:
            # explicit null clears the tag list (the column is NOT NULL,
            # so None can't pass through to the model)
            data["functions"] = (
                _normalize_functions(data["functions"])
                if data["functions"] is not None else [])
        if data.get("org_title") is not None:
            data["org_title"] = data["org_title"].strip() or None

        new_tier = data.get("tier")
        new_role_name = tier_roles[new_tier] if new_tier is not None else None
        # rank rules apply whenever a tier is requested (even a no-op one,
        # to match prior behavior); metadata-only edits skip the new-role
        # check but still enforce the target-person rank rule
        await _check_rank(db, actor, person_id, new_role_name)

        old_tier = _tier_of(current.role)
        result_tier = old_tier
        if new_tier is not None and new_tier != old_tier:
            now = datetime.now(UTC)
            current.revoked_at = now
            current.revoked_by = actor.person.id
            current.updated_at = now
            db.add(PersonRole(
                person_id=person_id,
                role=new_role_name,
                granted_by=actor.person.id,
                **{scope_col: org_id},
            ))
            audit(db, actor_id=actor.person.id, entity_type=entity_type,
                  entity_id=str(org_id), action="contact.tier",
                  changes={"person_id": {"from": None, "to": str(person_id)},
                           "tier": {"from": old_tier, "to": new_tier}})
            result_tier = new_tier

        prof_col = getattr(ContactProfile, scope_col)
        prof = (await db.scalars(select(ContactProfile).where(
            ContactProfile.person_id == person_id, prof_col == org_id))).one_or_none()

        meta_fields = {k: data[k] for k in ("org_title", "functions") if k in data}
        if meta_fields:
            before = {"org_title": prof.org_title if prof else None,
                     "functions": list(prof.functions) if prof else []}
            if prof is None:
                prof = ContactProfile(
                    person_id=person_id, functions=[], **{scope_col: org_id})
                db.add(prof)
            for field, value in meta_fields.items():
                setattr(prof, field, value)
            prof.updated_by = actor.person.id
            prof.updated_at = datetime.now(UTC)
            after = {"org_title": prof.org_title, "functions": list(prof.functions)}
            pdiff = diff(before, after)
            if pdiff:
                audit(db, actor_id=actor.person.id, entity_type=entity_type,
                      entity_id=str(org_id), action="contact.update",
                      changes={"person_id": {"from": None, "to": str(person_id)},
                               **pdiff})

        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise _err(409, "already_a_contact") from None
        return {
            "status": "updated",
            "tier": result_tier,
            "org_title": prof.org_title if prof else None,
            "functions": list(prof.functions) if prof else [],
        }

    @router.delete("/{org_id}/contacts/{person_id}", status_code=204)
    async def remove_contact(
        org_id: uuid.UUID,
        person_id: uuid.UUID,
        db: DbSession,
        actor: AuthContext = require_permission(resource, "change"),
    ) -> None:
        await _get_org(db, org_id, actor)
        col = getattr(PersonRole, scope_col)
        result = await db.execute(
            update(PersonRole)
            .where(PersonRole.person_id == person_id,
                   PersonRole.role.in_(tier_role_names),
                   col == org_id,
                   PersonRole.revoked_at.is_(None))
            .values(revoked_at=datetime.now(UTC), revoked_by=actor.person.id)
        )
        if result.rowcount == 0:
            raise _err(404, "contact_not_found")
        prof_col = getattr(ContactProfile, scope_col)
        await db.execute(delete(ContactProfile).where(
            ContactProfile.person_id == person_id, prof_col == org_id))
        audit(db, actor_id=actor.person.id, entity_type=entity_type,
              entity_id=str(org_id), action="contact.remove",
              changes={"person_id": {"from": None, "to": str(person_id)}})
        await db.commit()

    return router


clients_router = _make_org_router(
    prefix="/clients", model=Client, contact_role="client_viewer",
    scope_col="client_id", resource="clients")
partners_router = _make_org_router(
    prefix="/partners", model=Partner, contact_role="vendor_viewer",
    scope_col="partner_id", resource="partners")


# ── partner-supplied workers (rollup via worker_profiles.partner_id) ─

@partners_router.get("/{partner_id}/workers", response_model=list[WorkerItem])
async def list_partner_workers(
    partner_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("partners", "view"),
) -> list[WorkerItem]:
    from datetime import date

    from sqlalchemy import func

    from serversherpa.api.schemas import PartnerRef
    from serversherpa.db.models import WorkerCertification

    if await db.get(Partner, partner_id) is None:
        raise _err(404, "org_not_found")
    cond = scope_conditions("partners", actor.access, actor.person.id)
    if cond is not None:
        visible = await db.scalar(
            select(Partner.id).where(Partner.id == partner_id, cond))
        if visible is None:
            raise _err(404, "org_not_found")

    today = date.today()
    rows = (await db.execute(
        select(Person, WorkerProfile, UserAccount.person_id)
        .join(WorkerProfile, WorkerProfile.person_id == Person.id)
        .join(PersonRole, (PersonRole.person_id == Person.id)
              & (PersonRole.role == "worker")
              & (PersonRole.revoked_at.is_(None)))
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(WorkerProfile.partner_id == partner_id,
               Person.archived_at.is_(None))
        .order_by(Person.last_name, Person.first_name)
    )).all()

    person_ids = [p.id for p, *_ in rows]
    cert_rows = (await db.execute(
        select(WorkerCertification.person_id, func.count(),
               func.count().filter(WorkerCertification.expires_on < today))
        .where(WorkerCertification.person_id.in_(person_ids or [uuid.uuid4()]))
        .group_by(WorkerCertification.person_id)
    )).all()
    certs = {pid: (t, e) for pid, t, e in cert_rows}

    return [
        WorkerItem(
            person_id=person.id,
            display_name=person.display_name,
            first_name=person.first_name,
            last_name=person.last_name,
            contact_email=person.email,
            phone=person.phone,
            avatar_url=presign_get(person.avatar_key),
            has_account=account_id is not None,
            trade=profile.trade,
            level=profile.level,
            status=profile.status,
            status_note=profile.status_note,
            partner=PartnerRef(id=partner_id, name=""),  # implicit on this page
            cert_count=certs.get(person.id, (0, 0))[0],
            certs_expired=certs.get(person.id, (0, 0))[1],
        )
        for person, profile, account_id in rows
    ]

# ── people picker (all people, accounted or not) ───────────────────

people_router = APIRouter(prefix="/people", tags=["people"])


@people_router.get("", response_model=list[PersonListItem])
async def list_people(
    db: DbSession,
    actor: AuthContext = require_permission("users", "view"),
) -> list[PersonListItem]:
    query = (
        select(Person, UserAccount.person_id)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.archived_at.is_(None))
        .order_by(Person.last_name, Person.first_name)
    )
    cond = scope_conditions("users", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    rows = (await db.execute(query)).all()
    return [
        PersonListItem(
            person_id=person.id,
            display_name=person.display_name,
            email=person.email,
            job_title=person.job_title,
            avatar_url=presign_get(person.avatar_key),
            has_account=account_id is not None,
        )
        for person, account_id in rows
    ]


# ── external directory (client/partner contacts + external role) ───

external_router = APIRouter(prefix="/external", tags=["external"])

# role name -> (org kind, tier) — mirrors the {prefix}_{tier} naming the
# _make_org_router factory uses for its own tier_roles mapping
_ORG_TIER_ROLES: dict[str, tuple[str, str]] = {
    "client_owner": ("client", "owner"),
    "client_admin": ("client", "admin"),
    "client_viewer": ("client", "viewer"),
    "vendor_owner": ("partner", "owner"),
    "vendor_admin": ("partner", "admin"),
    "vendor_viewer": ("partner", "viewer"),
}


@external_router.get("", response_model=ExternalDirectoryOut)
async def list_external(
    db: DbSession,
    actor: AuthContext = require_permission("users", "view"),
) -> ExternalDirectoryOut:
    grant_rows = (await db.execute(
        select(PersonRole.person_id, PersonRole.role,
               PersonRole.client_id, PersonRole.partner_id)
        .where(PersonRole.role.in_([*_ORG_TIER_ROLES, "external"]),
               PersonRole.revoked_at.is_(None))
    )).all()

    person_ids = {pid for pid, *_ in grant_rows}
    if not actor.access.is_global:
        # non-global actors — use the actor's own access info directly
        # rather than a SQL scope condition (this query aggregates across
        # several tables, so there's no single column to filter on)
        person_ids &= {actor.person.id}

    # function_tags aggregates across ALL contact_profiles rows regardless
    # of which people this actor can see — that's fine for a global actor
    # (it's their own tenant's suggestion list) but would leak other
    # people's org metadata to a self-scoped caller, who has no editing
    # surface that needs suggestions anyway.
    function_tags = sorted({
        tag for functions in (await db.scalars(select(ContactProfile.functions))).all()
        for tag in (functions or [])
    }) if actor.access.is_global else []

    if not person_ids:
        return ExternalDirectoryOut(people=[], function_tags=function_tags)

    client_ids = {cid for _, _, cid, _ in grant_rows if cid}
    partner_ids = {pid for _, _, _, pid in grant_rows if pid}
    client_names = {c.id: c.name for c in (await db.scalars(
        select(Client).where(Client.id.in_(client_ids or [uuid.uuid4()])))).all()}
    partner_names = {p.id: p.name for p in (await db.scalars(
        select(Partner).where(Partner.id.in_(partner_ids or [uuid.uuid4()])))).all()}

    profiles = (await db.scalars(
        select(ContactProfile).where(ContactProfile.person_id.in_(person_ids)))).all()
    profile_by_key = {(p.person_id, p.client_id, p.partner_id): p for p in profiles}

    links_by_person: dict[uuid.UUID, list[ExternalLinkItem]] = {}
    for pid, role, cid, ptid in grant_rows:
        if pid not in person_ids or role not in _ORG_TIER_ROLES:
            continue
        kind, tier = _ORG_TIER_ROLES[role]
        org_id = cid if kind == "client" else ptid
        org_name = (client_names if kind == "client" else partner_names).get(org_id, "")
        prof = profile_by_key.get((pid, cid, ptid))
        links_by_person.setdefault(pid, []).append(ExternalLinkItem(
            kind=kind, org_id=org_id, org_name=org_name, tier=tier,
            org_title=prof.org_title if prof else None,
            functions=list(prof.functions) if prof else [],
        ))

    people_rows = (await db.execute(
        select(Person, UserAccount)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.id.in_(person_ids), Person.archived_at.is_(None))
        .order_by(Person.last_name, Person.first_name)
    )).all()

    people_out = []
    for person, account in people_rows:
        if account is None:
            login_status = "none"
        elif account.disabled_at is not None:
            login_status = "disabled"
        else:
            login_status = "active"
        people_out.append(ExternalPersonItem(
            person_id=person.id,
            display_name=person.display_name,
            first_name=person.first_name,
            last_name=person.last_name,
            email=person.email,
            phone=person.phone,
            avatar_url=presign_get(person.avatar_key),
            has_login=account is not None,
            login_status=login_status,
            links=links_by_person.get(person.id, []),
        ))

    return ExternalDirectoryOut(people=people_out, function_tags=function_tags)
