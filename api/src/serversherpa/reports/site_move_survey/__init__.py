"""Site & Move Survey — fills a partner-annotated xlsx template with
initiative site/asset data. Port of V2's api/reports/site_move_survey.py
into V3's reports framework; see
docs/superpowers/specs/2026-09-11-site-move-survey-design.md § Report
module.

This module exposes the registry entry point and option schema (so the
definition can be seeded — migration 0052 — and its options edited),
the pure fill engine (`fill.py`), context builder (`context.py`), and
asset-row shaping (`assets.py`), plus `build()` itself: gather (Task 3's
`gather.py`) -> context -> fill -> optional standards/photos sheets ->
xlsx bytes.
"""

import re
import uuid
from datetime import datetime
from io import BytesIO

import openpyxl
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportDefinition, ReportRun
from serversherpa.reports.registry import OptionsError, ReportResult
from serversherpa.reports.site_move_survey.assets import asset_rows
from serversherpa.reports.site_move_survey.context import build_context
from serversherpa.reports.site_move_survey.fill import fill_workbook
from serversherpa.reports.site_move_survey.gather import SurveyGatherError, gather
from serversherpa.reports.site_move_survey.photos import append_site_photos
from serversherpa.reports.site_move_survey.standards import (
    append_standards_sheet, parse_standards_cached,
)

XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Same set `move_report.build` strips from its filename (backslash, slash,
# colon, asterisk, question mark, quote, angle brackets, pipe, plus any
# stray newline/tab) — characters invalid (or awkward) in a filename on
# every OS this runs on.
_FILENAME_UNSAFE_RE = re.compile(r'[\\/:*?"<>|\r\n\t]+')

report_type = "site_move_survey"

# Definition-level options — mirrored onto every run unless overridden on
# the Generate modal. Typed like Move Report's SECTION_KEYS, but with a
# free-text company name alongside the boolean toggles.
_STR_OPTIONS = ("company_name",)
_BOOL_OPTIONS = ("include_transportation_standards", "include_site_photos",
                 "condensed_assets")

# Run-only options: the partner/contact/sites/notes chosen on the
# Generate modal (see the design spec's § Portal), layered on top of the
# definition's options when a run is queued. `partner_id` is the only one
# that's required.
_REQUIRED_RUN_OPTIONS = ("partner_id",)
_OPTIONAL_RUN_OPTIONS = ("contact_person_id", "source_site_id",
                         "destination_site_id", "asset_notes")
_UUID_OPTIONS = frozenset(("partner_id", "contact_person_id", "source_site_id",
                           "destination_site_id"))

_RUN_OPTIONS = frozenset(_REQUIRED_RUN_OPTIONS + _OPTIONAL_RUN_OPTIONS)
_KNOWN_OPTIONS = frozenset(_STR_OPTIONS + _BOOL_OPTIONS) | _RUN_OPTIONS


def default_options() -> dict:
    return {
        "company_name": "Cumulus Solutions Group",
        "include_transportation_standards": True,
        "include_site_photos": True,
        "condensed_assets": True,
    }


def _is_uuid_str(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _shape_problems(options: dict) -> list[str]:
    """Pure shape/type checks shared by `validate_options` and
    `validate_run_options` — no presence requirements here, since the
    definition's own options never carry the run-only keys at all."""
    problems = [f"unknown option {k!r}" for k in options if k not in _KNOWN_OPTIONS]

    for key in _STR_OPTIONS:
        if key in options and not isinstance(options[key], str):
            problems.append(f"option {key!r} must be a string")
    for key in _BOOL_OPTIONS:
        if key in options and not isinstance(options[key], bool):
            problems.append(f"option {key!r} must be true/false")
    for key in _UUID_OPTIONS:
        if key in options and not _is_uuid_str(options[key]):
            problems.append(f"option {key!r} must be a uuid string")
    if "asset_notes" in options and not isinstance(options["asset_notes"], str):
        problems.append("option 'asset_notes' must be a string")
    return problems


def _normalize(options: dict) -> dict:
    normalized = dict(default_options())
    for key in _STR_OPTIONS + _BOOL_OPTIONS:
        if key in options:
            normalized[key] = options[key]
    for key in _RUN_OPTIONS:
        if key in options:
            normalized[key] = options[key]
    return normalized


def validate_options(options: dict) -> dict:
    """Pure shape/type validation for either shape this module's
    `options` JSONB takes: the definition's own (`company_name` plus the
    three toggles) or a run's (those same keys, plus whichever of the
    partner/contact/sites/notes keys chosen on the Generate modal are
    present). Unknown keys are always rejected; every known key is
    type-checked when present, but none — including `partner_id` — is
    required here. Use `validate_run_options` where a partner is
    mandatory (queuing a run). Raises `OptionsError`, the same type Move
    Report's `validate_options` raises, so `routes/reports.py`'s shared
    `_validated_options` helper needs no per-type branching for the
    definition-patch path.
    """
    problems = _shape_problems(options)
    if problems:
        raise OptionsError(problems)
    return _normalize(options)


def validate_run_options(options: dict) -> dict:
    """`validate_options` plus the one requirement that only applies when
    actually queuing a run: `partner_id` must be present (and a uuid
    string, already checked by the shared shape check). Task 4's
    `create_run` route and `build()` should call this instead of
    `validate_options` so a run without a partner fails loudly."""
    problems = _shape_problems(options)
    if "partner_id" not in options:
        problems.append("option 'partner_id' is required")
    if problems:
        raise OptionsError(problems)
    return _normalize(options)


def _sanitize_filename_part(value: str) -> str:
    return _FILENAME_UNSAFE_RE.sub("-", value or "").strip() or "partner"


def _merged_run_options(definition_options: dict | None, run_options: dict) -> dict:
    """The definition's saved options (`company_name` + the three
    toggles) are the baseline; the run's own options — which always
    carry `partner_id` and may carry the toggle overrides the Generate
    modal's per-run checkboxes send — win on any key they actually
    contain. Merging the RAW dicts before the single `validate_run_options`
    call (rather than validating `run_options` first) matters: once
    normalized, `validate_run_options` fills in every toggle/`company_name`
    key with this module's hardcoded defaults, which would then stomp the
    definition's real values for any key the run never mentioned (e.g.
    `company_name`, which the Generate modal never sends at all)."""
    merged = dict(definition_options or {})
    merged.update(run_options or {})
    return validate_run_options(merged)


async def build(db: AsyncSession, run: ReportRun) -> ReportResult:
    """gather (Task 3) -> context.build_context -> fill.fill_workbook ->
    optional standards/photos sheets -> xlsx bytes.

    `SurveyGatherError` propagates unchanged from `gather()` so
    `reports/worker.py` can map its `.code` onto the run's `error`
    column; a template openpyxl can't load raises the same exception
    type with code `template_unreadable` so the worker needs only one
    extra `except` clause for every failure this module can produce.
    """
    definition = await db.get(ReportDefinition, run.definition_id)
    options = _merged_run_options(definition.options if definition else None, run.options or {})

    data = await gather(db, run)

    rows = asset_rows(data.assets, condensed=options["condensed_assets"])
    context = build_context(
        partner=data.partner, company_name=options["company_name"], contact=data.contact,
        client_address=data.client_address, initiative=data.initiative, origin=data.origin,
        destination=data.destination, origin_survey=data.origin_survey,
        destination_survey=data.destination_survey, assets_notes=data.asset_notes,
        asset_count=len(data.assets))

    try:
        wb = openpyxl.load_workbook(BytesIO(data.template_bytes))
    except Exception as exc:
        raise SurveyGatherError("template_unreadable") from exc

    fill_workbook(wb, context, rows, data.asset_notes,
                 include_transportation_standards=options["include_transportation_standards"])

    has_transport_sheet = any("transport" in title.lower() for title in wb.sheetnames)
    if (options["include_transportation_standards"] and data.standards_docx_bytes
            and not has_transport_sheet):
        items = parse_standards_cached(data.standards_attachment_id, data.standards_docx_bytes)
        append_standards_sheet(wb, items)

    if options["include_site_photos"]:
        append_site_photos(wb, data.photos)      # no-op when every entry is empty

    buf = BytesIO()
    wb.save(buf)
    content = buf.getvalue()

    partner_name = _sanitize_filename_part(data.partner.name)
    filename = (f"Site & Move Survey - {partner_name} - {datetime.now():%Y-%m-%d %H%M}.xlsx")
    return ReportResult(content=content, filename=filename, content_type=XLSX_CONTENT_TYPE)
