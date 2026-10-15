"""MacroPoint manual update: dedup key on truck location updates and a
truck_events table for trip events (Arrived/Departed at Pickup, Drop-Off or
a named stop).

`source_ref` is a hash of the update's content (see
trucks/macropoint/parse.py `source_ref_for`), unique per truck so a
re-uploaded email is a no-op and a load re-assigned to another truck still
lands. A plain (non-partial) unique constraint: NULLs are distinct in
Postgres, so hand-entered rows never collide, and `ON CONFLICT ON
CONSTRAINT` needs no index inference.

Revision ID: 0097
Revises: 0096
Create Date: 2026-10-15
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0097"
down_revision: str | None = "0096"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.TIMESTAMP(timezone=True)


def upgrade() -> None:
    op.add_column("truck_updates", sa.Column("source_ref", sa.Text, nullable=True))
    op.create_unique_constraint("uq_truck_updates_truck_source_ref", "truck_updates",
                                ["truck_id", "source_ref"])
    op.create_table(
        "truck_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("truck_id", UUID(as_uuid=True),
                  sa.ForeignKey("trucks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("recorded_at", TS, nullable=False),
        sa.Column("event", sa.Text, nullable=False),
        sa.Column("event_kind", sa.Text, nullable=True),
        sa.Column("stop", sa.Text, nullable=True),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text, nullable=True),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("truck_id", "source_ref", name="uq_truck_events_truck_source_ref"),
    )
    op.create_index("ix_truck_events_truck_recorded", "truck_events",
                    ["truck_id", sa.text("recorded_at DESC")])
    op.create_index("ix_truck_events_recorded_at", "truck_events",
                    [sa.text("recorded_at DESC")])


def downgrade() -> None:
    op.drop_index("ix_truck_events_recorded_at", table_name="truck_events")
    op.drop_index("ix_truck_events_truck_recorded", table_name="truck_events")
    op.drop_table("truck_events")
    op.drop_constraint("uq_truck_updates_truck_source_ref", "truck_updates", type_="unique")
    op.drop_column("truck_updates", "source_ref")
