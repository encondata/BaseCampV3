"""Asset watches: a person watches one asset, on its own or on an initiative it is on, for its
next update or for a status, and hears once when that happens.

- `asset_watches`: one person's watch on one asset. `initiative_id` is the place it was set: null
  for the asset itself, else an initiative the asset is on. `condition` is what it waits for,
  `next_update` or `status`, and `status` names the asset status a `status` watch waits for. Two
  CHECKs keep the shape: the condition is one of the two, and a status is set exactly when the
  condition is `status`. `baseline` is the snapshot of the asset taken when the watch was set or
  last changed, which the notification worker's check compares with; `created_at` is when.
- A unique index (`NULLS NOT DISTINCT`, so a second watch on the asset itself collides) allows
  one watch per person, asset and place. The person leads it, so a person's watches are found
  through it. Deleting the person, the asset or the initiative deletes its watches (CASCADE).
- The status is not a foreign key into `status_values`: it is checked against the active asset
  statuses when the watch is set, as the portal's picker offers them.

Nothing is backfilled. Rolling back drops the table, watches and all.

Design: docs/superpowers/specs/2026-11-05-asset-watches-design.md (Data and API)

Revision ID: 0121
Revises: 0120
Create Date: 2026-11-05
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0121"
down_revision: str | None = "0120"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "asset_watches",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True),
                  sa.ForeignKey("assets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"), nullable=True),
        sa.Column("condition", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=True),
        sa.Column("baseline", JSONB(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("condition IN ('next_update', 'status')",
                           name="ck_asset_watches_condition"),
        sa.CheckConstraint("(condition = 'status') = (status IS NOT NULL)",
                           name="ck_asset_watches_status"),
    )
    # one watch per person, asset and place; the person leads, so their watches are found
    # through it
    op.create_index("uq_asset_watches_target", "asset_watches",
                    ["person_id", "asset_id", "initiative_id"],
                    unique=True, postgresql_nulls_not_distinct=True)


def downgrade() -> None:
    op.drop_table("asset_watches")      # its index and checks go with it
