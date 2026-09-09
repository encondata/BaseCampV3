"""Reports API: definitions (list/clone/patch/delete + system guard) and,
from Task 3, runs (create/list/get/download/notify + the history gate)."""

from uuid import uuid4

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, Initiative, ReportDefinition, ReportRun,
)

from tests.test_sites_api import login
from tests.test_status_values_write import _make

ALL_ON = {"summary": True, "assets_by_source": True, "assets_by_destination": True,
          "size_weight": True, "rail_usage": True, "collisions": True,
          "source_racks": True, "destination_racks": True}


async def _definition(db, *, name="Move Report", is_system=True, options=None):
    d = ReportDefinition(name=name, description="d", report_type="move_report",
                         options=options or ALL_ON, is_system=is_system)
    db.add(d)
    await db.commit()
    return d


async def _initiative(db, *, name=None, client_id=None, archived=False):
    from datetime import UTC, datetime
    ini = Initiative(name=name or f"Move {uuid4().hex[:6]}", initiative_type="move",
                     status="planned", client_id=client_id,
                     archived_at=datetime.now(UTC) if archived else None)
    db.add(ini)
    await db.commit()
    return ini


# ── definitions ────────────────────────────────────────────────────

async def test_list_definitions_requires_reports_view(client, db, seeded_user):
    await _definition(db)
    worker = await _make(db, client, "worker", "w@test.example.com")
    assert (await client.get("/reports/definitions", headers=worker)).status_code == 403
    staff = await login(client)
    resp = await client.get("/reports/definitions", headers=staff)
    assert resp.status_code == 200, resp.text
    [d] = resp.json()
    assert d["name"] == "Move Report" and d["is_system"] is True
    assert d["report_type"] == "move_report" and d["options"] == ALL_ON


async def test_clone_copies_options_and_audits(client, db, seeded_user):
    src = await _definition(db, options={**ALL_ON, "collisions": False})
    hdrs = await login(client)                      # staff has reports:add
    resp = await client.post(f"/reports/definitions/{src.id}/clone", headers=hdrs)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Move Report (copy)" and body["is_system"] is False
    assert body["options"]["collisions"] is False
    assert await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "report_definition", AuditLog.action == "clone")) is not None


async def test_patch_validates_options_and_rejects_duplicate_name(client, db, seeded_user):
    d = await _definition(db)
    other = await _definition(db, name="Other", is_system=False)
    admin = await _make(db, client, "admin", "a@test.example.com")
    resp = await client.patch(f"/reports/definitions/{d.id}", headers=admin,
                              json={"options": {"summary": False}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["options"] == {**ALL_ON, "summary": False}   # missing keys defaulted
    resp = await client.patch(f"/reports/definitions/{d.id}", headers=admin,
                              json={"options": {"bogus": True}})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_options"
    resp = await client.patch(f"/reports/definitions/{other.id}", headers=admin,
                              json={"name": "move report"})           # citext clash
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "name_in_use"
    staff = await login(client)                                        # no reports:change
    assert (await client.patch(f"/reports/definitions/{d.id}", headers=staff,
                               json={"name": "x"})).status_code == 403


async def test_delete_is_soft_and_refuses_system_rows(client, db, seeded_user):
    system = await _definition(db)
    custom = await _definition(db, name="Custom", is_system=False)
    admin = await _make(db, client, "admin", "a@test.example.com")
    resp = await client.delete(f"/reports/definitions/{system.id}", headers=admin)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "system_definition"
    assert (await client.delete(f"/reports/definitions/{custom.id}", headers=admin)).status_code == 204
    names = [d["name"] for d in (await client.get("/reports/definitions", headers=admin)).json()]
    assert names == ["Move Report"]
    await db.refresh(custom)
    assert custom.archived_at is not None


# ── runs ───────────────────────────────────────────────────────────

async def _run_payload(d, ini, **extra):
    return {"definition_id": str(d.id), "initiative_id": str(ini.id),
            "options": ALL_ON, "notify": False, **extra}


async def test_create_run_queues_with_requester_rank(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=await _run_payload(d, ini, options={"collisions": False}))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "queued" and body["report_type"] == "move_report"
    assert body["options"] == {**ALL_ON, "collisions": False}
    assert body["definition_name"] == "Move Report"
    assert body["initiative_name"] == ini.name
    assert body["requested_by_name"] == "Alice Anderson"
    run = await db.get(ReportRun, body["id"])
    assert run.requested_rank > 0                       # staff rank, captured server-side
    assert await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "report_run", AuditLog.action == "create")) is not None


async def test_create_run_rejects_bad_options_and_hidden_initiatives(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=await _run_payload(d, ini, options={"nope": True}))
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_options"
    archived = await _initiative(db, archived=True)
    resp = await client.post("/reports/runs", headers=hdrs, json=await _run_payload(d, archived))
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "initiative_not_found"
    resp = await client.post("/reports/runs", headers=hdrs,
                             json={**await _run_payload(d, ini), "definition_id": str(uuid4())})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "definition_not_found"


async def test_history_gate_hides_higher_rank_runs_but_shows_own(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    admin = await _make(db, client, "admin", "a@test.example.com")
    staff = await login(client)
    admin_run = (await client.post("/reports/runs", headers=admin,
                                   json=await _run_payload(d, ini))).json()
    staff_run = (await client.post("/reports/runs", headers=staff,
                                   json=await _run_payload(d, ini))).json()
    seen = [r["id"] for r in (await client.get("/reports/runs", headers=staff)).json()]
    assert seen == [staff_run["id"]]                    # own run yes, admin's no
    seen = [r["id"] for r in (await client.get("/reports/runs", headers=admin)).json()]
    assert seen == [staff_run["id"], admin_run["id"]]  # newest first, lower rank visible
    assert (await client.get(f"/reports/runs/{admin_run['id']}", headers=staff)).status_code == 404
    assert (await client.get(f"/reports/runs/{admin_run['id']}", headers=admin)).status_code == 200


async def test_history_list_filters_and_cursor(client, db, seeded_user):
    d = await _definition(db)
    a = await _initiative(db, name="A move")
    b = await _initiative(db, name="B move")
    hdrs = await login(client)
    for ini in (a, b, b):
        await client.post("/reports/runs", headers=hdrs, json=await _run_payload(d, ini))
    only_b = (await client.get(f"/reports/runs?initiative_id={b.id}", headers=hdrs)).json()
    assert len(only_b) == 2
    page1 = (await client.get("/reports/runs?limit=2", headers=hdrs)).json()
    assert len(page1) == 2
    page2 = (await client.get(f"/reports/runs?limit=2&before={page1[-1]['created_at']}",
                              headers=hdrs)).json()
    assert len(page2) == 1 and page2[0]["initiative_name"] == "A move"
    assert (await client.get("/reports/runs?status=completed", headers=hdrs)).json() == []


async def test_download_requires_completion_then_presigns(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    hdrs = await login(client)
    run = (await client.post("/reports/runs", headers=hdrs, json=await _run_payload(d, ini))).json()
    resp = await client.get(f"/reports/runs/{run['id']}/download", headers=hdrs)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_ready"
    row = await db.get(ReportRun, run["id"])
    row.status = "completed"
    row.storage_key = f"reports/{ini.id}/{row.id}.pdf"
    row.filename = "Move Report - X - 2026-09-09 1200.pdf"
    await db.commit()
    resp = await client.get(f"/reports/runs/{run['id']}/download", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert row.storage_key in resp.json()["url"]
    assert "Move%20Report" in resp.json()["url"]


async def test_notify_patch_is_requester_only(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    staff = await login(client)
    admin = await _make(db, client, "admin", "a@test.example.com")
    run = (await client.post("/reports/runs", headers=staff, json=await _run_payload(d, ini))).json()
    resp = await client.patch(f"/reports/runs/{run['id']}", headers=staff, json={"notify": True})
    assert resp.status_code == 200 and resp.json()["notify"] is True
    resp = await client.patch(f"/reports/runs/{run['id']}", headers=admin, json={"notify": False})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"
