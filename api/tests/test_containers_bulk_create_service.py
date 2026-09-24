"""logistics/bulk_create — the numbered container batch behind POST
/containers/bulk and Create a move in steps' crates."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Container, Initiative, Site
from serversherpa.logistics.bulk_create import (
    ContainerBulkError, check_tags, check_vocab, create_containers, find_clashes,
)


async def test_creates_tags_and_audits_without_committing(db):
    site = Site(name="DC-1")
    ini = Initiative(name="Move", initiative_type="move", status="planned")
    db.add_all([site, ini])
    await db.commit()
    made = await create_containers(
        db, names=["C-1", "C-2", "C-3"], container_type="pallet", status=None,
        site_id=site.id, initiative_id=ini.id, tags={"vendor": 1, "priority": 1},
        actor_id=None)
    assert [c.name for c in made] == ["C-1", "C-2", "C-3"]
    assert [c.label_tag for c in made] == ["priority", "vendor", None]
    assert {c.status for c in made} == {"available"}
    assert {(c.site_id, c.initiative_id) for c in made} == {(site.id, ini.id)}
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "container", AuditLog.action == "create"))).all()
    assert sorted(a.entity_id for a in audits) == sorted(str(c.id) for c in made)
    await db.rollback()
    assert await db.scalar(select(func.count()).select_from(Container)) == 0


async def test_clashes_are_case_insensitive_and_ignore_archived(db):
    db.add_all([Container(name="c-2"),
                Container(name="C-3", archived_at=datetime.now(UTC))])
    await db.commit()
    assert await find_clashes(db, ["C-1", "C-2", "C-3"]) == ["C-2"]
    with pytest.raises(ContainerBulkError) as exc:
        await create_containers(db, names=["C-1", "C-2"], container_type="pallet",
                                status=None, site_id=None, initiative_id=None,
                                tags={}, actor_id=None)
    assert (exc.value.code, exc.value.extra) == ("name_collision", {"names": ["C-2"]})


async def test_checks_keep_the_route_codes(db):
    with pytest.raises(ContainerBulkError) as exc:
        check_tags({"bogus": 1}, 3)
    assert exc.value.code == "bad_tag_key"
    assert exc.value.extra["allowed"][0] == "priority"
    with pytest.raises(ContainerBulkError) as exc:
        check_tags({"priority": 4}, 3)
    assert exc.value.code == "tags_exceed_count"
    with pytest.raises(ContainerBulkError) as exc:
        await check_vocab(db, "spaceship", None)
    assert exc.value.code == "bad_container_type"
    with pytest.raises(ContainerBulkError) as exc:
        await check_vocab(db, "pallet", "nope")
    assert exc.value.code == "bad_status"
