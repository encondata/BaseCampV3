"""Biometric sign-in on the Android kiosk: the schema.

- `auth_sessions.login_method` ('password' | 'link' | 'move' |
  'biometric'; NULL for rows from before this migration): set by
  start_session from the route that signed in and carried through refresh
  rotation, so the server knows a sign-in was a password one from its own
  records, never from the heartbeat's self-reported login_method.
- `devices.personal_person_id` / `personal_set_at` / `personal_set_by`: a
  phone marked as one person's personal device.
- `biometric_keys`: a device-bound EC P-256 public key (DER
  SubjectPublicKeyInfo) per person and device. One live key per (person,
  device): a partial unique index where revoked_at is null.
  `password_sign_in_at` is the 30-day anchor; `last_nonce` holds the last
  challenge's jti, which makes each challenge single use.

Rolling back drops the table and the new columns (recorded login methods,
personal-device marks and keys are lost).

Design: docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md

Revision ID: 0107
Revises: 0106
Create Date: 2026-10-23
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0107"
down_revision: str | None = "0106"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("auth_sessions", sa.Column("login_method", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_auth_sessions_login_method", "auth_sessions",
        "login_method IS NULL OR login_method IN ('password', 'link', 'move', 'biometric')")

    op.add_column("devices", sa.Column(
        "personal_person_id", UUID(as_uuid=True),
        sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True))
    op.add_column("devices", sa.Column(
        "personal_set_at", sa.TIMESTAMP(timezone=True), nullable=True))
    op.add_column("devices", sa.Column(
        "personal_set_by", UUID(as_uuid=True),
        sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True))
    op.create_index("devices_personal_person_idx", "devices", ["personal_person_id"],
                    postgresql_where=sa.text("personal_person_id IS NOT NULL"))

    op.create_table(
        "biometric_keys",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", UUID(as_uuid=True),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("public_key", sa.LargeBinary(), nullable=False),
        sa.Column("key_alg", sa.Text(), nullable=False, server_default=sa.text("'ES256'")),
        sa.Column("security_level", sa.Text(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("password_sign_in_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("last_nonce", sa.Text(), nullable=True),
        sa.Column("revoked_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("revoke_reason", sa.Text(), nullable=True),
        sa.CheckConstraint("key_alg IN ('ES256')", name="ck_biometric_keys_key_alg"),
        sa.CheckConstraint("security_level IN ('tee', 'strongbox')",
                           name="ck_biometric_keys_security_level"),
    )
    op.create_index("biometric_keys_live_person_device_key", "biometric_keys",
                    ["person_id", "device_id"], unique=True,
                    postgresql_where=sa.text("revoked_at IS NULL"))
    op.create_index("biometric_keys_device_idx", "biometric_keys", ["device_id"])


def downgrade() -> None:
    op.drop_table("biometric_keys")
    op.drop_index("devices_personal_person_idx", table_name="devices")
    op.drop_column("devices", "personal_set_by")
    op.drop_column("devices", "personal_set_at")
    op.drop_column("devices", "personal_person_id")
    op.drop_constraint("ck_auth_sessions_login_method", "auth_sessions", type_="check")
    op.drop_column("auth_sessions", "login_method")
