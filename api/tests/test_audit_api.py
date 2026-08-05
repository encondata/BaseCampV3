"""/audit — the admin log viewer API: gate, filters, pagination, facets.
Staff have no audit:view grant in the default matrix; admin and up do."""
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from serversherpa.db.models import AuditLog, Person, PersonRole
from tests.test_sites_api import login, make_login


@pytest.fixture
async def admin_hdrs(db, client):
    person = Person(first_name="Ada", last_name="Admin",
                    email="ada-audit@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, "ada-audit@test.example.com")


async def test_staff_forbidden(client, seeded_user):
    hdrs = await login(client)
    assert (await client.get("/audit", headers=hdrs)).status_code == 403
    assert (await client.get("/audit/facets", headers=hdrs)).status_code == 403


async def test_admin_lists_filters_and_paginates(client, db, seeded_user, admin_hdrs):
    t0 = datetime.now(UTC) - timedelta(hours=2)
    rows = [
        AuditLog(actor_person_id=seeded_user.id, entity_type="site",
                 entity_id="s-1", action="create",
                 changes={"name": {"from": None, "to": "DC One"}}, at=t0),
        AuditLog(actor_person_id=seeded_user.id, entity_type="site",
                 entity_id="s-1", action="update",
                 changes={"city": {"from": "A", "to": "B"}},
                 at=t0 + timedelta(minutes=1)),
        AuditLog(actor_person_id=None, entity_type="auth",
                 entity_id="x@test.example.com", action="login_failed",
                 changes={}, at=t0 + timedelta(minutes=2)),
    ]
    db.add_all(rows)
    await db.commit()

    body = (await client.get("/audit", headers=admin_hdrs)).json()
    # newest first; the admin's own login row from this test is in here too
    ats = [r["at"] for r in body]
    assert ats == sorted(ats, reverse=True)
    site_row = next(r for r in body if r["action"] == "create")
    assert site_row["actor_name"] == "Alice Anderson"
    assert site_row["actor_id"] == str(seeded_user.id)
    assert site_row["changes"]["name"]["to"] == "DC One"

    only_sites = (await client.get(
        "/audit?entity_type=site", headers=admin_hdrs)).json()
    assert {r["entity_type"] for r in only_sites} == {"site"}
    assert len(only_sites) == 2

    only_updates = (await client.get(
        "/audit?entity_type=site&action=update", headers=admin_hdrs)).json()
    assert len(only_updates) == 1

    by_actor = (await client.get(
        f"/audit?actor_id={seeded_user.id}", headers=admin_hdrs)).json()
    assert {r["actor_id"] for r in by_actor} == {str(seeded_user.id)}

    page1 = (await client.get(
        "/audit?entity_type=site&limit=1", headers=admin_hdrs)).json()
    page2 = (await client.get(
        "/audit?entity_type=site&limit=1&offset=1", headers=admin_hdrs)).json()
    assert len(page1) == len(page2) == 1
    assert page1[0]["id"] != page2[0]["id"]

    since = (t0 + timedelta(minutes=1, seconds=30)).isoformat()
    resp = await client.get("/audit", headers=admin_hdrs,
                            params={"since": since})
    recent = resp.json()
    assert resp.status_code == 200, recent
    assert all(r["at"] >= since for r in recent)
    assert not any(r["action"] == "create" for r in recent)


async def test_facets_list_distinct_values(client, db, seeded_user, admin_hdrs):
    db.add(AuditLog(actor_person_id=seeded_user.id, entity_type="worker",
                    entity_id=str(uuid.uuid4()), action="archive", changes={}))
    await db.commit()
    body = (await client.get("/audit/facets", headers=admin_hdrs)).json()
    assert "worker" in body["entity_types"]
    assert "archive" in body["actions"]
    assert "auth" in body["entity_types"]   # the logins from this test session


async def test_entity_names_resolved(client, db, seeded_user, admin_hdrs):
    from serversherpa.db.models import Site
    site = Site(name="Named DC", city="Reno", region="NV",
                country="US", status="active")
    db.add(site)
    await db.flush()
    db.add(AuditLog(actor_person_id=seeded_user.id, entity_type="site",
                    entity_id=str(site.id), action="update",
                    changes={"city": {"from": "X", "to": "Reno"}}))
    db.add(AuditLog(actor_person_id=seeded_user.id, entity_type="worker",
                    entity_id=str(seeded_user.id), action="profile.update",
                    changes={}))
    # a row whose record no longer exists must not break resolution
    db.add(AuditLog(actor_person_id=seeded_user.id, entity_type="site",
                    entity_id=str(uuid.uuid4()), action="update", changes={}))
    await db.commit()

    rows = (await client.get("/audit", headers=admin_hdrs)).json()
    site_row = next(r for r in rows if r["entity_id"] == str(site.id))
    assert site_row["entity_name"] == "Named DC"
    assert site_row["entity_summary"] == {"Location": "Reno, NV",
                                          "Status": "active"}
    worker_row = next(r for r in rows if r["entity_type"] == "worker")
    assert worker_row["entity_name"] == "Alice Anderson"
    assert worker_row["entity_summary"]["Email"] == "alice@test.example.com"
    ghost = next(r for r in rows
                 if r["entity_type"] == "site" and r["entity_id"] != str(site.id))
    assert ghost["entity_name"] is None
