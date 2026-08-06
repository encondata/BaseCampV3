"""Asset categories are vocabulary: anyone with asset_models:view reads
them, but changing what categories EXIST is devtools-gated (the Variables
page), mirroring site types."""
import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Person, PersonRole
from tests.test_sites_api import login, make_login


@pytest.fixture
async def dev_hdrs(db, client):
    person = Person(first_name="Devon", last_name="Dev",
                    email="dev-cat@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="developer"))
    await db.commit()
    return await make_login(db, client, person, "dev-cat@test.example.com")


async def test_staff_cannot_mutate_categories(client, seeded_user):
    hdrs = await login(client)      # staff: asset_models view, no devtools
    assert (await client.post("/asset-categories", headers=hdrs, json={
        "key": "cooling", "label": "Cooling", "color": "#1668a7",
    })).status_code == 403
    assert (await client.patch("/asset-categories/server", headers=hdrs,
                               json={"label": "Compute"})).status_code == 403


async def test_developer_creates_edits_with_audit(client, db, seeded_user,
                                                  dev_hdrs):
    created = await client.post("/asset-categories", headers=dev_hdrs, json={
        "key": "cooling", "label": "Cooling", "description": "CRACs, chillers.",
        "sort_order": 6, "color": "#1668A7",
    })
    assert created.status_code == 201, created.text
    assert created.json()["color"] == "#1668a7"     # normalized lowercase

    dup = await client.post("/asset-categories", headers=dev_hdrs, json={
        "key": "cooling", "label": "Again", "color": "#1668a7"})
    assert dup.status_code == 409
    assert dup.json()["detail"]["code"] == "asset_category_exists"

    patched = await client.patch("/asset-categories/cooling", headers=dev_hdrs,
                                 json={"label": "Cooling & HVAC"})
    assert patched.status_code == 200
    assert patched.json()["label"] == "Cooling & HVAC"

    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "asset_category"))).all()
    actions = {r.action for r in rows}
    assert actions == {"create", "update"}
    upd = next(r for r in rows if r.action == "update")
    assert upd.changes["label"]["to"] == "Cooling & HVAC"


async def test_explicit_null_rejected_and_unknown_404(client, dev_hdrs):
    resp = await client.patch("/asset-categories/server", headers=dev_hdrs,
                              json={"label": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "label_required"

    resp = await client.patch("/asset-categories/nope", headers=dev_hdrs,
                              json={"label": "X"})
    assert resp.status_code == 404
