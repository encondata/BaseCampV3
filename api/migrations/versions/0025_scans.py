"""scans — raw_scans (the unprocessed inbox, log_entries-style BigInt
identity, append-only until the future matcher moves rows out or a
future pruning job deletes them) and processed_scans (the permanent
matched record, containers-style uuid domain table). The matcher,
ingest endpoint, and pruning job are deferred; this migration is
storage + grants only. A processed scan resolves to exactly one of
asset / container / person, enforced by CHECK; person_id is the
MATCHED person (badge scan) — operator_id is who ran the scanner.

Revision ID: 0025
Revises: 0024
Create Date: 2026-08-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCAN_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('scan','rfid','RFID','Read from an RFID tag.','#1668a7',1),
      ('scan','barcode','Barcode','Read from a barcode or QR label.','#6d4fc4',2),
      ('scan','manual','Manual','Keyed in by hand.','#a36207',3),
      ('processed_scan','asset','Asset','Matched to an asset.','#178a4c',1),
      ('processed_scan','container','Container','Matched to a container.','#0f7c86',2),
      ('processed_scan','person','Person','Matched to a person badge.','#6d4fc4',3)
"""

FULL = ("view", "add", "change", "delete")
# scans: Admin-section forensic surface, same posture as audit —
# internal-only, no client/partner visibility.
SCAN_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": ("view", "change", "delete"), "staff": ("view",),
}

def upgrade() -> None:
    op.execute(SCAN_SEEDS)

    # NOTE: the 8 shared context columns are written out longhand in BOTH
    # create_table calls below — sa.Column objects bind to one table, and
    # migrations are frozen history, not DRY targets (house style).
    op.create_table(
        "raw_scans",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("scanned_value", CITEXT, nullable=False),
        sa.Column("scan_type", sa.Text, nullable=False),
        sa.Column("scanned_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  comment="device-reported time; created_at is ingest time"),
        sa.Column("device_id", sa.Text, nullable=False, server_default="",
                  comment="reader/kiosk identity string; no devices table yet"),
        sa.Column("operator_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id"),
                  comment="who ran the scanner; NULL for unattended readers"),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("location_detail", sa.Text, nullable=False,
                  server_default=""),
        sa.Column("source", sa.Text, nullable=False, server_default="",
                  comment="provenance: kiosk / reader / import"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute("""
        ALTER TABLE raw_scans ADD COLUMN scan_type_record_type text
          GENERATED ALWAYS AS ('scan') STORED
    """)
    op.create_foreign_key(
        "raw_scans_scan_type_fkey", "raw_scans", "status_values",
        ["scan_type_record_type", "scan_type"], ["record_type", "key"])
    op.create_index("raw_scans_scanned_at_idx", "raw_scans",
                    [sa.text("scanned_at DESC")])
    op.create_index("raw_scans_scanned_value_idx", "raw_scans",
                    ["scanned_value"])

    op.create_table(
        "processed_scans",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("scanned_value", CITEXT, nullable=False),
        sa.Column("scan_type", sa.Text, nullable=False),
        sa.Column("scanned_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  comment="device-reported time"),
        sa.Column("device_id", sa.Text, nullable=False, server_default=""),
        sa.Column("operator_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id"),
                  comment="who ran the scanner; NULL for unattended readers"),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("location_detail", sa.Text, nullable=False,
                  server_default=""),
        sa.Column("source", sa.Text, nullable=False, server_default="",
                  comment="provenance: kiosk / reader / import"),
        sa.Column("raw_scan_id", sa.BigInteger,
                  comment="pre-move raw_scans.id; no FK — the raw row is "
                          "deleted on move, kept for traceability"),
        sa.Column("match_type", sa.Text, nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), sa.ForeignKey("assets.id")),
        sa.Column("container_id", UUID(as_uuid=True),
                  sa.ForeignKey("containers.id")),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  comment="the MATCHED person (badge scan); operator_id is "
                          "who ran the scanner"),
        sa.Column("processed_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint(
            "(match_type = 'asset' AND asset_id IS NOT NULL) OR "
            "(match_type = 'container' AND container_id IS NOT NULL) OR "
            "(match_type = 'person' AND person_id IS NOT NULL)",
            name="processed_scans_match_target_chk"),
    )
    op.execute("""
        ALTER TABLE processed_scans ADD COLUMN scan_type_record_type text
          GENERATED ALWAYS AS ('scan') STORED
    """)
    op.create_foreign_key(
        "processed_scans_scan_type_fkey", "processed_scans", "status_values",
        ["scan_type_record_type", "scan_type"], ["record_type", "key"])
    op.execute("""
        ALTER TABLE processed_scans ADD COLUMN match_record_type text
          GENERATED ALWAYS AS ('processed_scan') STORED
    """)
    op.create_foreign_key(
        "processed_scans_match_type_fkey", "processed_scans", "status_values",
        ["match_record_type", "match_type"], ["record_type", "key"])
    op.create_index("processed_scans_scanned_at_idx", "processed_scans",
                    [sa.text("scanned_at DESC")])
    op.create_index("processed_scans_scanned_value_idx", "processed_scans",
                    ["scanned_value"])
    op.create_index("processed_scans_asset_idx", "processed_scans",
                    ["asset_id"])
    op.create_index("processed_scans_container_idx", "processed_scans",
                    ["container_id"])
    op.create_index("processed_scans_person_idx", "processed_scans",
                    ["person_id"])

    conn = op.get_bind()
    for role, actions in SCAN_GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'scans', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'scans'"))
    op.drop_table("processed_scans")
    op.drop_table("raw_scans")
    conn.execute(sa.text(
        "DELETE FROM status_values "
        "WHERE record_type IN ('scan', 'processed_scan')"))
