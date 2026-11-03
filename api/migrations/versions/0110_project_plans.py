"""Project plans: one MS Project-style schedule per initiative (plans, tasks,
links, assignments, the reminder log, templates); the `project_plans`
permission resource; notification groups accept the 'plans' category.

All schedule times are floating local wall-clock times in the plan's zone
(`timestamp without time zone`); only audit-style columns are timestamptz.

Design: docs/superpowers/specs/2026-10-27-project-plans-design.md

Revision ID: 0110
Revises: 0109
Create Date: 2026-10-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0110"
down_revision: str | None = "0109"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
FULL_ROLES = ("developer", "founder", "super_admin", "admin")

OLD_CATEGORIES = ("categories <@ ARRAY['approvals','reports','wiki','security',"
                  "'learning']::text[]")
NEW_CATEGORIES = ("categories <@ ARRAY['approvals','reports','wiki','security',"
                  "'learning','plans']::text[]")

# creation order; downgrade drops in reverse
TABLES = (
    "project_plans", "plan_tasks", "plan_links", "plan_assignments",
    "plan_reminder_log", "plan_templates",
)

DDL = (
    # one plan per initiative. `settings` holds the per-plan overrides of the
    # system section (a missing or null key inherits); `version` is bumped on
    # every write and checked by structural ops.
    """
    CREATE TABLE project_plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        initiative_id uuid NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
        timezone text NOT NULL,
        project_start timestamp NOT NULL,
        status_date timestamp,
        calendar jsonb NOT NULL,
        settings jsonb NOT NULL DEFAULT '{}'::jsonb,
        owner_id uuid REFERENCES people(id) ON DELETE SET NULL,
        locked_at timestamptz,
        locked_by uuid REFERENCES people(id) ON DELETE SET NULL,
        baseline_set_at timestamptz,
        baseline_set_by uuid REFERENCES people(id) ON DELETE SET NULL,
        version integer NOT NULL DEFAULT 1,
        created_by uuid REFERENCES people(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid REFERENCES people(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT project_plans_initiative_id_key UNIQUE (initiative_id)
    )
    """,
    # `position` is the whole-plan outline order; summary-ness is derived from
    # children and never stored. start/finish are engine output for auto tasks
    # and user input for manual ones. The parent FK is checked at COMMIT, so
    # one ops batch can insert a task and point an existing one at it in any
    # statement order (the ORM sends a table's UPDATEs before its INSERTs);
    # the cascade on delete still runs at once. `color` is the task's Gantt
    # bar color, a lower-case #rrggbb (null = the default bar color).
    """
    CREATE TABLE plan_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_id uuid NOT NULL REFERENCES project_plans(id) ON DELETE CASCADE,
        parent_id uuid REFERENCES plan_tasks(id) ON DELETE CASCADE
            DEFERRABLE INITIALLY DEFERRED,
        position integer NOT NULL,
        name text NOT NULL,
        is_milestone boolean NOT NULL DEFAULT false,
        mode text NOT NULL DEFAULT 'auto',
        duration_minutes integer NOT NULL DEFAULT 0,
        duration_unit text NOT NULL DEFAULT 'd',
        elapsed boolean NOT NULL DEFAULT false,
        start timestamp,
        finish timestamp,
        constraint_type text NOT NULL DEFAULT 'asap',
        constraint_date timestamp,
        deadline timestamp,
        percent_complete integer NOT NULL DEFAULT 0,
        actual_start timestamp,
        actual_finish timestamp,
        notes text,
        show_on_timeline boolean NOT NULL DEFAULT false,
        color text,
        total_slack_minutes integer,
        is_critical boolean NOT NULL DEFAULT false,
        conflict text,
        baseline_start timestamp,
        baseline_finish timestamp,
        baseline_duration_minutes integer,
        completed_at timestamptz,
        completed_by uuid REFERENCES people(id) ON DELETE SET NULL,
        created_by uuid REFERENCES people(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid REFERENCES people(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT plan_tasks_mode_check CHECK (mode IN ('auto', 'manual')),
        CONSTRAINT plan_tasks_duration_unit_check
            CHECK (duration_unit IN ('m', 'h', 'd', 'w', 'mo')),
        CONSTRAINT plan_tasks_duration_minutes_check CHECK (duration_minutes >= 0),
        CONSTRAINT plan_tasks_constraint_type_check
            CHECK (constraint_type IN ('asap', 'snet', 'snlt', 'fnet', 'fnlt', 'mso', 'mfo')),
        CONSTRAINT plan_tasks_percent_complete_check
            CHECK (percent_complete BETWEEN 0 AND 100),
        CONSTRAINT plan_tasks_conflict_check
            CHECK (conflict IS NULL OR conflict IN ('link', 'constraint')),
        CONSTRAINT plan_tasks_color_check CHECK (color ~ '^#[0-9a-f]{6}$')
    )
    """,
    "CREATE INDEX plan_tasks_plan_position_idx ON plan_tasks (plan_id, position)",
    "CREATE INDEX plan_tasks_parent_idx ON plan_tasks (parent_id)",
    # a person delete sets these to NULL on every task the person touched;
    # without an index that is a scan of every plan's tasks per column.
    # Partial: a null can never match the FK trigger's `col = $1`.
    (
        "CREATE INDEX plan_tasks_completed_by_idx "
        "ON plan_tasks (completed_by) WHERE completed_by IS NOT NULL"
    ),
    (
        "CREATE INDEX plan_tasks_created_by_idx "
        "ON plan_tasks (created_by) WHERE created_by IS NOT NULL"
    ),
    (
        "CREATE INDEX plan_tasks_updated_by_idx "
        "ON plan_tasks (updated_by) WHERE updated_by IS NOT NULL"
    ),
    # the reminder sweep only looks at tasks that are still open
    (
        "CREATE INDEX plan_tasks_open_deadline_idx ON plan_tasks (deadline) "
        "WHERE percent_complete < 100"
    ),
    # lag is signed (negative = lead); lag_elapsed ignores the calendar
    """
    CREATE TABLE plan_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_id uuid NOT NULL REFERENCES project_plans(id) ON DELETE CASCADE,
        predecessor_id uuid NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
        successor_id uuid NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
        link_type text NOT NULL DEFAULT 'FS',
        lag_minutes integer NOT NULL DEFAULT 0,
        lag_unit text NOT NULL DEFAULT 'd',
        lag_elapsed boolean NOT NULL DEFAULT false,
        CONSTRAINT plan_links_pair_key UNIQUE (predecessor_id, successor_id),
        CONSTRAINT plan_links_predecessor_id_check CHECK (predecessor_id <> successor_id),
        CONSTRAINT plan_links_link_type_check CHECK (link_type IN ('FS', 'SS', 'FF', 'SF')),
        CONSTRAINT plan_links_lag_unit_check
            CHECK (lag_unit IN ('m', 'h', 'd', 'w', 'mo'))
    )
    """,
    "CREATE INDEX plan_links_plan_idx ON plan_links (plan_id)",
    # a task delete cascades here by successor too (the pair key leads with
    # the predecessor)
    "CREATE INDEX plan_links_successor_idx ON plan_links (successor_id)",
    # a task is assigned to a person or to a partner, never both; partners
    # are display-only resources that get no reminders
    """
    CREATE TABLE plan_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id uuid NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
        person_id uuid REFERENCES people(id) ON DELETE CASCADE,
        partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
        CONSTRAINT plan_assignments_resource_check
            CHECK (num_nonnulls(person_id, partner_id) = 1)
    )
    """,
    (
        "CREATE UNIQUE INDEX plan_assignments_task_person_uniq "
        "ON plan_assignments (task_id, person_id) WHERE person_id IS NOT NULL"
    ),
    (
        "CREATE UNIQUE INDEX plan_assignments_task_partner_uniq "
        "ON plan_assignments (task_id, partner_id) WHERE partner_id IS NOT NULL"
    ),
    # what a task or person delete cascades through: the two unique indexes
    # above are partial, so they cannot serve `WHERE task_id = $1`
    "CREATE INDEX plan_assignments_task_idx ON plan_assignments (task_id)",
    (
        "CREATE INDEX plan_assignments_person_idx "
        "ON plan_assignments (person_id) WHERE person_id IS NOT NULL"
    ),
    # and the same for a partner delete, which cascades here
    (
        "CREATE INDEX plan_assignments_partner_idx "
        "ON plan_assignments (partner_id) WHERE partner_id IS NOT NULL"
    ),
    # stage is `d<N>` / `due` / `overdue:<YYYY-MM-DD>`. Keying on due_at means
    # moving a due date re-arms its reminders.
    """
    CREATE TABLE plan_reminder_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id uuid NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
        person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        stage text NOT NULL,
        due_at timestamp NOT NULL,
        sent_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT plan_reminder_log_dedupe_key UNIQUE (task_id, person_id, stage, due_at)
    )
    """,
    # a person delete cascades here (task_id leads the dedupe key)
    "CREATE INDEX plan_reminder_log_person_idx ON plan_reminder_log (person_id)",
    """
    CREATE TABLE plan_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name citext NOT NULL,
        description text,
        data jsonb NOT NULL,
        created_by uuid REFERENCES people(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid REFERENCES people(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT plan_templates_name_key UNIQUE (name)
    )
    """,
)


def upgrade() -> None:
    for stmt in DDL:
        op.execute(stmt)

    op.drop_constraint("ck_notification_groups_categories", "notification_groups", type_="check")
    op.create_check_constraint("ck_notification_groups_categories",
                               "notification_groups", NEW_CATEGORIES)

    conn = op.get_bind()
    for role in FULL_ROLES:
        for action in FULL:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'project_plans', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM role_permissions WHERE resource = 'project_plans'"))

    # rows already using the new category would block the narrower check
    conn.execute(sa.text(
        "UPDATE notification_groups SET categories = array_remove(categories, 'plans') "
        "WHERE 'plans' = ANY(categories)"))
    op.drop_constraint("ck_notification_groups_categories", "notification_groups", type_="check")
    op.create_check_constraint("ck_notification_groups_categories",
                               "notification_groups", OLD_CATEGORIES)

    for table in reversed(TABLES):
        op.execute(f"DROP TABLE {table}")
