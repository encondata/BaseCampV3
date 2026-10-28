"""Pydantic bodies and responses for the plan API (api/routes/plans.py).

Every plan time is floating wall-clock text, `YYYY-MM-DDTHH:MM`
(plans/floating.py), never a zoned datetime. The audit-style moments
(`locked_at`, `baseline_set_at`, `completed_at`, `updated_at`) are real
instants and serialize as ISO datetimes with an offset."""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


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
