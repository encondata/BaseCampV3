"""Pydantic bodies and responses for the plan API (api/routes/plans.py).

Every plan time is floating wall-clock text, `YYYY-MM-DDTHH:MM`
(plans/floating.py), never a zoned datetime. The audit-style moments
(`locked_at`, `baseline_set_at`, `completed_at`, `updated_at`) are real
instants and serialize as ISO datetimes with an offset."""

import math
import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from serversherpa.plans.durations import DurationError, Units, parse_duration
from serversherpa.plans.limits import MAX_RESTORE_ROWS


class PlanCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_start: str                      # YYYY-MM-DD (calendar default start) or a time
    owner_id: uuid.UUID | None = None
    # a plan template (plans/templates.py): its calendar, settings, tasks
    # and links, dates shifted to project_start; 404 `template_not_found`
    template_id: uuid.UUID | None = None


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
    also staff is listed once, as team; `is_staff` still says so (who can
    own the plan: service.is_staff)."""

    kind: Literal["person", "partner"]
    id: uuid.UUID
    name: str
    group: Literal["team", "staff", "partner"]
    has_email: bool
    has_account: bool
    is_staff: bool


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
    color: str | None                       # Gantt bar color "#rrggbb"; None = the default
    total_slack_minutes: int | None
    is_critical: bool
    conflict: str | None
    baseline_start: str | None
    baseline_finish: str | None
    baseline_duration_minutes: int | None
    # working minutes from the baseline to the schedule (MS Project's Start /
    # Finish Variance): negative when ahead, None without a baseline
    start_variance_minutes: int | None
    finish_variance_minutes: int | None
    completed_at: datetime | None
    completed_by_name: str | None
    predecessors: str                       # MS Project text: "2,3SS+1 day"
    successors: str
    assignees: list[AssigneeOut]
    status: TaskStatus
    missed_deadline: bool
    created_at: datetime
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
    system_settings: dict[str, Any]         # what the plan inherits: the system values, no calendar
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
# as null clears it where that makes sense (dates, notes, color) and is refused
# where it does not (name, duration, mode, ...).

MAX_OPS = 5000          # one paste of a whole plan, with room to spare


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
    color: str | None = None                # "#rrggbb", any case (stored lower-case); null clears
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
    color: str | None = None


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
    wins over the one % would fill or clear, except that 100 with
    `actual_finish: null` is 422 `bad_field` (a 100% task has an actual
    finish). `confirm` answers a `completion_confirm` (see `SetPercentOp`)."""

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
    `confirm: true`; either way nothing is written. `confirm` belongs to
    its op: it answers only what that op completes, so after a
    `completion_confirm` a client resends the batch with `confirm: true`
    on every op that completes something (set_percent, complete,
    mark_on_track, update_task)."""

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
    zero-duration milestone is 100 once it is reached, else 0 (one flagged
    with a duration counts as a task). A summary marks every leaf
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
    leaf spanning it is marked on track through it, never below the %
    it already has. A date alone is the calendar's default end of that
    day. `confirm` answers a `completion_confirm`, as on `set_percent`.

    The answer is an `OpsOut`, whose `tasks` are only the rows whose
    stored fields changed: a task whose `status` (late, in progress)
    changes only because of the new status date is not among them, so
    refetch the plan (or recompute status) after this call. The
    `inverse` puts the tasks back; it does not restore the status date."""

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


# --- plan-level writes (PATCH /plans/{id}, lock, baseline, version) ----------------


def _json_safe(value):
    """`value` with every NaN and Infinity (Python's JSON parser accepts
    them) replaced by its text, at any depth."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


class JsonSafeBody(BaseModel):
    """A request body whose NaN or Infinity is refused like any other bad
    value. FastAPI's 422 echoes each bad input, and a non-finite float
    cannot be written as JSON (the refusal would become a 500), so they
    arrive as text, which no number field takes."""

    @model_validator(mode="before")
    @classmethod
    def _finite(cls, data):
        return _json_safe(data)


class PlanPatchIn(JsonSafeBody):
    """PATCH /plans/{plan_id}: send `base_version` (409 `plan_changed`
    unless it is the plan's version) and only the fields that change.

    - `project_start`, `status_date`: floating times; a date alone is the
      calendar's default start (project start) or default end (status
      date) that day, the calendar sent with them, else the plan's.
      `status_date` null = now.
    - `timezone`: an IANA name from the tz database (422 `bad_timezone`).
    - `owner_id`: a staff person (422 `bad_owner`); null = no owner.
    - `calendar`: the whole calendar (422 `bad_calendar` {message}),
      stored in canonical form (plans/calendar.py, clean_calendar).
    - `settings`: merged into the plan's overrides key by key, one level
      down inside `completion` / `reminders`: a value overrides, null
      removes the override (that key, or a whole group) so the plan
      inherits the system value again. Checked as PlanSettingsOverrides
      (422 `bad_field`, `field` = "settings.<path>"); `default_duration`
      also against the 10-year cap in the units of the plan's calendar
      (the one sent with it, else the stored one).

    A locked plan takes only `status_date` and `owner_id`: sending any
    other field, even unchanged, is 409 `plan_locked`. The plan is
    recalculated, audited and its version bumped when anything changed;
    a PATCH that changes nothing answers the plan as it is."""

    model_config = ConfigDict(extra="forbid")

    base_version: int
    project_start: str | None = None
    timezone: str | None = None
    status_date: str | None = None
    owner_id: uuid.UUID | None = None
    calendar: Any = None                    # checked by the service: bad_calendar
    settings: Any = None                    # checked as PlanSettingsOverrides: bad_field


class BaselineIn(BaseModel):
    """POST /plans/{plan_id}/baseline (the body is optional). `replace`
    answers a 409 `baseline_exists` {set_at}."""

    model_config = ConfigDict(extra="forbid")

    replace: bool = False


class PlanVersionOut(BaseModel):
    """GET /plans/{plan_id}/version: what the tab polls to notice another
    admin's change."""

    version: int
    updated_at: datetime
    updated_by_name: str | None


# --- plan templates (plans/templates.py) ---


class PlanTemplateSaveIn(BaseModel):
    """POST /plans/{plan_id}/save-as-template. `name`: 1-120 characters
    once trimmed, unique ignoring case (409 `template_exists`);
    `description`: up to 1,000, blank = none. 422 `bad_field` {field}."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str | None = None


class PlanTemplatePatchIn(BaseModel):
    """PATCH /plan-templates/{id}: only the fields that change, with the
    save's rules; a null description clears it."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None


class PlanTemplateOut(BaseModel):
    """A template as GET /plan-templates lists it (never its data)."""

    id: uuid.UUID
    name: str
    description: str | None
    task_count: int
    created_by_name: str | None
    updated_at: datetime


# --- the all-initiatives Timeline page (GET /plans/timeline, plans/timeline.py) ---


class TimelineMilestoneOut(BaseModel):
    """A task flagged Show on timeline, as a diamond on its initiative's row."""

    initiative_id: uuid.UUID
    plan_id: uuid.UUID
    task_id: uuid.UUID
    name: str
    at: str                                 # its finish, floating
    day: str                                # YYYY-MM-DD: floating.last_day
    complete: bool
    late: bool


class TimelineNextOut(BaseModel):
    name: str
    at: str                                 # its finish, floating
    day: str                                # YYYY-MM-DD: floating.last_day


class TimelineSummaryOut(BaseModel):
    """One plan, for the initiative hover card's "Plan:" line."""

    percent_complete: int
    next: TimelineNextOut | None


class PlanTimelineOut(BaseModel):
    milestones: list[TimelineMilestoneOut]
    summaries: dict[uuid.UUID, TimelineSummaryOut]   # by initiative id


# --- settings (plan overrides, and the system section) -----------------------------
#
# One set of rules for both: a plan override is checked exactly like the
# system value it overrides. Strict types (no "yes" for true, no 2.0 for 2).

MAX_REMINDER_OFFSETS = 5
MAX_OFFSET_DAYS = 365
MAX_CRITICAL_SLACK_DAYS = 30
_HHMM = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")


def _send_time(value: str) -> str:
    if _HHMM.fullmatch(value) is None:
        raise ValueError("must be an HH:MM time, 00:00 to 23:59")
    return value


def _offsets(value: list[int]) -> list[int]:
    """1-5 distinct days before the due day, each 1-365; kept largest first."""
    if not 1 <= len(value) <= MAX_REMINDER_OFFSETS:
        raise ValueError(f"must list 1 to {MAX_REMINDER_OFFSETS} offsets")
    if len(set(value)) != len(value):
        raise ValueError("offsets must be distinct")
    if any(not 1 <= day <= MAX_OFFSET_DAYS for day in value):
        raise ValueError(f"each offset must be 1 to {MAX_OFFSET_DAYS} days")
    return sorted(value, reverse=True)


def _whole(value: float) -> int | float:
    """A whole number of days is kept as an int (2, not 2.0)."""
    return int(value) if value.is_integer() else value


def _duration_text(value: str) -> str:
    try:
        parse_duration(value, Units())
    except DurationError as exc:
        raise ValueError(str(exc)) from None
    return value


SubtasksRule = Literal["cascade", "block", "none"]
PredecessorsRule = Literal["block", "warn", "none"]
OverdueCadence = Literal["daily", "once", "off"]
TaskMode = Literal["auto", "manual"]
SendTime = Annotated[str, AfterValidator(_send_time)]
OffsetDays = Annotated[list[int], AfterValidator(_offsets)]
SlackDays = Annotated[float, Field(ge=0, le=MAX_CRITICAL_SLACK_DAYS, allow_inf_nan=False),
                      AfterValidator(_whole)]
DurationText = Annotated[str, AfterValidator(_duration_text)]

_SETTINGS = ConfigDict(extra="forbid", strict=True)


class CompletionSettings(BaseModel):
    model_config = _SETTINGS

    subtasks: SubtasksRule
    predecessors: PredecessorsRule


class ReminderSettings(BaseModel):
    model_config = _SETTINGS

    enabled: bool
    offsets_days: OffsetDays
    on_due_day: bool
    overdue: OverdueCadence
    send_time: SendTime                     # plan-local
    use_finish_without_deadline: bool
    notify_on_assign: bool
    overdue_to_owner: bool
    email_assignees: bool


class ProjectPlanSettingsOut(BaseModel):
    """GET|PUT /system/project-plans. A new plan copies `calendar`; every
    other key is inherited live by each plan that does not override it."""

    calendar: dict[str, Any]
    honor_constraints: bool
    critical_slack_days: int | float
    default_task_mode: str
    default_duration: str
    show_times: bool
    completion: CompletionSettings
    reminders: ReminderSettings


class ProjectPlanSettingsIn(JsonSafeBody):
    """PUT /system/project-plans: only the keys sent change, and none may be
    null. `completion` and `reminders` replace the whole group (every key
    required); `calendar` replaces the whole calendar, checked by the
    route (422 `bad_calendar` {message}) and stored in canonical form.
    `default_duration` is also held to the 10-year cap in the units of the
    calendar (the one sent with it, else the stored one): 422 `bad_field`
    {"field": "default_duration"}."""

    model_config = _SETTINGS

    calendar: dict[str, Any] | None = None
    honor_constraints: bool | None = None
    critical_slack_days: SlackDays | None = None
    default_task_mode: TaskMode | None = None
    default_duration: DurationText | None = None
    show_times: bool | None = None
    completion: CompletionSettings | None = None
    reminders: ReminderSettings | None = None

    @model_validator(mode="after")
    def _no_nulls(self):
        for key in self.model_fields_set:
            if getattr(self, key) is None:
                raise ValueError(f"{key} cannot be null")
        return self


class CompletionOverrides(BaseModel):
    model_config = _SETTINGS

    subtasks: SubtasksRule | None = None
    predecessors: PredecessorsRule | None = None


class ReminderOverrides(BaseModel):
    model_config = _SETTINGS

    enabled: bool | None = None
    offsets_days: OffsetDays | None = None
    on_due_day: bool | None = None
    overdue: OverdueCadence | None = None
    send_time: SendTime | None = None
    use_finish_without_deadline: bool | None = None
    notify_on_assign: bool | None = None
    overdue_to_owner: bool | None = None
    email_assignees: bool | None = None


class PlanSettingsOverrides(BaseModel):
    """A PATCH's `settings`: any subset of the system keys but `calendar`
    (a plan owns its own), with the same rules; null means "inherit"
    (plans/settings.py, merge_overrides)."""

    model_config = _SETTINGS

    honor_constraints: bool | None = None
    critical_slack_days: SlackDays | None = None
    default_task_mode: TaskMode | None = None
    default_duration: DurationText | None = None
    show_times: bool | None = None
    completion: CompletionOverrides | None = None
    reminders: ReminderOverrides | None = None
