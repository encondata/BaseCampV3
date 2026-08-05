from sqlalchemy import select

from serversherpa.db.models import AuditLog, Client, Site, SiteClient
from tests.test_sites_api import login


async def test_set_clients_full_replace(client, db, seeded_user):
    hdrs = await login(client)
    ca, cb = Client(name="Acme L"), Client(name="Bcme L")
    db.add_all([ca, cb])
    await db.flush()
    site = Site(name="Shared DC")
    db.add(site)
    await db.commit()

    resp = await client.put(f"/sites/{site.id}/clients", headers=hdrs,
                            json={"client_ids": [str(ca.id), str(cb.id)]})
    assert resp.status_code == 200
    assert {c["name"] for c in resp.json()["clients"]} == {"Acme L", "Bcme L"}

    # full replace: dropping one removes exactly one junction row
    resp = await client.put(f"/sites/{site.id}/clients", headers=hdrs,
                            json={"client_ids": [str(cb.id)]})
    rows = list(await db.scalars(
        select(SiteClient.client_id).where(SiteClient.site_id == site.id)))
    assert rows == [cb.id]

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "clients.set"))
    assert row is not None

    bad = await client.put(f"/sites/{site.id}/clients", headers=hdrs,
                           json={"client_ids": ["00000000-0000-0000-0000-000000000000"]})
    assert bad.status_code == 404
    assert bad.json()["detail"]["code"] == "client_not_found"


async def test_survey_save_validates_and_audits(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="Survey Site")
    db.add(site)
    await db.commit()

    resp = await client.put(f"/sites/{site.id}/survey", headers=hdrs, json={
        "survey_data": {"contact_name": " Dana ", "dock_available": True,
                        "floor": 2}})
    assert resp.status_code == 200
    assert resp.json()["survey_data"] == {"contact_name": "Dana",
                                          "dock_available": True, "floor": 2}

    bad = await client.put(f"/sites/{site.id}/survey", headers=hdrs,
                           json={"survey_data": {"nope": 1}})
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "unknown_survey_field"

    wrong = await client.put(f"/sites/{site.id}/survey", headers=hdrs,
                             json={"survey_data": {"dock_available": "yes"}})
    assert wrong.json()["detail"]["code"] == "invalid_survey_value"

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "survey.update"))
    assert row is not None and "contact_name" in row.changes


async def test_survey_clear_records_dropped_key_in_audit(client, db, seeded_user):
    """diff() only walks `after`, so a key present before and dropped now
    must be recorded explicitly as {"from": <old>, "to": None} — and must
    actually disappear from survey_data, not just linger with a null."""
    hdrs = await login(client)
    site = Site(name="Survey Clear Site")
    db.add(site)
    await db.commit()

    resp = await client.put(f"/sites/{site.id}/survey", headers=hdrs, json={
        "survey_data": {"contact_name": "Dana", "floor": 2}})
    assert resp.status_code == 200
    assert resp.json()["survey_data"] == {"contact_name": "Dana", "floor": 2}

    resp = await client.put(f"/sites/{site.id}/survey", headers=hdrs, json={
        "survey_data": {"contact_name": "Dana"}})
    assert resp.status_code == 200
    assert resp.json()["survey_data"] == {"contact_name": "Dana"}
    assert "floor" not in resp.json()["survey_data"]

    rows = (await db.scalars(
        select(AuditLog).where(AuditLog.action == "survey.update")
        .order_by(AuditLog.at))).all()
    assert len(rows) == 2
    dropped = rows[-1].changes
    assert dropped["floor"] == {"from": 2, "to": None}
    assert "contact_name" not in dropped         # unchanged field, no entry

    site_after = await db.get(Site, site.id)
    await db.refresh(site_after)
    assert site_after.survey_data == {"contact_name": "Dana"}
