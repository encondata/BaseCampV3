"""people and user_accounts

Revision ID: 0001
Revises:
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import BYTEA, CITEXT, INET, UUID

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")

    op.create_table(
        "people",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        # names
        sa.Column("first_name", sa.Text, nullable=False),
        sa.Column("last_name", sa.Text, nullable=False),
        sa.Column("preferred_name", sa.Text),
        # contact
        sa.Column("email", CITEXT),
        sa.Column("phone", sa.Text, comment="normalized E.164"),
        sa.Column("job_title", sa.Text),
        # mailing address
        sa.Column("address_line1", sa.Text),
        sa.Column("address_line2", sa.Text),
        sa.Column("city", sa.Text),
        sa.Column("region", sa.Text, comment="state / province"),
        sa.Column("postal_code", sa.Text),
        sa.Column("country", sa.Text, nullable=False, server_default="US",
                  comment="ISO 3166-1 alpha-2"),
        # identifiers
        sa.Column("external_id", sa.Text,
                  comment="human-entered badge # / employee # / roster ID; not unique"),
        sa.Column("badge_uid", UUID(as_uuid=True), nullable=False, unique=True,
                  server_default=sa.text("gen_random_uuid()"),
                  comment="encoded in badge QR; rotatable, never expose people.id"),
        sa.Column("rfid_tag", sa.Text, comment="hardware tag serial, assigned later"),
        # misc
        sa.Column("avatar_key", sa.Text, comment="object key in Spaces/MinIO"),
        sa.Column("notes", sa.Text),
        # provenance
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text, comment="import filename / API client id"),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        # lifecycle
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True),
                  comment="soft archive; rows are never hard-deleted"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("source IN ('manual', 'import', 'api')", name="people_source_check"),
    )

    op.create_index("people_email_uniq", "people", ["email"], unique=True,
                    postgresql_where=sa.text("email IS NOT NULL"))
    op.create_index("people_rfid_uniq", "people", ["rfid_tag"], unique=True,
                    postgresql_where=sa.text("rfid_tag IS NOT NULL"))
    op.create_index("people_external_idx", "people", ["external_id"])
    op.create_index("people_name_idx", "people", ["last_name", "first_name"])

    op.create_table(
        "user_accounts",
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id"), primary_key=True,
                  comment="PK = FK: exactly one account per person"),
        sa.Column("email", CITEXT, nullable=False, unique=True,
                  comment="login identifier, independent of people.email"),
        sa.Column("password_hash", sa.Text, comment="Argon2id; NULL = cannot log in yet"),
        sa.Column("must_change_password", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("password_updated_at", sa.TIMESTAMP(timezone=True)),
        # 2FA — one TOTP credential per account
        sa.Column("totp_secret_enc", BYTEA, comment="Fernet-encrypted TOTP seed"),
        sa.Column("totp_confirmed_at", sa.TIMESTAMP(timezone=True),
                  comment="set only after a proven working code"),
        # lockout & telemetry
        sa.Column("failed_login_count", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("locked_until", sa.TIMESTAMP(timezone=True)),
        sa.Column("last_login_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("last_login_ip", INET),
        # lifecycle
        sa.Column("disabled_at", sa.TIMESTAMP(timezone=True),
                  comment="kill switch; person record untouched"),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_table("user_accounts")
    op.drop_table("people")
