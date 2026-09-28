"""Natural ordering: the `natural` ICU collation (migration 0082) and the
list endpoints that order text with it."""

from sqlalchemy import text

from serversherpa.db.models import Container, Person, PersonRole, Site

from tests.test_status_values_write import _make

NAMES = ["Rack 10", "Rack 2", "rack 1", "Rack 1a"]
EXPECTED = ["rack 1", "Rack 1a", "Rack 2", "Rack 10"]


async def test_collation_orders_numbers_by_value_and_ignores_case(db):
    rows = await db.execute(text(
        "SELECT x FROM unnest(CAST(:names AS text[])) AS t(x) ORDER BY x COLLATE \"natural\""),
        {"names": NAMES})
    assert [r[0] for r in rows] == EXPECTED


async def test_sites_list_is_naturally_ordered(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "nat-admin@test.example.com")
    for n in NAMES:
        db.add(Site(name=n))
    await db.commit()
    body = (await client.get("/sites", headers=hdrs)).json()
    names = [s["name"] for s in body if s["name"] in NAMES]
    assert names == EXPECTED


async def test_people_lists_order_last_names_naturally(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "nat-admin2@test.example.com")
    for n in NAMES:
        p = Person(first_name="Pat", last_name=n)
        db.add(p)
        await db.flush()
        db.add(PersonRole(person_id=p.id, role="worker"))
    await db.commit()
    body = (await client.get("/workers", headers=hdrs)).json()
    lasts = [w["last_name"] for w in body if w.get("last_name") in NAMES]
    assert lasts == EXPECTED


async def test_warehouse_containers_are_naturally_ordered(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "nat-admin3@test.example.com")
    wh = Site(name="Nat warehouse", site_type="warehouse")
    db.add(wh)
    await db.flush()
    for n in NAMES:
        db.add(Container(name=n, site_id=wh.id))
    await db.commit()
    body = (await client.get(f"/warehouse/{wh.id}/inventory", headers=hdrs)).json()
    names = [c["name"] for c in body["containers"] if c["name"] in NAMES]
    assert names == EXPECTED
