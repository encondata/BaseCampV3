"""Bulk-import endpoints: rank gating, template formats, preview/commit flow.

seeded_user (role staff, rank 40) has sites:add but must be BELOW the bulk
rank bar; admin (60) clears it and may approve updates.
"""
import io

import openpyxl
import pytest
from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Person, PersonRole, Site
from serversherpa.sites import bulk_import as bi
from tests.test_sites_api import login, make_login


@pytest.fixture
async def admin_hdrs(db, client):
    person = Person(first_name="Ada", last_name="Admin",
                    email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, "ada@test.example.com")


@pytest.fixture
async def dev_hdrs(db, client):
    person = Person(first_name="Devon", last_name="Dev",
                    email="dev@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="developer"))
    await db.commit()
    return await make_login(db, client, person, "dev@test.example.com")


async def test_staff_rank_forbidden(client, seeded_user):
    hdrs = await login(client)      # staff: sites FULL but rank 40
    assert (await client.get(
        "/sites/bulk-import/template?format=csv", headers=hdrs)).status_code == 403
    assert (await client.post(
        "/sites/bulk-import/preview", headers=hdrs,
        json={"rows": [{"name": "X"}]})).status_code == 403
    assert (await client.post(
        "/sites/bulk-import/commit", headers=hdrs,
        json={"rows": [{"name": "X"}]})).status_code == 403


async def test_template_formats(client, db, seeded_user, admin_hdrs):
    csv_resp = await client.get("/sites/bulk-import/template?format=csv",
                                headers=admin_hdrs)
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert csv_resp.text.splitlines()[0] == ",".join(bi.COLUMNS)

    xlsx_resp = await client.get("/sites/bulk-import/template?format=xlsx",
                                 headers=admin_hdrs)
    assert xlsx_resp.status_code == 200
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_resp.content))
    assert wb.sheetnames == ["Sites", "Reference"]
    ref_cells = [row[0].value for row in wb["Reference"].iter_rows()]
    assert "datacenter" in ref_cells and "active" in ref_cells

    json_resp = await client.get("/sites/bulk-import/template?format=json",
                                 headers=admin_hdrs)
    assert json_resp.status_code == 200
    assert json_resp.json() == bi.SAMPLE_ROWS

    bad = await client.get("/sites/bulk-import/template?format=doc",
                           headers=admin_hdrs)
    assert bad.status_code == 422


async def test_export_formats(client, db, seeded_user, admin_hdrs):
    db.add(Site(name="Exported", country="US", status="active"))
    await db.commit()
    csv_resp = await client.get("/sites/bulk-import/export?format=csv", headers=admin_hdrs)
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-disposition"].endswith('filename="sites-export.csv"')
    assert "Exported" in csv_resp.text
    xlsx_resp = await client.get("/sites/bulk-import/export?format=xlsx", headers=admin_hdrs)
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_resp.content))
    assert wb.sheetnames == ["Sites", "Reference"]
    assert [c.value for c in next(wb["Sites"].iter_rows(max_row=1))] == bi.COLUMNS
    assert (await client.get("/sites/bulk-import/export?format=csv",
                             headers=await login(client))).status_code == 403
    assert (await client.get("/sites/bulk-import/export?format=pdf",
                             headers=admin_hdrs)).status_code == 422


async def test_preview_json_and_file_paths(client, seeded_user, admin_hdrs):
    rows = [{"name": "Alpha DC", "city": "Reno"}]
    via_json = await client.post("/sites/bulk-import/preview",
                                 headers=admin_hdrs, json={"rows": rows})
    assert via_json.status_code == 200, via_json.text
    assert via_json.json()["rows"][0]["action"] == "create"

    csv_bytes = b"name,city\nAlpha DC,Reno\n"
    via_file = await client.post(
        "/sites/bulk-import/preview", headers=admin_hdrs,
        files={"file": ("alpha.csv", csv_bytes, "text/csv")})
    assert via_file.status_code == 200, via_file.text
    a, b = via_json.json()["rows"][0], via_file.json()["rows"][0]
    assert a["data"] == b["data"]
    # `cells` is what the portal replays on commit: the uploaded cells, with
    # no create-only defaults filled in
    assert a["cells"] == b["cells"]
    assert a["cells"]["status"] == "" and a["data"]["status"] == "active"

    bad = await client.post(
        "/sites/bulk-import/preview", headers=admin_hdrs,
        json={"rows": [{"name": "A", "citty": "x"}]})
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "unknown_columns"


async def test_admin_previews_and_commits_updates(client, db, seeded_user, admin_hdrs):
    site = Site(name="Already Here", city="Old", country="US", status="active")
    db.add(site)
    await db.commit()
    rows = {"rows": [{"name": "Already Here", "city": "New"}]}
    body = (await client.post("/sites/bulk-import/preview",
                              headers=admin_hdrs, json=rows)).json()
    assert "update_allowed" not in body
    assert body["rows"][0]["action"] == "update"
    assert body["rows"][0]["matched_by"] == "name"
    assert body["rows"][0]["diff"]["city"] == {"old": "Old", "new": "New"}
    ok = await client.post("/sites/bulk-import/commit", headers=admin_hdrs,
                           json={**rows, "approved_updates": [str(site.id)]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["updated"] == 1


async def test_commit_end_to_end(client, db, seeded_user, admin_hdrs):
    resp = await client.post("/sites/bulk-import/commit", headers=admin_hdrs,
                             json={"rows": [{"name": "Bulk One"},
                                            {"name": "Bulk Two"}],
                                   "source": "e2e.csv"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["created"], body["updated"], body["unchanged"]) == (2, 0, 0)
    assert len(body["rows"]) == 2
    assert [r["action"] for r in body["rows"]] == ["created", "created"]
    assert all(r["site_id"] for r in body["rows"])
    count = await db.scalar(select(func.count()).select_from(Site).where(
        Site.name.in_(["Bulk One", "Bulk Two"])))
    assert count == 2


async def test_commit_atomicity_via_api(client, db, seeded_user, admin_hdrs):
    before = await db.scalar(select(func.count()).select_from(Site))
    resp = await client.post("/sites/bulk-import/commit", headers=admin_hdrs,
                             json={"rows": [{"name": "Fine"},
                                            {"name": "Broken", "type": "nope"}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "rows_invalid"
    assert len(resp.json()["detail"]["rows"]) == 2
    after = await db.scalar(select(func.count()).select_from(Site))
    assert after == before


async def test_commit_approval_flow(client, db, seeded_user, dev_hdrs):
    site = Site(name="Needs Approval", city="Old", country="US", status="active")
    db.add(site)
    await db.commit()
    rows = {"rows": [{"name": "Needs Approval", "city": "New"}]}

    denied = await client.post("/sites/bulk-import/commit",
                               headers=dev_hdrs, json=rows)
    assert denied.status_code == 422
    assert denied.json()["detail"]["code"] == "rows_invalid"

    ok = await client.post("/sites/bulk-import/commit", headers=dev_hdrs,
                           json={**rows, "approved_updates": [str(site.id)]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["updated"] == 1
    await db.refresh(site)
    assert site.city == "New"


async def test_commit_replays_uploaded_cells_and_defaults_the_source(
        client, db, seeded_user, admin_hdrs):
    """The portal posts the preview's `cells`; a blank status/country in them
    must stay blank on an existing site, and an unlabeled run reads as an
    upload in the audit trail."""
    site = Site(name="Replayed", city="Old", country="CH", status="planned")
    db.add(site)
    await db.commit()
    body = (await client.post(
        "/sites/bulk-import/preview", headers=admin_hdrs,
        json={"rows": [{"name": "Replayed", "city": "New"}]})).json()
    cells = body["rows"][0]["cells"]

    ok = await client.post("/sites/bulk-import/commit", headers=admin_hdrs,
                           json={"rows": [cells],
                                 "approved_updates": [str(site.id)]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["updated"] == 1
    await db.refresh(site)
    assert site.city == "New"
    assert site.status == "planned" and site.country == "CH"

    summary = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "site_bulk_import").order_by(
        AuditLog.at.desc()))
    assert summary.changes["source"] == "upload"
