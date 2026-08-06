"""Container bulk import — resolution, per-row errors, create-only commit."""

from sqlalchemy import select

from serversherpa.db.models import Container, Site
from serversherpa.logistics import bulk_import as bulk

from .test_assets_api import login


def _rows(*dicts):
    return [(i + 2, d) for i, d in enumerate(dicts)]  # header = row 1


async def test_preview_resolves_and_errors(db, seeded_user):
    db.add(Site(name="DC-East"))
    db.add(Container(name="Existing"))
    await db.commit()

    results = await bulk.preview_rows(db, _rows(
        {"name": "New Crate", "container_type": "Pelican case",
         "site_name": "dc-east", "status": "available"},
        {"name": "", "container_type": "cart"},
        {"name": "Bad Refs", "container_type": "hovercraft",
         "site_name": "Atlantis", "status": "nope"},
        {"name": "Existing"},
    ))
    assert [r["action"] for r in results] == [
        "create", "error", "error", "error"]
    assert results[0]["data"]["container_type"] == "pelican_case"
    assert results[0]["data"]["site_name"] == "DC-East"
    assert results[1]["errors"] == ["name_required"]
    assert set(results[2]["errors"]) == {
        "unknown_container_type", "unknown_site", "unknown_status"}
    assert results[3]["errors"] == ["duplicate_name"]


async def test_commit_creates_only_valid_rows(db, seeded_user, client):
    hdrs = await login(client)
    db.add(Site(name="DC-West"))
    await db.commit()

    resp = await client.post("/containers/bulk-import/commit", headers=hdrs,
                             json={"rows": [
                                 {"name": "Bulk-1", "site_name": "DC-West"},
                                 {"name": "Bulk-2", "status": "packed"},
                             ]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["created"] == 2
    names = {c.name for c in await db.scalars(select(Container))}
    assert {"Bulk-1", "Bulk-2"} <= names


async def test_commit_rejects_invalid_rows(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk-import/commit", headers=hdrs,
                             json={"rows": [{"name": "OK"},
                                            {"name": "", "status": "nope"}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "rows_invalid"


async def test_template_endpoint(client, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/containers/bulk-import/template?fmt=csv",
                            headers=hdrs)
    assert resp.status_code == 200
    assert resp.text.splitlines()[0] == \
        "name,container_type,rfid_tag,site_name,location_detail,status"
