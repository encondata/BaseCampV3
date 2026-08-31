"""Matching ladder: ID (uuid / legacy) → RFID → serial → name.
Multiple hits at a tier = ambiguous → None (stop, don't fall through).
Archived entities never match."""

from datetime import UTC, datetime

from serversherpa.db.models import Asset, Container, Person
from serversherpa.scans.matching import Match, match_scan


async def _asset(db, **over):
    a = Asset(**over)
    db.add(a)
    await db.flush()
    return a


async def test_uuid_matches_asset_id(db):
    a = await _asset(db, serial_number="SN-1")
    got = await match_scan(db, str(a.id))
    assert got == Match("asset", a.id)


async def test_legacy_id_matches_numeric_value(db):
    a = await _asset(db, legacy_id=4471)
    assert await match_scan(db, "4471") == Match("asset", a.id)


async def test_rfid_matches_across_tables_in_order(db):
    c = Container(name="Crate 9", rfid_tag="E280AAA")
    db.add(c)
    p = Person(first_name="Badge", last_name="Holder", rfid_tag="E280BBB")
    db.add(p)
    await db.flush()
    assert await match_scan(db, "e280aaa") == Match("container", c.id)
    assert await match_scan(db, "E280BBB") == Match("person", p.id)


async def test_rfid_beats_serial(db):
    by_serial = await _asset(db, serial_number="COLLIDE")
    by_rfid = await _asset(db, rfid_tag="COLLIDE")
    assert await match_scan(db, "COLLIDE") == Match("asset", by_rfid.id)


async def test_serial_single_hit_matches(db):
    a = await _asset(db, serial_number="SN-77")
    assert await match_scan(db, "sn-77") == Match("asset", a.id)


async def test_duplicate_serial_is_ambiguous_not_name_fallthrough(db):
    await _asset(db, serial_number="DUPE")
    await _asset(db, serial_number="DUPE")
    # a name row that WOULD match must not be reached — ambiguity stops
    await _asset(db, name="DUPE")
    assert await match_scan(db, "DUPE") is None


async def test_name_fallback_single_hit(db):
    a = await _asset(db, name="Rack 12 switch")
    assert await match_scan(db, "Rack 12 switch") == Match("asset", a.id)


async def test_archived_entities_never_match(db):
    await _asset(db, serial_number="GONE", archived_at=datetime.now(UTC))
    assert await match_scan(db, "GONE") is None


async def test_no_match_returns_none(db):
    assert await match_scan(db, "definitely-not-here") is None


async def test_person_rfid_matches_case_insensitively(db):
    p = Person(first_name="Badge", last_name="Holder", rfid_tag="E280CCC")
    db.add(p)
    await db.flush()
    assert await match_scan(db, "e280ccc") == Match("person", p.id)


async def test_duplicate_name_is_ambiguous(db):
    await _asset(db, name="Widget")
    await _asset(db, name="Widget")
    assert await match_scan(db, "Widget") is None


async def test_duplicate_legacy_id_is_ambiguous(db):
    await _asset(db, legacy_id=4471)
    await _asset(db, legacy_id=4471)
    assert await match_scan(db, "4471") is None
