"""contact_profiles: per-org contact metadata (org_title + function tags).
Independent of person_roles so tier revoke+regrant never touches it —
rows are upserted in place per (person, org) and deleted when the contact
link itself is removed.

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "contact_profiles",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  nullable=False),
        sa.Column("client_id", UUID(as_uuid=True), sa.ForeignKey("clients.id")),
        sa.Column("partner_id", UUID(as_uuid=True), sa.ForeignKey("partners.id")),
        sa.Column("org_title", sa.Text),
        sa.Column("functions", JSONB, nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("updated_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        # exactly one of client_id/partner_id set — same "exactly one anchor"
        # shape as person_roles, just without the revoked-history escape hatch
        # (a contact_profiles row never survives its org link being removed)
        sa.CheckConstraint(
            "(client_id IS NOT NULL) != (partner_id IS NOT NULL)",
            name="contact_profiles_org_scope_check"),
    )
    # logical PK is (person_id, org) where org is whichever column is set;
    # a surrogate id is the real PK (nullable columns can't co-own one), so
    # these partial unique indexes carry the actual one-row-per-link rule
    op.create_index(
        "contact_profiles_client_uniq", "contact_profiles",
        ["person_id", "client_id"], unique=True,
        postgresql_where=sa.text("client_id IS NOT NULL"))
    op.create_index(
        "contact_profiles_partner_uniq", "contact_profiles",
        ["person_id", "partner_id"], unique=True,
        postgresql_where=sa.text("partner_id IS NOT NULL"))
    op.create_index("contact_profiles_client_idx", "contact_profiles", ["client_id"])
    op.create_index("contact_profiles_partner_idx", "contact_profiles", ["partner_id"])


def downgrade() -> None:
    op.drop_table("contact_profiles")
