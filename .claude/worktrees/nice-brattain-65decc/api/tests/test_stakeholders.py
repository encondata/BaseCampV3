"""Stakeholders: client/partner CRUD, contacts as scoped role grants."""

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password

PW = "CorrectHorse9!"


async def _headers(client, email="alice@test.example.com"):
    resp = await client.post("/auth/login", json={"email": email, "password": PW})
    assert resp.status_code == 200
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _mk_person(db, first="Carl", last="Contact", email=None):
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.commit()
    return person


async def test_client_crud_cycle(client, seeded_user):
    headers = await _headers(client)

    resp = await client.post("/clients", headers=headers, json={
        "name": "Acme Datacenters", "code": "ACME", "tier": "preferred",
        "city": "Las Vegas", "region": "NV", "website": "https://acme.example.com",
    })
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Acme Datacenters"
    assert body["tier"] == "preferred"
    assert body["status"] == "active"
    assert body["contact_count"] == 0
    org_id = body["id"]

    # duplicate name rejected
    resp = await client.post("/clients", headers=headers,
                             json={"name": "acme datacenters"})
    assert resp.status_code == 409

    # update + manager assignment
    me = (await client.get("/auth/me/profile", headers=headers)).json()
    resp = await client.patch(f"/clients/{org_id}", headers=headers, json={
        "status": "dormant", "account_manager_id": me["id"]})
    assert resp.status_code == 200
    assert resp.json()["status"] == "dormant"
    assert resp.json()["account_manager"]["display_name"] == "Alice Anderson"

    # archive / unarchive
    assert (await client.post(f"/clients/{org_id}/archive",
                              headers=headers)).status_code == 204
    listing = (await client.get("/clients", headers=headers)).json()
    assert listing[0]["archived_at"] is not None
    assert (await client.post(f"/clients/{org_id}/unarchive",
                              headers=headers)).status_code == 204


async def test_client_contacts_are_scoped_grants(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")

    resp = await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                             json={"person_id": str(person.id)})
    assert resp.status_code == 201
    # duplicate add → 409
    resp = await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                             json={"person_id": str(person.id)})
    assert resp.status_code == 409

    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert [c["display_name"] for c in contacts] == ["Carl Contact"]
    assert contacts[0]["has_account"] is False

    # the grant is a real person_roles row scoped to the client
    listing = (await client.get("/clients", headers=headers)).json()
    assert listing[0]["contact_count"] == 1

    # remove → revoked (history kept), count drops
    resp = await client.delete(
        f"/clients/{org['id']}/contacts/{person.id}", headers=headers)
    assert resp.status_code == 204
    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts == []
    from sqlalchemy import func, select
    total = await db.scalar(select(func.count()).select_from(PersonRole)
                            .where(PersonRole.person_id == person.id))
    assert total == 1  # revoked row preserved


async def test_partner_with_type_and_vendor_contact(client, seeded_user, db):
    headers = await _headers(client)
    resp = await client.post("/partners", headers=headers, json={
        "name": "Northwind Staffing", "partner_types": ["staffing"]})
    assert resp.status_code == 201
    org = resp.json()
    assert org["partner_types"] == ["staffing"]

    person = await _mk_person(db, first="Wanda", last="Worker")
    assert (await client.post(f"/partners/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201

    # vendor grant is partner-scoped in person_roles
    from sqlalchemy import select
    grant = (await db.scalars(select(PersonRole).where(
        PersonRole.person_id == person.id,
        PersonRole.revoked_at.is_(None)))).one()
    assert grant.role == "vendor_viewer"
    assert str(grant.partner_id) == org["id"]
    assert grant.client_id is None


async def test_people_picker_lists_unaccounted(client, seeded_user, db):
    await _mk_person(db, first="No", last="Account")
    headers = await _headers(client)
    people = (await client.get("/people", headers=headers)).json()
    names = {p["display_name"]: p["has_account"] for p in people}
    assert names["Alice Anderson"] is True
    assert names["No Account"] is False


async def test_worker_cannot_touch_stakeholders(client, seeded_user, db):
    person = Person(first_name="Wan", last_name="Worker",
                    email="wan@test.example.com")
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email="wan@test.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=person.id, role="worker"))
    await db.commit()

    headers = await _headers(client, email="wan@test.example.com")
    assert (await client.get("/clients", headers=headers)).status_code == 403
    assert (await client.post("/clients", headers=headers,
                              json={"name": "X"})).status_code == 403
    assert (await client.get("/people", headers=headers)).status_code == 403


async def test_search_finds_orgs(client, seeded_user):
    headers = await _headers(client)
    await client.post("/clients", headers=headers, json={"name": "Acme", "code": "ACM"})
    await client.post("/partners", headers=headers,
                      json={"name": "Northwind", "partner_types": ["staffing"]})
    body = (await client.get("/search?q=acm", headers=headers)).json()
    kinds = {(r["kind"], r["label"]) for r in body["results"]}
    assert ("client", "Acme") in kinds
    body = (await client.get("/search?q=northw", headers=headers)).json()
    assert ("partner", "Northwind") in {(r["kind"], r["label"]) for r in body["results"]}


async def test_partner_supplied_workers_list(client, seeded_user, db):
    headers = await _headers(client)
    partner = (await client.post("/partners", headers=headers, json={
        "name": "Northwind", "partner_types": ["staffing"]})).json()

    # a worker assigned to this partner
    w = await _mk_person(db, first="Wanda", last="Worker")
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    await client.put(f"/workers/{w.id}/profile", headers=headers, json={
        "trade": "Packer", "level": "L3", "partner_id": partner["id"]})

    # a direct-hire worker (no partner) — must NOT appear
    d = await _mk_person(db, first="Dee", last="Direct", email="dee2@test.example.com")
    db.add(PersonRole(person_id=d.id, role="worker"))
    await db.commit()
    await client.put(f"/workers/{d.id}/profile", headers=headers,
                     json={"trade": "Driver"})

    supplied = (await client.get(f"/partners/{partner['id']}/workers",
                                 headers=headers)).json()
    assert [x["display_name"] for x in supplied] == ["Wanda Worker"]
    assert supplied[0]["trade"] == "Packer"
    assert supplied[0]["level"] == "L3"

    # unknown partner → 404
    import uuid
    assert (await client.get(f"/partners/{uuid.uuid4()}/workers",
                             headers=headers)).status_code == 404


async def test_partner_multiple_types(client, seeded_user):
    headers = await _headers(client)
    resp = await client.post("/partners", headers=headers, json={
        "name": "OmniCorp", "partner_types": ["staffing", "logistics"]})
    assert resp.status_code == 201
    assert resp.json()["partner_types"] == ["staffing", "logistics"]

    # edit to a different set
    pid = resp.json()["id"]
    resp = await client.patch(f"/partners/{pid}", headers=headers, json={
        "partner_types": ["logistics", "subcontractor", "consultant"]})
    assert resp.json()["partner_types"] == ["logistics", "subcontractor", "consultant"]

    # invalid type rejected
    resp = await client.post("/partners", headers=headers, json={
        "name": "Bad", "partner_types": ["staffing", "spaceships"]})
    assert resp.status_code == 422


async def test_patch_org_writes_audit_row(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()

    resp = await client.patch(f"/clients/{org['id']}", headers=headers,
                              json={"status": "dormant"})
    assert resp.status_code == 200

    from sqlalchemy import select
    from serversherpa.db.models import AuditLog
    row = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "client",
        AuditLog.entity_id == org["id"],
        AuditLog.action == "update"))).one_or_none()
    assert row is not None                      # the audit row was committed
    assert row.changes["status"] == {"from": "active", "to": "dormant"}
    assert row.actor_person_id == seeded_user.id


async def test_client_contact_sees_only_their_org(client, db, seeded_user):
    from serversherpa.config import get_settings
    from serversherpa.db.models import Client, Person, PersonRole, UserAccount
    from serversherpa.security.passwords import hash_password
    from datetime import UTC, datetime

    ca, cb = Client(name="Acme"), Client(name="Bcme")
    db.add_all([ca, cb])
    await db.flush()
    contact = Person(first_name="C", last_name="Contact",
                     email="contact@acme.example.com")
    db.add(contact)
    await db.flush()
    db.add(UserAccount(person_id=contact.id, email="contact@acme.example.com",
                       password_hash=hash_password(
                           "CorrectHorse9!",
                           pepper=get_settings().password_pepper.get_secret_value()),
                       password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=ca.id))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "contact@acme.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    listing = (await client.get("/clients", headers=hdrs)).json()
    names = {c["name"] for c in listing}
    assert names == {"Acme"}                       # scoped list
    resp = await client.get(f"/clients/{cb.id}", headers=hdrs)
    assert resp.status_code == 404                 # out-of-scope detail = 404
    resp = await client.get("/partners", headers=hdrs)
    assert resp.status_code == 403                 # no partners:view
