"""Learning portal: documents (published versions, translations, quizzes),
packets and assignment rules, access codes and sessions, assignments and
sign-offs, invite schedules, email log and time-clock overrides; the
learning_admin role and the `learning` permission resource; worker
certifications and the mail outbox learn where a row came from / carry
attachments; notification groups accept the 'learning' category.

Design: docs/superpowers/specs/2026-10-25-learning-portal-design.md

Revision ID: 0109
Revises: 0108
Create Date: 2026-10-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0109"
down_revision: str | None = "0108"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ZERO = "'00000000-0000-0000-0000-000000000000'::uuid"

FULL = ("view", "add", "change", "delete")
FULL_ROLES = ("developer", "founder", "super_admin", "admin", "learning_admin")

OLD_CATEGORIES = "categories <@ ARRAY['approvals','reports','wiki','security']::text[]"
NEW_CATEGORIES = ("categories <@ ARRAY['approvals','reports','wiki','security',"
                  "'learning']::text[]")

# creation order; downgrade drops in reverse
TABLES = (
    "learning_documents", "learning_document_versions", "learning_translations",
    "learning_quiz_questions", "learning_packets", "learning_packet_items",
    "learning_rules", "learning_codes", "learning_sessions",
    "learning_assignments", "learning_signoffs", "learning_quiz_attempts",
    "learning_invite_schedules", "learning_email_log", "learning_overrides",
)

DDL = (
    """
    CREATE TABLE learning_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        wiki_node_id uuid REFERENCES wiki_nodes(id) ON DELETE SET NULL,
        title text NOT NULL,
        summary text,
        validity_days integer,
        resign_rule text NOT NULL DEFAULT 'expired_or_new_version',
        sign_style text NOT NULL DEFAULT 'typed_name',
        require_scroll boolean NOT NULL DEFAULT true,
        min_read_seconds integer,
        quiz_enabled boolean NOT NULL DEFAULT false,
        quiz_pass_percent integer,
        quiz_max_attempts integer,
        quiz_fail_action text NOT NULL DEFAULT 'retry',
        current_version_id uuid,
        archived_at timestamptz,
        created_by uuid REFERENCES people(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT learning_documents_resign_rule_check
            CHECK (resign_rule IN ('every_initiative', 'expired_or_new_version')),
        CONSTRAINT learning_documents_sign_style_check
            CHECK (sign_style IN ('checkbox', 'typed_name', 'drawn_signature')),
        CONSTRAINT learning_documents_quiz_pass_percent_check
            CHECK (quiz_pass_percent BETWEEN 1 AND 100),
        CONSTRAINT learning_documents_quiz_fail_action_check
            CHECK (quiz_fail_action IN ('retry', 'lock'))
    )
    """,
    "CREATE INDEX learning_documents_wiki_node_idx ON learning_documents (wiki_node_id)",
    """
    CREATE TABLE learning_document_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES learning_documents(id) ON DELETE CASCADE,
        version_no integer NOT NULL,
        wiki_version_id uuid,
        wiki_version_no integer,
        title text NOT NULL,
        content_json jsonb NOT NULL,
        content_html text NOT NULL,
        image_asset_ids uuid[] NOT NULL DEFAULT '{}',
        change_note text,
        published_by uuid REFERENCES people(id),
        published_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT learning_document_versions_doc_no_key UNIQUE (document_id, version_no)
    )
    """,
    """
    ALTER TABLE learning_documents
        ADD CONSTRAINT learning_documents_current_version_fk
        FOREIGN KEY (current_version_id) REFERENCES learning_document_versions(id)
        ON DELETE SET NULL
    """,
    """
    CREATE TABLE learning_translations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        version_id uuid NOT NULL REFERENCES learning_document_versions(id) ON DELETE CASCADE,
        language text NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        title text NOT NULL,
        content_html text NOT NULL,
        source text NOT NULL DEFAULT 'manual',
        updated_by uuid REFERENCES people(id),
        updated_at timestamptz NOT NULL DEFAULT now(),
        reviewed_by uuid REFERENCES people(id),
        reviewed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT learning_translations_version_language_key UNIQUE (version_id, language),
        CONSTRAINT learning_translations_language_check
            CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
        CONSTRAINT learning_translations_status_check
            CHECK (status IN ('draft', 'in_review', 'published')),
        CONSTRAINT learning_translations_source_check
            CHECK (source IN ('claude', 'manual'))
    )
    """,
    """
    CREATE TABLE learning_quiz_questions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES learning_documents(id) ON DELETE CASCADE,
        prompt text NOT NULL,
        choices jsonb NOT NULL,
        correct_choice_ids text[] NOT NULL,
        translations jsonb NOT NULL DEFAULT '{}'::jsonb,
        position double precision NOT NULL DEFAULT 0,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX learning_quiz_questions_document_idx ON learning_quiz_questions (document_id)",
    """
    CREATE TABLE learning_packets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        description text,
        enforce_order boolean NOT NULL DEFAULT false,
        due_offset_days integer,
        icon text,
        color text,
        archived_at timestamptz,
        created_by uuid REFERENCES people(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE learning_packet_items (
        packet_id uuid NOT NULL REFERENCES learning_packets(id) ON DELETE CASCADE,
        document_id uuid NOT NULL REFERENCES learning_documents(id),
        position double precision NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (packet_id, document_id)
    )
    """,
    """
    CREATE TABLE learning_rules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        packet_id uuid NOT NULL REFERENCES learning_packets(id) ON DELETE CASCADE,
        conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
        position double precision NOT NULL DEFAULT 0,
        enabled boolean NOT NULL DEFAULT true,
        created_by uuid REFERENCES people(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE learning_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id uuid NOT NULL REFERENCES people(id),
        initiative_id uuid REFERENCES initiatives(id) ON DELETE CASCADE,
        fingerprint bytea NOT NULL,
        link_token_hash text NOT NULL UNIQUE,
        expires_at timestamptz,
        failed_count integer NOT NULL DEFAULT 0,
        locked_until timestamptz,
        revoked_at timestamptz,
        last_used_at timestamptz,
        created_by uuid REFERENCES people(id),
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    (
        "CREATE UNIQUE INDEX learning_codes_fingerprint_active_uniq "
        "ON learning_codes (fingerprint) WHERE revoked_at IS NULL"
    ),
    (
        "CREATE UNIQUE INDEX learning_codes_person_initiative_active_uniq "
        f"ON learning_codes (person_id, coalesce(initiative_id, {ZERO})) "
        "WHERE revoked_at IS NULL"
    ),
    """
    CREATE TABLE learning_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code_id uuid REFERENCES learning_codes(id) ON DELETE CASCADE,
        person_id uuid NOT NULL REFERENCES people(id),
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        ip text,
        user_agent text,
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX learning_sessions_person_idx ON learning_sessions (person_id)",
    """
    CREATE TABLE learning_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id uuid NOT NULL REFERENCES people(id),
        initiative_id uuid REFERENCES initiatives(id) ON DELETE CASCADE,
        document_id uuid NOT NULL REFERENCES learning_documents(id),
        version_id uuid NOT NULL REFERENCES learning_document_versions(id),
        packet_id uuid REFERENCES learning_packets(id) ON DELETE SET NULL,
        rule_id uuid REFERENCES learning_rules(id) ON DELETE SET NULL,
        source text NOT NULL,
        due_on date,
        status text NOT NULL DEFAULT 'assigned',
        opened_at timestamptz,
        signed_at timestamptz,
        signoff_id uuid,
        quiz_locked_at timestamptz,
        created_by uuid REFERENCES people(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT learning_assignments_source_check
            CHECK (source IN ('rule', 'manual', 'new_version')),
        CONSTRAINT learning_assignments_status_check
            CHECK (status IN ('assigned', 'opened', 'signed', 'cancelled'))
    )
    """,
    (
        "CREATE UNIQUE INDEX learning_assignments_open_uniq ON learning_assignments "
        f"(person_id, coalesce(initiative_id, {ZERO}), document_id) "
        "WHERE status <> 'cancelled'"
    ),
    "CREATE INDEX learning_assignments_initiative_idx ON learning_assignments (initiative_id)",
    "CREATE INDEX learning_assignments_document_idx ON learning_assignments (document_id)",
    # A sign-off is a legal record: it keeps its person/document/version even
    # if the assignment or initiative it came from is later deleted.
    """
    CREATE TABLE learning_signoffs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        assignment_id uuid REFERENCES learning_assignments(id) ON DELETE SET NULL,
        person_id uuid NOT NULL REFERENCES people(id),
        document_id uuid NOT NULL REFERENCES learning_documents(id),
        version_id uuid NOT NULL REFERENCES learning_document_versions(id),
        initiative_id uuid REFERENCES initiatives(id) ON DELETE SET NULL,
        language text NOT NULL,
        typed_name text,
        signature_png bytea,
        read_seconds integer NOT NULL,
        scrolled_to_end boolean NOT NULL,
        quiz_score integer,
        ip text,
        user_agent text,
        signed_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    (
        "CREATE INDEX learning_signoffs_person_document_idx "
        "ON learning_signoffs (person_id, document_id, signed_at DESC)"
    ),
    """
    CREATE TABLE learning_quiz_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        assignment_id uuid NOT NULL REFERENCES learning_assignments(id) ON DELETE CASCADE,
        answers jsonb NOT NULL,
        score_percent integer NOT NULL,
        passed boolean NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX learning_quiz_attempts_assignment_idx ON learning_quiz_attempts (assignment_id)",
    # defaults are the spec's: invite 7 days before start at 08:00, reminders
    # at 5 and 3 days before, due 2 days before.
    """
    CREATE TABLE learning_invite_schedules (
        initiative_id uuid PRIMARY KEY REFERENCES initiatives(id) ON DELETE CASCADE,
        mode text NOT NULL DEFAULT 'manual',
        send_offset_days integer NOT NULL DEFAULT 7,
        send_time time NOT NULL DEFAULT '08:00',
        reminder_offsets integer[] NOT NULL DEFAULT '{5,3}',
        due_offset_days integer NOT NULL DEFAULT 2,
        late_adds boolean NOT NULL DEFAULT true,
        sent_at timestamptz,
        sent_by uuid REFERENCES people(id),
        updated_by uuid REFERENCES people(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT learning_invite_schedules_mode_check
            CHECK (mode IN ('manual', 'scheduled'))
    )
    """,
    """
    CREATE TABLE learning_email_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id uuid NOT NULL REFERENCES people(id),
        initiative_id uuid REFERENCES initiatives(id) ON DELETE SET NULL,
        code_id uuid REFERENCES learning_codes(id) ON DELETE CASCADE,
        assignment_id uuid REFERENCES learning_assignments(id) ON DELETE SET NULL,
        kind text NOT NULL,
        stage text NOT NULL DEFAULT '',
        outbox_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT learning_email_log_kind_check
            CHECK (kind IN ('invite', 'reminder', 'complete', 'new_version', 'link'))
    )
    """,
    (
        "CREATE UNIQUE INDEX learning_email_log_dedupe_uniq ON learning_email_log "
        f"(kind, person_id, coalesce(code_id, {ZERO}), stage)"
    ),
    """
    CREATE TABLE learning_overrides (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id uuid NOT NULL REFERENCES people(id),
        initiative_id uuid REFERENCES initiatives(id) ON DELETE SET NULL,
        site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
        device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
        admin_person_id uuid NOT NULL REFERENCES people(id),
        reason text NOT NULL,
        reason_text text,
        scope text NOT NULL,
        local_day date NOT NULL,
        outstanding jsonb NOT NULL,
        time_entry_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT learning_overrides_reason_check
            CHECK (reason IN ('signing_on_break', 'signed_on_paper', 'no_phone', 'other')),
        CONSTRAINT learning_overrides_scope_check CHECK (scope IN ('punch', 'day'))
    )
    """,
    "CREATE INDEX learning_overrides_person_day_idx ON learning_overrides (person_id, local_day)",
)


def upgrade() -> None:
    for stmt in DDL:
        op.execute(stmt)

    op.add_column("worker_certifications", sa.Column(
        "source", sa.Text(), nullable=False, server_default="manual"))
    op.create_check_constraint("worker_certifications_source_check",
                               "worker_certifications",
                               "source IN ('manual', 'learning')")
    op.add_column("worker_certifications", sa.Column(
        "learning_initiative_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("email_outbox", sa.Column(
        "attachments", postgresql.JSONB(), nullable=True))

    op.drop_constraint("ck_notification_groups_categories", "notification_groups", type_="check")
    op.create_check_constraint("ck_notification_groups_categories",
                               "notification_groups", NEW_CATEGORIES)

    conn = op.get_bind()
    conn.execute(sa.text("""
        INSERT INTO roles (name, description, rank, scope_anchor, is_system, label, color)
        VALUES ('learning_admin',
                'Manages learning documents, packets, rules and sign-offs',
                40, 'global', true, 'Learning admin', 'c-violet')
        ON CONFLICT (name) DO UPDATE SET rank = 40, scope_anchor = 'global',
            is_system = true, label = 'Learning admin', color = 'c-violet'
    """))
    for role in FULL_ROLES:
        for action in FULL:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'learning', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})
    conn.execute(sa.text(
        "INSERT INTO role_permissions (role, resource, action) "
        "VALUES ('staff', 'learning', 'view') ON CONFLICT DO NOTHING"))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM role_permissions WHERE resource = 'learning'"))
    conn.execute(sa.text("DELETE FROM person_roles WHERE role = 'learning_admin'"))
    conn.execute(sa.text("DELETE FROM roles WHERE name = 'learning_admin'"))

    # rows already using the new category would block the narrower check
    conn.execute(sa.text(
        "UPDATE notification_groups SET categories = array_remove(categories, 'learning')"))
    op.drop_constraint("ck_notification_groups_categories", "notification_groups", type_="check")
    op.create_check_constraint("ck_notification_groups_categories",
                               "notification_groups", OLD_CATEGORIES)

    op.drop_column("email_outbox", "attachments")
    op.drop_column("worker_certifications", "learning_initiative_id")
    op.drop_constraint("worker_certifications_source_check", "worker_certifications",
                       type_="check")
    op.drop_column("worker_certifications", "source")

    op.execute("ALTER TABLE learning_documents DROP CONSTRAINT learning_documents_current_version_fk")
    for table in reversed(TABLES):
        op.execute(f"DROP TABLE {table}")
