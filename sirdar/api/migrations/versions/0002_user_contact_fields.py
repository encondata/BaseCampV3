"""Contact fields on users (copied from the portal's people; editable on /me).

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-01
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE users
          ADD COLUMN contact_email text,
          ADD COLUMN phone text,
          ADD COLUMN address_line1 text,
          ADD COLUMN address_line2 text,
          ADD COLUMN city text,
          ADD COLUMN region text,
          ADD COLUMN postal_code text,
          ADD COLUMN country text NOT NULL DEFAULT 'US';
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE users
          DROP COLUMN contact_email, DROP COLUMN phone, DROP COLUMN address_line1,
          DROP COLUMN address_line2, DROP COLUMN city, DROP COLUMN region,
          DROP COLUMN postal_code, DROP COLUMN country;
    """)
