"""Assign workers from a template: the xlsx template under /workers and the
preview/commit routes under /initiatives/{id}/people/assign."""
import io

import openpyxl
import pytest
from sqlalchemy import func, select

from serversherpa.db.models import InitiativePerson, PermissionOverride, Person, PersonRole
from serversherpa.people import assign_bulk as ab
from tests.test_assign_bulk_service import mk_job, mk_partner, mk_site, mk_worker
from tests.test_sites_api import login, make_login

TEMPLATE = "/workers/bulk-import/assign-template"


@pytest.fixture
async def admin_hdrs(db, client):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, "ada@test.example.com")


@pytest.fixture
async def setup(db, seeded_user):
    job = await mk_job(db)
    partner = await mk_partner(db, "Vend Picked")
    site = await mk_site(db, "DC East")
    return job, partner, site


def base(job):
    return f"/initiatives/{job.id}/people/assign"


def row(first="", last="", preferred="", phone="", email="", role=""):
    return {"first_name": first, "last_name": last, "preferred_name": preferred,
            "phone": phone, "email": email, "role": role}


def csv_of(*rows) -> bytes:
    lines = [",".join(ab.COLUMNS)] + [",".join(r[c] for c in ab.COLUMNS) for r in rows]
    return ("\n".join(lines) + "\n").encode()


def form(partner, site):
    return {"partner_id": str(partner.id), "site_id": str(site.id)}


def json_body(partner, site, *rows, decisions=None, row_numbers=None, **extra):
    return {"rows": list(rows), "row_numbers": row_numbers or [i + 2 for i in range(len(rows))],
            "partner_id": str(partner.id), "site_id": str(site.id),
            "decisions": decisions or {}, **extra}


async def test_template_columns_and_roles_sheet(client, db, seeded_user, admin_hdrs):
    resp = await client.get(TEMPLATE, headers=admin_hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    assert "assign" in resp.headers["content-disposition"]
    wb = openpyxl.load_workbook(io.BytesIO(resp.content))
    assert wb.sheetnames == [ab.SHEET, "Reference"]
    ws = wb[ab.SHEET]
    assert [c.value for c in ws[1]] == ab.COLUMNS
    sample = [c.value or "" for c in ws[2]]
    assert sample == ["Person", "A", "", "+1 555 555 0101", "person.a@example.com", ""]
    ref_values = [c.value for c in wb["Reference"]["A"] if c.value]
    assert ref_values[0] == "Roles" and "Tech" in ref_values


async def test_template_route_not_shadowed_by_person_id(client, db, seeded_user, admin_hdrs):
    """Declared above GET /workers/{person_id}, so the literal segment never
    hits the UUID route (which would 422)."""
    resp = await client.get(TEMPLATE, headers=admin_hdrs)
    assert resp.status_code == 200
    staff = await login(client)
    assert (await client.get(TEMPLATE, headers=staff)).status_code == 403


async def test_preview_file_then_json(client, db, setup, admin_hdrs):
    job, partner, site = setup
    await mk_worker(db, "Ana", "Lopez", email="ana@example.com")
    data = csv_of(row("Ana", "Lopez", email="ana@example.com"),
                  row("Zed", "Nobody", email="zed@example.com"))
    resp = await client.post(f"{base(job)}/preview", headers=admin_hdrs,
                             data=form(partner, site),
                             files={"file": ("crew.csv", data, "text/csv")})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert set(out) >= {"rows", "counts", "people", "roles", "can_commit"}
    assert [r["row"] for r in out["rows"]] == [2, 3]
    assert out["rows"][1]["action"] == "attention"
    assert out["can_commit"] is False
    again = await client.post(
        f"{base(job)}/preview", headers=admin_hdrs,
        json=json_body(partner, site, *[r["cells"] for r in out["rows"]],
                       decisions={"3": {"person": "new"}}))
    assert again.status_code == 200, again.text
    assert [r["action"] for r in again.json()["rows"]] == ["assign", "create"]
    assert again.json()["can_commit"] is True


async def test_preview_bad_bodies(client, db, setup, admin_hdrs):
    job, partner, site = setup
    for body, code in (
        ({**json_body(partner, site, row("A", "B")), "partner_id": "nope"}, "invalid_json"),
        ({**json_body(partner, site, row("A", "B")), "site_id": None}, "invalid_json"),
        (json_body(partner, site, row("A", "B"), decisions={"2": {"bogus": 1}}),
         "invalid_decisions"),
        (json_body(partner, site, row("A", "B"), row_numbers=[1, 2]), "invalid_row_numbers"),
    ):
        resp = await client.post(f"{base(job)}/preview", headers=admin_hdrs, json=body)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json()["detail"]["code"] == code, body
    missing = await client.post(f"{base(job)}/preview", headers=admin_hdrs,
                                data=form(partner, site),
                                files={"other": ("x.txt", b"", "text/plain")})
    assert missing.status_code == 422 and missing.json()["detail"]["code"] == "missing_file"


async def test_preview_requires_rank_and_worker_perms(client, db, setup, admin_hdrs):
    job, partner, site = setup
    body = json_body(partner, site, row("A", "B"))
    staff = await login(client)
    for path in ("preview", "commit"):
        resp = await client.post(f"{base(job)}/{path}", headers=staff, json=body)
        assert resp.status_code == 403, path
    admin = await db.scalar(select(Person).where(Person.email == "ada@test.example.com"))
    for action in ("add", "change"):
        override = PermissionOverride(person_id=admin.id, resource="workers",
                                      action=action, allow=False)
        db.add(override)
        await db.commit()
        for path in ("preview", "commit"):
            resp = await client.post(f"{base(job)}/{path}", headers=admin_hdrs, json=body)
            assert resp.status_code == 403, (action, path)
            assert resp.json()["detail"]["code"] == "forbidden"
        await db.delete(override)
        await db.commit()


async def test_archived_initiative_409(client, db, setup, admin_hdrs):
    _, partner, site = setup
    old = await mk_job(db, "Old", archived=True)
    resp = await client.post(f"{base(old)}/preview", headers=admin_hdrs,
                             json=json_body(partner, site, row("A", "B")))
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "initiative_archived"


async def test_archived_partner_or_site_409(client, db, setup, admin_hdrs):
    job, partner, site = setup
    old_partner = await mk_partner(db, "Vend Old")
    old_partner.archived_at = func.now()
    old_site = await mk_site(db, "DC Old", archived=True)
    await db.commit()
    for p, s, code in ((old_partner, site, "partner_archived"),
                       (partner, old_site, "site_archived")):
        for path in ("preview", "commit"):
            resp = await client.post(f"{base(job)}/{path}", headers=admin_hdrs,
                                     json=json_body(p, s, row("A", "B")))
            assert resp.status_code == 409, (code, path, resp.text)
            assert resp.json()["detail"]["code"] == code


async def test_missing_partner_404(client, db, setup, admin_hdrs):
    job, partner, site = setup
    missing = "00000000-0000-0000-0000-000000000000"
    for body, code in (
        ({**json_body(partner, site, row("A", "B")), "partner_id": missing}, "partner_not_found"),
        ({**json_body(partner, site, row("A", "B")), "site_id": missing}, "site_not_found"),
    ):
        resp = await client.post(f"{base(job)}/preview", headers=admin_hdrs, json=body)
        assert resp.status_code == 404 and resp.json()["detail"]["code"] == code
    resp = await client.post(f"{base(job)}/preview", headers=admin_hdrs,
                             data={**form(partner, site), "partner_id": missing},
                             files={"file": ("crew.csv", csv_of(row("A", "B")), "text/csv")})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "partner_not_found"


async def test_commit_round_trip(client, db, setup, admin_hdrs):
    job, partner, site = setup
    ana = await mk_worker(db, "Ana", "Lopez", email="ana@example.com")
    data = csv_of(row("Ana", "Lopez", email="ana@example.com"),
                  row("Zed", "Nobody", email="zed@example.com"))
    first = await client.post(f"{base(job)}/preview", headers=admin_hdrs,
                              data=form(partner, site),
                              files={"file": ("crew.csv", data, "text/csv")})
    rows = first.json()["rows"]
    body = json_body(partner, site, *[r["cells"] for r in rows],
                     row_numbers=[r["row"] for r in rows],
                     decisions={"3": {"person": "new"}}, source="crew.csv")
    multipart = await client.post(f"{base(job)}/commit", headers=admin_hdrs,
                                  data=form(partner, site),
                                  files={"file": ("crew.csv", data, "text/csv")})
    assert multipart.status_code == 422 and multipart.json()["detail"]["code"] == "invalid_json"
    done = await client.post(f"{base(job)}/commit", headers=admin_hdrs, json=body)
    assert done.status_code == 200, done.text
    out = done.json()
    assert (out["assigned"], out["created"], out["updated"], out["already_assigned"]) == (
        1, 1, 0, 0)
    assert [r["row"] for r in out["rows"]] == [2, 3]
    assert out["rows"][0]["person_id"] == str(ana.id)
    assert await db.scalar(select(func.count()).select_from(InitiativePerson).where(
        InitiativePerson.initiative_id == job.id)) == 2
    zed = await db.scalar(select(Person).where(Person.last_name == "Nobody"))
    assert zed.source_ref == "crew.csv"


async def test_commit_rows_invalid_422(client, db, setup, admin_hdrs):
    job, partner, site = setup
    resp = await client.post(f"{base(job)}/commit", headers=admin_hdrs,
                             json=json_body(partner, site, row("Zed", "Nobody")))
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "rows_invalid"
    assert detail["rows"][0]["action"] == "attention"
    assert await db.scalar(select(func.count()).select_from(InitiativePerson)) == 0
