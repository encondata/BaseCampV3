"""trucks/bulk_create — the numbered truck batch Create a move in steps
uses: attached to the move, origin → destination, one audit per truck."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Initiative, Site, Truck
from serversherpa.trucks.bulk_create import TruckBulkError, create_trucks, find_clashes


async def test_create_trucks_attaches_the_move_and_sites(db):
    a, b = Site(name="A"), Site(name="B")
    ini = Initiative(name="Move", initiative_type="move", status="planned")
    db.add_all([a, b, ini])
    await db.commit()
    made = await create_trucks(db, ["T-1", "T-2"], ini.id, a.id, b.id, None)
    assert [(t.name, t.initiative_id, t.start_site_id, t.end_site_id, t.status)
            for t in made] == [("T-1", ini.id, a.id, b.id, "created"),
                               ("T-2", ini.id, a.id, b.id, "created")]
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "truck", AuditLog.action == "create"))).all()
    assert len(audits) == 2
    assert audits[0].changes["initiative_id"]["to"] == str(ini.id)
    await db.rollback()
    assert await db.scalar(select(func.count()).select_from(Truck)) == 0


async def test_truck_clashes_are_case_insensitive_and_ignore_archived(db):
    db.add_all([Truck(name="t-2"), Truck(name="T-3", archived_at=datetime.now(UTC))])
    await db.commit()
    assert await find_clashes(db, ["T-1", "T-2", "T-3"]) == ["T-2"]
    with pytest.raises(TruckBulkError) as exc:
        await create_trucks(db, ["T-1", "T-2"], None, None, None, None)
    assert exc.value.names == ["T-2"]
    assert await db.scalar(select(func.count()).select_from(Truck)) == 2
