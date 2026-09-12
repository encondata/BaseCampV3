"""Generate Labels — the package behind `label-worker`.

`values` builds the per-asset placeholder catalog (+ a template's
generation_rules); `select` resolves the active template for a label
type/site; `engine` renders one label (code or design kind) and reports
unknown tokens; `runner` drives one queued run end to end; `jobs` is the
run-table queue (claim/requeue, same shape as reports/jobs.py); `worker`
is the `serversherpa label-worker` process loop.

`enqueue_run` is the single entry point any surface (the future API
route, other packages) uses to queue a run — it owns label-type
validation and the one-active-run-per-initiative rule so every caller
gets the same behavior."""

import uuid
from collections.abc import Sequence

# aliased: this package has a `select` SUBMODULE (generate/select.py), and
# once anything imports `serversherpa.labels.generate.select`, Python sets
# a same-named `select` attribute on THIS package's namespace — which is
# this very module's globals — clobbering a plain `from sqlalchemy import
# select` here. See labels/generate/select.py.
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LabelGenerationRun, LabelVocab

ACTIVE_STATUSES = ("queued", "running")


class InvalidLabelTypes(ValueError):
    """One or more requested label types are not active `type` vocab
    keys (or the list was empty). `problems` are the offending keys,
    sorted — an empty list means the request had no types at all."""

    def __init__(self, problems: list[str]):
        super().__init__(
            "no label types provided" if not problems
            else f"unknown or inactive label types: {', '.join(problems)}")
        self.problems = problems


class RunActive(Exception):
    """The initiative already has a queued/running run — `run_id` is that
    run so the caller can link to it (409 in the future API route)."""

    def __init__(self, run_id: uuid.UUID):
        super().__init__(f"a run is already active for this initiative: {run_id}")
        self.run_id = run_id


async def enqueue_run(
    db: AsyncSession, *, initiative_id: uuid.UUID, label_types: Sequence[str],
    regenerate_existing: bool, requested_by: uuid.UUID, notify: bool,
) -> LabelGenerationRun:
    requested = list(dict.fromkeys(label_types))          # de-dupe, keep order
    if not requested:
        raise InvalidLabelTypes([])
    active_keys = set((await db.execute(
        sa_select(LabelVocab.key).where(LabelVocab.kind == "type",
                                     LabelVocab.key.in_(requested),
                                     LabelVocab.is_active == True))).scalars())  # noqa: E712
    problems = sorted(set(requested) - active_keys)
    if problems:
        raise InvalidLabelTypes(problems)

    existing = await db.scalar(
        sa_select(LabelGenerationRun).where(
            LabelGenerationRun.initiative_id == initiative_id,
            LabelGenerationRun.status.in_(ACTIVE_STATUSES)))
    if existing is not None:
        raise RunActive(existing.id)

    run = LabelGenerationRun(
        initiative_id=initiative_id, label_types=requested,
        regenerate_existing=regenerate_existing, requested_by=requested_by,
        notify=notify, status="queued")
    db.add(run)
    await db.commit()
    return run
