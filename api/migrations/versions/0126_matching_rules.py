"""Matching rules: versioned flows per place and the test set.

- matching_rule_versions: one flow (jsonb) per place and version, with a state
  (draft, standby, live, retired). A partial unique index allows at most one
  Live version per place.
- matching_test_assets / matching_test_rows: the placeholder assets and the
  (place, value, expected result) rows the check and the test bar run against.

Seeds v1 of each place as Live (today's kiosk matching) and the starting test
set from `serversherpa.matching_rules.seed`, which is the record of these rows.

Revision ID: 0126
Revises: 0125
Create Date: 2026-11-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

from serversherpa.matching_rules.seed import seed_statements

revision: str = "0126"
down_revision: str | None = "0125"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PLACES = "('printing', 'scanning')"


def _id() -> sa.Column:
    return sa.Column("id", UUID(as_uuid=True), primary_key=True,
                     server_default=sa.text("gen_random_uuid()"))


def _now(name: str) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=False,
                     server_default=sa.text("now()"))


def _person(name: str) -> sa.Column:
    return sa.Column(name, UUID(as_uuid=True),
                     sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True)


def upgrade() -> None:
    op.create_table(
        "matching_rule_versions",
        _id(),
        sa.Column("place", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="draft"),
        sa.Column("flow", JSONB(), nullable=False),
        sa.Column("based_on_id", UUID(as_uuid=True),
                  sa.ForeignKey("matching_rule_versions.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("checked", JSONB(), nullable=True,
                  comment='{"passed","total","ok","checked_at"}'),
        _person("created_by"),
        _person("updated_by"),
        _person("state_changed_by"),
        _now("created_at"),
        _now("updated_at"),
        sa.Column("state_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(f"place IN {_PLACES}", name="matching_rule_versions_place_check"),
        sa.CheckConstraint("state IN ('draft', 'standby', 'live', 'retired')",
                           name="matching_rule_versions_state_check"),
        sa.UniqueConstraint("place", "version", name="matching_rule_versions_place_version_key"),
    )
    op.create_index("matching_rule_versions_one_live", "matching_rule_versions", ["place"],
                    unique=True, postgresql_where=sa.text("state = 'live'"))

    op.create_table(
        "matching_test_assets",
        _id(),
        sa.Column("asset_tag", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("rfid", sa.Text(), nullable=True),
        sa.Column("serial", sa.Text(), nullable=True),
        sa.Column("sits", sa.Text(), nullable=False, server_default="move"),
        _now("created_at"),
        _now("updated_at"),
        sa.CheckConstraint("asset_tag > 0", name="matching_test_assets_tag_check"),
        sa.CheckConstraint("sits IN ('move', 'client')", name="matching_test_assets_sits_check"),
        sa.UniqueConstraint("asset_tag", name="matching_test_assets_asset_tag_key"),
    )

    op.create_table(
        "matching_test_rows",
        _id(),
        sa.Column("test_asset_id", UUID(as_uuid=True),
                  sa.ForeignKey("matching_test_assets.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("place", sa.Text(), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("expected", sa.Text(), nullable=False),
        _now("created_at"),
        sa.CheckConstraint(f"place IN {_PLACES}", name="matching_test_rows_place_check"),
        sa.CheckConstraint("btrim(value) <> ''", name="matching_test_rows_value_check"),
        sa.CheckConstraint(
            "expected IN ('asset_tag', 'serial', 'rfid', 'name', 'not_found')",
            name="matching_test_rows_expected_check"),
        sa.UniqueConstraint("place", "value", name="matching_test_rows_place_value_key"),
    )
    op.create_index("matching_test_rows_test_asset_idx", "matching_test_rows", ["test_asset_id"])

    bind = op.get_bind()
    for sql, params in seed_statements():
        bind.execute(sa.text(sql), params)


def downgrade() -> None:
    op.drop_table("matching_test_rows")
    op.drop_table("matching_test_assets")
    op.drop_table("matching_rule_versions")
