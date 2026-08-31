"""status rules — DB-driven rules the scan-matching worker applies when
a matched scan carries a status checkpoint. Rules trigger on
(trigger_status, trigger_match_type); conditions are AND-only; actions
are keys into the code-side typed catalog (no dynamic identifiers).
Executions are the per-fire log; rule_name is denormalized so history
survives rule deletion. Also adds raw_scans.match_attempted_at — the
worker's unmatched marker (matched rows are deleted, so only unmatched
rows ever show a value).

Revision ID: 0035
Revises: 0034
Create Date: 2026-08-31
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
# status_rules: Admin-authored automation. Same internal-only posture as
# scans; admins author rules, staff may read them.
RULE_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": ("view",),
}


def upgrade() -> None:
    op.add_column("raw_scans", sa.Column(
        "match_attempted_at", sa.TIMESTAMP(timezone=True),
        comment="last matcher attempt; NULL = never tried"))
    op.create_index("raw_scans_match_attempted_idx", "raw_scans",
                    ["match_attempted_at"])

    op.create_table(
        "status_rules",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("trigger_status", sa.Text, nullable=False),
        sa.Column("trigger_match_type", sa.Text, nullable=False),
        sa.Column("priority", sa.Integer, nullable=False,
                  server_default="10", comment="lower runs first"),
        sa.Column("enabled", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute("""
        ALTER TABLE status_rules ADD COLUMN trigger_status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "status_rules_trigger_status_fkey", "status_rules", "status_values",
        ["trigger_status_record_type", "trigger_status"],
        ["record_type", "key"])
    op.execute("""
        ALTER TABLE status_rules ADD COLUMN trigger_match_record_type text
          GENERATED ALWAYS AS ('processed_scan') STORED
    """)
    op.create_foreign_key(
        "status_rules_trigger_match_fkey", "status_rules", "status_values",
        ["trigger_match_record_type", "trigger_match_type"],
        ["record_type", "key"])
    op.create_index("status_rules_trigger_idx", "status_rules",
                    ["trigger_status", "trigger_match_type"])

    op.create_table(
        "status_rule_conditions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("rule_id", UUID(as_uuid=True),
                  sa.ForeignKey("status_rules.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("field", sa.Text, nullable=False,
                  comment="dotted key into the code-side field registry"),
        sa.Column("operator", sa.Text, nullable=False),
        sa.Column("value", sa.Text),
    )
    op.create_index("status_rule_conditions_rule_idx",
                    "status_rule_conditions", ["rule_id"])

    op.create_table(
        "status_rule_actions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("rule_id", UUID(as_uuid=True),
                  sa.ForeignKey("status_rules.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("action_type", sa.Text, nullable=False,
                  comment="key into the code-side typed action catalog"),
        sa.Column("params", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
    )
    op.create_index("status_rule_actions_rule_idx",
                    "status_rule_actions", ["rule_id"])

    op.create_table(
        "status_rule_executions",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("rule_id", UUID(as_uuid=True),
                  sa.ForeignKey("status_rules.id", ondelete="SET NULL")),
        sa.Column("rule_name", sa.Text, nullable=False,
                  comment="denormalized; survives rule deletion"),
        sa.Column("processed_scan_id", UUID(as_uuid=True),
                  sa.ForeignKey("processed_scans.id"),
                  comment="NULL for error rows — the scan txn rolled back"),
        sa.Column("conditions_met", sa.Boolean, nullable=False),
        sa.Column("actions_applied", JSONB, nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("error", sa.Text),
        sa.Column("executed_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("duration_ms", sa.Integer, nullable=False,
                  server_default="0"),
    )
    op.create_index("status_rule_executions_rule_idx",
                    "status_rule_executions", ["rule_id"])
    op.create_index("status_rule_executions_at_idx",
                    "status_rule_executions", [sa.text("executed_at DESC")])

    conn = op.get_bind()
    for role, actions in RULE_GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'status_rules', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'status_rules'"))
    op.drop_table("status_rule_executions")
    op.drop_table("status_rule_actions")
    op.drop_table("status_rule_conditions")
    op.drop_table("status_rules")
    op.drop_index("raw_scans_match_attempted_idx", table_name="raw_scans")
    op.drop_column("raw_scans", "match_attempted_at")
