"""Sites — facilities we and our clients operate in. Rebuilt from the
legacy BaseCamp sites table: real lat/lon columns, editable type/status
lookups, one M:N client relationship (not two), and a validated survey."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    RawSurveyRowOut, SiteClientsIn, SiteCreateIn, SiteDetail, SiteItem,
    SiteLookupOut, SiteLookupUpdateIn, SiteSurveyRowOut, SiteSurveyValueIn,
    SiteTypeCreateIn, SiteUpdateIn,
)
from serversherpa.db.models import (
    Client, Partner, Person, RawSurveyEntry, Site, SiteClient,
    SiteSurveyEntry, SiteType, StatusValue,
)
from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.sites import bulk_import as bulk
from serversherpa.sites.survey import (
    FIELDS_BY_KEY, SURVEY_FIELDS, SURVEY_GROUPS, SurveyError, SurveyField,
    survey_schema, validate_survey,
)

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
    types = {t.key: (t.label, t.color) for t in await db.scalars(select(SiteType))}
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
    label, color = statuses.get(site.status, (site.status, "#51606f"))
    # site_type is nullable — no type set is not the same as an orphaned type
    # key, so only the latter gets the hex fallback (mirroring status above).
    type_label, type_color = (
        types.get(site.site_type, (site.site_type, "#51606f"))
        if site.site_type is not None else (None, None)
    )
    return {
        "id": site.id, "name": site.name, "code": site.code,
        "site_type": site.site_type, "type_label": type_label, "type_color": type_color,
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


# ── bulk import ────────────────────────────────────────────────────
# Declared ABOVE get_site: /sites/bulk-import/* must never be swallowed by
# GET /sites/{site_id} (which would 422 on the non-UUID segment).

def _require_bulk_rank(actor: AuthContext) -> None:
    """Bulk import is admin-and-up: sites:add alone (staff hold it) is not
    enough — the blast radius of a thousand-row write warrants the same bar
    as the other rank-gated admin tooling."""
    if not actor.access.is_global or actor.access.max_rank < GATE_BYPASS_RANK:
        raise _err(403, "forbidden")


def _bulk_err(exc: bulk.BulkImportError) -> HTTPException:
    return _err(422, exc.code, **exc.extra)


@router.get("/bulk-import/template")
async def bulk_import_template(
    db: DbSession,
    format: str = "csv",
    actor: AuthContext = require_permission("sites", "add"),
):
    _require_bulk_rank(actor)
    if format == "json":
        return bulk.SAMPLE_ROWS
    if format == "csv":
        return Response(bulk.build_template_csv(), media_type="text/csv",
                        headers={"Content-Disposition":
                                 'attachment; filename="sites-template.csv"'})
    if format == "xlsx":
        types = [t.key for t in await db.scalars(
            select(SiteType).order_by(SiteType.sort_order))]
        statuses = list(await db.scalars(
            select(StatusValue.key)
            .where(StatusValue.record_type == "site")
            .order_by(StatusValue.sort_order)))
        return Response(
            bulk.build_template_xlsx(types, statuses),
            media_type="application/vnd.openxmlformats-officedocument"
                       ".spreadsheetml.sheet",
            headers={"Content-Disposition":
                     'attachment; filename="sites-template.xlsx"'})
    raise _err(422, "unknown_format")


@router.get("/bulk-import/export")
async def bulk_import_export(
    db: DbSession,
    format: str = "xlsx",
    actor: AuthContext = require_permission("sites", "add"),
):
    """The current sites in the template's layout — fill in, re-upload."""
    _require_bulk_rank(actor)
    if format not in ("csv", "xlsx"):
        raise _err(422, "unknown_format")
    rows = await bulk.export_rows(db)
    if format == "csv":
        return Response(bulk.build_rows_csv(rows), media_type="text/csv",
                        headers={"Content-Disposition":
                                 'attachment; filename="sites-export.csv"'})
    types = [t.key for t in await db.scalars(select(SiteType).order_by(SiteType.sort_order))]
    statuses = list(await db.scalars(
        select(StatusValue.key).where(StatusValue.record_type == "site")
        .order_by(StatusValue.sort_order)))
    return Response(
        bulk.build_rows_xlsx(rows, types, statuses),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="sites-export.xlsx"'})


async def _rows_from_request(request: Request) -> list[tuple[int, dict]]:
    ctype = request.headers.get("content-type", "")
    try:
        if ctype.startswith("multipart/"):
            form = await request.form()
            upload = form.get("file")
            if upload is None or isinstance(upload, str):
                raise bulk.BulkImportError("missing_file")
            return bulk.parse_upload(upload.filename or "", await upload.read())
        body = await request.json()
        return bulk.number_json_rows(body.get("rows"))
    except bulk.BulkImportError as exc:
        raise _bulk_err(exc) from None
    except (ValueError, AttributeError):
        raise _err(422, "invalid_json") from None


@router.post("/bulk-import/preview")
async def bulk_import_preview(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "add"),
) -> dict:
    _require_bulk_rank(actor)
    numbered = await _rows_from_request(request)
    return await bulk.preview_rows(db, numbered)


@router.post("/bulk-import/commit")
async def bulk_import_commit(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "add"),
) -> dict:
    _require_bulk_rank(actor)
    try:
        body = await request.json()
    except ValueError:
        raise _err(422, "invalid_json") from None
    try:
        numbered = bulk.number_json_rows(body.get("rows"))
    except bulk.BulkImportError as exc:
        raise _bulk_err(exc) from None
    approved = {str(s) for s in body.get("approved_updates") or []}
    try:
        return await bulk.commit_rows(
            db, actor.person.id, numbered, approved_updates=approved,
            source_label=str(body.get("source") or "paste"))
    except bulk.BulkImportError as exc:
        raise _bulk_err(exc) from None


async def _detail(db: DbSession, site: Site) -> SiteDetail:
    """One site with its labels, partner name, and client links.
    Shared by get_site and every write endpoint's response."""
    types, statuses = await _labels(db)
    partners = {}
    if site.partner_id:
        name = await db.scalar(select(Partner.name).where(Partner.id == site.partner_id))
        partners = {site.partner_id: name}
    clients = await _clients_by_site(db, [site.id])
    return SiteDetail(**_item(site, types, statuses, partners, clients))


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
NON_NULLABLE_SITE_TYPE_FIELDS = ("label", "description", "sort_order", "color")


@lookups_router.get("/site-types", response_model=list[SiteLookupOut])
async def list_site_types(
    db: DbSession,
    _actor: AuthContext = require_permission("sites", "view"),
) -> list[SiteLookupOut]:
    rows = (await db.scalars(
        select(SiteType).order_by(SiteType.sort_order, SiteType.label))).all()
    return [SiteLookupOut.model_validate(r) for r in rows]


@lookups_router.post("/site-types", response_model=SiteLookupOut, status_code=201)
async def create_site_type(
    body: SiteTypeCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "add"),
) -> SiteLookupOut:
    existing = await db.get(SiteType, body.key)
    if existing is not None:
        raise _err(409, "site_type_exists")
    row = SiteType(
        key=body.key, label=body.label, description=body.description,
        sort_order=body.sort_order, icon=body.icon, color=body.color,
        updated_at=datetime.now(UTC),
    )
    db.add(row)
    audit(db, actor_id=actor.person.id, entity_type="site_type",
          entity_id=body.key, action="create",
          changes=diff({}, snapshot(row, ["label", "description", "sort_order",
                                           "icon", "color"])))
    await db.commit()
    return SiteLookupOut.model_validate(row)


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
    fields = ["label", "description", "sort_order", "icon", "color"]
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


GROUP_LABELS: dict[str, str] = dict(SURVEY_GROUPS)


async def _people_names(db: DbSession, ids: set) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict((await db.execute(
        select(Person.id, Person.first_name + " " + Person.last_name)
        .where(Person.id.in_(ids)))).all())


def _survey_row(field: SurveyField, entry: SiteSurveyEntry | None,
               people: dict) -> SiteSurveyRowOut:
    return SiteSurveyRowOut(
        field_key=field.key, label=field.label, group=field.group,
        group_label=GROUP_LABELS.get(field.group, field.group),
        kind=field.kind, options=list(field.options),
        value=entry.value if entry is not None else None,
        raw_id=entry.raw_id if entry is not None else None,
        updated_by=entry.updated_by if entry is not None else None,
        updated_by_name=(people.get(entry.updated_by)
                         if entry is not None else None),
        updated_at=entry.updated_at if entry is not None else None,
    )


@router.get("/{site_id}/survey", response_model=list[SiteSurveyRowOut])
async def get_site_survey(
    site_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "view"),
) -> list[SiteSurveyRowOut]:
    _require_global(actor)
    await _get_site(db, site_id, actor)
    entries = {e.field_key: e for e in await db.scalars(
        select(SiteSurveyEntry).where(SiteSurveyEntry.site_id == site_id))}
    people = await _people_names(db, {e.updated_by for e in entries.values()})
    return [_survey_row(f, entries.get(f.key), people) for f in SURVEY_FIELDS]


@router.get("/{site_id}/survey/raw", response_model=list[RawSurveyRowOut])
async def get_site_survey_raw(
    site_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "view"),
) -> list[RawSurveyRowOut]:
    _require_global(actor)
    await _get_site(db, site_id, actor)
    rows = list(await db.scalars(
        select(RawSurveyEntry).where(RawSurveyEntry.site_id == site_id)
        .order_by(RawSurveyEntry.id.desc())))
    people = await _people_names(db, {r.submitted_by for r in rows})
    return [RawSurveyRowOut(
        id=r.id, field_key=r.field_key,
        registered=r.field_key in FIELDS_BY_KEY,
        value=r.value, captured_at=r.captured_at,
        submitted_by=r.submitted_by,
        submitted_by_name=people.get(r.submitted_by),
        device_id=r.device_id, source=r.source, created_at=r.created_at,
    ) for r in rows]


async def _clear_curated_survey_field(
    db: DbSession, site_id: uuid.UUID, field_key: str, actor: AuthContext,
    *, require_existing: bool,
) -> None:
    """Appends a null raw entry and deletes the curated row (write-both,
    clear direction). A no-op — no raw entry, no audit row — when nothing
    is curated and `require_existing` is False (the PUT-with-empty-value
    path); `require_existing=True` (DELETE) instead 404s."""
    existing = await db.scalar(select(SiteSurveyEntry).where(
        SiteSurveyEntry.site_id == site_id,
        SiteSurveyEntry.field_key == field_key))
    if existing is None:
        if require_existing:
            raise _err(404, "survey_value_not_found")
        return
    before = existing.value
    db.add(RawSurveyEntry(
        site_id=site_id, field_key=field_key, value=None,
        captured_at=datetime.now(UTC), submitted_by=actor.person.id,
        source="portal"))
    await db.delete(existing)
    audit(db, actor_id=actor.person.id, entity_type="site",
          entity_id=str(site_id), action="survey.update",
          changes={field_key: {"from": before, "to": None}})


async def _upsert_survey_entry(
    db: DbSession, site_id: uuid.UUID, field_key: str, cleaned, raw_id: int,
    actor_id: uuid.UUID, now: datetime, existing: SiteSurveyEntry | None,
) -> tuple[SiteSurveyEntry, object]:
    """Insert the curated row, or update it if the caller already selected
    `existing`. `site_survey_data` has UNIQUE(site_id, field_key) — under
    concurrent PUTs of the same field, both requests can miss the caller's
    select and both attempt the insert. Guard the insert in a savepoint:
    on IntegrityError the pending row is expunged automatically, so
    re-select the concurrent winner and fall through to the update path.
    Returns (entry, before-value) for the audit diff."""
    before = existing.value if existing is not None else None
    if existing is None:
        try:
            async with db.begin_nested():
                existing = SiteSurveyEntry(
                    site_id=site_id, field_key=field_key, value=cleaned,
                    raw_id=raw_id, updated_by=actor_id)
                db.add(existing)
                await db.flush()
            return existing, before
        except IntegrityError:
            existing = await db.scalar(select(SiteSurveyEntry).where(
                SiteSurveyEntry.site_id == site_id,
                SiteSurveyEntry.field_key == field_key))
            if existing is None:      # violation wasn't ours — re-raise
                raise
            before = existing.value

    existing.value = cleaned
    existing.raw_id = raw_id
    existing.updated_by = actor_id
    existing.updated_at = now
    await db.flush()
    return existing, before


@router.put("/{site_id}/survey/{field_key}", response_model=SiteSurveyRowOut)
async def put_site_survey_field(
    site_id: uuid.UUID,
    field_key: str,
    body: SiteSurveyValueIn,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "change"),
) -> SiteSurveyRowOut:
    _require_global(actor)
    await _get_site(db, site_id, actor)
    try:
        cleaned = validate_survey({field_key: body.value}).get(field_key)
    except SurveyError as exc:
        raise _err(422, exc.code, field=exc.field) from None
    field = FIELDS_BY_KEY[field_key]

    if cleaned is None:
        await _clear_curated_survey_field(
            db, site_id, field_key, actor, require_existing=False)
        await db.commit()
        return _survey_row(field, None, {})

    existing = await db.scalar(select(SiteSurveyEntry).where(
        SiteSurveyEntry.site_id == site_id,
        SiteSurveyEntry.field_key == field_key))
    if existing is not None and existing.value == cleaned:
        # idempotent PUT — value unchanged, so write nothing: no raw entry,
        # no audit row, no updated_by/updated_at/raw_id touch. Names
        # resolve against the existing row's updated_by, which may not be
        # this actor.
        people = await _people_names(db, {existing.updated_by})
        return _survey_row(field, existing, people)

    now = datetime.now(UTC)
    raw = RawSurveyEntry(site_id=site_id, field_key=field_key, value=cleaned,
                         captured_at=now, submitted_by=actor.person.id,
                         source="portal")
    db.add(raw)
    await db.flush()

    entry, before = await _upsert_survey_entry(
        db, site_id, field_key, cleaned, raw.id, actor.person.id, now, existing)

    audit(db, actor_id=actor.person.id, entity_type="site",
          entity_id=str(site_id), action="survey.update",
          changes={field_key: {"from": before, "to": cleaned}})
    await db.commit()

    people = await _people_names(db, {actor.person.id})
    return _survey_row(field, entry, people)


@router.delete("/{site_id}/survey/{field_key}", status_code=204)
async def delete_site_survey_field(
    site_id: uuid.UUID,
    field_key: str,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "change"),
) -> None:
    _require_global(actor)
    await _get_site(db, site_id, actor)
    await _clear_curated_survey_field(
        db, site_id, field_key, actor, require_existing=True)
    await db.commit()
