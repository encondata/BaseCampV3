"""Time entries schema — defaults, one-open-entry-per-person partial unique
index, vocab seeds, role grants."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import Person, StatusValue, TimeEntry

NOW = datetime(2026, 8, 27, 8, 0, tzinfo=UTC)
LATER = datetime(2026, 8, 27, 17, 0, tzinfo=UTC)


async def _person(db) -> Person:
    p = Person(first_name="Time", last_name="Tracker")
    db.add(p)
    await db.flush()
    return p


async def test_time_entry_defaults(db):
    person = await _person(db)
    e = TimeEntry(person_id=person.id, clock_in_at=NOW)
    db.add(e)
    await db.commit()
    assert e.id is not None
    assert e.status == "open"
    assert e.source == "punch"
    assert e.break_minutes == 0
    assert e.notes == ""
    assert e.adjusted is False
    assert e.clock_out_at is None


async def test_one_open_entry_per_person_enforced(db):
    person = await _person(db)
    pid = person.id
    first = TimeEntry(person_id=pid, clock_in_at=NOW)
    db.add(first)
    await db.commit()
    first_id = first.id

    db.add(TimeEntry(person_id=pid, clock_in_at=NOW))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    reloaded_first = await db.get(TimeEntry, first_id)
    reloaded_first.clock_out_at = LATER
    await db.commit()

    second = TimeEntry(person_id=pid, clock_in_at=LATER)
    db.add(second)
    await db.commit()
    assert second.id is not None


async def test_time_entry_vocabulary_seeds(db):
    values = {s.key for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "time_entry"))}
    assert values == {"open", "pending", "approved", "rejected"}


async def test_time_role_grants_seeded(db):
    rows = (await db.execute(text(
        "SELECT role, action FROM role_permissions WHERE resource='time'"
    ))).all()
    grants = {}
    for role, action in rows:
        grants.setdefault(role, set()).add(action)
    assert grants["admin"] == {"view", "add", "change", "delete"}
    assert grants["staff"] == {"view"}
    assert "worker" not in grants
