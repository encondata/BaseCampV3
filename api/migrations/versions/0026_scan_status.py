"""scan status — what status the asset was scanned to be. Nullable
`status` on raw_scans and processed_scans, FK'd into the EXISTING
'asset' vocabulary (one vocabulary across scan → matcher → roster;
several keys are literally scan checkpoints, e.g. rfid_2_loading_dock).
MATCH SIMPLE composite FK: NULL status (bare presence read) skips the
check. Recording only — applying the status stays with the deferred
matcher.

Revision ID: 0026
Revises: 0025
Create Date: 2026-08-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("raw_scans", sa.Column(
        "status", sa.Text,
        comment="asset/move status this scan asserted; NULL = presence read"))
    op.execute("""
        ALTER TABLE raw_scans ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "raw_scans_status_fkey", "raw_scans", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])

    op.add_column("processed_scans", sa.Column(
        "status", sa.Text,
        comment="asset/move status this scan asserted; NULL = presence read"))
    op.execute("""
        ALTER TABLE processed_scans ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "processed_scans_status_fkey", "processed_scans", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])


def downgrade() -> None:
    op.drop_constraint("processed_scans_status_fkey", "processed_scans",
                       type_="foreignkey")
    op.drop_column("processed_scans", "status_record_type")
    op.drop_column("processed_scans", "status")
    op.drop_constraint("raw_scans_status_fkey", "raw_scans",
                       type_="foreignkey")
    op.drop_column("raw_scans", "status_record_type")
    op.drop_column("raw_scans", "status")
