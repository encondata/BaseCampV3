"""Sites list/detail: scoping, labels, client links."""
from sqlalchemy import text

from serversherpa.db.models import Client, Person, PersonRole, Site, SiteClient


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


async def test_list_shows_labels_and_clients(client, db, seeded_user):
    hdrs = await login(client)
    acme = Client(name="Acme Co")
    db.add(acme)
    await db.flush()
    site = Site(name="Acme DC1", site_type="datacenter", status="planned",
                city="Austin", country="US")
    db.add(site)
    await db.flush()
    db.add(SiteClient(site_id=site.id, client_id=acme.id))
    await db.commit()

    rows = (await client.get("/sites", headers=hdrs)).json()
    assert len(rows) == 1
    row = rows[0]
    assert row["name"] == "Acme DC1"
    assert row["type_label"] == "Data centre"
    assert row["status_label"] == "Planned" and row["status_color"] == "c-aqua"
    assert row["clients"] == [{"client_id": str(acme.id), "name": "Acme Co"}]


async def test_client_actor_is_hard_gated_out_of_sites(client, db, seeded_user):
    """Sites is internal-only: a client-anchored actor gets no view grant by
    default and, even if one existed, the visible_to hard gate in the
    resolver blocks org-anchored actors before overrides are consulted.
    So both list and detail must 403 — there is no scoped view to fall back
    to, unlike the 404-out-of-scope behavior internal actors get."""
    ca = Client(name="Acme S")
    db.add(ca)
    await db.flush()
    s1 = Site(name="Acme Site")
    db.add(s1)
    await db.flush()
    db.add(SiteClient(site_id=s1.id, client_id=ca.id))
    contact = Person(first_name="C", last_name="Contact")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=ca.id))
    await db.commit()
    hdrs = await make_login(db, client, contact, "sitecontact@acme.example.com")

    denied_list = await client.get("/sites", headers=hdrs)
    assert denied_list.status_code == 403
    assert denied_list.json()["detail"]["code"] == "forbidden"

    denied_detail = await client.get(f"/sites/{s1.id}", headers=hdrs)
    assert denied_detail.status_code == 403
    assert denied_detail.json()["detail"]["code"] == "forbidden"


async def test_internal_actor_detail_includes_survey_data(client, db, seeded_user):
    site = Site(name="Internal Site")
    db.add(site)
    await db.commit()
    hdrs = await login(client)

    ok = await client.get(f"/sites/{site.id}", headers=hdrs)
    assert ok.status_code == 200 and "survey_data" in ok.json()


async def test_lookups_and_survey_schema(client, seeded_user):
    hdrs = await login(client)
    types = (await client.get("/site-types", headers=hdrs)).json()
    assert [t["key"] for t in types][0] == "datacenter"
    statuses = (await client.get("/status-values?record_type=site",
                                 headers=hdrs)).json()
    assert statuses[0]["key"] == "active" and statuses[0]["color"] == "c-green"
    schema = (await client.get("/sites/survey-schema", headers=hdrs)).json()
    assert [g["key"] for g in schema["groups"]] == ["contact", "facility",
                                                    "dock", "notes"]


async def test_worker_has_no_sites_access(client, db, seeded_user):
    await db.execute(text("UPDATE person_roles SET role='worker' WHERE person_id=:p"),
                     {"p": seeded_user.id})
    await db.commit()
    hdrs = await login(client)
    assert (await client.get("/sites", headers=hdrs)).status_code == 403
