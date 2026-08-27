"""Site survey rows API — write-both flow, curated/raw reads, gates."""

from serversherpa.db.models import (
    Person, PersonRole, RawSurveyEntry, Site, SiteSurveyEntry,
)

from .test_assets_api import login, make_login


async def test_put_writes_raw_and_curated(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="WB Site")
    db.add(site)
    await db.commit()

    resp = await client.put(f"/sites/{site.id}/survey/dock_available",
                            headers=hdrs, json={"value": True})
    assert resp.status_code == 200, resp.text
    row = resp.json()
    assert row["value"] is True
    assert row["label"] == "Dock available"
    assert row["updated_by_name"]  # the actor
    assert row["raw_id"] is not None

    # raw trail has exactly one portal-sourced entry pointing the same way
    raws = (await client.get(f"/sites/{site.id}/survey/raw",
                             headers=hdrs)).json()
    assert len(raws) == 1
    assert raws[0]["id"] == row["raw_id"]
    assert raws[0]["source"] == "portal"
    assert raws[0]["registered"] is True

    # second write: curated stays one row (upsert), raw grows to two
    resp = await client.put(f"/sites/{site.id}/survey/dock_available",
                            headers=hdrs, json={"value": False})
    assert resp.json()["value"] is False
    curated = (await client.get(f"/sites/{site.id}/survey",
                                headers=hdrs)).json()
    answered = [r for r in curated if r["value"] is not None]
    assert len(answered) == 1
    raws = (await client.get(f"/sites/{site.id}/survey/raw",
                             headers=hdrs)).json()
    assert len(raws) == 2
    assert raws[0]["value"] is False        # newest first


async def test_curated_list_covers_registry(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="Registry Site")
    db.add(site)
    await db.commit()
    rows = (await client.get(f"/sites/{site.id}/survey", headers=hdrs)).json()
    from serversherpa.sites.survey import SURVEY_FIELDS
    assert [r["field_key"] for r in rows] == [f.key for f in SURVEY_FIELDS]
    assert all(r["value"] is None for r in rows)   # nothing answered yet


async def test_clear_appends_null_raw_and_deletes_curated(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="Clear Site")
    db.add(site)
    await db.commit()
    await client.put(f"/sites/{site.id}/survey/floor",
                     headers=hdrs, json={"value": 3})
    resp = await client.delete(f"/sites/{site.id}/survey/floor", headers=hdrs)
    assert resp.status_code == 204
    curated = (await client.get(f"/sites/{site.id}/survey", headers=hdrs)).json()
    floor = next(r for r in curated if r["field_key"] == "floor")
    assert floor["value"] is None
    raws = (await client.get(f"/sites/{site.id}/survey/raw", headers=hdrs)).json()
    assert len(raws) == 2 and raws[0]["value"] is None

    resp = await client.delete(f"/sites/{site.id}/survey/floor", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "survey_value_not_found"


async def test_validation_errors(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="Val Site")
    db.add(site)
    await db.commit()
    resp = await client.put(f"/sites/{site.id}/survey/not_a_field",
                            headers=hdrs, json={"value": "x"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_survey_field"
    resp = await client.put(f"/sites/{site.id}/survey/dock_available",
                            headers=hdrs, json={"value": "yes"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_survey_value"
    resp = await client.put(
        "/sites/00000000-0000-0000-0000-000000000000/survey/floor",
        headers=hdrs, json={"value": 1})
    assert resp.status_code == 404


async def test_raw_shows_stray_keys(client, db, seeded_user):
    from datetime import UTC, datetime
    hdrs = await login(client)
    site = Site(name="Stray Site")
    db.add(site)
    await db.flush()
    db.add(RawSurveyEntry(site_id=site.id, field_key="legacy_custom_thing",
                          value="hello", captured_at=datetime.now(UTC),
                          source="import"))
    await db.commit()
    raws = (await client.get(f"/sites/{site.id}/survey/raw", headers=hdrs)).json()
    assert raws[0]["registered"] is False
    assert raws[0]["source"] == "import"


async def test_survey_audit_written(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="Audit Site")
    db.add(site)
    await db.commit()
    await client.put(f"/sites/{site.id}/survey/floor",
                     headers=hdrs, json={"value": 5})
    # seeded_user's default role (staff) has no `audit` grant — bump to
    # admin so the read below doesn't 403 before reaching the assertions.
    db.add(PersonRole(person_id=seeded_user.id, role="admin"))
    await db.commit()
    resp = await client.get(
        f"/audit?entity_type=site&entity_id={site.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = [r for r in resp.json() if r["action"] == "survey.update"]
    assert len(rows) == 1
    assert "floor" in rows[0]["changes"]
    assert rows[0]["changes"]["floor"]["to"] == 5


async def test_survey_gate_worker_forbidden(client, db, seeded_user):
    # worker role has no sites grant at all
    w = Person(first_name="Wk", last_name="NoSites")
    db.add(w)
    await db.flush()
    db.add(PersonRole(person_id=w.id, role="worker"))
    site = Site(name="Gate Site")
    db.add(site)
    await db.commit()
    hdrs = await make_login(db, client, w, "wk-nosites@test.example.com")

    resp = await client.get(f"/sites/{site.id}/survey", headers=hdrs)
    assert resp.status_code == 403
    resp = await client.get(f"/sites/{site.id}/survey/raw", headers=hdrs)
    assert resp.status_code == 403
    resp = await client.put(f"/sites/{site.id}/survey/floor",
                            headers=hdrs, json={"value": 1})
    assert resp.status_code == 403
    resp = await client.delete(f"/sites/{site.id}/survey/floor", headers=hdrs)
    assert resp.status_code == 403
