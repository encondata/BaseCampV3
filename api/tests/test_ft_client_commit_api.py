"""Import commit with per-serial Continue/Skip choices (SS-526, SS-527):
rows flagged as belonging to another client need a choice before commit."""

import uuid

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, Client, ImportJob, PermissionOverride, Person,
)
from serversherpa.imports.worker import run_once

from .client_groups_fixtures import client_user
from .test_assets_api import login
from .test_move_asset_import_api import _upload

CSV = (b"Serial Number,Asset Name\n"
       b"SN-B1,one\nSN-B2,two\nsn-b1,again\nSN-NEW,fresh\n")


async def _setup(client, db, csv=CSV):
    """Acme's move; SN-B1 and SN-B2 belong to Bravo. Returns the headers,
    both clients, the two Bravo assets and a completed validate job id."""
    headers = await login(client)
    acme, bravo = Client(name="Acme"), Client(name="Bravo")
    db.add_all([acme, bravo])
    await db.flush()
    b1 = Asset(name="b1", serial_number="sn-b1", client_id=bravo.id)
    b2 = Asset(name="b2", serial_number="sn-b2", client_id=bravo.id)
    db.add_all([b1, b2])
    await db.commit()
    resp = await client.post("/initiatives", headers=headers, json={
        "name": "Acme move", "initiative_type": "move",
        "client_id": str(acme.id)})
    assert resp.status_code == 201, resp.text
    iid = resp.json()["id"]
    resp = await _upload(client, headers, iid, content=csv)
    assert resp.status_code == 201, resp.text
    job_id = resp.json()["id"]
    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, uuid.UUID(job_id))
    assert job.status == "completed" and job.phase == "validate"
    return headers, acme, bravo, b1, b2, job_id


def _commit(client, headers, job_id, body=None):
    return client.post(f"/initiatives/assets/import-jobs/{job_id}/commit",
                       headers=headers, **({} if body is None else {"json": body}))


async def test_commit_requires_every_choice(client, db, seeded_user):
    headers, _a, _b, _b1, _b2, job_id = await _setup(client, db)
    # no body at all, then a partial body: both name the missing serials
    for body in (None, {"client_choices": {"SN-B1": "continue"}}):
        resp = await _commit(client, headers, job_id, body)
        assert resp.status_code == 422, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "client_choices_required"
        assert detail["serials"] == (["sn-b1", "sn-b2"] if body is None
                                     else ["sn-b2"])
        job = await db.get(ImportJob, uuid.UUID(job_id))
        await db.refresh(job)
        assert job.phase == "validate" and job.status == "completed"
        assert "client_choices" not in job.options


async def test_commit_with_choices_runs_and_moves(client, db, seeded_user):
    headers, acme, bravo, b1, b2, job_id = await _setup(client, db)
    resp = await _commit(client, headers, job_id, {"client_choices": {
        "SN-B1": "continue", "sn-b2": "skip", "sn-unrelated": "continue"}})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["phase"] == "commit" and body["status"] == "queued"
    # keys lower-cased; choices for non-conflicts are not stored
    assert body["options"]["client_choices"] == {"sn-b1": "continue",
                                                 "sn-b2": "skip"}
    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, uuid.UUID(job_id))
    await db.refresh(job)
    assert job.status == "completed", job.error
    await db.refresh(b1)
    await db.refresh(b2)
    assert b1.client_id == acme.id
    assert b2.client_id == bravo.id
    new = await db.scalar(select(Asset).where(Asset.serial_number == "sn-new"))
    assert new is not None and new.client_id == acme.id


async def test_commit_without_conflicts_needs_no_body(client, db, seeded_user):
    headers, *_rest, job_id = await _setup(
        client, db, csv=b"Serial Number,Asset Name\nSN-NEW,fresh\n")
    resp = await _commit(client, headers, job_id)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "queued"
    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, uuid.UUID(job_id))
    await db.refresh(job)
    assert job.status == "completed"


async def test_invalid_choice_value_422(client, db, seeded_user):
    headers, *_rest, job_id = await _setup(client, db)
    resp = await _commit(client, headers, job_id, {"client_choices": {
        "sn-b1": "continue", "sn-b2": "maybe"}})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "invalid_client_choice"
    job = await db.get(ImportJob, uuid.UUID(job_id))
    await db.refresh(job)
    assert job.phase == "validate" and job.status == "completed"


async def test_poll_requires_global_actor(client, db, seeded_user):
    """Job results name other clients, so a client-anchored actor holding
    initiatives:change through an override still cannot read them."""
    headers, acme, _bravo, _b1, _b2, job_id = await _setup(client, db)
    h = await client_user(db, client, acme.id, "client_owner")
    person = await db.scalar(select(Person).where(
        Person.email == "cg-user@test.example.com"))
    db.add(PermissionOverride(person_id=person.id, resource="initiatives",
                              action="change", allow=True))
    await db.commit()
    resp = await client.get(f"/initiatives/assets/import-jobs/{job_id}",
                            headers=h)
    assert resp.status_code == 403, resp.text
    resp = await client.get(f"/initiatives/assets/import-jobs/{job_id}",
                            headers=headers)
    assert resp.status_code == 200


async def test_reprocessed_child_inherits_choices_and_needs_none(
        client, db, seeded_user):
    """Conflict rows are never review rows, so a reprocess child (which reruns
    only review rows) holds no conflicts: it inherits the parent's stored
    choices through options, its commit needs no body, and the parent's
    Continue/Skip outcomes stay as the parent applied them."""
    csv = (b"Serial Number,Asset Name,Asset Make,Asset Model\n"
           b"SN-B1,one,,\nSN-B2,two,,\nSN-REV,odd,HPE,DL380\n")
    headers, acme, bravo, b1, b2, job_id = await _setup(client, db, csv=csv)
    resp = await _commit(client, headers, job_id, {"client_choices": {
        "sn-b1": "continue", "sn-b2": "skip"}})
    assert resp.status_code == 200, resp.text
    assert await run_once(get_sessionmaker()) is True
    parent = await db.get(ImportJob, uuid.UUID(job_id))
    await db.refresh(parent)
    assert parent.status == "completed" and parent.results["summary"]["review"] == 1

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/reprocess", headers=headers)
    assert resp.status_code == 201, resp.text
    child_id = resp.json()["id"]
    assert resp.json()["options"]["client_choices"] == {"sn-b1": "continue",
                                                        "sn-b2": "skip"}
    assert await run_once(get_sessionmaker()) is True
    child = await db.get(ImportJob, uuid.UUID(child_id))
    await db.refresh(child)
    assert child.status == "completed" and child.phase == "validate"
    assert child.results["summary"]["conflicts"] == 0

    resp = await _commit(client, headers, child_id)          # no body needed
    assert resp.status_code == 200, resp.text
    assert resp.json()["options"]["client_choices"] == {"sn-b1": "continue",
                                                        "sn-b2": "skip"}
    assert await run_once(get_sessionmaker()) is True
    await db.refresh(child)
    assert child.status == "completed", child.error
    await db.refresh(b1)
    await db.refresh(b2)
    assert b1.client_id == acme.id and b2.client_id == bravo.id
