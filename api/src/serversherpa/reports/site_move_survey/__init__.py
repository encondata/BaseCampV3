"""Site & Move Survey — fills a partner-annotated xlsx template with
initiative site/asset data. Port of V2's api/reports/site_move_survey.py
into V3's reports framework; see
docs/superpowers/specs/2026-09-11-site-move-survey-design.md § Report
module.

This module currently exposes the registry entry point and option schema
(so the definition can be seeded — migration 0052 — and its options
edited) plus the pure fill engine (`fill.py`), context builder
(`context.py`), and asset-row shaping (`assets.py`). `build()` itself is
completed in Task 4, once `gather.py` (Task 3) can read the database.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportRun
from serversherpa.reports.registry import OptionsError, ReportResult

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


async def build(db: AsyncSession, run: ReportRun) -> ReportResult:
    """Completed in Task 4: gather (Task 3) -> context.build_context ->
    fill.fill_workbook -> optional standards/photos sheets -> bytes."""
    raise NotImplementedError("site_move_survey.build is implemented in Task 4")
