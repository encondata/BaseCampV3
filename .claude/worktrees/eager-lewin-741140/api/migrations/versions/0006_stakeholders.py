"""stakeholders — flesh out clients, add partners, scope vendor grants

- clients gains business contact info, status/tier, account manager, logo
- partners: external organizations (staffing, logistics, subcontractors…)
  that field workers and vendor contacts roll up to
- person_roles gains partner_id: the vendor role is partner-scoped exactly
  like the client role is client-scoped

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ORG_STATUS = "status IN ('prospect', 'active', 'dormant')"
ORG_TIER = "tier IN ('standard', 'preferred', 'strategic')"
PARTNER_TYPE = ("partner_type IN ('staffing', 'logistics', 'subcontractor', "
                "'consultant', 'other')")


def _org_columns() -> list[sa.Column]:
    return [
        sa.Column("phone", sa.Text),
        sa.Column("website", sa.Text),
        sa.Column("address_line1", sa.Text),
        sa.Column("address_line2", sa.Text),
        sa.Column("city", sa.Text),
        sa.Column("region", sa.Text),
        sa.Column("postal_code", sa.Text),
        sa.Column("country", sa.Text, nullable=False, server_default="US"),
        sa.Column("status", sa.Text, nullable=False, server_default="active"),
        sa.Column("tier", sa.Text, nullable=False, server_default="standard"),
        sa.Column("account_manager", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  comment="staff person who owns the relationship"),
        sa.Column("logo_key", sa.Text, comment="object key (attachments flow)"),
    ]


def upgrade() -> None:
    # ── clients: new columns ───────────────────────────────────────
    for col in _org_columns():
        op.add_column("clients", col)
    op.create_check_constraint("clients_status_check", "clients", ORG_STATUS)
    op.create_check_constraint("clients_tier_check", "clients", ORG_TIER)

    # ── partners ───────────────────────────────────────────────────
    op.create_table(
        "partners",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT, nullable=False, unique=True),
        sa.Column("code", CITEXT, unique=True),
        sa.Column("partner_type", sa.Text, nullable=False, server_default="other"),
        sa.Column("notes", sa.Text),
        *_org_columns(),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("source IN ('manual', 'import', 'api')",
                           name="partners_source_check"),
        sa.CheckConstraint(ORG_STATUS, name="partners_status_check"),
        sa.CheckConstraint(ORG_TIER, name="partners_tier_check"),
        sa.CheckConstraint(PARTNER_TYPE, name="partners_type_check"),
    )

    # ── person_roles: partner scoping for the vendor role ─────────
    op.add_column("person_roles", sa.Column(
        "partner_id", UUID(as_uuid=True), sa.ForeignKey("partners.id"),
        comment="required for partner-scoped roles (vendor), else NULL"))
    # active grants must be correctly scoped; revoked history rows from
    # before partner scoping existed are exempt
    op.create_check_constraint(
        "person_roles_partner_scope_check", "person_roles",
        "(revoked_at IS NOT NULL) OR ((role = 'vendor') = (partner_id IS NOT NULL))")
    op.create_index("person_roles_partner_idx", "person_roles", ["partner_id"])

    # the one-active-grant rule must distinguish scopes on both axes
    op.drop_index("person_roles_active_uniq", table_name="person_roles")
    op.create_index(
        "person_roles_active_uniq", "person_roles",
        ["person_id", "role", "client_id", "partner_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("person_roles_active_uniq", table_name="person_roles")
    op.create_index(
        "person_roles_active_uniq", "person_roles",
        ["person_id", "role", "client_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    op.drop_index("person_roles_partner_idx", table_name="person_roles")
    op.drop_constraint("person_roles_partner_scope_check", "person_roles")
    op.drop_column("person_roles", "partner_id")
    op.drop_table("partners")
    op.drop_constraint("clients_tier_check", "clients")
    op.drop_constraint("clients_status_check", "clients")
    for col in reversed(_org_columns()):
        op.drop_column("clients", col.name)
