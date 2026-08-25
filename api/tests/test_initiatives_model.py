"""Initiatives schema — defaults, vocab seeds, and DB-level constraints."""

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Initiative, InitiativeLink, InitiativePerson, Person, StatusValue,
)


async def test_vocab_seeds(db):
    counts = dict((await db.execute(
        select(StatusValue.record_type, func.count())
        .where(StatusValue.record_type.in_((
            "initiative", "initiative_type", "initiative_sub_type",
            "initiative_work_type", "shipping_type")))
        .group_by(StatusValue.record_type))).all())
    assert counts == {"initiative": 6, "initiative_type": 3,
                      "initiative_sub_type": 6, "initiative_work_type": 5,
                      "shipping_type": 4}


async def test_defaults(db):
    i = Initiative(name="Denver refresh", initiative_type="project")
    db.add(i)
    await db.commit()
    await db.refresh(i)
    assert i.status == "planned"
    assert i.archived_at is None
    assert i.created_at is not None
    assert i.shipping_types is None


async def test_unknown_status_rejected(db):
    db.add(Initiative(name="X", initiative_type="project", status="bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_unknown_type_rejected(db):
    db.add(Initiative(name="X", initiative_type="bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_person_unique_per_initiative(db):
    i = Initiative(name="X", initiative_type="event")
    p = Person(first_name="Terry", last_name="Tech")
    db.add_all([i, p])
    await db.flush()
    db.add(InitiativePerson(initiative_id=i.id, person_id=p.id))
    await db.commit()
    db.add(InitiativePerson(initiative_id=i.id, person_id=p.id))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_link_self_reference_rejected(db):
    i = Initiative(name="X", initiative_type="project")
    db.add(i)
    await db.flush()
    db.add(InitiativeLink(parent_id=i.id, child_id=i.id))
    with pytest.raises(IntegrityError):
        await db.commit()
