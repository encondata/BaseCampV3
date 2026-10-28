"""Pydantic bodies and responses for the plan API (api/routes/plans.py).

Every plan time is floating wall-clock text, `YYYY-MM-DDTHH:MM`
(plans/floating.py), never a zoned datetime. The audit-style moments
(`locked_at`, `baseline_set_at`, `completed_at`, `updated_at`) are real
instants and serialize as ISO datetimes with an offset."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class PlanCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_start: str                      # YYYY-MM-DD (calendar default start) or a time
    owner_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None    # accepted, unused until templates land (Plan C)


class InitiativeWindow(BaseModel):
    start: str | None                       # YYYY-MM-DD
    end: str | None


class PlanPermissions(BaseModel):
    view: bool
    add: bool
    change: bool
    delete: bool


class AssigneeOut(BaseModel):
    kind: Literal["person", "partner"]
    id: uuid.UUID
    name: str


class ResourceOut(BaseModel):
    """One entry of the Resource Names picker. A person on the team who is
    also staff is listed once, as team."""

    kind: Literal["person", "partner"]
    id: uuid.UUID
    name: str
    group: Literal["team", "staff", "partner"]
    has_email: bool
    has_account: bool


class PlanLinkOut(BaseModel):
    id: uuid.UUID
    predecessor_id: uuid.UUID
    successor_id: uuid.UUID
    link_type: str
    lag_minutes: int
    lag_unit: str
    lag_elapsed: bool
    lag_text: str                           # "+2 days", "-4 hrs", "0 days"


TaskStatus = Literal["complete", "late", "in_progress", "not_started"]


class PlanTaskOut(BaseModel):
    id: uuid.UUID
    display_id: int                         # index + 1 in outline order
    wbs: str                                # "1", "1.2", "1.2.1"
    outline_level: int                      # 1 at the top
    parent_id: uuid.UUID | None
    position: int
    is_summary: bool
    name: str
    is_milestone: bool
    mode: str
    duration_minutes: int
    duration_unit: str
    elapsed: bool
    duration_text: str                      # "2 days", "4 hrs", "3 edays"
    start: str | None
    finish: str | None
    constraint_type: str
    constraint_date: str | None
    deadline: str | None
    percent_complete: int
    actual_start: str | None
    actual_finish: str | None
    notes: str | None
    show_on_timeline: bool
    total_slack_minutes: int | None
    is_critical: bool
    conflict: str | None
    baseline_start: str | None
    baseline_finish: str | None
    baseline_duration_minutes: int | None
    completed_at: datetime | None
    completed_by_name: str | None
    predecessors: str                       # MS Project text: "2,3SS+1 day"
    successors: str
    assignees: list[AssigneeOut]
    status: TaskStatus
    missed_deadline: bool
    updated_at: datetime


class PlanOut(BaseModel):
    id: uuid.UUID
    initiative_id: uuid.UUID
    initiative_name: str
    initiative_window: InitiativeWindow
    timezone: str
    project_start: str
    project_finish: str | None              # the latest task finish; None for an empty plan
    status_date: str | None                 # None = now
    now: str                                # plan-local now
    calendar: dict[str, Any]
    settings_overrides: dict[str, Any]
    settings: dict[str, Any]                # effective: system + overrides
    owner_id: uuid.UUID | None
    owner_name: str | None
    locked_at: datetime | None
    locked_by_name: str | None
    baseline_set_at: datetime | None
    version: int
    permissions: PlanPermissions
    tasks: list[PlanTaskOut]
    links: list[PlanLinkOut]
    resources: list[ResourceOut]


# --- ops (POST /plans/{plan_id}/ops) ------------------------------------------------
#
# Values are checked by plans/ops.py, not here, so a bad one answers 422
# {"code": "bad_field", "field": ...} (or `bad_duration`) like the rest of
# the plan API. A field left out of `fields` is not touched; a field sent
# as null clears it where that makes sense (dates, notes) and is refused
# where it does not (name, duration, mode, ...).

MAX_OPS = 5000          # one paste of a whole plan, with room to spare
MAX_RESTORE_ROWS = 20_000   # rows in each list of one restore op


class TaskFields(BaseModel):
    """The editable task fields; send only the ones that change."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    duration: str | None = None             # duration text: "2d", "4 hrs", "0", "3ed"
    start: str | None = None                # floating time; a date alone = default start
    finish: str | None = None               # a date alone = default end
    mode: str | None = None                 # auto | manual
    is_milestone: bool | None = None
    constraint_type: str | None = None      # asap snet snlt fnet fnlt mso mfo
    constraint_date: str | None = None
    deadline: str | None = None
    percent_complete: int | None = None
    actual_start: str | None = None
    actual_finish: str | None = None
    notes: str | None = None
    show_on_timeline: bool | None = None
    # The Predecessors cell, MS Project text ("2,3SS+1d"): replaces every
    # link into the task (numbering: see UpdateTaskOp).
    predecessors: str | None = None


class AddTaskOp(BaseModel):
    """A new task. With `before_id` it goes right above that task, as its
    sibling; otherwise it is the last subtask of `parent_id`, or the last
    task of the plan. `temp_id` is the client's name for it, answered in
    `OpsOut.temp_ids`."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["add_task"]
    temp_id: str | None = None
    before_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None
    name: str = ""
    duration: str | None = None
    start: str | None = None
    finish: str | None = None
    mode: str | None = None
    is_milestone: bool | None = None
    deadline: str | None = None
    notes: str | None = None


class UpdateTaskOp(BaseModel):
    """Edits one task's fields. `fields.predecessors` replaces every link
    into the task; its numbers are display IDs in the outline order as it
    stood when the batch began, before any of the batch's outline changes
    (add, delete, move, indent, outdent, restore) are applied, since that
    is the outline the text was typed against. A task added in the batch
    cannot be named, nor one deleted earlier in it.

    `fields.percent_complete` is a progress edit, the same as `set_percent`
    (its actuals, stamps and completion rules), applied after the task's
    other fields and its Predecessors; an actual sent in the same `fields`
    wins over the one % would fill or clear. `confirm` answers a
    `completion_confirm` (see `SetPercentOp`)."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["update_task"]
    id: uuid.UUID
    fields: TaskFields
    confirm: bool = False


class DeleteTasksOp(BaseModel):
    """Deletes each task with all of its subtasks (and their links)."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["delete_tasks"]
    ids: list[uuid.UUID]


class MoveTasksOp(BaseModel):
    """Moves the tasks (each with its subtasks, in outline order) right
    above `before_id`, else to the end of `parent_id`'s subtasks, else to
    the end of the plan."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["move_tasks"]
    ids: list[uuid.UUID]
    before_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None


class IndentOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["indent"]
    ids: list[uuid.UUID]


class OutdentOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["outdent"]
    ids: list[uuid.UUID]


class AddLinkOp(BaseModel):
    """A link from `predecessor_id` to `successor_id`: `link_type` FS, SS,
    FF or SF, and `lag` as lag text ("+2d", "-4h", "1ed"; negative is a
    lead). The new link's id comes back in `OpsOut.links`."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["add_link"]
    predecessor_id: uuid.UUID
    successor_id: uuid.UUID
    link_type: str = "FS"
    lag: str = "0"


class UpdateLinkOp(BaseModel):
    """Changes a link's type or lag; its ends never change (delete it and
    add another)."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["update_link"]
    id: uuid.UUID
    link_type: str | None = None
    lag: str | None = None


class DeleteLinkOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["delete_link"]
    id: uuid.UUID


class ResourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str                               # person | partner
    id: uuid.UUID


class SetAssigneesOp(BaseModel):
    """Replaces the task's assignees (an empty list clears them). A new
    assignee must be in the plan's `resources`; one the task already has
    stays allowed after leaving that list (archived, off the team).
    "Already has" means assigned when this op runs (an earlier op in the
    same batch counts), not when the batch began."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["set_assignees"]
    task_id: uuid.UUID
    resources: list[ResourceRef]


class SetPercentOp(BaseModel):
    """Sets each task's % complete (0-100) with its actuals: above 0 an
    empty actual start becomes the scheduled start; 100 fills an empty
    actual finish with the scheduled finish and stamps who completed it
    and when; below 100 clears the actual finish and the stamps, and 0 the
    actual start too. A summary's % is derived: 100 completes it (as
    `complete`), anything else is 422 `summary_field`.

    A task reaching 100% goes through the plan's completion rules
    (plans/completion.py) once the batch's ops have run: 409
    `completion_blocked` {blockers}, or 409 `completion_confirm`
    {will_complete, open_predecessors} until the op is resent with
    `confirm: true`; either way nothing is written."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["set_percent"]
    ids: list[uuid.UUID]
    percent: int
    confirm: bool = False


class CompleteOp(BaseModel):
    """`set_percent` 100."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["complete"]
    ids: list[uuid.UUID]
    confirm: bool = False


class MarkOnTrackOp(BaseModel):
    """MS Project's Mark on Track: each task's % becomes the share of its
    duration scheduled before the status date (the plan's, else now); a
    milestone is 100 once it is reached, else 0. A summary marks every leaf
    below it. Reaching 100 goes through the completion rules, so it takes a
    `confirm` like `set_percent`."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["mark_on_track"]
    ids: list[uuid.UUID]
    confirm: bool = False


class RestoreOp(BaseModel):
    """Puts rows back as an earlier batch found them: the `inverse` of
    every batch is one of these (plans/ops_inverse.py has the row format).
    `tasks` re-creates a missing task from its full snapshot or writes the
    given fields onto an existing one; `links` likewise; each `assignments`
    entry ({task_id, resources: [{kind, id}]}) replaces that task's
    assignees; `remove_tasks` (with their subtasks) and `remove_links` are
    deleted.

    Only the server writes these: `sig` is its signature over the plan id
    and every other field of the op, and a restore without a valid one for
    this plan is refused (422 `bad_restore`). Send an inverse back
    unchanged."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["restore"]
    tasks: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_RESTORE_ROWS)
    links: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_RESTORE_ROWS)
    assignments: list[dict[str, Any]] = Field(default_factory=list,
                                              max_length=MAX_RESTORE_ROWS)
    remove_tasks: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_RESTORE_ROWS)
    remove_links: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_RESTORE_ROWS)
    sig: str | None = Field(default=None, max_length=128)


Op = Annotated[
    AddTaskOp | UpdateTaskOp | DeleteTasksOp | MoveTasksOp | IndentOp | OutdentOp
    | AddLinkOp | UpdateLinkOp | DeleteLinkOp | SetAssigneesOp | SetPercentOp | CompleteOp
    | MarkOnTrackOp | RestoreOp,
    Field(discriminator="op"),
]


class OpsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_version: int
    ops: list[Op] = Field(min_length=1, max_length=MAX_OPS)


class UpdateProjectIn(BaseModel):
    """POST /plans/{plan_id}/update-project (MS Project's Update Project).
    `status_date` is stored (null = now); with `complete_through` every
    incomplete leaf finishing by then goes to 100% and every incomplete
    leaf spanning it is marked on track through it. A date alone is the
    calendar's default end of that day. `confirm` answers a
    `completion_confirm`, as on `set_percent`."""

    model_config = ConfigDict(extra="forbid")

    status_date: str | None
    complete_through: str | None = None
    confirm: bool = False


class OpsOut(BaseModel):
    """What one batch changed. `tasks` and `links` are only the rows whose
    stored fields changed (the engine's included); `order` is the whole
    outline order when any task's parent or position changed (else None),
    for the client to renumber display IDs and WBS. `inverse` is the batch
    that undoes this one."""

    version: int
    tasks: list[PlanTaskOut]
    links: list[PlanLinkOut]
    deleted_tasks: list[uuid.UUID]
    deleted_links: list[uuid.UUID]
    order: list[uuid.UUID] | None
    temp_ids: dict[str, uuid.UUID]
    inverse: list[dict[str, Any]]
    notices: list[dict[str, Any]]
