"""Reports API: definitions (list/clone/patch/delete + system guard) and,
from Task 3, runs (create/list/get/download/notify + the history gate)."""

import io
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import openpyxl
from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, Attachment, AuditLog, Initiative, InitiativeAsset, Partner, ProcessedScan,
    ReportDefinition, ReportRun,
)
from serversherpa.reports import worker as report_worker
from serversherpa.services.storage import get_object, put_object

from tests.test_sites_api import login
from tests.test_status_values_write import _make

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
TEMPLATE_FIXTURE = (Path(__file__).resolve().parent / "fixtures"
                   / "champagne_annotated_template.xlsx").read_bytes()

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
    resp = await client.patch(f"/reports/definitions/{other.id}", headers=admin,
                              json={"name": "   "})                    # blank after strip
    assert resp.status_code == 422 and resp.json()["detail"] == {
        "code": "invalid_options", "problems": ["name is required"]}
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
    # the write gate is reports:add, so a role without it never reaches the
    # requester check at all
    worker = await _make(db, client, "worker", "w@test.example.com")
    resp = await client.patch(f"/reports/runs/{run['id']}", headers=worker, json={"notify": True})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"
    row = await db.get(ReportRun, UUID(run["id"]))
    await db.refresh(row)
    assert row.notify is True                          # untouched by the refused writes


# ── Site & Move Survey: optional initiative + partners endpoint ──────

async def _survey_definition(db, *, options=None):
    d = ReportDefinition(name="Site & Move Survey", report_type="site_move_survey",
                         is_system=True,
                         options=options or {"company_name": "Cumulus Solutions Group",
                                            "include_transportation_standards": True,
                                            "include_site_photos": True,
                                            "condensed_assets": True})
    db.add(d)
    await db.commit()
    return d


async def _partner(db, *, name="Champagne Logistics", partner_types=("logistics",),
                   archived=False):
    from datetime import UTC, datetime

    p = Partner(name=name, partner_types=list(partner_types),
               archived_at=datetime.now(UTC) if archived else None)
    db.add(p)
    await db.commit()
    return p


async def test_survey_partners_lists_logistics_only_not_archived(client, db, seeded_user):
    """The xlsx template itself lives on the report definition (not the
    partner — templates are company-owned), so this endpoint returns
    just id/name for logistics, non-archived partners — no template
    flag."""
    champagne = await _partner(db, name="Champagne Logistics")
    zeta = await _partner(db, name="Zeta Movers")
    await _partner(db, name="Staffing Co", partner_types=["staffing"])
    await _partner(db, name="Old Logistics", archived=True)

    worker = await _make(db, client, "worker", "w@test.example.com")
    assert (await client.get("/reports/site-move-survey/partners",
                             headers=worker)).status_code == 403

    staff = await login(client)
    resp = await client.get("/reports/site-move-survey/partners", headers=staff)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [r["name"] for r in rows] == ["Champagne Logistics", "Zeta Movers"]  # sorted, no staffing/archived
    assert all(set(r.keys()) == {"id", "name"} for r in rows)
    by_id = {r["id"]: r for r in rows}
    assert by_id[str(champagne.id)]["name"] == "Champagne Logistics"
    assert by_id[str(zeta.id)]["name"] == "Zeta Movers"


async def test_create_run_without_initiative_requires_the_survey_report_type(client, db, seeded_user):
    survey_def = await _survey_definition(db)
    move_def = await _definition(db)
    partner = await _partner(db)
    hdrs = await login(client)

    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(survey_def.id), "initiative_id": None,
        "options": {"partner_id": str(partner.id)}, "notify": False})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["initiative_id"] is None and body["initiative_name"] == "—"
    assert body["report_type"] == "site_move_survey"

    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(move_def.id), "initiative_id": None,
        "options": ALL_ON, "notify": False})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "initiative_required"


async def test_create_run_inherits_the_definitions_company_name_and_toggles(client, db, seeded_user):
    """Regression: a run that never mentions `company_name` (the Generate
    modal never sends it) or every toggle must store — and build with —
    the DEFINITION's own saved values, not this module's hardcoded
    defaults. Before the fix, `validate_run_options(body.options)` alone
    normalized every missing key to the hardcoded default BEFORE it ever
    reached `_merged_run_options` in build(), permanently masking the
    definition's real `company_name`/toggles for any run created through
    this route."""
    survey_def = await _survey_definition(db, options={
        "company_name": "Acme Test Co", "include_transportation_standards": False,
        "include_site_photos": True, "condensed_assets": True})
    partner = await _partner(db)
    storage_key = f"test/sms-api/{survey_def.id}/company-regression.xlsx"
    await put_object(storage_key, TEMPLATE_FIXTURE, XLSX_MIME)
    db.add(Attachment(entity_type="report_definition", entity_id=survey_def.id,
                      kind="survey_template",
                      storage_key=storage_key, filename="template.xlsx",
                      content_type=XLSX_MIME, size_bytes=len(TEMPLATE_FIXTURE)))
    await db.commit()

    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(survey_def.id), "initiative_id": None,
        "options": {"partner_id": str(partner.id)}, "notify": False})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["options"]["company_name"] == "Acme Test Co"
    assert body["options"]["include_transportation_standards"] is False

    run = await db.get(ReportRun, UUID(body["id"]))
    assert await report_worker.run_once(get_sessionmaker()) is True
    await db.refresh(run)                 # worker commits through its own sessions
    assert run.status == "completed", run.error

    stored = await get_object(run.storage_key)
    wb = openpyxl.load_workbook(io.BytesIO(stored))
    assert wb["Customer and Site Information"]["C11"].value == "Acme Test Co"
    assert "Transportation Standards" not in wb.sheetnames


async def test_create_run_for_survey_without_partner_id_is_invalid_options(client, db, seeded_user):
    survey_def = await _survey_definition(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(survey_def.id), "initiative_id": None,
        "options": {}, "notify": False})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_options"
    assert any("partner_id" in p for p in resp.json()["detail"]["problems"])


async def test_definition_patch_accepts_company_name_string(client, db, seeded_user):
    survey_def = await _survey_definition(db)
    admin = await _make(db, client, "admin", "a@test.example.com")
    resp = await client.patch(f"/reports/definitions/{survey_def.id}", headers=admin,
                              json={"options": {"company_name": "New Customer Name"}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["options"]["company_name"] == "New Customer Name"


async def test_history_shows_standalone_run_with_dash_initiative(client, db, seeded_user):
    survey_def = await _survey_definition(db)
    partner = await _partner(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(survey_def.id), "initiative_id": None,
        "options": {"partner_id": str(partner.id)}, "notify": False})
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]

    rows = (await client.get("/reports/runs", headers=hdrs)).json()
    [row] = [r for r in rows if r["id"] == run_id]
    assert row["initiative_id"] is None
    assert row["initiative_name"] == "—"


# ── Move Scan History: preview + PDF run creation ───────────────────

async def _scan_history_definition(db, *, options=None):
    d = ReportDefinition(name="Move Scan History", report_type="move_scan_history",
                         is_system=True,
                         options=options or {"default_format": "xlsx",
                                            "status_columns": "pipeline"})
    db.add(d)
    await db.commit()
    return d


async def _scan_history_initiative_with_asset(db, *, client_id=None):
    ini = await _initiative(db, client_id=client_id)
    asset = Asset(legacy_id=8001 + (uuid4().int % 1000), serial_number="SN-8001", name="Widget")
    db.add(asset)
    await db.flush()
    db.add(InitiativeAsset(initiative_id=ini.id, asset_id=asset.id))
    db.add(ProcessedScan(
        scanned_value="EPC-8001", scan_type="rfid", scanned_at=datetime.now(UTC),
        processed_at=datetime.now(UTC), match_type="asset", asset_id=asset.id, status="complete"))
    await db.commit()
    return ini, asset


async def test_scan_history_preview_returns_shape_with_pipeline_flags_and_scanned_extra(
        client, db, seeded_user):
    ini, _asset = await _scan_history_initiative_with_asset(db)
    hdrs = await login(client)
    resp = await client.get(
        f"/reports/move-scan-history/preview?initiative_id={ini.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initiative"]["id"] == str(ini.id)
    assert body["initiative"]["name"] == ini.name
    assert body["total_assets"] == 1
    assert body["scanned_assets"] == 1
    assert body["completed"] == 1
    assert body["completion_pct"] == 100
    assert body["last_scan_at"] is not None
    statuses = body["statuses"]
    assert all({"key", "label", "color", "in_pipeline", "scan_count"} <= s.keys()
              for s in statuses)
    complete_col = next(s for s in statuses if s["key"] == "complete")
    assert complete_col["in_pipeline"] is True
    assert complete_col["scan_count"] == 1                 # the scanned extra shows up here


async def test_scan_history_preview_404s_for_unknown_and_archived_initiatives(
        client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get(
        f"/reports/move-scan-history/preview?initiative_id={uuid4()}", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "initiative_not_found"

    archived = await _initiative(db, archived=True)
    resp = await client.get(
        f"/reports/move-scan-history/preview?initiative_id={archived.id}", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "initiative_not_found"


async def test_scan_history_preview_requires_reports_view(client, db, seeded_user):
    ini = await _initiative(db)
    worker = await _make(db, client, "worker", "w@test.example.com")
    resp = await client.get(
        f"/reports/move-scan-history/preview?initiative_id={ini.id}", headers=worker)
    assert resp.status_code == 403


async def test_scan_history_run_creation_accepts_pdf_and_all_columns(client, db, seeded_user):
    d = await _scan_history_definition(db)
    ini = await _initiative(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(d.id), "initiative_id": str(ini.id),
        "options": {"format": "pdf", "status_columns": "all"}, "notify": False})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["options"] == {"format": "pdf", "status_columns": "all"}
    assert body["report_type"] == "move_scan_history"


async def test_scan_history_run_creation_rejects_unknown_format(client, db, seeded_user):
    d = await _scan_history_definition(db)
    ini = await _initiative(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(d.id), "initiative_id": str(ini.id),
        "options": {"format": "csv"}, "notify": False})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_options"
