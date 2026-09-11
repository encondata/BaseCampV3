"""Assets API — read paths, labels, and the client-scoping contract."""

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, Client, Person, PersonRole, Site,
)


async def login(client, email="alice@test.example.com", pw="CorrectHorse9!"):
    resp = await client.post("/auth/login", json={"email": email, "password": pw})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def make_login(db, client_api, person, email):
    """Give an existing person a login and return their auth header."""
    from datetime import UTC, datetime

    from serversherpa.config import get_settings
    from serversherpa.db.models import UserAccount
    from serversherpa.security.passwords import hash_password

    db.add(UserAccount(
        person_id=person.id, email=email,
        password_hash=hash_password(
            "CorrectHorse9!", pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    await db.commit()
    return await login(client_api, email=email)


async def _client_contact(db, client_api, org_name, email):
    """A client_viewer contact of a fresh org; returns (org, headers)."""
    org = Client(name=org_name)
    db.add(org)
    await db.flush()
    contact = Person(first_name="C", last_name="Contact")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org.id))
    await db.commit()
    hdrs = await make_login(db, client_api, contact, email)
    return org, hdrs


async def test_registry_shape():
    from serversherpa.access.resources import REGISTRY

    assert REGISTRY["assets"].visible_to == frozenset({"global", "client"})
    assert REGISTRY["asset_models"].visible_to == frozenset({"global"})
    assert "/assets" in REGISTRY["assets"].routes
    assert "/assets/models" in REGISTRY["asset_models"].routes


async def test_scope_map(db, seeded_user):
    from serversherpa.access.resolver import resolve_access
    from serversherpa.access.scope import scope_conditions

    org_a, org_b = Client(name="Acme"), Client(name="Bcme")
    db.add_all([org_a, org_b])
    await db.flush()
    contact = Person(first_name="S", last_name="Coped")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org_a.id))
    db.add_all([Asset(name="a-acme", client_id=org_a.id),
                Asset(name="a-bcme", client_id=org_b.id),
                Asset(name="a-house", client_id=None)])
    await db.commit()

    access = await resolve_access(db, contact.id)
    cond = scope_conditions("assets", access, contact.id)
    names = {a.name for a in await db.scalars(select(Asset).where(cond))}
    assert names == {"a-acme"}          # own org only — house gear invisible


async def test_client_contact_scoped_list_and_403s(client, db, seeded_user):
    """The house three-assertion contract: in-scope row visible /
    out-of-scope detail 404 / no-permission resource 403."""
    org, hdrs = await _client_contact(db, client, "Acme A", "ac1@acme.example.com")
    other = Client(name="Other Co")
    db.add(other)
    await db.flush()
    mine = Asset(name="mine", client_id=org.id)
    theirs = Asset(name="theirs", client_id=other.id)
    db.add_all([mine, theirs])
    await db.commit()

    rows = (await client.get("/assets", headers=hdrs)).json()
    assert {r["name"] for r in rows} == {"mine"}

    resp = await client.get(f"/assets/{theirs.id}", headers=hdrs)
    assert resp.status_code == 404

    resp = await client.get("/asset-models", headers=hdrs)
    assert resp.status_code == 403      # catalog is internal-only


async def test_list_embeds_labels_and_model_summary(client, db, seeded_user):
    hdrs = await login(client)
    m = AssetModel(make="Dell", model="R740", category="server", ru_size=2)
    org = Client(name="Acme L")
    site = Site(name="DC-1")
    db.add_all([m, org, site])
    await db.flush()
    db.add(Asset(serial_number="SN-100", name="web-01", model_id=m.id,
                 client_id=org.id, site_id=site.id, status="active",
                 location_detail="Hall B, Rack 14"))
    await db.commit()

    rows = (await client.get("/assets", headers=hdrs)).json()
    assert len(rows) == 1
    row = rows[0]
    assert row["serial_number"] == "SN-100"
    assert row["status_label"] == "Active" and row["status_color"] == "#178a4c"
    assert row["client_name"] == "Acme L"
    assert row["site_name"] == "DC-1"
    assert row["model"]["make"] == "Dell"
    assert row["model"]["category_label"] == "Server"
    assert "knowledge" not in row["model"]        # summary only — house IP


async def test_client_contact_gets_model_summary_but_not_catalog(client, db, seeded_user):
    org, hdrs = await _client_contact(db, client, "Acme MS", "ms@acme.example.com")
    m = AssetModel(make="Dell", model="R640")
    db.add(m)
    await db.flush()
    db.add(Asset(name="mine", client_id=org.id, model_id=m.id))
    await db.commit()

    rows = (await client.get("/assets", headers=hdrs)).json()
    assert rows[0]["model"]["make"] == "Dell"     # embedded summary works
    assert (await client.get("/asset-models", headers=hdrs)).status_code == 403


async def test_new_assets_get_sequential_asset_ids_from_100000(client, db, seeded_user):
    """Asset ID (legacy_id) is auto-numbered by asset_number_seq (0047):
    never blank, unique, and it rides along on the list and detail items."""
    hdrs = await login(client)
    first = await client.post("/assets", headers=hdrs,
                              json={"serial_number": "SEQ-1", "name": "seq-one"})
    assert first.status_code == 201, first.text
    second = await client.post("/assets", headers=hdrs,
                               json={"serial_number": "SEQ-2", "name": "seq-two"})
    assert second.status_code == 201, second.text
    a, b = first.json()["legacy_id"], second.json()["legacy_id"]
    assert a >= 100000 and b == a + 1
    listed = {r["id"]: r["legacy_id"] for r in (await client.get("/assets", headers=hdrs)).json()}
    assert listed[first.json()["id"]] == a
    assert len(set(listed.values())) == len(listed)          # unique across the list
