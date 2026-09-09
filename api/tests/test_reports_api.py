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
