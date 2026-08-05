"""Sites — facilities we and our clients operate in. Rebuilt from the
legacy BaseCamp sites table: real lat/lon columns, editable type/status
lookups, one M:N client relationship (not two), and a validated survey."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    SiteClientsIn, SiteCreateIn, SiteDetail, SiteItem, SiteLookupOut,
    SiteLookupUpdateIn, SiteSurveyIn, SiteUpdateIn,
)
from serversherpa.db.models import (
    Client, Partner, Site, SiteClient, SiteType, StatusValue,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.sites.survey import SurveyError, survey_schema, validate_survey

router = APIRouter(prefix="/sites", tags=["sites"])
lookups_router = APIRouter(tags=["sites"])


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _get_site(db: DbSession, site_id: uuid.UUID, actor: AuthContext) -> Site:
    """404 for missing AND out-of-scope — an actor must not learn an id exists."""
    site = await db.get(Site, site_id)
    if site is None:
        raise _err(404, "site_not_found")
    cond = scope_conditions("sites", actor.access, actor.person.id)
    if cond is not None:
        # Sites are internal-only (visible_to = {"global"}), so only a
        # global actor can ever reach this resource, and scope_conditions()
        # always returns None for them — this branch is unreachable today.
        # Kept for defence in depth if the read gate is ever widened.
        visible = await db.scalar(select(Site.id).where(Site.id == site_id, cond))
        if visible is None:
            raise _err(404, "site_not_found")
    return site


async def _labels(db: DbSession) -> tuple[dict, dict]:
    types = {t.key: t.label for t in await db.scalars(select(SiteType))}
    statuses = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "site"))}
    return types, statuses


async def _clients_by_site(db: DbSession, site_ids: list[uuid.UUID]) -> dict:
    if not site_ids:
        return {}
    rows = (await db.execute(
        select(SiteClient.site_id, Client.id, Client.name)
        .join(Client, Client.id == SiteClient.client_id)
        .where(SiteClient.site_id.in_(site_ids))
        .order_by(Client.name)
    )).all()
    out: dict = {}
    for site_id, client_id, name in rows:
        out.setdefault(site_id, []).append({"client_id": client_id, "name": name})
    return out


def _item(site: Site, types: dict, statuses: dict, partners: dict,
          clients: dict) -> dict:
    label, color = statuses.get(site.status, (site.status, "c-slate"))
    return {
        "id": site.id, "name": site.name, "code": site.code,
        "site_type": site.site_type, "type_label": types.get(site.site_type),
        "status": site.status, "status_label": label, "status_color": color,
        "address_line1": site.address_line1, "address_line2": site.address_line2,
        "city": site.city, "region": site.region,
        "postal_code": site.postal_code, "country": site.country,
        "latitude": float(site.latitude) if site.latitude is not None else None,
        "longitude": float(site.longitude) if site.longitude is not None else None,
        "timezone": site.timezone, "dc_provider": site.dc_provider,
        "partner_id": site.partner_id, "partner_name": partners.get(site.partner_id),
        "notes": site.notes, "archived_at": site.archived_at,
        "created_at": site.created_at, "clients": clients.get(site.id, []),
    }


@router.get("", response_model=list[SiteItem])
async def list_sites(
    db: DbSession,
    actor: AuthContext = require_permission("sites", "view"),
) -> list[SiteItem]:
    query = select(Site).order_by(Site.name)
    cond = scope_conditions("sites", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    sites = (await db.scalars(query)).all()

    types, statuses = await _labels(db)
    partner_ids = {s.partner_id for s in sites if s.partner_id}
    partners = {}
    if partner_ids:
        partners = dict((await db.execute(
            select(Partner.id, Partner.name).where(Partner.id.in_(partner_ids))
        )).all())
    clients = await _clients_by_site(db, [s.id for s in sites])
    return [SiteItem(**_item(s, types, statuses, partners, clients)) for s in sites]


@router.get("/survey-schema")
async def get_survey_schema(
    _actor: AuthContext = require_permission("sites", "view"),
) -> dict:
    return survey_schema()


async def _detail(db: DbSession, site: Site) -> SiteDetail:
    """One site with its labels, partner name, client links and survey.
    Shared by get_site and every write endpoint's response."""
    types, statuses = await _labels(db)
    partners = {}
    if site.partner_id:
        name = await db.scalar(select(Partner.name).where(Partner.id == site.partner_id))
        partners = {site.partner_id: name}
    clients = await _clients_by_site(db, [site.id])
    return SiteDetail(**_item(site, types, statuses, partners, clients),
                      survey_data=site.survey_data or {})


@router.get("/{site_id}", response_model=SiteDetail)
async def get_site(
    site_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "view"),
) -> SiteDetail:
    site = await _get_site(db, site_id, actor)
    return await _detail(db, site)


# ── editable type/status lookups ───────────────────────────────────

# site_types.icon is Mapped[str | None] (models.py:346) — NULL is the correct
# spelling of "no icon", so an explicit `icon: null` must flow through and
# clear the column. The other three mutable columns are NOT NULL, so a null on
# those is pre-checked into a 422 instead of an IntegrityError.
# The predicate is `is None`, NOT a falsy check: sort_order=0 is a legitimate
# ordering value that must pass through.
NON_NULLABLE_SITE_TYPE_FIELDS = ("label", "description", "sort_order")


@lookups_router.get("/site-types", response_model=list[SiteLookupOut])
async def list_site_types(
    db: DbSession,
    _actor: AuthContext = require_permission("sites", "view"),
) -> list[SiteLookupOut]:
    rows = (await db.scalars(
        select(SiteType).order_by(SiteType.sort_order, SiteType.label))).all()
    return [SiteLookupOut.model_validate(r) for r in rows]


@lookups_router.patch("/site-types/{key}", response_model=SiteLookupOut)
async def update_site_type(
    key: str,
    body: SiteLookupUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> SiteLookupOut:
    row = await db.get(SiteType, key)
    if row is None:
        raise _err(404, "site_type_not_found")
    fields = ["label", "description", "sort_order", "icon"]
    data = body.model_dump(exclude_unset=True)
    # reject an explicit null up front rather than letting it reach the UPDATE
    for field in NON_NULLABLE_SITE_TYPE_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    before = snapshot(row, fields)
    # no `value is not None` guard: it would silently DROP an explicit
    # `icon: null`, leaving the row unchanged while still returning 200.
    # exclude_unset already means "the caller named this field", and the null
    # case is handled by the pre-check above. Mirrors update_status_value.
    for field, value in data.items():
        setattr(row, field, value)
    changes = diff(before, snapshot(row, fields))
    if changes:
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="site_type",
              entity_id=key, action="update", changes=changes)
    await db.commit()
    return SiteLookupOut.model_validate(row)


# ── create / update / archive ──────────────────────────────────────

SITE_FIELDS = [
    "name", "code", "site_type", "status", "address_line1", "address_line2",
    "city", "region", "postal_code", "country", "latitude", "longitude",
    "timezone", "dc_provider", "partner_id", "notes",
]

# columns that are NOT NULL on Site — an explicit null on any of these in a
# PATCH must be rejected rather than blind-setattr'd into an IntegrityError.
NON_NULLABLE_SITE_FIELDS = ("name", "status", "country")


def _validate_coords(lat, lon) -> None:
    if (lat is None) != (lon is None):
        raise _err(422, "invalid_coordinates")      # half a coordinate
    if lat is not None and not (-90 <= float(lat) <= 90):
        raise _err(422, "invalid_coordinates")
    if lon is not None and not (-180 <= float(lon) <= 180):
        raise _err(422, "invalid_coordinates")


async def _check_lookups(db: DbSession, site_type, status) -> None:
    if site_type is not None and await db.get(SiteType, site_type) is None:
        raise _err(422, "unknown_site_type")
    if status is not None and await db.scalar(
        select(StatusValue).where(
            StatusValue.record_type == "site", StatusValue.key == status)
    ) is None:
        raise _err(422, "unknown_status")


def _require_global(actor: AuthContext) -> None:
    """Creating and editing sites is an internal act. Org-anchored actors are
    read-only here (their matrix says view-only, but an override must not open
    a write path — sites have no per-actor write scope)."""
    if not actor.access.is_global:
        raise _err(403, "forbidden")


@router.post("", response_model=SiteDetail, status_code=201)
async def create_site(
    body: SiteCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "add"),
) -> SiteDetail:
    _require_global(actor)
    _validate_coords(body.latitude, body.longitude)
    await _check_lookups(db, body.site_type, body.status)
    data = body.model_dump(exclude_none=True)
    site = Site(**data, created_by=actor.person.id)
    db.add(site)
    await db.flush()
    initial = snapshot(site, SITE_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value is not None}
    audit(db, actor_id=actor.person.id, entity_type="site", entity_id=str(site.id),
          action="create", changes=changes)
    await db.commit()
    return await _detail(db, site)


@router.patch("/{site_id}", response_model=SiteDetail)
async def update_site(
    site_id: uuid.UUID,
    body: SiteUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "change"),
) -> SiteDetail:
    _require_global(actor)
    site = await _get_site(db, site_id, actor)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_SITE_FIELDS:
        if field in data and not data[field]:
            raise _err(422, f"{field}_required")
    lat = data.get("latitude", site.latitude)
    lon = data.get("longitude", site.longitude)
    _validate_coords(lat, lon)
    await _check_lookups(db, data.get("site_type"), data.get("status"))

    fields = list(data.keys())
    before = snapshot(site, fields)
    for field, value in data.items():
        setattr(site, field, value)
    changes = diff(before, snapshot(site, fields))
    if changes:
        site.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="site",
              entity_id=str(site_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, site)


@router.post("/{site_id}/archive", status_code=204)
async def archive_site(
    site_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "change"),
) -> None:
    _require_global(actor)
    site = await _get_site(db, site_id, actor)
    site.archived_at = datetime.now(UTC)
    site.updated_at = site.archived_at
    audit(db, actor_id=actor.person.id, entity_type="site",
          entity_id=str(site_id), action="archive")
    await db.commit()


@router.post("/{site_id}/unarchive", status_code=204)
async def unarchive_site(
    site_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "change"),
) -> None:
    _require_global(actor)
    site = await _get_site(db, site_id, actor)
    site.archived_at = None
    site.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="site",
          entity_id=str(site_id), action="restore")
    await db.commit()


# ── client links + survey save ─────────────────────────────────────


@router.put("/{site_id}/clients")
async def set_site_clients(
    site_id: uuid.UUID,
    body: SiteClientsIn,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "change"),
) -> dict:
    _require_global(actor)
    await _get_site(db, site_id, actor)
    desired = set(body.client_ids)
    if desired:
        found = set(await db.scalars(select(Client.id).where(Client.id.in_(desired))))
        missing = desired - found
        if missing:
            raise _err(404, "client_not_found", id=str(sorted(missing)[0]))

    current = set(await db.scalars(
        select(SiteClient.client_id).where(SiteClient.site_id == site_id)))
    for client_id in current - desired:
        await db.execute(SiteClient.__table__.delete().where(
            SiteClient.site_id == site_id, SiteClient.client_id == client_id))
    for client_id in desired - current:
        db.add(SiteClient(site_id=site_id, client_id=client_id,
                          linked_by=actor.person.id))
    if desired != current:
        audit(db, actor_id=actor.person.id, entity_type="site",
              entity_id=str(site_id), action="clients.set",
              changes={"added": sorted(str(c) for c in desired - current),
                       "removed": sorted(str(c) for c in current - desired)})
    await db.commit()
    clients = await _clients_by_site(db, [site_id])
    return {"clients": clients.get(site_id, [])}


@router.put("/{site_id}/survey", response_model=SiteDetail)
async def set_site_survey(
    site_id: uuid.UUID,
    body: SiteSurveyIn,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "change"),
) -> SiteDetail:
    _require_global(actor)
    site = await _get_site(db, site_id, actor)
    try:
        cleaned = validate_survey(body.survey_data)
    except SurveyError as exc:
        raise _err(422, exc.code) from None
    before = dict(site.survey_data or {})
    site.survey_data = cleaned
    changes = diff(before, cleaned)
    # a key present before and absent now is a clear — diff() only walks `after`
    for key in before.keys() - cleaned.keys():
        changes[key] = {"from": before[key], "to": None}
    if changes:
        site.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="site",
              entity_id=str(site_id), action="survey.update", changes=changes)
    await db.commit()
    return await _detail(db, site)
