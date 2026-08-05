"""Stakeholders — clients and partners. One implementation, two org types:
the tables share their shape, and contacts are scoped role grants
(client role @ client, vendor role @ partner) so people↔org linkage
rides the existing person_roles machinery.
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    ContactAddIn,
    ContactItem,
    ManagerRef,
    OrgCreateIn,
    OrgItem,
    OrgUpdateIn,
    PersonListItem,
    WorkerItem,
)
from serversherpa.db.models import (
    Client,
    Partner,
    Person,
    PersonRole,
    UserAccount,
    WorkerProfile,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.storage import presign_get


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _make_org_router(  # noqa: C901 — one cohesive factory beats two copies
    *, prefix: str, model: type, contact_role: str, scope_col: str,
    resource: str,
) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[prefix.strip("/")])
    is_partner = model is Partner
    entity_type = "partner" if is_partner else "client"

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
                   PersonRole.role == contact_role,
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
        rows = (await db.execute(
            select(Person, PersonRole.granted_at, UserAccount.person_id)
            .join(PersonRole, PersonRole.person_id == Person.id)
            .outerjoin(UserAccount, UserAccount.person_id == Person.id)
            .where(col == org_id,
                   PersonRole.role == contact_role,
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
            )
            for person, granted_at, account_id in rows
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
        grant = PersonRole(
            person_id=body.person_id,
            role=contact_role,
            granted_by=actor.person.id,
            **{scope_col: org_id},
        )
        db.add(grant)
        audit(db, actor_id=actor.person.id, entity_type=entity_type,
              entity_id=str(org_id), action="contact.add",
              changes={"person_id": {"from": None, "to": str(body.person_id)}})
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise _err(409, "already_a_contact") from None
        return {"status": "granted"}

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
                   PersonRole.role == contact_role,
                   col == org_id,
                   PersonRole.revoked_at.is_(None))
            .values(revoked_at=datetime.now(UTC), revoked_by=actor.person.id)
        )
        if result.rowcount == 0:
            raise _err(404, "contact_not_found")
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
