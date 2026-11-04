"""Tell the people behind a bulk action how it ended. The import worker runs three jobs that
write data (ACTIONS); when one finishes or fails, the person who committed it and the uploader
(when that's someone else) each get an inbox notice, sent straight with `notify()` like a
report's "ready" (the kinds are not announced and nobody can watch for them). `run_once`
(imports/worker.py) calls `notify_job_done` once the job's own final state is committed, in a
session of its own, so a failure here can never undo the work.

A From-To file can be uploaded by one person and committed by another, so `recipients` names
both: the committer (`import_jobs.committed_by`, set by the commit route) first, then the
uploader (`created_by`). A job with no committer (a move setup, which its creator queues, or one
queued before migration 0119) tells its uploader alone, and one person who did both is told once.

Nothing is sent for:
- a validate pass (`writes_data`): it writes nothing, and the person is reviewing it on screen;
- a job with nobody to tell (`recipients` is empty): no committer and no uploader;
- a job that was canceled: whoever canceled it did that themselves.

A From-To import that leaves rows out (rows with an error, rows whose make and model needs
review) is still "finished", and its line says how many: nothing on the initiative lists the
rows that were not imported, and the import page keeps no earlier results.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 5), and answer 7
in docs/superpowers/specs/2026-11-02-notifications-phase2-as-built.md"""

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative
from serversherpa.notifications.inbox import notify

# The import_jobs kinds that write data, as the title names them: "{action} finished" or
# "{action} failed".
ACTIONS: dict[str, str] = {
    "asset_bulk_update": "Bulk update assets",
    "move_assets": "From-To import",
    "move_setup": "Move setup",
}

# Where a notice leads. None of the three jobs has a page of its own, so a finished notice
# opens the result, and a failed one the tool, to try again. `{id}` is the job's initiative
# (a failed move setup has none: its draft is kept, and /bulk/new-move opens a new wizard).
FINISHED_LINKS: dict[str, str] = {
    "asset_bulk_update": "/assets",
    "move_assets": "/initiatives/{id}?tab=assets",
    "move_setup": "/initiatives/{id}",
}
FAILED_LINKS: dict[str, str] = {
    "asset_bulk_update": "/bulk/assets",
    "move_assets": "/initiatives/{id}/import-assets",
    "move_setup": "/bulk/new-move",
}

# The only two statuses that end in a notice.
NOTIFIED_STATUSES = ("completed", "failed")


@dataclass(frozen=True)
class JobDone:
    """How one job ended, as the worker read it back from the row once its final state was
    committed. `created_by` is who uploaded it and `committed_by` who queued it to write (null
    for a move setup and for a job queued before migration 0119). `initiative_id` is the row's:
    a move setup sets it only at the very end. `rows_left_out` is a From-To import's count of
    rows it read but did not import (`count_left_out`); the other jobs leave it 0."""
    job_id: uuid.UUID
    kind: str
    phase: str
    status: str
    created_by: uuid.UUID | None
    initiative_id: uuid.UUID | None
    committed_by: uuid.UUID | None = None
    rows_left_out: int = 0


def writes_data(kind: str, phase: str) -> bool:
    """Whether a job of this kind, claimed in this phase, changes data (and so ends in a
    notice) rather than only checking a file. Every job that writes data is claimed in phase
    "commit": a bulk update's preview and a move setup's draft are never claimed until they are
    queued as a commit, and a From-To import's validate pass (also the move setup wizard's file
    check) writes nothing."""
    return kind in ACTIONS and phase == "commit"


def recipients(done: JobDone) -> list[uuid.UUID]:
    """Who hears how the job ended: the person who committed it, then the uploader when that's
    someone else. Either can be missing (no committer on a move setup or a job queued before
    migration 0119; no uploader on a job nobody started) and is left out; one person who did
    both is listed once. Empty when nobody is left."""
    people: list[uuid.UUID] = []
    for person_id in (done.committed_by, done.created_by):
        if person_id is not None and person_id not in people:
            people.append(person_id)
    return people


def count_left_out(summary: dict | None) -> int:
    """How many rows of a From-To import's file were read but not imported, from the summary
    the worker stored on the job: the rows with an error plus the rows whose make and model
    needs review. `ImportJob.error_count` holds only the first kind, so it is not the number
    on its own. The import page calls these rows "skipped", and a move setup records them as
    `assets_left_out`."""
    summary = summary or {}
    return int(summary.get("errors") or 0) + int(summary.get("review") or 0)


def _link(template: str, initiative_id: uuid.UUID | None) -> str | None:
    """The link for a kind, with the initiative filled in; none when it needs one and the
    job has none."""
    if "{id}" not in template:
        return template
    return None if initiative_id is None else template.format(id=initiative_id)


def _finished_line(done: JobDone, initiative: Initiative | None) -> str:
    """The initiative's name, and for a From-To import that left rows out, how many:
    "Move 1 · 3 rows not imported". Plain name when nothing was left out."""
    parts = [] if initiative is None else [initiative.name]
    if done.kind == "move_assets" and done.rows_left_out > 0:
        parts.append(f"{done.rows_left_out} row{'' if done.rows_left_out == 1 else 's'} "
                     "not imported")
    return " · ".join(parts)


async def notify_job_done(db: AsyncSession, done: JobDone) -> None:
    """Tell everyone in `recipients(done)` the job finished or failed, each the same notice.
    Adds to `db` and never commits, like notify(): the caller commits.

    Finished carries the initiative's name (and a From-To import's rows left out); failed is
    title and link only, since the error behind it is internal."""
    if not writes_data(done.kind, done.phase) or done.status not in NOTIFIED_STATUSES:
        return
    people = recipients(done)
    if not people:
        return
    action = ACTIONS[done.kind]
    if done.status == "completed":
        initiative = (await db.get(Initiative, done.initiative_id)
                      if done.initiative_id is not None else None)
        kind, title = "bulk_action_finished", f"{action} finished"
        body = _finished_line(done, initiative)
        link = _link(FINISHED_LINKS[done.kind], done.initiative_id)
    else:
        kind, title = "bulk_action_failed", f"{action} failed"
        body = ""
        link = _link(FAILED_LINKS[done.kind], done.initiative_id)
    for person_id in people:
        await notify(db, person_id, kind, title, body=body, link=link,
                     payload={"job_id": str(done.job_id), "job_kind": done.kind})
