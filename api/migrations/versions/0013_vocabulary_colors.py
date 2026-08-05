"""Vocabulary colours become hex; site types and levels gain one; rank defers.

The seven tokens each carried a *different value per theme* — light values are
dark colours, dark values are bright. A single stored hex only works because
render-time clamps lightness per theme (see the spec). Light is the source:
it preserves today's light-mode appearance byte-for-byte.

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# token -> light-theme hex (directory.css :root)
TOKEN_HEX = {
    "c-green": "#178a4c", "c-amber": "#a36207", "c-red": "#c03540",
    "c-blue": "#1668a7", "c-violet": "#6d4fc4", "c-aqua": "#0f7c86",
    "c-slate": "#51606f",
}
FALLBACK_HEX = "#51606f"   # matches the old UNKNOWN_COLOR = "c-slate"

# no prior colour existed — site types rendered permanently grey
SITE_TYPE_HEX = {
    "datacenter": "#1668a7", "office": "#6d4fc4", "warehouse": "#a36207",
    "colo": "#0f7c86", "partner_office": "#178a4c", "other": "#51606f",
}

# lifted verbatim from LEVEL_COLORS in portal/src/pages/Workers.tsx, which this
# migration's landing deletes — badges must look identical afterwards
LEVEL_HEX = {
    "L1": "#8a93a6", "L2": "#4dd0ff", "L3": "#35e0c8",
    "L4": "#3ddc84", "L5": "#a78bfa", "L6": "#ffb84d",
}


def _case(mapping: dict[str, str], col: str, fallback: str) -> str:
    whens = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in mapping.items())
    return f"CASE {col} {whens} ELSE '{fallback}' END"


def upgrade() -> None:
    op.execute(f"UPDATE status_values SET color = {_case(TOKEN_HEX, 'color', FALLBACK_HEX)}")

    # add nullable -> backfill -> NOT NULL: no lingering server_default, matching
    # status_values.color (the create endpoints always supply a colour)
    #
    # worker_levels' fallback deliberately differs from FALLBACK_HEX: an
    # unmapped level here would go through the badge shape (background,
    # floored at L 0.66 by directory.css's `.lvl-badge b`), not the chip
    # shape FALLBACK_HEX was chosen for. #51606f (L 0.482) would be floored
    # away immediately; status/labels.py's UNKNOWN_LEVEL_COLOR (#8a93a6,
    # L 0.662) is what that same "no colour on record" case already renders
    # at runtime, so use it here too rather than a value the render path
    # can't actually produce.
    for table, mapping, key, fallback in (
        ("site_types", SITE_TYPE_HEX, "key", FALLBACK_HEX),
        ("worker_levels", LEVEL_HEX, "level", "#8a93a6"),
    ):
        op.add_column(table, sa.Column("color", sa.Text, nullable=True))
        op.execute(f"UPDATE {table} SET color = {_case(mapping, key, fallback)}")
        op.alter_column(table, "color", nullable=False)

    # A non-deferrable unique constraint is checked per ROW, so a single
    # `UPDATE ... SET rank = rank + 1 WHERE rank >= n` collides mid-statement
    # (3 -> 4 hits the row still at 4). Declaring it DEFERRABLE moves the check
    # to STATEMENT end, which is all the rank shift needs — INITIALLY IMMEDIATE
    # keeps real violations on the offending statement rather than at COMMIT,
    # so callers never need SET CONSTRAINTS.
    op.drop_constraint("worker_levels_rank_key", "worker_levels", type_="unique")
    op.create_unique_constraint(
        "worker_levels_rank_key", "worker_levels", ["rank"], deferrable=True,
        initially="IMMEDIATE")


def downgrade() -> None:
    # LOSSY, deliberately. A token vocabulary cannot represent an arbitrary
    # colour: the seven known hexes reverse-map, and everything a user picked
    # after 0013 collapses to c-slate. There is no honest nearest-match — a
    # colour-distance function would invent a wrong answer rather than admit
    # the loss. site_types.color and worker_levels.color are dropped outright.
    reverse = {v: k for k, v in TOKEN_HEX.items()}
    op.execute(f"UPDATE status_values SET color = {_case(reverse, 'color', 'c-slate')}")

    op.drop_constraint("worker_levels_rank_key", "worker_levels", type_="unique")
    op.create_unique_constraint("worker_levels_rank_key", "worker_levels", ["rank"])

    op.drop_column("worker_levels", "color")
    op.drop_column("site_types", "color")
