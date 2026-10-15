"""Container contents rows carry the full asset record — the same AssetItem
GET /assets/{id} returns, built by the shared asset_items builder."""

from sqlalchemy import event

from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    Asset,
    AssetModel,
    Client,
    PermissionOverride,
    Person,
    PersonRole,
    Site,
)

from .test_assets_api import login, make_login

OLD_FIELDS = ("asset_id", "serial_number", "name", "model_name", "status",
              "status_label", "status_color", "added_at", "added_by_name")


async def _container(client, hdrs, name="Crate"):
    resp = await client.post("/containers", headers=hdrs, json={"name": name})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _rich_asset(db, tag="1"):
    model = AssetModel(make="Dell", model=f"R74{tag}", category="server",
                       ru_size=2)
    org, site = Client(name=f"Acme {tag}"), Site(name=f"HQ {tag}")
    db.add_all([model, org, site])
    await db.flush()
    a = Asset(serial_number=f"SN-{tag}", name=f"srv{tag}", model_id=model.id,
              client_id=org.id, site_id=site.id, location_detail="Row 4",
              rfid_tag=f"E200{tag}", pod_number=f"P{tag}")
    db.add(a)
    await db.flush()
    return a


async def test_rows_carry_the_asset_record(client, db, seeded_user):
    hdrs = await login(client)
    cid = await _container(client, hdrs)
    a1, a2 = await _rich_asset(db, "1"), await _rich_asset(db, "2")
    await db.commit()

    posted = await client.post(
        f"/containers/{cid}/assets", headers=hdrs,
        json={"asset_ids": [str(a1.id), str(a2.id)]})
    assert posted.status_code == 200, posted.text
    listed = await client.get(f"/containers/{cid}/assets", headers=hdrs)
    assert listed.status_code == 200

    for rows in (posted.json(), listed.json()):
        assert len(rows) == 2
        for row in rows:
            for field in OLD_FIELDS:
                assert field in row
            one = await client.get(f"/assets/{row['asset_id']}", headers=hdrs)
            assert one.status_code == 200
            assert row["asset"] == one.json()
            assert row["asset"]["id"] == row["asset_id"]
            assert row["asset"]["model"]["make"] == "Dell"
            assert row["asset"]["client_name"].startswith("Acme")
            assert row["asset"]["site_name"].startswith("HQ")
            assert row["asset"]["location_detail"] == "Row 4"
            assert row["asset"]["container_id"] == cid
            assert row["asset"]["container_name"] == "Crate"
            assert row["model_name"] == "Dell " + row["asset"]["model"]["model"]
            assert row["status_label"] == row["asset"]["status_label"]


async def test_statement_count_is_flat_as_the_box_fills(client, db, seeded_user):
    hdrs = await login(client)
    cid = await _container(client, hdrs)
    engine = get_engine().sync_engine
    statements: list[str] = []

    def record(conn, cursor, statement, *rest):
        statements.append(statement)

    async def fill(n, tag):
        assets = [await _rich_asset(db, f"{tag}{i}") for i in range(n)]
        await db.commit()
        resp = await client.post(
            f"/containers/{cid}/assets", headers=hdrs,
            json={"asset_ids": [str(a.id) for a in assets]})
        assert resp.status_code == 200, resp.text

    async def measure(expected):
        statements.clear()
        event.listen(engine, "before_cursor_execute", record)
        try:
            resp = await client.get(f"/containers/{cid}/assets", headers=hdrs)
        finally:
            event.remove(engine, "before_cursor_execute", record)
        assert len(resp.json()) == expected
        return len(statements)

    await fill(2, "s")
    small = await measure(2)
    await fill(8, "l")
    large = await measure(10)
    assert 0 < small == large, (small, large)


async def test_asset_is_null_without_assets_view(client, db, seeded_user):
    """containers:view alone gets the flat fields, never the full record."""
    admin = await login(client)
    cid = await _container(client, admin)
    a = await _rich_asset(db)
    await db.commit()
    assert (await client.post(f"/containers/{cid}/assets", headers=admin,
                              json={"asset_ids": [str(a.id)]})).status_code == 200

    staffer = Person(first_name="No", last_name="Assets")
    db.add(staffer)
    await db.flush()
    db.add(PersonRole(person_id=staffer.id, role="staff"))
    db.add(PermissionOverride(person_id=staffer.id, resource="assets",
                              action="view", allow=False))
    await db.commit()
    hdrs = await make_login(db, client, staffer, "noassets@test.example.com")

    assert (await client.get("/assets", headers=hdrs)).status_code == 403
    resp = await client.get(f"/containers/{cid}/assets", headers=hdrs)
    assert resp.status_code == 200, resp.text
    (row,) = resp.json()
    assert row["asset"] is None
    assert row["asset_id"] == str(a.id)
    assert row["serial_number"] == "SN-1"
    assert row["model_name"] == "Dell R741"
    assert row["status_label"]
    assert row["added_by_name"] is not None or row["added_at"]

    # the super-user still gets the full record
    full = (await client.get(f"/containers/{cid}/assets", headers=admin)).json()
    one = (await client.get(f"/assets/{a.id}", headers=admin)).json()
    assert full[0]["asset"] == one
