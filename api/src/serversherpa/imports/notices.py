"""Tell the person who started a bulk action how it ended. The import worker runs three jobs
that write data (ACTIONS); when one finishes or fails, its owner gets an inbox notice, sent
straight with `notify()` like a report's "ready" (the kinds are not announced and nobody can
watch for them). `run_once` (imports/worker.py) calls `notify_job_done` once the job's own
final state is committed, in a session of its own, so a failure here can never undo the work.

Nothing is sent for:
- a validate pass (`writes_data`): it writes nothing, and the person is reviewing it on screen;
- a job whose `created_by` is null: there is nobody to tell;
- a job that was canceled: the person did that themselves.

A From-To import that finishes with row errors is still "finished": the rows it could not
take are listed on the initiative's assets.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 5)"""

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
ANNOUNCED = ("completed", "failed")


@dataclass(frozen=True)
class JobDone:
    """How one job ended, as the worker read it back from the row once its final state was
    committed. `initiative_id` is the row's: a move setup sets it only at the very end."""
    job_id: uuid.UUID
    kind: str
    phase: str
    status: str
    created_by: uuid.UUID | None
    initiative_id: uuid.UUID | None


def writes_data(kind: str, phase: str) -> bool:
    """Whether a job of this kind, claimed in this phase, changes data (and so ends in a
    notice) rather than only checking a file. A bulk update and a move setup always do (their
    previews run in the API request and are never claimed); a From-To import only in its
    commit phase, which also leaves the move setup wizard's file checks out."""
    if kind == "move_assets":
        return phase == "commit"
    return kind in ("asset_bulk_update", "move_setup")


def _link(template: str, initiative_id: uuid.UUID | None) -> str | None:
    """The link for a kind, with the initiative filled in; none when it needs one and the
    job has none."""
    if "{id}" not in template:
        return template
    return None if initiative_id is None else template.format(id=initiative_id)


async def notify_job_done(db: AsyncSession, done: JobDone) -> None:
    """Tell the job's owner it finished or failed. Adds to `db` and never commits, like
    notify(): the caller commits.

    Finished carries the initiative's name; failed is title and link only, since the error
    behind it is internal."""
    if (not writes_data(done.kind, done.phase) or done.created_by is None
            or done.status not in ANNOUNCED):
        return
    action = ACTIONS[done.kind]
    payload = {"job_id": str(done.job_id), "job_kind": done.kind}
    if done.status == "completed":
        initiative = (await db.get(Initiative, done.initiative_id)
                      if done.initiative_id is not None else None)
        await notify(db, done.created_by, "bulk_action_finished", f"{action} finished",
                     body=initiative.name if initiative is not None else "",
                     link=_link(FINISHED_LINKS[done.kind], done.initiative_id),
                     payload=payload)
    else:
        await notify(db, done.created_by, "bulk_action_failed", f"{action} failed",
                     link=_link(FAILED_LINKS[done.kind], done.initiative_id),
                     payload=payload)
