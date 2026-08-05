"""clients, roles lookup, and person_roles grants

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "clients",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT, nullable=False, unique=True),
        sa.Column("code", CITEXT, unique=True,
                  comment="short human slug, e.g. 'ACME' — used in exports/labels"),
        sa.Column("notes", sa.Text),
        # provenance (same convention as people)
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        # lifecycle
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("source IN ('manual', 'import', 'api')",
                           name="clients_source_check"),
    )

    op.create_table(
        "roles",
        sa.Column("name", sa.Text, primary_key=True),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )

    op.create_table(
        "person_roles",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  nullable=False),
        sa.Column("role", sa.Text, sa.ForeignKey("roles.name"), nullable=False),
        sa.Column("client_id", UUID(as_uuid=True), sa.ForeignKey("clients.id"),
                  comment="required for client-scoped roles, else NULL"),
        # grant / revoke history — rows are never deleted
        sa.Column("granted_by", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  comment="NULL only for system bootstrap"),
        sa.Column("granted_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("revoked_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("revoked_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        # the 'client' hat must point at a client; company-wide hats must not
        sa.CheckConstraint("(role = 'client') = (client_id IS NOT NULL)",
                           name="person_roles_client_scope_check"),
        # a revocation is attributed and timestamped together
        sa.CheckConstraint(
            "(revoked_at IS NULL) = (revoked_by IS NULL) OR granted_by IS NULL",
            name="person_roles_revoke_pair_check"),
    )

    # one ACTIVE grant per (person, role, client); PG16 NULLS NOT DISTINCT
    # makes two active unscoped grants of the same role collide as intended
    op.create_index(
        "person_roles_active_uniq", "person_roles",
        ["person_id", "role", "client_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    # hot path: load a person's active roles at auth time
    op.create_index("person_roles_person_active_idx", "person_roles",
                    ["person_id"], postgresql_where=sa.text("revoked_at IS NULL"))
    op.create_index("person_roles_client_idx", "person_roles", ["client_id"])

    op.execute("""
        INSERT INTO roles (name, description) VALUES
        ('admin',    'Full system administration — settings, accounts, all data'),
        ('staff',    'Company employee — day-to-day operations across all clients'),
        ('worker',   'Field crew member — scanning and move-floor tasks'),
        ('client',   'Person at a client organization, scoped to that client''s data'),
        ('vendor',   'Person at a partner/vendor company (partner link to come)'),
        ('external', 'Outside collaborator with narrow, explicitly-granted access')
    """)


def downgrade() -> None:
    op.drop_table("person_roles")
    op.drop_table("roles")
    op.drop_table("clients")
