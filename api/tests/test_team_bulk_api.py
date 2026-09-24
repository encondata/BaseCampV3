"""Bulk assign people endpoints: gates, formats, preview, commit."""
import io

import openpyxl
import pytest
from sqlalchemy import func, select

from serversherpa.db.models import Initiative, InitiativePerson, Person, PersonRole
from serversherpa.people import team_bulk as tb
from tests.test_sites_api import login, make_login
from tests.test_team_bulk_service import mk_job, mk_site, mk_worker


@pytest.fixture
async def admin_hdrs(db, client):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, "ada@test.example.com")


def base(job):
    return f"/initiatives/{job.id}/people/bulk"


async def test_staff_forbidden_on_all_four(client, db, seeded_user):
    job = await mk_job(db)
    hdrs = await login(client)
    assert (await client.get(f"{base(job)}/template?format=csv", headers=hdrs)).status_code == 403
    assert (await client.get(f"{base(job)}/export?format=csv", headers=hdrs)).status_code == 403
    assert (await client.post(f"{base(job)}/preview", headers=hdrs,
                              json={"rows": [{"worker": "X"}]})).status_code == 403
    assert (await client.post(f"{base(job)}/commit", headers=hdrs,
                              json={"rows": [{"worker": "X"}]})).status_code == 403


async def test_unknown_and_archived_job(client, db, seeded_user, admin_hdrs):
    missing = "00000000-0000-0000-0000-000000000000"
    resp = await client.post(f"/initiatives/{missing}/people/bulk/preview", headers=admin_hdrs,
                             json={"rows": [{"worker": "X"}]})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "initiative_not_found"
    archived = await mk_job(db, "Old", archived=True)
    resp = await client.post(f"{base(archived)}/preview", headers=admin_hdrs,
                             json={"rows": [{"worker": "X"}]})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "initiative_archived"


async def test_template_and_export_formats(client, db, seeded_user, admin_hdrs):
    job = await mk_job(db)
    await mk_site(db, "DC East")
    await mk_worker(db, "Ana", "Lopez")
    csv_resp = await client.get(f"{base(job)}/template?format=csv", headers=admin_hdrs)
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-disposition"] == 'attachment; filename="team-template.csv"'
    assert csv_resp.text.splitlines()[0] == "worker,site,role"
    xlsx = await client.get(f"{base(job)}/template?format=xlsx", headers=admin_hdrs)
    wb = openpyxl.load_workbook(io.BytesIO(xlsx.content))
    assert wb.sheetnames == ["Team", "Reference"]
    ref_values = [c.value for c in wb["Reference"]["A"] if c.value]
    assert "Workers" in ref_values and "Ana Lopez" in ref_values and "DC East" in ref_values
    assert "Lead" in ref_values
    exp = await client.get(f"{base(job)}/export?format=csv", headers=admin_hdrs)
    assert exp.status_code == 200 and exp.text.splitlines() == ["worker,site,role"]
    bad = await client.get(f"{base(job)}/template?format=pdf", headers=admin_hdrs)
    assert bad.status_code == 422


async def test_file_preview_then_json_commit_with_override(client, db, seeded_user, admin_hdrs):
    job = await mk_job(db)
    ana = await mk_worker(db, "Ana", "Lopez")
    csv = "worker,site,role\nAnna Lopes,,lead\nBen Nobody,,\n"
    resp = await client.post(f"{base(job)}/preview", headers=admin_hdrs,
                             files={"file": ("team.csv", csv.encode(), "text/csv")})
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert [r["row"] for r in rows] == [2, 3]
    assert [r["action"] for r in rows] == ["attention", "attention"]
    body = {"rows": [r["cells"] for r in rows], "row_numbers": [2, 3],
            "overrides": {"2": {"worker": str(ana.id)}}, "skip": [3]}
    again = await client.post(f"{base(job)}/preview", headers=admin_hdrs, json=body)
    assert [r["action"] for r in again.json()["rows"]] == ["add", "skipped"]
    assert again.json()["can_commit"] is True
    done = await client.post(f"{base(job)}/commit", headers=admin_hdrs,
                             json={**body, "approved_updates": [], "source": "team.csv"})
    assert done.status_code == 200, done.text
    out = done.json()
    assert (out["created"], out["skipped"]) == (1, 1)
    assert [r["row"] for r in out["rows"]] == [2, 3]
    assert await db.scalar(select(func.count()).select_from(InitiativePerson)) == 1


async def test_commit_unresolved_is_422_rows_invalid(client, db, seeded_user, admin_hdrs):
    job = await mk_job(db)
    resp = await client.post(f"{base(job)}/commit", headers=admin_hdrs,
                             json={"rows": [{"worker": "Nobody"}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "rows_invalid"


async def test_bad_bodies_are_422(client, db, seeded_user, admin_hdrs):
    job = await mk_job(db)
    for body, code in (
        ({"rows": [{"worker": "X"}], "row_numbers": [1, 2]}, "invalid_row_numbers"),
        ({"rows": [{"worker": "X"}], "overrides": {"1": {"bogus": "x"}}}, "invalid_overrides"),
        ({"rows": [{"worker": "X"}], "skip": "all"}, "invalid_skip"),
        ({"rows": [{"nope": "X"}]}, "unknown_columns"),
    ):
        resp = await client.post(f"{base(job)}/preview", headers=admin_hdrs, json=body)
        assert resp.status_code == 422 and resp.json()["detail"]["code"] == code, body
