"""GET /workers/{person_id} detail payload + person notes host."""

import uuid

from serversherpa.db.models import (
    Initiative, InitiativePerson, Person, WorkerProfile,
)
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

    # worker A must NOT be able to read worker B's notes via the
    # "workers" scope-probe (the bug: scope_conditions("workers", ...)
    # returns WorkerProfile columns, but was being probed against Person,
    # creating an unjoined cross product that matched every person id).
    resp = await client.get(
        f"/notes?entity_type=person&entity_id={worker_b.id}",
        headers=worker_a_headers)
    assert resp.status_code == 404

    # worker A can read their own notes (empty list, but in scope -> 200).
    resp = await client.get(
        f"/notes?entity_type=person&entity_id={worker_a.id}",
        headers=worker_a_headers)
    assert resp.status_code == 200
    assert resp.json() == []
