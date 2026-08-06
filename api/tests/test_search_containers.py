"""Global search — containers by name and RFID, permission-gated."""

from serversherpa.db.models import Client, Container, Person, PersonRole

from .test_assets_api import login, make_login


async def test_search_finds_containers(client, db, seeded_user):
    hdrs = await login(client)
    db.add_all([Container(name="Crate Alpha", rfid_tag="CRF-77"),
                Container(name="Unrelated")])
    await db.commit()

    resp = await client.get("/search?q=alpha", headers=hdrs)
    hits = [h for h in resp.json()["results"] if h["kind"] == "container"]
    assert [h["label"] for h in hits] == ["Crate Alpha"]

    resp = await client.get("/search?q=CRF-77", headers=hdrs)
    assert any(h["kind"] == "container" for h in resp.json()["results"])


async def test_search_respects_permission(client, db, seeded_user):
    db.add(Container(name="Hidden Crate"))
    org = Client(name="Search Client Co")
    nobody = Person(first_name="No", last_name="Body")
    db.add_all([org, nobody])
    await db.flush()
    db.add(PersonRole(person_id=nobody.id, role="client_viewer", client_id=org.id))
    await db.commit()
    hdrs = await make_login(db, client, nobody, "seeker@test.example.com")
    resp = await client.get("/search?q=crate", headers=hdrs)
    assert not any(h["kind"] == "container" for h in resp.json()["results"])
