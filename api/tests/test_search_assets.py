"""Global search: asset + asset_model sections, permission- and row-scoped."""

from serversherpa.db.models import Asset, AssetModel, AssetModelAlias
from tests.test_assets_api import _client_contact, login


async def test_search_finds_assets_and_models(client, db, seeded_user):
    hdrs = await login(client)
    m = AssetModel(make="Dell", model="R740")
    db.add(m)
    await db.flush()
    db.add(AssetModelAlias(model_id=m.id, alias="PowerEdge 740"))
    db.add(Asset(serial_number="SN-R740-1", name="web-01", model_id=m.id))
    await db.commit()

    body = (await client.get("/search?q=R740", headers=hdrs)).json()
    kinds = {(r["kind"], r["label"]) for r in body["results"]}
    assert ("asset", "SN-R740-1") in kinds or ("asset", "web-01") in kinds
    assert ("asset_model", "Dell R740") in kinds

    # alias text also finds the model
    body = (await client.get("/search?q=PowerEdge", headers=hdrs)).json()
    assert any(r["kind"] == "asset_model" for r in body["results"])


async def test_search_scopes_assets_and_hides_catalog(client, db, seeded_user):
    org, hdrs = await _client_contact(db, client, "Acme SR", "sr@acme.example.com")
    from serversherpa.db.models import Client
    other = Client(name="Other SR")
    db.add(other)
    await db.flush()
    db.add_all([
        Asset(serial_number="FINDME-1", client_id=org.id),
        Asset(serial_number="FINDME-2", client_id=other.id),
    ])
    m = AssetModel(make="Findme", model="Z1")
    db.add(m)
    await db.commit()

    body = (await client.get("/search?q=FINDME", headers=hdrs)).json()
    labels = [r["label"] for r in body["results"] if r["kind"] == "asset"]
    assert labels == ["FINDME-1"]                     # own org only
    assert not any(r["kind"] == "asset_model" for r in body["results"])
