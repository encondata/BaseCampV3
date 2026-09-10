"""Asset numbers: every asset gets a human-readable Asset ID.

`assets.legacy_id` carried BaseCamp V2's numeric ids (38257–38484) and was
NULL for every asset born in V3. It now IS the Asset ID: a sequence starting
at 100000 numbers the V3-born rows in creation order and defaults every
future insert, the column becomes NOT NULL and unique. V2 ids are kept as
they were (the sequence starts well above them). Column name is historical.

Revision ID: 0047
Revises: 0046
Create Date: 2026-09-10
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0047"
down_revision: str | None = "0046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

START = 100000


def upgrade() -> None:
    op.execute(f"CREATE SEQUENCE asset_number_seq START WITH {START}")
    # number the unnumbered in creation order (id as a stable tie-break)
    op.execute(f"""
        UPDATE assets a SET legacy_id = {START} + o.rn - 1
        FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
              FROM assets WHERE legacy_id IS NULL) o
        WHERE a.id = o.id
    """)
    # continue after the highest number handed out (or start fresh)
    op.execute(f"""
        SELECT setval('asset_number_seq',
                      COALESCE((SELECT MAX(legacy_id) FROM assets
                                WHERE legacy_id >= {START}), {START - 1}))
    """)
    op.execute("ALTER TABLE assets ALTER COLUMN legacy_id "
               "SET DEFAULT nextval('asset_number_seq')")
    op.execute("ALTER SEQUENCE asset_number_seq OWNED BY assets.legacy_id")
    op.execute("ALTER TABLE assets ALTER COLUMN legacy_id SET NOT NULL")
    op.create_index("ux_assets_legacy_id", "assets", ["legacy_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ux_assets_legacy_id", table_name="assets")
    op.execute("ALTER TABLE assets ALTER COLUMN legacy_id DROP NOT NULL")
    op.execute("ALTER TABLE assets ALTER COLUMN legacy_id DROP DEFAULT")
    op.execute("DROP SEQUENCE asset_number_seq")
