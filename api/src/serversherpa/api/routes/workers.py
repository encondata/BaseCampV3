"""Workers — people holding the worker role, with profile (trade / level /
status / partner rollup), certifications, and the editable level scale.

Blacklist policy: setting a worker's status to blacklist automatically
disables their login account and revokes every session; leaving blacklist
re-enables the account (noted in the UI).
"""

import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.scope import scope_conditions
from serversherpa.api.bulk_routes import bulk_http_error, require_bulk_rank, rows_from_request
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    CertCreateIn,
    CertItem,
    PartnerRef,
    ProfileUpdateIn,
    WorkerDetailOut,
    WorkerInitiativeItem,
    WorkerItem,
    WorkerLevelCreateIn,
    WorkerLevelOut,
    WorkerLevelUpdateIn,
    WorkerProfileIn,
)
from serversherpa.api.worker_edits import (
    apply_person_update, apply_profile_update, visible_workers_query,
)
from serversherpa.db.models import (
    Initiative,
    InitiativePerson,
    Partner,
    Person,
    PersonRole,
    Site,
    StatusValue,
    UserAccount,
    WorkerCertification,
    WorkerLevel,
    WorkerProfile,
)
from serversherpa.db.ordering import natural
from serversherpa.people import bulk_import as bulk
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.storage import presign_get
from serversherpa.status.labels import (
    level_colors, level_fields, status_fields, status_labels,
)

router = APIRouter(prefix="/workers", tags=["workers"])
levels_router = APIRouter(prefix="/worker-levels", tags=["workers"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _require_worker(db: AsyncSession, person_id: uuid.UUID) -> Person:
    person = await db.get(Person, person_id)
    if person is None:
        raise _err(404, "person_not_found")
    has_role = await db.scalar(
        select(PersonRole.id).where(
            PersonRole.person_id == person_id,
            PersonRole.role == "worker",
            PersonRole.revoked_at.is_(None),
        ).limit(1))
    if has_role is None:
        raise _err(422, "not_a_worker")
    return person


async def _check_worker_scope(
    db: AsyncSession, actor: AuthContext, person_id: uuid.UUID,
) -> None:
    """Detail/mutation re-check: 404 (never 403) on an out-of-scope worker —
    no ID probing."""
    cond = scope_conditions("workers", actor.access, actor.person.id)
    if cond is None:
        return
    visible = await db.scalar(
        select(WorkerProfile.person_id)
        .where(WorkerProfile.person_id == person_id, cond))
    if visible is None:
        raise _err(404, "person_not_found")


@router.get("", response_model=list[WorkerItem])
async def list_workers(
    db: DbSession,
    actor: AuthContext = require_permission("workers", "view"),
) -> list[WorkerItem]:
    today = date.today()
    rows = (await db.execute(
        visible_workers_query(actor)
        .order_by(natural(Person.last_name), natural(Person.first_name))
    )).all()

    person_ids = [p.id for p, *_ in rows]
    cert_rows = (await db.execute(
        select(
            WorkerCertification.person_id,
            func.count(),
            func.count().filter(WorkerCertification.expires_on < today),
        )
        .where(WorkerCertification.person_id.in_(person_ids or [uuid.uuid4()]))
        .group_by(WorkerCertification.person_id)
    )).all()
    certs = {pid: (total, expired) for pid, total, expired in cert_rows}
    labels = await status_labels(db, "worker")
    lvl_colors = await level_colors(db)

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
            trade=profile.trade if profile else None,
            **level_fields(profile.level if profile else None, lvl_colors),
            **status_fields(profile.status if profile else "active", labels),
            status_note=profile.status_note if profile else None,
            partner=(PartnerRef(id=partner_id, name=partner_name)
                     if partner_id else None),
            cert_count=certs.get(person.id, (0, 0))[0],
            certs_expired=certs.get(person.id, (0, 0))[1],
        )
        for person, profile, partner_id, partner_name, account_id in rows
    ]


_VOCAB_FALLBACK = "#51606f"     # mirrors initiatives.py's unmapped-key color


# ── bulk import ────────────────────────────────────────────────────
# Declared ABOVE get_worker: /workers/bulk-import/* must never be swallowed
# by GET /workers/{person_id} (which would 422 on the non-UUID segment).

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


@router.get("/bulk-import/template")
async def bulk_import_template(
    db: DbSession,
    format: str = "csv",
    actor: AuthContext = require_permission("workers", "add"),
):
    require_bulk_rank(actor)
    if format == "csv":
        return Response(bulk.build_template_csv(), media_type="text/csv",
                        headers=_attachment("workers-template.csv"))
    if format == "xlsx":
        levels, statuses, partners = await bulk.reference_lists(db)
        return Response(bulk.build_template_xlsx(levels, statuses, partners),
                        media_type=_XLSX, headers=_attachment("workers-template.xlsx"))
    raise _err(422, "unknown_format")


@router.get("/bulk-import/export")
async def bulk_import_export(
    db: DbSession,
    format: str = "xlsx",
    actor: AuthContext = require_permission("workers", "add"),
):
    """The current workers in the template's layout — fill in, re-upload."""
    require_bulk_rank(actor)
    if format not in ("csv", "xlsx"):
        raise _err(422, "unknown_format")
    rows = await bulk.export_rows(db)
    if format == "csv":
        return Response(bulk.build_rows_csv(rows), media_type="text/csv",
                        headers=_attachment("workers-export.csv"))
    levels, statuses, partners = await bulk.reference_lists(db)
    return Response(bulk.build_rows_xlsx(rows, levels, statuses, partners),
                    media_type=_XLSX, headers=_attachment("workers-export.xlsx"))


@router.post("/bulk-import/preview")
async def bulk_import_preview(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "add"),
) -> dict:
    require_bulk_rank(actor)
    numbered = await rows_from_request(
        request, parse_upload=bulk.parse_upload, number_json_rows=bulk.number_json_rows)
    return await bulk.preview_rows(db, numbered, actor_id=actor.person.id,
                                   actor_rank=actor.access.max_rank)


@router.post("/bulk-import/commit")
async def bulk_import_commit(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "add"),
) -> dict:
    require_bulk_rank(actor)
    # the commit edits existing people as well as creating them, so it must
    # express the authority it exercises — `change`, not `add` alone
    if not actor.access.can("workers", "change"):
        raise _err(403, "forbidden")
    try:
        body = await request.json()
    except ValueError:
        raise _err(422, "invalid_json") from None
    try:
        numbered = bulk.number_json_rows(body.get("rows"))
    except bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None
    approved = {str(s) for s in body.get("approved_updates") or []}
    try:
        return await bulk.commit_rows(
            db, numbered, actor_id=actor.person.id, actor_rank=actor.access.max_rank,
            approved_updates=approved, source_label=str(body.get("source") or "upload"))
    except bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None


@router.get("/{person_id}", response_model=WorkerDetailOut)
async def get_worker(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "view"),
) -> WorkerDetailOut:
    person = await _require_worker(db, person_id)
    await _check_worker_scope(db, actor, person_id)

    profile = await db.get(WorkerProfile, person_id)
    partner = (await db.get(Partner, profile.partner_id)
               if profile and profile.partner_id else None)
    account = await db.get(UserAccount, person_id)
    labels = await status_labels(db, "worker")
    lvl_colors = await level_colors(db)
    level_row = (await db.get(WorkerLevel, profile.level)
                 if profile and profile.level else None)

    today = date.today()
    cert_total, cert_expired = (await db.execute(
        select(func.count(),
               func.count().filter(WorkerCertification.expires_on < today))
        .where(WorkerCertification.person_id == person_id))).one()

    # Initiative/site membership history and several Person fields
    # (rating lives inside `initiatives`, plus notes/badge/RFID/address) are
    # internal-only: a partner-anchored actor (e.g. vendor_admin, who holds
    # workers:view over their own supplied workers) must not receive them —
    # the join below also carries no scope check of its own, so skipping it
    # entirely for non-global actors is simplest and cheapest.
    initiatives: list[WorkerInitiativeItem] = []
    if actor.access.is_global:
        # one query per vocabulary, mirroring initiatives.py::_people_rows
        vocab_rows = await db.scalars(select(StatusValue).where(
            StatusValue.record_type.in_(
                ["initiative", "initiative_type", "initiative_work_type"])))
        vocabs: dict[str, dict[str, tuple[str, str]]] = {}
        for s in vocab_rows:
            vocabs.setdefault(s.record_type, {})[s.key] = (s.label, s.color)

        memberships = (await db.execute(
            select(InitiativePerson, Initiative, Site.name)
            .join(Initiative, Initiative.id == InitiativePerson.initiative_id)
            .outerjoin(Site, Site.id == InitiativePerson.site_worked_id)
            .where(InitiativePerson.person_id == person_id)
            .order_by(InitiativePerson.created_at.desc()))).all()
        for m, init, site_name in memberships:
            wt = (vocabs.get("initiative_work_type", {}).get(
                      m.work_type, (m.work_type, _VOCAB_FALLBACK))
                  if m.work_type is not None else (None, None))
            t = vocabs.get("initiative_type", {}).get(
                init.initiative_type, (init.initiative_type, _VOCAB_FALLBACK))
            s = vocabs.get("initiative", {}).get(
                init.status, (init.status, _VOCAB_FALLBACK))
            initiatives.append(WorkerInitiativeItem(
                initiative_id=init.id, initiative_name=init.name,
                type_label=t[0], type_color=t[1],
                status_label=s[0], status_color=s[1],
                work_type_label=wt[0], work_type_color=wt[1],
                site_worked_name=site_name, rating=m.rating,
                added_at=m.created_at))

    is_global = actor.access.is_global
    return WorkerDetailOut(
        person_id=person.id,
        display_name=person.display_name,
        first_name=person.first_name,
        last_name=person.last_name,
        contact_email=person.email,
        phone=person.phone,
        avatar_url=presign_get(person.avatar_key),
        has_account=account is not None,
        trade=profile.trade if profile else None,
        **level_fields(profile.level if profile else None, lvl_colors),
        **status_fields(profile.status if profile else "active", labels),
        status_note=profile.status_note if profile else None,
        partner=(PartnerRef(id=partner.id, name=partner.name)
                 if partner else None),
        cert_count=cert_total or 0,
        certs_expired=cert_expired or 0,
        preferred_name=person.preferred_name,
        job_title=person.job_title,
        address_line1=person.address_line1 if is_global else None,
        address_line2=person.address_line2 if is_global else None,
        city=person.city if is_global else None,
        region=person.region if is_global else None,
        postal_code=person.postal_code if is_global else None,
        country=person.country if is_global else None,
        badge_uid=person.badge_uid if is_global else None,
        rfid_tag=person.rfid_tag if is_global else None,
        person_notes=person.notes if is_global else None,
        source=person.source,
        source_ref=person.source_ref,
        created_at=person.created_at,
        level_def=(WorkerLevelOut.model_validate(level_row)
                   if level_row else None),
        initiatives=initiatives,
    )


@router.patch("/{person_id}/person", status_code=204)
async def update_worker_person(
    person_id: uuid.UUID,
    body: ProfileUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "change"),
) -> None:
    """Person contact/identity fields for a worker. Unlike
    `PATCH /users/{person_id}/profile` (users.py::admin_update_profile),
    this does NOT require the target to hold a UserAccount and does NOT
    forbid self-targeting — both of which make that endpoint unusable for
    imported, account-less workers and confusing for self-edits. The checks
    and the audit live in worker_edits.apply_person_update."""
    person = await _require_worker(db, person_id)
    await _check_worker_scope(db, actor, person_id)
    await apply_person_update(db, actor, person, body.model_dump(exclude_unset=True))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise _err(409, "email_in_use") from None


@router.put("/{person_id}/profile", status_code=204)
async def upsert_profile(
    person_id: uuid.UUID,
    body: WorkerProfileIn,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "change"),
) -> None:
    await _require_worker(db, person_id)
    await _check_worker_scope(db, actor, person_id)
    await apply_profile_update(db, actor, person_id, body.model_dump(exclude_unset=True))
    await db.commit()


# ── certifications ─────────────────────────────────────────────────


@router.get("/{person_id}/certifications", response_model=list[CertItem])
async def list_certifications(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "view"),
) -> list[CertItem]:
    await _require_worker(db, person_id)
    await _check_worker_scope(db, actor, person_id)
    rows = (await db.scalars(
        select(WorkerCertification)
        .where(WorkerCertification.person_id == person_id)
        .order_by(WorkerCertification.expires_on.asc().nulls_last(),
                  natural(WorkerCertification.name))
    )).all()
    return [CertItem.model_validate(c) for c in rows]


@router.post("/{person_id}/certifications", response_model=CertItem, status_code=201)
async def add_certification(
    person_id: uuid.UUID,
    body: CertCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "add"),
) -> CertItem:
    await _require_worker(db, person_id)
    await _check_worker_scope(db, actor, person_id)
    cert = WorkerCertification(
        person_id=person_id, created_by=actor.person.id,
        **body.model_dump())
    db.add(cert)
    audit(db, actor_id=actor.person.id, entity_type="worker",
          entity_id=str(person_id), action="certification.add",
          changes={"name": {"from": None, "to": body.name}})
    await db.commit()
    return CertItem.model_validate(cert)


@router.delete("/{person_id}/certifications/{cert_id}", status_code=204)
async def delete_certification(
    person_id: uuid.UUID,
    cert_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "delete"),
) -> None:
    cert = await db.get(WorkerCertification, cert_id)
    if cert is None or cert.person_id != person_id:
        raise _err(404, "certification_not_found")
    await _check_worker_scope(db, actor, person_id)
    audit(db, actor_id=actor.person.id, entity_type="worker",
          entity_id=str(person_id), action="certification.remove",
          changes={"name": {"from": cert.name, "to": None}})
    await db.delete(cert)
    await db.commit()


# ── editable level scale ───────────────────────────────────────────


@levels_router.get("", response_model=list[WorkerLevelOut])
async def list_levels(
    db: DbSession,
    _actor: AuthContext = require_permission("workers", "view"),
) -> list[WorkerLevelOut]:
    rows = (await db.scalars(
        select(WorkerLevel).order_by(WorkerLevel.rank))).all()
    return [WorkerLevelOut.model_validate(r) for r in rows]


# every mutable column on WorkerLevel is NOT NULL (db/models.py:236-239), but
# the update schema types them `X | None` and exclude_unset INCLUDES an
# explicitly sent null — so `{"description": null}` would setattr None and
# either 500 on IntegrityError or (for JSONB) silently no-op. Pre-checking
# mirrors update_status_value / update_site_type.
# The predicate is `is None`, NOT a falsy check: `expected_skills: []` is a
# legitimate value (a level with no listed skills) that must pass through.
NON_NULLABLE_WORKER_LEVEL_FIELDS = ("title", "description", "expected_skills", "color")


@levels_router.patch("/{level}", response_model=WorkerLevelOut)
async def update_level(
    level: str,
    body: WorkerLevelUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> WorkerLevelOut:
    row = await db.get(WorkerLevel, level)
    if row is None:
        raise _err(404, "level_not_found")
    fields = ["title", "description", "expected_skills", "color"]
    data = body.model_dump(exclude_unset=True)
    # reject an explicit null up front rather than letting it reach the UPDATE
    for field in NON_NULLABLE_WORKER_LEVEL_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    before = snapshot(row, fields)
    # no `value is not None` guard: it would silently DROP an explicit
    # `expected_skills: []`, leaving the row unchanged while still returning
    # 200. exclude_unset already means "the caller named this field", and the
    # null case is handled by the pre-check above. Mirrors update_status_value.
    for field, value in data.items():
        setattr(row, field, value)
    changes = diff(before, snapshot(row, fields))
    if changes:
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="worker_level",
              entity_id=level, action="update", changes=changes)
    await db.commit()
    return WorkerLevelOut.model_validate(row)


# fields captured for the create audit snapshot: the mutable columns
# update_level touches, plus the two that only exist at creation time.
LEVEL_FIELDS = ["level", "rank", "title", "description", "expected_skills", "color"]


@levels_router.post("", response_model=WorkerLevelOut, status_code=201)
async def create_level(
    body: WorkerLevelCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "add"),
) -> WorkerLevelOut:
    if await db.get(WorkerLevel, body.level) is not None:
        raise _err(409, "worker_level_exists")

    if body.after is None:
        new_rank = 1
    else:
        anchor = await db.get(WorkerLevel, body.after)
        if anchor is None:
            raise _err(422, "unknown_level")
        new_rank = anchor.rank + 1

    # Safe without deferring to commit: worker_levels_rank_key is DEFERRABLE,
    # which makes Postgres check uniqueness at STATEMENT end rather than per
    # row, so this single `rank + 1` shift never sees the transient collision
    # a per-row check would (3 -> 4 landing on the row still at 4). It stays
    # INITIALLY IMMEDIATE so a real violation still raises on this statement,
    # where it's attributable, instead of at COMMIT.
    await db.execute(
        update(WorkerLevel)
        .where(WorkerLevel.rank >= new_rank)
        .values(rank=WorkerLevel.rank + 1))

    row = WorkerLevel(level=body.level, rank=new_rank, title=body.title,
                      description=body.description,
                      expected_skills=body.expected_skills, color=body.color,
                      updated_at=datetime.now(UTC))
    db.add(row)
    audit(db, actor_id=actor.person.id, entity_type="worker_level",
          entity_id=body.level, action="create",
          changes=diff({}, snapshot(row, LEVEL_FIELDS)))
    await db.commit()
    return WorkerLevelOut.model_validate(row)
