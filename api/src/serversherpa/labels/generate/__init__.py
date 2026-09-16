"""Generate Labels — the package behind `label-worker`.

`values` builds the per-asset placeholder catalog (+ a template's
generation_rules); `select` resolves the active template for a label
type/site; `engine` renders one label (code or design kind) and reports
unknown tokens; `runner` drives one queued run end to end; `jobs` is the
run-table queue (claim/requeue, same shape as reports/jobs.py); `worker`
is the `serversherpa label-worker` process loop.

`enqueue_run` is the single entry point any surface (the future API
route, other packages) uses to queue a run — it owns label-type
validation, the one-active-run-per-initiative rule, and (per-type
template overrides) validating that each override key is one of the
run's own label types and each value an active template of that same
type, so every caller gets the same behavior. The runner honors an
override over `select.select_template`'s auto-match, falling back to
"no template" if the override was deactivated between enqueue and
processing."""

import uuid
from collections.abc import Sequence

# aliased: this package has a `select` SUBMODULE (generate/select.py), and
# once anything imports `serversherpa.labels.generate.select`, Python sets
# a same-named `select` attribute on THIS package's namespace — which is
# this very module's globals — clobbering a plain `from sqlalchemy import
# select` here. See labels/generate/select.py.
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LabelGenerationRun, LabelTemplate, LabelVocab

ACTIVE_STATUSES = ("queued", "running")


# Vocab `type` keys that are NOT asset/device labels — excluded from Generate
# Labels (the preview's type list and run validation). Container labels have
# their own page and report (Avery sheets, see reports/container_labels) and
# their own 4x6 ZPL templates (migration 0066); the runner here only walks
# assets, so every container type must be listed or it would emit one label
# per ASSET with empty container placeholders.
CONTAINER_LABEL_TYPES: frozenset[str] = frozenset({"container", "container_info"})

class InvalidLabelTypes(ValueError):
    """One or more requested label types are not active `type` vocab
    keys (or the list was empty). `problems` are the offending keys,
    sorted — an empty list means the request had no types at all."""

    def __init__(self, problems: list[str]):
        super().__init__(
            "no label types provided" if not problems
            else f"unknown or inactive label types: {', '.join(problems)}")
        self.problems = problems


class InvalidTemplates(ValueError):
    """One or more `template_overrides` entries are unusable: the key
    isn't one of the run's own label types, the template id doesn't
    exist or isn't active, or it exists but is a different type's
    template. `problems` are human-readable, one per offending entry,
    e.g. "front: template <id> is not active"."""

    def __init__(self, problems: list[str]):
        super().__init__(f"invalid template overrides: {', '.join(problems)}")
        self.problems = problems


class RunActive(Exception):
    """The initiative already has a queued/running run — `run_id` is that
    run so the caller can link to it (409 in the future API route)."""

    def __init__(self, run_id: uuid.UUID):
        super().__init__(f"a run is already active for this initiative: {run_id}")
        self.run_id = run_id


async def _validated_template_overrides(
    db: AsyncSession, template_overrides: dict[str, str] | None, requested: list[str],
) -> dict[str, str]:
    """Every key must be one of the run's own `requested` label types,
    and every value a template id that exists, is active, and whose
    `label_type` matches the key it's filed under. Returns the overrides
    with values normalized to plain uuid text, ready to store on the
    run — the runner reads them back with `uuid.UUID(...)`."""
    if not template_overrides:
        return {}

    problems: list[str] = []
    parsed: dict[str, uuid.UUID] = {}
    for label_type, raw_id in template_overrides.items():
        if label_type not in requested:
            problems.append(f"{label_type}: not one of the run's label types")
            continue
        try:
            parsed[label_type] = uuid.UUID(str(raw_id))
        except (ValueError, AttributeError, TypeError):
            problems.append(f"{label_type}: template {raw_id} is not active")

    if parsed:
        rows = (await db.execute(
            sa_select(LabelTemplate.id, LabelTemplate.label_type, LabelTemplate.is_active)
            .where(LabelTemplate.id.in_(parsed.values())))).all()
        by_id = {row_id: (row_type, row_active) for row_id, row_type, row_active in rows}
    else:
        by_id = {}

    validated: dict[str, str] = {}
    for label_type, template_id in parsed.items():
        found = by_id.get(template_id)
        if found is None or not found[1]:
            problems.append(f"{label_type}: template {template_id} is not active")
        elif found[0] != label_type:
            problems.append(f"{label_type}: template is a '{found[0]}' template")
        else:
            validated[label_type] = str(template_id)

    if problems:
        raise InvalidTemplates(problems)
    return validated


async def enqueue_run(
    db: AsyncSession, *, initiative_id: uuid.UUID, label_types: Sequence[str],
    regenerate_existing: bool, requested_by: uuid.UUID, notify: bool,
    template_overrides: dict[str, str] | None = None,
) -> LabelGenerationRun:
    requested = list(dict.fromkeys(label_types))          # de-dupe, keep order
    if not requested:
        raise InvalidLabelTypes([])
    # Generate Labels renders asset/device labels only. Container labels are
    # Avery sheets produced by the Container Labels page / report, so the
    # `container` and `container_info` vocab types are never valid asset run
    # types even when active.
    container_keys = [k for k in requested if k in CONTAINER_LABEL_TYPES]
    if container_keys:
        raise InvalidLabelTypes(
            [f"{k}: container labels are generated from the Container Labels page"
             for k in container_keys])
    active_keys = set((await db.execute(
        sa_select(LabelVocab.key).where(LabelVocab.kind == "type",
                                     LabelVocab.key.in_(requested),
                                     LabelVocab.is_active == True))).scalars())  # noqa: E712
    problems = sorted(set(requested) - active_keys)
    if problems:
        raise InvalidLabelTypes(problems)

    validated_overrides = await _validated_template_overrides(
        db, template_overrides, requested)

    existing = await db.scalar(
        sa_select(LabelGenerationRun).where(
            LabelGenerationRun.initiative_id == initiative_id,
            LabelGenerationRun.status.in_(ACTIVE_STATUSES)))
    if existing is not None:
        raise RunActive(existing.id)

    run = LabelGenerationRun(
        initiative_id=initiative_id, label_types=requested,
        regenerate_existing=regenerate_existing, requested_by=requested_by,
        notify=notify, status="queued", template_overrides=validated_overrides)
    db.add(run)
    await db.commit()
    return run
