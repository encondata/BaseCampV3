"""Global search endpoint: matching, scoping, auth."""

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password

LOGIN = {"email": "alice@test.example.com", "password": "CorrectHorse9!"}


async def _login(client, email=LOGIN["email"]):
    resp = await client.post("/auth/login",
                             json={"email": email, "password": LOGIN["password"]})
    assert resp.status_code == 200
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _add_user(db, *, first, last, email, role, job=None):
    person = Person(first_name=first, last_name=last, email=email, job_title=job)
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email=email,
        password_hash=hash_password(
            LOGIN["password"], pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=person.id, role=role))
    await db.commit()


async def test_search_requires_auth(client):
    assert (await client.get("/search?q=alice")).status_code == 401


async def test_search_matches_name_email_and_title(client, seeded_user, db):
    await _add_user(db, first="Maria", last="Garcia",
                    email="mgarcia@test.example.com", role="worker", job="Crew Lead")
    headers = await _login(client)

    # partial name
    body = (await client.get("/search?q=gar", headers=headers)).json()
    assert [r["label"] for r in body["results"]] == ["Maria Garcia"]
    assert body["results"][0]["kind"] == "user"

    # email fragment
    body = (await client.get("/search?q=mgarcia@", headers=headers)).json()
    assert [r["label"] for r in body["results"]] == ["Maria Garcia"]

    # job title
    body = (await client.get("/search?q=crew", headers=headers)).json()
    assert [r["label"] for r in body["results"]] == ["Maria Garcia"]

    # no match
    body = (await client.get("/search?q=zzzzz", headers=headers)).json()
    assert body["results"] == []


async def test_worker_gets_no_people_results(client, seeded_user, db):
    await _add_user(db, first="Wan", last="Worker",
                    email="wan@test.example.com", role="worker")
    headers = await _login(client, email="wan@test.example.com")
    body = (await client.get("/search?q=alice", headers=headers)).json()
    assert body["results"] == []


async def test_search_respects_permissions_and_scope(client, db, seeded_user):
    """A client_viewer searching sees only their own org — no people, no
    partners, no other clients."""
    from serversherpa.config import get_settings
    from serversherpa.db.models import Client, Person, PersonRole, UserAccount
    from serversherpa.security.passwords import hash_password
    from datetime import UTC, datetime

    ca, cb = Client(name="Acme Search"), Client(name="Bcme Search")
    db.add_all([ca, cb])
    await db.flush()
    contact = Person(first_name="C", last_name="Contact",
                     email="csearch@acme.example.com")
    db.add(contact)
    await db.flush()
    db.add(UserAccount(person_id=contact.id, email="csearch@acme.example.com",
                       password_hash=hash_password(
                           "CorrectHorse9!",
                           pepper=get_settings().password_pepper.get_secret_value()),
                       password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=ca.id))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "csearch@acme.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    results = (await client.get("/search?q=Search", headers=hdrs)).json()
    flat = str(results)
    assert "Acme Search" in flat
    assert "Bcme Search" not in flat        # other client scoped out
    assert "alice" not in flat.lower()      # no users:view -> no people results


async def test_sites_appear_for_staff_not_org_actors(client, db, seeded_user):
    """Sites join global search: staff find them by name/code/city; the
    sites hard gate (internal-only) keeps client-anchored actors from ever
    seeing site results."""
    from datetime import UTC, datetime

    from serversherpa.config import get_settings
    from serversherpa.db.models import (
        Client, Person, PersonRole, Site, UserAccount,
    )
    from serversherpa.security.passwords import hash_password
    from tests.test_sites_api import login

    db.add(Site(name="Delta Hall", code="DH1", city="Searchville",
                country="US", status="active"))
    await db.commit()

    hdrs = await login(client)
    for term in ("Delta", "DH1", "Searchville"):
        results = (await client.get(f"/search?q={term}", headers=hdrs)).json()
        hit = next((r for r in results["results"] if r["kind"] == "site"), None)
        assert hit is not None, term
        assert hit["label"] == "Delta Hall"

    ca = Client(name="Siteless Co")
    db.add(ca)
    await db.flush()
    contact = Person(first_name="S", last_name="Contact",
                     email="ssearch@acme.example.com")
    db.add(contact)
    await db.flush()
    db.add(UserAccount(person_id=contact.id, email="ssearch@acme.example.com",
                       password_hash=hash_password(
                           "CorrectHorse9!",
                           pepper=get_settings().password_pepper.get_secret_value()),
                       password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=ca.id))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "ssearch@acme.example.com", "password": "CorrectHorse9!"})
    chdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    results = (await client.get("/search?q=Delta", headers=chdrs)).json()
    assert not any(r["kind"] == "site" for r in results["results"])
