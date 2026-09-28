"""0080: model flags, the lookup queue, suggestions; flags round-trip the API."""
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion
from tests.test_assets_api import login


async def test_model_flags_default_false(db):
    m = AssetModel(make="HPE", model="DL320 Gen11")
    db.add(m)
    await db.commit()
    row = await db.scalar(select(AssetModel).where(AssetModel.id == m.id))
    assert row.private is False and row.spec_lookup_skip is False
    assert row.specs_looked_up_at is None


async def test_one_active_job_per_model(db):
    m = AssetModel(make="HPE", model="DL320 Gen11")
    db.add(m)
    await db.flush()
    db.add(SpecLookupJob(model_id=m.id))
    await db.commit()
    db.add(SpecLookupJob(model_id=m.id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_done_jobs_do_not_block_a_new_one(db):
    m = AssetModel(make="HPE", model="DL320 Gen11")
    db.add(m)
    await db.flush()
    db.add(SpecLookupJob(model_id=m.id, status="done"))
    db.add(SpecLookupJob(model_id=m.id))
    await db.commit()


async def test_suggestion_defaults(db):
    m = AssetModel(make="HPE", model="DL320 Gen11")
    db.add(m)
    await db.flush()
    s = SpecSuggestion(model_id=m.id, field="ru_size", value="1", quote="1U rack",
                       source_url="https://www.hpe.com/x")
    db.add(s)
    await db.commit()
    row = await db.scalar(select(SpecSuggestion).where(SpecSuggestion.id == s.id))
    assert row.status == "pending" and row.unit is None and row.previous_value is None


async def test_flags_round_trip_the_api(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/asset-models", headers=hdrs,
                             json={"make": "Acme", "model": "Secret 9000", "private": True})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["private"] is True and body["spec_lookup_skip"] is False
    assert body["specs_looked_up_at"] is None
    resp = await client.patch(f"/asset-models/{body['id']}", headers=hdrs,
                              json={"private": False, "spec_lookup_skip": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["private"] is False and resp.json()["spec_lookup_skip"] is True
