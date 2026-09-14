"""Kiosk session: who is signed in on a kiosk right now, and how. Adds
three nullable columns to `devices`, set by the sign-in heartbeat and
cleared by POST /kiosk/sign-out.

Design: docs/superpowers/specs/2026-09-13-kiosk-web-design.md

Revision ID: 0062
Revises: 0061
Create Date: 2026-09-13
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0062"
down_revision: str | None = "0061"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column(
        "session_person_id", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True))
    op.add_column("devices", sa.Column(
        "session_login_method", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column(
        "session_started_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "session_started_at")
    op.drop_column("devices", "session_login_method")
    op.drop_column("devices", "session_person_id")
