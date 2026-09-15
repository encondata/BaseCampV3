"""Initiative color — `initiatives.color`, the per-initiative hex the
calendar and timeline bars paint with.

Nullable rather than NOT NULL DEFAULT: a single server default would hand
every row the same color and defeat the point. Existing rows are
backfilled round-robin over `created_at` (deterministic and reproducible),
`POST /initiatives` assigns on create, and every reader falls back to the
status color when the column is null.

Numbering: `reports` was at 0063 when this was written. A sibling
session's unmerged `timeclock` branch already holds
`0064_time_entry_device.py` and has applied it to the shared dev
database, so this migration is 0065 with `down_revision = "0063"`, which
keeps this branch's own chain (and its test database) self-consistent.
When the two branches converge, whoever merges second re-points this
revision's `down_revision` to "0064" — there is no data dependency
between them, only the chain.

Design: docs/superpowers/specs/2026-09-15-initiative-color-design.md

Revision ID: 0065
Revises: 0063
Create Date: 2026-09-15
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0065"
down_revision: str | None = "0063"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# A frozen copy of the application palette
# (serversherpa.api.routes.initiatives.INITIATIVE_PALETTE). Deliberately
# inlined rather than imported: this backfill must not move when the app
# does — same convention as the other migrations that inline their values.
PALETTE = (
    "#1668a7", "#0f7c86", "#178a4c", "#5d8a17", "#a36207", "#c05a1f",
    "#c03540", "#b3316d", "#8b3fb8", "#6d4fc4", "#3f63c4", "#51606f",
)


def upgrade() -> None:
    op.add_column("initiatives", sa.Column("color", sa.Text(), nullable=True))
    values = ", ".join(f"({n}, '{hex_}')" for n, hex_ in enumerate(PALETTE))
    op.execute(f"""
        WITH palette (n, hex) AS (VALUES {values}),
        ranked AS (
            SELECT id,
                   (row_number() OVER (ORDER BY created_at, id) - 1)
                       % {len(PALETTE)} AS n
            FROM initiatives
        )
        UPDATE initiatives i
           SET color = palette.hex
          FROM ranked JOIN palette ON palette.n = ranked.n
         WHERE i.id = ranked.id
    """)


def downgrade() -> None:
    op.drop_column("initiatives", "color")
