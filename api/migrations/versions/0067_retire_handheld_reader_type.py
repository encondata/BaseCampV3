"""Retire the handheld_reader device type.

Nothing ever created one. The only producer was the Handheld Readers
page's own "+ New handheld" button, and the fleet has no rows: every
handheld in use runs the kiosk app and self-registers through
/kiosk/heartbeat as a kiosk, with its Android flavor recorded in
`sub_type` ('android', or 'zebra' for a Zebra handheld). The separate
device type described a distinction the system does not actually make,
so it goes, along with the page that was its only surface.

Order matters. `devices.device_type` is foreign-keyed to `status_values`
(devices_device_type_fkey, on the generated `type_record_type` plus
`device_type`), so a straggler device must be converted to a kiosk
BEFORE the vocabulary row is deleted — deleting first fails against any
surviving device. `sub_type` is carried over untouched: it has no CHECK
constraint, so a legacy 'zebra'/'android'/'ios' value survives, and the
first two land on labels the Kiosk Devices page already shows.

The data work lives in `retire_handheld_reader(conn)` rather than in
`upgrade()` directly so the test suite can re-run it against a database
whose `clean_db` fixture re-seeds status_values before every test (same
convention as 0066's `seed(conn)` and 0053's
`repoint_survey_templates(conn)`).

The downgrade restores the vocabulary row ONLY. It cannot un-convert the
devices: once a handheld has been rewritten to 'kiosk' nothing records
that it was ever a handheld, so a downgrade leaves those rows as kiosks.
This is a one-way migration in every sense that matters.

Revision ID: 0067
Revises: 0066
Create Date: 2026-09-17
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0067"
down_revision: str | None = "0066"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def retire_handheld_reader(conn) -> None:
    """Convert, then delete — never the other way round (see module docstring)."""
    conn.execute(sa.text("""
        UPDATE devices SET device_type = 'kiosk'
        WHERE device_type = 'handheld_reader'
    """))
    conn.execute(sa.text("""
        DELETE FROM status_values
        WHERE record_type = 'device_type' AND key = 'handheld_reader'
    """))


def upgrade() -> None:
    retire_handheld_reader(op.get_bind())


def downgrade() -> None:
    """Restores the vocabulary row so the type can be referenced again.
    Devices converted by upgrade() stay kiosks — which ones were handhelds
    is not recorded anywhere, so there is nothing to restore them from."""
    op.execute("""
        INSERT INTO status_values
          (record_type, key, label, description, color, sort_order)
        VALUES ('device_type','handheld_reader','Handheld Reader',
                'Android / iOS / Zebra handheld scanner.','#6d4fc4',3)
        ON CONFLICT (record_type, key) DO NOTHING
    """)
