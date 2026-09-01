"""kiosk fields on devices. version is SHARED (app/firmware version
string for any family). kiosk_type ('laptop'/'pi') and
current_initiative_id (the move a kiosk is scanning for) are the
kiosk block. Registration expiry reuses token_expires_at; kiosk IP
reuses lan_ip; the kiosk's checkpoint reuses scan_status.

Revision ID: 0040
Revises: 0039
Create Date: 2026-09-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0040"
down_revision: str | None = "0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("version", sa.Text))
    op.add_column("devices", sa.Column(
        "kiosk_type", sa.Text, comment="kiosk block; laptop / pi"))
    op.add_column("devices", sa.Column(
        "current_initiative_id", UUID(as_uuid=True),
        sa.ForeignKey("initiatives.id"),
        comment="kiosk block; the selected move"))


def downgrade() -> None:
    op.drop_column("devices", "current_initiative_id")
    op.drop_column("devices", "kiosk_type")
    op.drop_column("devices", "version")
