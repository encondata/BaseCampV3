"""GET /workers/{person_id} detail payload + person notes host."""

import uuid

from serversherpa.db.models import (
    Initiative, InitiativePerson, Partner, Person, PersonRole, WorkerProfile,
)
from tests.test_sites_api import make_login
from tests.test_workers import _headers, _mk_worker  # shared harness


async def test_worker_detail_returns_person_extras(client, seeded_user, db):
    worker = await _mk_worker(db)
    worker.job_title = "Rack tech"
    worker.city = "Las Vegas"
    worker.rfid_tag = "RF-001"
    worker.notes = "V2 rating: 4\nV2 work: Project #3"
    worker.source_ref = "backup_20260825_193157:people/7"
    db.add(WorkerProfile(person_id=worker.id, trade="Hardware", status="active"))
    await db.commit()

    headers = await _headers(client)
    resp = await client.get(f"/workers/{worker.id}", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["display_name"] == "Wan Worker"
    assert body["trade"] == "Hardware"
    assert body["status"] == "active"
    assert body["job_title"] == "Rack tech"
    assert body["city"] == "Las Vegas"
    assert body["rfid_tag"] == "RF-001"
    assert body["person_notes"].startswith("V2 rating: 4")
    assert body["source_ref"] == "backup_20260825_193157:people/7"
    assert body["badge_uid"]
    assert body["initiatives"] == []
    assert body["level_def"] is None


async def test_worker_detail_includes_initiative_history(client, seeded_user, db):
    worker = await _mk_worker(db)
    init = Initiative(name="NAP11 Hall Migration", initiative_type="move",
                      status="in_progress")
    db.add(init)
    await db.flush()
    db.add(InitiativePerson(initiative_id=init.id, person_id=worker.id,
                            work_type="lead", rating=4))
    await db.commit()

    headers = await _headers(client)
    body = (await client.get(f"/workers/{worker.id}", headers=headers)).json()
    assert len(body["initiatives"]) == 1
    row = body["initiatives"][0]
    assert row["initiative_id"] == str(init.id)
    assert row["initiative_name"] == "NAP11 Hall Migration"
    assert row["rating"] == 4
    assert row["status_label"]          # label resolved (or key fallback)
    assert row["added_at"]


async def test_worker_detail_level_def(client, seeded_user, db):
    worker = await _mk_worker(db)
    db.add(WorkerProfile(person_id=worker.id, level="L3", status="active"))
    await db.commit()
    headers = await _headers(client)
    body = (await client.get(f"/workers/{worker.id}", headers=headers)).json()
    assert body["level"] == "L3"
    assert body["level_def"]["title"] == "Technician"
    assert isinstance(body["level_def"]["expected_skills"], list)


async def test_worker_detail_404s(client, seeded_user, db):
    headers = await _headers(client)
    # unknown id
    resp = await client.get(f"/workers/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404
    # a person without the worker role is not a worker
    person = Person(first_name="No", last_name="Role")
    db.add(person)
    await db.commit()
    resp = await client.get(f"/workers/{person.id}", headers=headers)
    assert resp.status_code == 422


async def test_person_notes_host(client, seeded_user, db):
    worker = await _mk_worker(db)
    headers = await _headers(client)
    resp = await client.post("/notes", headers=headers, json={
        "entity_type": "person", "entity_id": str(worker.id),
        "body": "met on site"})
    assert resp.status_code == 201
    listing = (await client.get(
        f"/notes?entity_type=person&entity_id={worker.id}",
        headers=headers)).json()
    assert [n["body"] for n in listing] == ["met on site"]


async def test_patch_worker_person_updates_accountless_worker(client, seeded_user, db):
    """The account-less-worker regression: 112 imported workers have no
    UserAccount row, so the old `/users/{id}/profile` PATCH (which requires
    one) 404s on them. The new `/workers/{id}/person` endpoint must work
    without an account."""
    worker = await _mk_worker(db, account=False, email="noacct@test.example.com")
    headers = await _headers(client)

    resp = await client.patch(f"/workers/{worker.id}/person", headers=headers, json={
        "job_title": "Field Tech", "city": "Reno"})
    assert resp.status_code == 204

    body = (await client.get(f"/workers/{worker.id}", headers=headers)).json()
    assert body["job_title"] == "Field Tech"
    assert body["city"] == "Reno"


async def test_patch_worker_person_rank_guard(client, seeded_user, db):
    """A worker who ALSO holds an account and an elevated role (rank higher
    than the actor's) must not be editable via this endpoint — mirrors the
    blacklist rank guard in upsert_profile. seeded_user is "staff" (rank 40);
    admin is rank 60, so it genuinely outranks staff."""
    worker = await _mk_worker(db, first="Ed", last="Elevated",
                              email="ed@test.example.com")
    db.add(PersonRole(person_id=worker.id, role="admin"))
    await db.commit()

    headers = await _headers(client)
    resp = await client.patch(f"/workers/{worker.id}/person", headers=headers, json={
        "job_title": "Ops Lead"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"


async def test_patch_worker_person_email_conflict(client, seeded_user, db):
    worker_a = await _mk_worker(
        db, first="Ann", last="WorkerA", email="worker-a@test.example.com")
    worker_b = await _mk_worker(
        db, first="Bob", last="WorkerB", email="worker-b@test.example.com")
    headers = await _headers(client)

    resp = await client.patch(f"/workers/{worker_a.id}/person", headers=headers, json={
        "email": "worker-b@test.example.com"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "email_in_use"


async def test_person_notes_scoped_worker_cannot_read_others(client, seeded_user, db):
    worker_a = await _mk_worker(
        db, first="Ann", last="WorkerA", email="worker-a@test.example.com")
    worker_b = await _mk_worker(
        db, first="Bob", last="WorkerB", email="worker-b@test.example.com")
    db.add(WorkerProfile(person_id=worker_a.id, status="active"))
    db.add(WorkerProfile(person_id=worker_b.id, status="active"))
    await db.commit()

    admin_headers = await _headers(client)
    resp = await client.post("/notes", headers=admin_headers, json={
        "entity_type": "person", "entity_id": str(worker_b.id),
        "body": "note about worker B"})
    assert resp.status_code == 201

    worker_a_headers = await _headers(client, email="worker-a@test.example.com")

    # worker A must NOT be able to read worker B's notes. This used to hit
    # the "workers" scope-probe (guarding against a bug where
    # scope_conditions("workers", ...) returns WorkerProfile columns, but
    # was being probed against Person, creating an unjoined cross product
    # that matched every person id) and 404 out-of-scope. Security-fixes
    # task 2 finding (b) generalized notes' internal-only rule to the
    # 'person' host too — a non-global actor is denied on ANY person-notes
    # read, in-scope or not, before the scope probe ever runs — so this is
    # now 403, matching worker A's own notes below.
    resp = await client.get(
        f"/notes?entity_type=person&entity_id={worker_b.id}",
        headers=worker_a_headers)
    assert resp.status_code == 403

    # worker A cannot read their OWN notes either — notes on the person
    # host are internal-only for non-global reads, full stop.
    resp = await client.get(
        f"/notes?entity_type=person&entity_id={worker_a.id}",
        headers=worker_a_headers)
    assert resp.status_code == 403


async def test_worker_detail_redacts_internal_fields_for_partner_actor(
        client, seeded_user, db):
    """Security-fixes task 5 finding (a): GET /workers/{id} joined
    initiatives/sites without a scope check and always returned rating,
    person_notes, badge_uid, rfid_tag and address fields. vendor_admin holds
    workers:view but is partner-anchored (not global) — it must see the
    worker (in scope, supplied by their own partner) but not the internal
    fields or the initiative history."""
    worker = await _mk_worker(db)
    worker.job_title = "Rack tech"
    worker.city = "Las Vegas"
    worker.address_line1 = "123 Data Dr"
    worker.rfid_tag = "RF-002"
    worker.notes = "internal note about Wan"

    partner = Partner(name="Northwind Staffing")
    db.add(partner)
    await db.flush()
    profile = WorkerProfile(person_id=worker.id, trade="Hardware",
                            status="active", partner_id=partner.id)
    db.add(profile)

    init = Initiative(name="NAP11 Hall Migration", initiative_type="move",
                      status="in_progress")
    db.add(init)
    await db.flush()
    db.add(InitiativePerson(initiative_id=init.id, person_id=worker.id,
                            work_type="lead", rating=4))

    contact = Person(first_name="V", last_name="Contact",
                     email="vc@partner.example.com")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="vendor_admin",
                      partner_id=partner.id))
    await db.commit()

    vendor_hdrs = await make_login(db, client, contact, "vc@partner.example.com")

    resp = await client.get(f"/workers/{worker.id}", headers=vendor_hdrs)
    assert resp.status_code == 200
    body = resp.json()
    assert body["initiatives"] == []
    assert body["person_notes"] is None
    assert body["badge_uid"] is None
    assert body["rfid_tag"] is None
    assert body["address_line1"] is None
    assert body["city"] is None
    assert body["country"] is None
    # non-internal fields are still fine to send
    assert body["display_name"] == "Wan Worker"
    assert body["trade"] == "Hardware"

    # a global actor still sees everything
    admin_hdrs = await _headers(client)
    body2 = (await client.get(f"/workers/{worker.id}", headers=admin_hdrs)).json()
    assert body2["person_notes"] == "internal note about Wan"
    assert body2["rfid_tag"] == "RF-002"
    assert body2["badge_uid"]
    assert body2["city"] == "Las Vegas"
    assert len(body2["initiatives"]) == 1
