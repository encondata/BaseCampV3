"""partner type vocab — partner_types becomes an admin-editable
status_values vocabulary instead of a hardcoded pydantic Literal.
Converts partners.partner_types from JSONB to text[] so the array
usage-count branch (unnest) can count it, matching initiatives'
shipping_types. Existing keys already match the seeds below — no
value rewrite needed, only a container-type conversion.

Revision ID: 0017
Revises: 0016
Create Date: 2026-08-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PARTNER_TYPE_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('partner_type','staffing','Staffing','Contract labour.','#1668a7',1),
      ('partner_type','logistics','Logistics','Transport & freight.','#a36207',2),
      ('partner_type','tech','Tech','Hands-on technical services.','#178a4c',3),
      ('partner_type','cable','Cable','Structured cabling.','#0f7c86',4),
      ('partner_type','subcontractor','Subcontractor','General subcontracting.','#6d4fc4',5),
      ('partner_type','consultant','Consultant','Advisory services.','#51606f',6),
      ('partner_type','other','Other','Anything else.','#c03540',7)
"""


def upgrade() -> None:
    op.execute(PARTNER_TYPE_SEEDS)

    # Postgres 16 rejects a correlated subquery in an ALTER COLUMN TYPE
    # USING clause ("cannot use subquery in transform expression"), so the
    # jsonb -> text[] conversion goes via a shadow column + UPDATE instead
    # of a single ALTER ... TYPE ... USING statement. End state is
    # identical: existing keys already match the seeds — no value rewrite,
    # only a container-type conversion.
    op.execute("ALTER TABLE partners ADD COLUMN partner_types_new text[]")
    op.execute(
        "UPDATE partners SET partner_types_new = "
        "ARRAY(SELECT jsonb_array_elements_text(partner_types))")
    op.execute("ALTER TABLE partners DROP COLUMN partner_types")
    op.execute(
        "ALTER TABLE partners RENAME COLUMN partner_types_new TO partner_types")
    op.execute(
        "ALTER TABLE partners ALTER COLUMN partner_types "
        "SET DEFAULT '{}'::text[]")
    op.execute(
        "ALTER TABLE partners ALTER COLUMN partner_types SET NOT NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE partners ALTER COLUMN partner_types DROP NOT NULL")
    op.execute("ALTER TABLE partners ALTER COLUMN partner_types DROP DEFAULT")
    op.execute("""
        ALTER TABLE partners ALTER COLUMN partner_types TYPE jsonb
          USING (to_jsonb(partner_types))
    """)
    op.execute(
        "ALTER TABLE partners ALTER COLUMN partner_types "
        "SET DEFAULT '[]'::jsonb")
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM status_values WHERE record_type = 'partner_type'"))
