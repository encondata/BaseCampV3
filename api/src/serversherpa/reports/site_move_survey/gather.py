"""Site & Move Survey — gather step: reads the database into a plain
`SurveyData` dataclass carrying everything `context.build_context`,
`assets.asset_rows`, `standards.py`, and `photos.py` need. No ORM object
survives past this module — Task 4's `build()` is the only caller, and
it hands `SurveyData`'s fields straight to those pure functions. Mirrors
`reports/move_report/gather.py`'s split (read the DB once, up front) and
ports the resolution rules from V2's `api/reports/site_move_survey.py`
(read-only reference at /Users/jrh1812/Developer/BaseCampV2-reference)
where V3's schema still supports them.

See docs/superpowers/specs/2026-09-11-site-move-survey-design.md §
"Report module" for the gather bullet this implements.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, AssetModel, Attachment, Initiative, InitiativeAsset, Partner, Person,
    ReportRun, Site, SiteSurveyEntry,
)
from serversherpa.reports.site_move_survey.assets import AssetRowInput
from serversherpa.services.storage import get_object

# Attachments newer than this per site are ignored — matches V2's
# `_append_site_photos` `LIMIT 10`.
MAX_SITE_PHOTOS = 10


class SurveyGatherError(Exception):
    """Raised with one of this module's error codes; `build()` (Task 4)
    maps `.code` onto the run's `error` column verbatim, the same way
    Move Report's `InitiativeUnavailable` is mapped by its caller."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SurveyData:
    """Everything `build()` needs to fill the template, already resolved
    from the database.

    `origin_survey`/`destination_survey` are raw `field_key -> value`
    dicts straight from `site_survey_data` (undecorated — `context.
    site_context` is what renders booleans to yes/no and fills in every
    registry key); `assets` is the initiative's roster shaped for
    `assets.asset_rows`; `asset_notes` is the run option's free-form
    text (used only when `assets` is empty — see `context.build_context`
    and `fill.expand_asset_rows`); `template_bytes` is the report
    definition's (`run.definition_id`) newest `survey_template`
    attachment — templates are company-owned, attached to the report
    definition rather than the partner, so several may exist for
    different purposes and the newest one is what a run fills (per-
    purpose selection is deferred); `standards_docx_bytes` is the
    definition's newest `.docx`-named `report_asset` attachment, or
    `None` when there isn't one; `standards_attachment_id` accompanies
    it so `build()` can cache the parsed items by attachment id via
    `standards.parse_standards_cached` without re-deriving the id itself;
    `photos` holds already-fetched image bytes per site, origin then
    destination, skipping sites with none.
    """
    partner: Partner
    contact: Person | None
    client_address: str
    initiative: Initiative | None
    origin: Site | None
    destination: Site | None
    origin_survey: dict[str, object]
    destination_survey: dict[str, object]
    assets: list[AssetRowInput]
    asset_notes: str
    template_bytes: bytes
    standards_docx_bytes: bytes | None
    standards_attachment_id: uuid.UUID | None
    photos: list[tuple[str, list[bytes]]]


def _as_uuid(value) -> uuid.UUID | None:
    """Run options are JSONB, so ids arrive as strings (or are absent
    entirely). Returns `None` for anything that isn't a well-formed
    UUID string rather than raising — an option a caller forgot to
    validate just resolves as "not given"."""
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


async def _survey_answers(db: AsyncSession, site_id: uuid.UUID | None) -> dict[str, object]:
    if site_id is None:
        return {}
    rows = await db.scalars(
        select(SiteSurveyEntry).where(SiteSurveyEntry.site_id == site_id))
    return {row.field_key: row.value for row in rows}


async def _site_photos(db: AsyncSession, site: Site | None) -> list[bytes]:
    if site is None:
        return []
    atts = (await db.scalars(
        select(Attachment)
        .where(Attachment.entity_type == "site", Attachment.entity_id == site.id,
               Attachment.kind == "photo", Attachment.deleted_at.is_(None))
        .order_by(Attachment.created_at.desc(), Attachment.id.desc())
        .limit(MAX_SITE_PHOTOS))).all()
    return [await get_object(att.storage_key) for att in atts]


async def _newest_survey_template(db: AsyncSession, definition_id: uuid.UUID) -> Attachment | None:
    """The xlsx questionnaire template lives on the report definition,
    not the partner — several may be attached (a later version may pick
    one per purpose, e.g. move vs e-waste pickup); for now the newest
    (`created_at` DESC, `id` DESC tie-break) is the one a run fills. A
    `survey_template` row still sitting on a partner (a pre-migration-
    0053 legacy row) is never consulted here."""
    return await db.scalar(
        select(Attachment)
        .where(Attachment.entity_type == "report_definition",
               Attachment.entity_id == definition_id,
               Attachment.kind == "survey_template", Attachment.deleted_at.is_(None))
        .order_by(Attachment.created_at.desc(), Attachment.id.desc()).limit(1))


async def _newest_docx_report_asset(db: AsyncSession, definition_id: uuid.UUID) -> Attachment | None:
    """The definition's `report_asset` attachments can be a `.docx`
    (the standards doc) or a `.pdf` (per `attachments.py`'s
    `DOCUMENT_KIND_EXTENSIONS`) — filtered in Python rather than SQL so
    the match is an exact, case-insensitive suffix check regardless of
    the database's collation/LIKE-escaping rules."""
    atts = (await db.scalars(
        select(Attachment)
        .where(Attachment.entity_type == "report_definition",
               Attachment.entity_id == definition_id,
               Attachment.kind == "report_asset",
               Attachment.deleted_at.is_(None))
        .order_by(Attachment.created_at.desc(), Attachment.id.desc()))).all()
    for att in atts:
        if att.filename.lower().endswith(".docx"):
            return att
    return None


async def gather(db: AsyncSession, run: ReportRun) -> SurveyData:
    """Reads everything the Site & Move Survey build needs for one run.

    Resolution order: `partner_id` is a required run option — its
    absence, an unparsable value, or no matching row all raise
    `partner_not_found`; a partner missing `logistics` from
    `partner_types` raises `partner_not_logistics`; no `survey_template`
    attachment on the report definition (`run.definition_id`) raises
    `no_survey_template` — the template is company-owned, not the
    partner's, so this check no longer depends on which partner was
    chosen. The initiative (via `run.initiative_id`) is optional — any type works,
    and for a `move` its `origin_site_id`/`destination_site_id` seed the
    sites, overridable (or, with no initiative, wholly supplied) by the
    run's `source_site_id`/`destination_site_id` options. Assets come
    from the initiative's roster only (a survey with no initiative has
    none); the contact defaults to the run's requester when
    `contact_person_id` isn't given.
    """
    options = run.options or {}

    partner = None
    partner_id = _as_uuid(options.get("partner_id"))
    if partner_id is not None:
        partner = await db.get(Partner, partner_id)
    if partner is None:
        raise SurveyGatherError("partner_not_found")
    if "logistics" not in (partner.partner_types or []):
        raise SurveyGatherError("partner_not_logistics")

    template_att = await _newest_survey_template(db, run.definition_id)
    if template_att is None:
        raise SurveyGatherError("no_survey_template")
    template_bytes = await get_object(template_att.storage_key)

    initiative = await db.get(Initiative, run.initiative_id) if run.initiative_id else None

    origin_override = _as_uuid(options.get("source_site_id"))
    destination_override = _as_uuid(options.get("destination_site_id"))

    # The move-only site columns (db/models.py: Initiative's docstring)
    # stay populated (not wiped) after an admin changes a move to another
    # type, so a non-move initiative must never seed sites from them —
    # only run options do for those types.
    is_move = initiative is not None and initiative.initiative_type == "move"

    if origin_override is not None:
        origin = await db.get(Site, origin_override)
    elif is_move and initiative.origin_site_id is not None:
        origin = await db.get(Site, initiative.origin_site_id)
    else:
        origin = None

    if destination_override is not None:
        destination = await db.get(Site, destination_override)
    elif is_move and initiative.destination_site_id is not None:
        destination = await db.get(Site, initiative.destination_site_id)
    else:
        destination = None

    origin_survey = await _survey_answers(db, origin.id if origin else None)
    destination_survey = await _survey_answers(db, destination.id if destination else None)

    contact_id = _as_uuid(options.get("contact_person_id")) or run.requested_by
    contact = await db.get(Person, contact_id) if contact_id else None

    # V3's `Client` model carries no address columns (see db/models.py) —
    # there is nothing to read yet even though sites do link to clients
    # (the `site_clients` join table). Kept as its own line, not folded
    # into `context.py`, so the day address columns land on `Client` (or
    # `SiteClient`), only this needs to change.
    client_address = ""

    assets: list[AssetRowInput] = []
    if initiative is not None:
        rows = (await db.execute(
            select(InitiativeAsset, Asset, AssetModel)
            .join(Asset, Asset.id == InitiativeAsset.asset_id)
            .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
            .where(InitiativeAsset.initiative_id == initiative.id)
            .order_by(Asset.name.nullslast(), Asset.serial_number))).all()
        assets = [
            AssetRowInput(
                make=model.make if model else None,
                model=model.model if model else None,
                ru_size=model.ru_size if model else None,
                weight=model.weight_lbs if model else None,
                rack=ia.source_rack,
                ru_position=(float(ia.source_ru) if ia.source_ru is not None else None),
                legacy_id=asset.legacy_id,
                serial=asset.serial_number,
                name=asset.name,
                rfid=asset.rfid_tag,
                location=asset.location_detail or None,
            )
            for ia, asset, model in rows
        ]

    asset_notes = options.get("asset_notes") or ""

    photos: list[tuple[str, list[bytes]]] = []
    for label_prefix, site in (("Origin", origin), ("Destination", destination)):
        if site is None:
            continue
        if label_prefix == "Destination" and origin is not None and site.id == origin.id:
            # Same site chosen for both ends (e.g. an unset destination
            # override that happens to equal the origin) — V2 skipped
            # this rather than showing one site's photos twice under two
            # headings.
            continue
        images = await _site_photos(db, site)
        if images:
            photos.append((f"{label_prefix}: {site.name}", images))

    standards_att = await _newest_docx_report_asset(db, run.definition_id)
    standards_docx_bytes = (
        await get_object(standards_att.storage_key) if standards_att is not None else None)

    return SurveyData(
        partner=partner, contact=contact, client_address=client_address,
        initiative=initiative, origin=origin, destination=destination,
        origin_survey=origin_survey, destination_survey=destination_survey,
        assets=assets, asset_notes=asset_notes, template_bytes=template_bytes,
        standards_docx_bytes=standards_docx_bytes,
        standards_attachment_id=(standards_att.id if standards_att is not None else None),
        photos=photos,
    )
