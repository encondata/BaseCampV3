"""Migration 0118: worker_profiles gains will_travel (boolean), travel_region
and travel_restrictions (text), all nullable."""

from sqlalchemy import text


async def test_travel_columns_are_nullable_with_the_right_types(db):
    cols = dict((await db.execute(text(
        "SELECT column_name, data_type || ':' || is_nullable FROM information_schema.columns "
        "WHERE table_name='worker_profiles' AND column_name IN "
        "('will_travel', 'travel_region', 'travel_restrictions')"))).all())
    assert cols == {"will_travel": "boolean:YES", "travel_region": "text:YES",
                    "travel_restrictions": "text:YES"}
