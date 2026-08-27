"""site survey rows — replaces the single sites.survey_data JSONB blob
with two tables: raw_survey_data (append-only submission trail,
log_entries/raw_scans-style BigInt identity, ANY key accepted — strays
allowed for raw-editor parity with the legacy blob) and
site_survey_data (curated current answer per (site, field); UNIQUE
enforced, raw_id links back to the submission that produced it). This
is the V2-lineage upgrade: V2 had ONE blob presented as two views
(typed form + flat dump); V3 makes that split real. The future write
flow is one transaction per answer — append raw, then upsert curated
(deferred to the API layer; this migration is storage only).

Data migration: every existing sites.survey_data blob is exploded here,
per key, into a raw_survey_data row (source='migration', captured_at=
now(), no submitter); registry-known keys additionally get a
site_survey_data row pointing at the raw row via raw_id. Unknown/stray
keys land in raw only. Importing the survey field registry
(serversherpa.sites.survey.FIELDS_BY_KEY) into a migration is
acceptable here: the registry is code, not data, by design — it is
never itself migrated, only consulted. Values are inserted as-is, no
re-validation: they already passed validation when originally written
to the blob. The blob column is then dropped; promotion of future raw
rows (kiosk/import feeds) into curated answers is a deferred matcher-
style step, like scans, and is NOT part of this migration.

Revision ID: 0027
Revises: 0026
Create Date: 2026-08-27
"""
import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

from serversherpa.sites.survey import FIELDS_BY_KEY

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "raw_survey_data",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id"),
                  nullable=False),
        sa.Column("field_key", sa.Text, nullable=False,
                  comment="ANY key — strays allowed (V2 raw-editor parity), "
                          "not FK'd to the registry"),
        sa.Column("value", JSONB,
                  comment="scalar: string/bool/number; null = 'cleared' "
                          "submission"),
        sa.Column("captured_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  comment="when the answer was given"),
        sa.Column("submitted_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id"),
                  comment="null for future unattended sources"),
        sa.Column("device_id", sa.Text, nullable=False, server_default="",
                  comment="future kiosk identity"),
        sa.Column("source", sa.Text, nullable=False, server_default="",
                  comment="'portal' now; 'kiosk' / 'import' / 'migration'"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()"),
                  comment="ingest time"),
    )
    op.create_index("raw_survey_data_site_idx", "raw_survey_data",
                    ["site_id", "id"])

    op.create_table(
        "site_survey_data",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id"),
                  nullable=False),
        sa.Column("field_key", sa.Text, nullable=False,
                  comment="must exist in the server-side registry "
                          "(API-validated; registry is code, not DB)"),
        sa.Column("value", JSONB, nullable=False,
                  comment="validated against the registry field kind"),
        sa.Column("raw_id", sa.BigInteger,
                  sa.ForeignKey("raw_survey_data.id"),
                  comment="provenance: the submission this answer came from"),
        sa.Column("updated_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("site_id", "field_key",
                            name="site_survey_data_site_field_uniq"),
    )
    op.create_index("site_survey_data_site_idx", "site_survey_data",
                    ["site_id"])

    # Explode every existing blob into raw rows (+ curated rows for
    # registry-known keys) before the column is dropped.
    conn = op.get_bind()
    sites = conn.execute(sa.text(
        "SELECT id, survey_data FROM sites "
        "WHERE survey_data IS NOT NULL AND survey_data != '{}'::jsonb")).all()
    for site_id, blob in sites:
        for key, value in (blob or {}).items():
            raw_id = conn.execute(sa.text(
                "INSERT INTO raw_survey_data "
                "(site_id, field_key, value, captured_at, source) "
                "VALUES (:s, :k, CAST(:v AS jsonb), now(), 'migration') "
                "RETURNING id"),
                {"s": site_id, "k": key, "v": json.dumps(value)}).scalar()
            if key in FIELDS_BY_KEY:
                conn.execute(sa.text(
                    "INSERT INTO site_survey_data "
                    "(site_id, field_key, value, raw_id) "
                    "VALUES (:s, :k, CAST(:v AS jsonb), :r)"),
                    {"s": site_id, "k": key, "v": json.dumps(value), "r": raw_id})

    op.drop_column("sites", "survey_data")


def downgrade() -> None:
    op.add_column("sites", sa.Column(
        "survey_data", JSONB, nullable=False,
        server_default=sa.text("'{}'::jsonb")))

    conn = op.get_bind()
    conn.execute(sa.text("""
        UPDATE sites SET survey_data = agg.blob
        FROM (
            SELECT site_id, jsonb_object_agg(field_key, value) AS blob
            FROM site_survey_data
            GROUP BY site_id
        ) agg
        WHERE sites.id = agg.site_id
    """))

    op.drop_table("site_survey_data")
    op.drop_table("raw_survey_data")
