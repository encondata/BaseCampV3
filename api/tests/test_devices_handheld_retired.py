"""The handheld_reader device type is retired (migration 0067).

Nothing ever produced one: the only creator was the Handheld Readers
page's own "+ New handheld" button, and every handheld in the fleet runs
the kiosk app and self-registers as a kiosk. The vocabulary row is gone
and the portal page with it.

Migration 0067's data work lives in `retire_handheld_reader(conn)`, a
plain function taking a raw connection, rather than being written
straight into `upgrade()` — `clean_db` (api/tests/conftest.py) re-seeds
status_values from its own canonical list before every test, so a row
this migration deletes is back by the time a test runs and the deletion
has to be re-applied directly against the test database. Same convention
as 0066's `seed(conn)` (test_container_zpl_templates.py) and 0053's
`repoint_survey_templates(conn)`.

The ordering inside that function is load-bearing: devices.device_type
is foreign-keyed to status_values (devices_device_type_fkey, on the
generated type_record_type + device_type pair), so deleting the vocab
row while a device still points at it fails. The dev database has zero
handheld rows, so the case is constructed here rather than relying on
real data to exercise it.
"""

import importlib.util
from pathlib import Path

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import StatusValue

API_DIR = Path(__file__).resolve().parents[1]
MIGRATION_PATH = (
    API_DIR / "migrations" / "versions" / "0067_retire_handheld_reader_type.py"
)


def _load_migration_0067():
    spec = importlib.util.spec_from_file_location(
        "_migration_0067_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _restore_a_pre_0067_handheld(db, name: str = "handheld-zebra-1") -> None:
    """The vocabulary row and one device on it, exactly as a database that
    had not yet run 0067 would carry them."""
    await db.execute(text("""
        INSERT INTO status_values
          (record_type, key, label, description, color, sort_order)
        VALUES ('device_type','handheld_reader','Handheld Reader',
                'Android / iOS / Zebra handheld scanner.','#6d4fc4',3)
    """))
    await db.execute(text("""
        INSERT INTO devices (device_type, name, sub_type)
        VALUES ('handheld_reader', :name, 'zebra')
    """), {"name": name})
    await db.commit()


async def test_the_handheld_reader_device_type_is_retired(db):
    keys = set((await db.execute(
        select(StatusValue.key)
        .where(StatusValue.record_type == "device_type"))).scalars())
    assert keys == {"router", "fixed_reader", "kiosk"}


async def test_any_surviving_handheld_device_becomes_a_kiosk(db):
    """The migration converts before it deletes, and leaves sub_type alone:
    a legacy 'zebra' handheld lands on a value the kiosk page can already
    display."""
    await _restore_a_pre_0067_handheld(db)

    migration = _load_migration_0067()
    await db.run_sync(
        lambda session: migration.retire_handheld_reader(session.connection()))
    await db.commit()
    db.expire_all()

    row = (await db.execute(text(
        "SELECT device_type, sub_type FROM devices WHERE name = 'handheld-zebra-1'"
    ))).one()
    assert tuple(row) == ("kiosk", "zebra")
    assert await db.get(StatusValue, ("device_type", "handheld_reader")) is None


async def test_deleting_the_vocab_row_before_converting_would_fail(db):
    """Why the order inside retire_handheld_reader() is not cosmetic: the
    foreign key rejects the delete while a device still references the
    row. If the statements are ever reordered, this is the failure a
    production upgrade would hit."""
    await _restore_a_pre_0067_handheld(db, name="handheld-zebra-2")

    with pytest.raises(IntegrityError):
        async with db.begin_nested():
            await db.execute(text(
                "DELETE FROM status_values "
                "WHERE record_type = 'device_type' AND key = 'handheld_reader'"))
    await db.rollback()
