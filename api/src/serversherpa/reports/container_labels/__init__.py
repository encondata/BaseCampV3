"""Container Labels — Avery 5164 sheets, one page per container with
five barcode labels and one QR info label, exactly as V2 produced them.
Port of V2's `/labels/containers` page (browser-drawn jsPDF/bwip-js)
into V3's reports framework, so any surface (Reports, the report
worker/inbox) can request the same PDF the portal downloads directly.
See docs/superpowers/specs/2026-09-12-container-labels-design.md
§ Report module.

No definition-level options (`{}`) — everything a run needs
(`container_ids`, `tags`) is chosen per-generation on the Generate
modal, exactly as V2's tag choices were never persisted."""

import re
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportRun
from serversherpa.reports import container_label_renderer
from serversherpa.reports.container_labels.gather import gather
from serversherpa.reports.move_report.gather import InitiativeUnavailable
from serversherpa.reports.registry import OptionsError, ReportResult

report_type = "container_labels"

TAG_KEYS = ("priority", "vendor", "accessories", "ewaste", "warehouse")

# Same set move_report.build strips from its filename (backslash, slash,
# colon, asterisk, question mark, quote, angle brackets, pipe, plus any
# stray newline/tab).
_FILENAME_UNSAFE_RE = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def default_options() -> dict:
    return {}


def validate_options(options: dict) -> dict:
    """Definition-level options: none. Unknown keys are rejected, same
    OptionsError contract as every other module."""
    if options:
        raise OptionsError([f"unknown option {k!r}" for k in options])
    return {}


def _is_uuid_str(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def validate_run_options(options: dict) -> dict:
    """Run-level options: `container_ids` (a non-empty list of uuid
    strings, required) and `tags` (container id -> one of TAG_KEYS,
    optional — every key must also appear in `container_ids`, else
    `tag_for_unknown_container:<id>`). Both `container_ids` and `tags`
    keys are canonicalized (`str(uuid.UUID(v))`) in the returned dict,
    so `{cid.upper(): "priority"}` and `{cid: "priority"}` compare
    equal downstream — `build()`'s `tags.get(c.id)` lookup depends on
    this, since `gather()`'s `c.id` is always the canonical form."""
    known = {"container_ids", "tags"}
    problems = [f"unknown option {k!r}" for k in options if k not in known]

    container_ids = options.get("container_ids")
    canonical_ids: list[str] = []
    if container_ids is None:
        problems.append("option 'container_ids' is required")
    elif not isinstance(container_ids, list) or not container_ids:
        problems.append("option 'container_ids' must be a non-empty list")
    elif bad := [v for v in container_ids if not _is_uuid_str(v)]:
        problems.append(f"option 'container_ids' must contain uuid strings (bad: {bad!r})")
    else:
        canonical_ids = [str(uuid.UUID(v)) for v in container_ids]

    raw_tags = options.get("tags", {})
    canonical_tags: dict = {}
    if "tags" in options and not isinstance(options["tags"], dict):
        problems.append("option 'tags' must be an object")
    elif isinstance(raw_tags, dict):
        for cid, tag in raw_tags.items():
            if not _is_uuid_str(cid):
                problems.append(f"tag key {cid!r} must be a uuid string")
                continue
            if tag is not None and tag not in TAG_KEYS:
                problems.append(f"tag value {tag!r} must be one of {TAG_KEYS}")
                continue
            canonical_tags[str(uuid.UUID(cid))] = tag
        if canonical_ids:
            for cid in canonical_tags:
                if cid not in canonical_ids:
                    problems.append(f"tag_for_unknown_container:{cid}")

    if problems:
        raise OptionsError(problems)
    return {"container_ids": canonical_ids, "tags": canonical_tags}


async def build(db: AsyncSession, run: ReportRun) -> ReportResult:
    """gather -> payload -> container_label_renderer.render -> PDF."""
    if run.initiative_id is None:
        # routes.create_run already enforces this (`initiative_required`)
        # for every report type but Site & Move Survey — belt and
        # suspenders should `build()` ever be called directly, same as
        # move_scan_history.build's own check.
        raise InitiativeUnavailable("container_labels requires an initiative")

    run_options = validate_run_options(run.options or {})
    container_ids = [uuid.UUID(cid) for cid in run_options["container_ids"]]
    tags: dict = run_options["tags"]

    data = await gather(db, run.initiative_id, container_ids)

    payload = {
        "move": {
            "id": data.initiative_id,
            "name": data.initiative_name,
            "sourceSite": data.origin_site_name,
            "destSite": data.destination_site_name,
            "scheduledStart": (data.scheduled_start.isoformat()
                              if data.scheduled_start else None),
        },
        "containers": [
            {"id": c.id, "name": c.name, "tag": tags.get(c.id)}
            for c in data.containers
        ],
        "tag_image_dir": container_label_renderer.tag_image_dir(),
    }
    content = await container_label_renderer.render(payload)

    safe_name = _FILENAME_UNSAFE_RE.sub("-", data.initiative_name).strip() or "initiative"
    stamp = datetime.now(UTC).strftime("%Y-%m-%d %H%M")
    filename = f"Container Labels - {safe_name} - {stamp}.pdf"
    return ReportResult(content=content, filename=filename, content_type="application/pdf")
