"""Project plan ORM models; the schema of record is migration 0110.

Every schedule time is a floating local wall-clock time in the plan's zone
(`timestamp without time zone`). `Base` maps `datetime` to timestamptz, so
each wall-clock column below says `TIMESTAMP(timezone=False)` explicitly;
the audit-style columns (`created_at`, `updated_at`, `locked_at`, ...) are
the only timestamptz ones."""

import uuid
from datetime import datetime

from sqlalchemy import (
    TIMESTAMP,
    Boolean,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from serversherpa.db.models import Base


def _id() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, server_default=text("gen_random_uuid()"))


def _now() -> Mapped[datetime]:
    return mapped_column(server_default=text("now()"))


def _person() -> Mapped[uuid.UUID | None]:
    return mapped_column(ForeignKey("people.id", ondelete="SET NULL"))


def _wall() -> Mapped[datetime | None]:
    """A nullable floating wall-clock time."""
    return mapped_column(TIMESTAMP(timezone=False))


class ProjectPlan(Base):
    __tablename__ = "project_plans"

    id: Mapped[uuid.UUID] = _id()
    initiative_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    timezone: Mapped[str]                  # IANA name; "now" and reminder send times only
    project_start: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=False))
    status_date: Mapped[datetime | None] = _wall()    # null = "now"
    calendar: Mapped[dict] = mapped_column(JSONB)
    settings: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))    # per-plan overrides; null keys inherit
    owner_id: Mapped[uuid.UUID | None] = _person()
    locked_at: Mapped[datetime | None]
    locked_by: Mapped[uuid.UUID | None] = _person()
    baseline_set_at: Mapped[datetime | None]
    baseline_set_by: Mapped[uuid.UUID | None] = _person()
    version: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    created_by: Mapped[uuid.UUID | None] = _person()
    created_at: Mapped[datetime] = _now()
    updated_by: Mapped[uuid.UUID | None] = _person()
    updated_at: Mapped[datetime] = _now()

    __table_args__ = (UniqueConstraint(
        "initiative_id", name="project_plans_initiative_id_key"),)


class PlanTask(Base):
    __tablename__ = "plan_tasks"

    id: Mapped[uuid.UUID] = _id()
    plan_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("project_plans.id", ondelete="CASCADE"))
    # checked at COMMIT (migration 0110): an ops batch may point a task at
    # a parent it inserts in the same flush
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE", deferrable=True,
                   initially="DEFERRED"))
    position: Mapped[int] = mapped_column(Integer)    # whole-plan outline order
    name: Mapped[str]
    is_milestone: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    mode: Mapped[str] = mapped_column(server_default="auto")          # auto | manual
    duration_minutes: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    duration_unit: Mapped[str] = mapped_column(server_default="d")    # m h d w mo
    elapsed: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    start: Mapped[datetime | None] = _wall()
    finish: Mapped[datetime | None] = _wall()
    constraint_type: Mapped[str] = mapped_column(server_default="asap")
    constraint_date: Mapped[datetime | None] = _wall()
    deadline: Mapped[datetime | None] = _wall()
    percent_complete: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    actual_start: Mapped[datetime | None] = _wall()
    actual_finish: Mapped[datetime | None] = _wall()
    notes: Mapped[str | None]
    show_on_timeline: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    total_slack_minutes: Mapped[int | None] = mapped_column(Integer)
    is_critical: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    conflict: Mapped[str | None]                      # link | constraint
    baseline_start: Mapped[datetime | None] = _wall()
    baseline_finish: Mapped[datetime | None] = _wall()
    baseline_duration_minutes: Mapped[int | None] = mapped_column(Integer)
    completed_at: Mapped[datetime | None]
    completed_by: Mapped[uuid.UUID | None] = _person()
    created_by: Mapped[uuid.UUID | None] = _person()
    created_at: Mapped[datetime] = _now()
    updated_by: Mapped[uuid.UUID | None] = _person()
    updated_at: Mapped[datetime] = _now()

    __table_args__ = (
        Index("plan_tasks_plan_position_idx", "plan_id", "position"),
        Index("plan_tasks_parent_idx", "parent_id"),
        Index("plan_tasks_open_deadline_idx", "deadline",
              postgresql_where=text("percent_complete < 100")),
    )


class PlanLink(Base):
    __tablename__ = "plan_links"

    id: Mapped[uuid.UUID] = _id()
    plan_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("project_plans.id", ondelete="CASCADE"))
    predecessor_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE"))
    successor_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE"))
    link_type: Mapped[str] = mapped_column(server_default="FS")       # FS SS FF SF
    lag_minutes: Mapped[int] = mapped_column(Integer, server_default=text("0"))   # signed
    lag_unit: Mapped[str] = mapped_column(server_default="d")
    lag_elapsed: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))

    __table_args__ = (
        UniqueConstraint("predecessor_id", "successor_id", name="plan_links_pair_key"),
        Index("plan_links_plan_idx", "plan_id"),
    )


class PlanAssignment(Base):
    """A task's resource: exactly one of person_id / partner_id is set."""
    __tablename__ = "plan_assignments"

    id: Mapped[uuid.UUID] = _id()
    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE"))
    person_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="CASCADE"))
    partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id", ondelete="CASCADE"))

    __table_args__ = (
        Index("plan_assignments_task_person_uniq", "task_id", "person_id", unique=True,
              postgresql_where=text("person_id IS NOT NULL")),
        Index("plan_assignments_task_partner_uniq", "task_id", "partner_id", unique=True,
              postgresql_where=text("partner_id IS NOT NULL")),
    )


class PlanReminderLog(Base):
    """One row per reminder sent. Keyed on due_at, so moving a due date
    re-arms the task's reminders."""
    __tablename__ = "plan_reminder_log"

    id: Mapped[uuid.UUID] = _id()
    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_tasks.id", ondelete="CASCADE"))
    person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("people.id", ondelete="CASCADE"))
    stage: Mapped[str]                     # d<N> | due | overdue:<YYYY-MM-DD>
    due_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=False))
    sent_at: Mapped[datetime] = _now()

    __table_args__ = (UniqueConstraint(
        "task_id", "person_id", "stage", "due_at", name="plan_reminder_log_dedupe_key"),)


class PlanTemplate(Base):
    __tablename__ = "plan_templates"

    id: Mapped[uuid.UUID] = _id()
    name: Mapped[str] = mapped_column(CITEXT)
    description: Mapped[str | None] = mapped_column(Text)
    data: Mapped[dict] = mapped_column(JSONB)
    created_by: Mapped[uuid.UUID | None] = _person()
    created_at: Mapped[datetime] = _now()
    updated_by: Mapped[uuid.UUID | None] = _person()
    updated_at: Mapped[datetime] = _now()

    __table_args__ = (UniqueConstraint("name", name="plan_templates_name_key"),)
