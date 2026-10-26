"""The learning_compliance report: registry, options, the seeded system
definition (migration 0109), gather rows, the Excel workbook and the PDF,
and the run gate (learning managers only, no initiative needed)."""
import importlib.util
import json
import uuid
from datetime import timedelta
from io import BytesIO
from pathlib import Path

import openpyxl
import pytest
from sqlalchemy import select, text

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Attachment,
    Notification,
    Person,
    PermissionOverride,
    PersonRole,
    ReportDefinition,
    ReportRun,
)
from serversherpa.reports import learning_compliance, worker
from serversherpa.reports.move_scan_history.xlsx import XLSX_MIME
from serversherpa.reports.registry import OptionsError, get_module, registry
from tests.test_learning_assign import TODAY, _doc, _initiative, _manager, _packet
from tests.test_learning_stats import _assignment, _on, _override, _people, _person, _sign
from tests.test_sites_api import make_login

MIGRATION = (Path(__file__).resolve().parents[1]
             / "migrations" / "versions" / "0109_learning_portal.py")


def _migration_module():
    spec = importlib.util.spec_from_file_location("_migration_0109", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _definition(db) -> ReportDefinition:
    migration = _migration_module()
    await db.execute(text(migration.INSERT_DEFINITION_SQL), {
        "name": migration.REPORT_DEFINITION_NAME, "description": migration.REPORT_DESCRIPTION,
        "report_type": migration.REPORT_TYPE, "options": migration.REPORT_DEFAULT_OPTIONS})
    await db.commit()
    return await db.scalar(select(ReportDefinition).where(
        ReportDefinition.report_type == "learning_compliance"))


async def _scenario(db):
    """Acme move: Ann signed (valid), Bob never signed, Cy signed a document
    that expires during the move; plus a general (no initiative) assignment."""
    dress = await _doc(db, "Dress code", validity_days=365)
    nda = await _doc(db, "Acme NDA")
    move = await _initiative(db, "Acme move", start=TODAY + timedelta(days=5),
                             end=TODAY + timedelta(days=60))
    await _packet(db, [dress, nda])
    ann, bob, cy = await _people(db, "Ann", "Bob", "Cy")
    await _on(db, move, ann, bob, cy)
    await _sign(db, ann, dress, initiative=move, days_ago=2, quiz_score=90, language="es")
    await _sign(db, ann, nda, initiative=move, days_ago=2)
    await _sign(db, cy, dress, days_ago=350)
    await _sign(db, cy, nda, initiative=move, days_ago=1)
    await _assignment(db, bob, dress, move)
    admin = await _person(db, "Ada", "Admin")
    await _override(db, bob, admin, initiative=move)
    await _override(db, bob, admin, initiative=move)
    return move, dress, nda, (ann, bob, cy)


# ── module ───────────────────────────────────────────────────────────


def test_report_type_registered_and_options():
    assert learning_compliance.report_type == "learning_compliance"
    assert registry()["learning_compliance"] is learning_compliance
    assert get_module("learning_compliance") is learning_compliance
    assert learning_compliance.default_options() == {"default_format": "xlsx"}
    assert learning_compliance.validate_options({}) == {"default_format": "xlsx"}
    assert learning_compliance.validate_options(
        {"default_format": "pdf"}) == {"default_format": "pdf"}
    for bad in ({"default_format": "csv"}, {"colour": 1}, [], None):
        with pytest.raises(OptionsError):
            learning_compliance.validate_options(bad)


def test_validate_run_options():
    ini = str(uuid.uuid4())
    assert learning_compliance.validate_run_options({}) == {}
    assert learning_compliance.validate_run_options(
        {"initiative_id": ini, "format": "pdf"}) == {"initiative_id": ini, "format": "pdf"}
    # a null or empty initiative means everyone and is dropped
    assert learning_compliance.validate_run_options(
        {"initiative_id": None, "format": "xlsx"}) == {"format": "xlsx"}
    assert learning_compliance.validate_run_options({"initiative_id": ""}) == {}
    for bad in ({"initiative_id": "nope"}, {"format": "csv"}, {"colour": 1}, "x", None):
        with pytest.raises(OptionsError):
            learning_compliance.validate_run_options(bad)


async def test_report_seed_row_present(db):
    migration = _migration_module()
    assert migration.REPORT_TYPE == "learning_compliance"
    seeded = json.loads(migration.REPORT_DEFAULT_OPTIONS)
    assert seeded == learning_compliance.default_options()
    assert learning_compliance.validate_options(seeded) == seeded

    params = {"name": migration.REPORT_DEFINITION_NAME,
              "description": migration.REPORT_DESCRIPTION,
              "report_type": migration.REPORT_TYPE, "options": migration.REPORT_DEFAULT_OPTIONS}
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)      # idempotent
    await db.commit()
    rows = (await db.execute(text(
        "SELECT report_type, options, is_system FROM report_definitions WHERE name = :n"),
        {"n": migration.REPORT_DEFINITION_NAME})).all()
    assert len(rows) == 1
    assert rows[0][0] == "learning_compliance" and rows[0][2] is True
    assert rows[0][1] == seeded
    await db.execute(text(migration.DELETE_DEFINITION_SQL),
                     {"report_type": migration.REPORT_TYPE})
    await db.commit()
    assert await db.scalar(text(
        "SELECT count(*) FROM report_definitions WHERE report_type = 'learning_compliance'")) == 0


# ── gather ───────────────────────────────────────────────────────────


async def test_gather_rows_for_an_initiative(db, seeded_user):
    move, dress, nda, (ann, bob, cy) = await _scenario(db)
    data = await learning_compliance.gather.gather(db, move.id)
    assert data.initiative_name == "Acme move"
    rows = {(r.person, r.document): r for r in data.rows}
    assert len(data.rows) == 6                          # 3 people x 2 required documents

    ann_dress = rows[("Ann W", "Dress code")]
    assert ann_dress.status == "Valid" and ann_dress.version == 1
    assert ann_dress.language == "es" and ann_dress.signed_at is not None
    assert ann_dress.expires_on is not None            # signed for the move: good to its end
    assert ann_dress.overrides == 0
    assert rows[("Cy W", "Dress code")].status == "Expires during initiative"
    assert rows[("Cy W", "Dress code")].expires_on == TODAY + timedelta(days=15)
    bob_dress = rows[("Bob W", "Dress code")]
    assert bob_dress.status == "Not signed" and bob_dress.signed_at is None
    assert bob_dress.version is None and bob_dress.overrides == 2


async def test_gather_everyone_spans_initiatives_and_general_set(db, seeded_user):
    move, dress, nda, (ann, bob, cy) = await _scenario(db)
    extra = await _doc(db, "Forklift safety")
    await _assignment(db, ann, extra, None, source="manual")          # general set
    data = await learning_compliance.gather.gather(db, None)
    assert data.initiative_name is None
    contexts = {(r.person, r.document): r.initiative for r in data.rows}
    assert contexts[("Ann W", "Dress code")] == "Acme move"
    assert contexts[("Ann W", "Forklift safety")] == "General"
    assert len(data.rows) == 7


# ── build ────────────────────────────────────────────────────────────


async def _run(db, definition, options, initiative_id=None, requester=None):
    run = ReportRun(definition_id=definition.id, report_type="learning_compliance",
                    initiative_id=initiative_id, options=options,
                    requested_by=requester.id, requested_rank=60)
    db.add(run)
    await db.commit()
    return run


def _sheet_rows(content: bytes):
    wb = openpyxl.load_workbook(BytesIO(content))
    return wb, [[c for c in row] for row in wb["Compliance"].iter_rows(values_only=True)]


async def test_report_registered_and_builds_xlsx_and_pdf(db, seeded_user):
    move, dress, nda, (ann, bob, cy) = await _scenario(db)
    definition = await _definition(db)
    requester = await db.scalar(select(Person).where(Person.email == "alice@test.example.com"))

    module = get_module("learning_compliance")
    xlsx = await module.build(db, await _run(
        db, definition, {"initiative_id": str(move.id), "format": "xlsx"}, move.id, requester))
    assert xlsx.content_type == XLSX_MIME and xlsx.filename.endswith(".xlsx")
    assert "Acme move" in xlsx.filename
    wb, rows = _sheet_rows(xlsx.content)
    header = rows[0]
    assert header[:2] == ["Person", "Document"]
    for column in ("Status", "Version signed", "Language", "Signed at", "Expires on",
                   "Overrides"):
        assert column in header
    body = [r for r in rows[1:] if r[0]]
    assert len(body) == 6
    status_col = header.index("Status")
    assert sorted({r[status_col] for r in body}) == [
        "Expires during initiative", "Not signed", "Valid"]
    assert "Summary" in wb.sheetnames

    pdf = await module.build(db, await _run(
        db, definition, {"format": "pdf"}, move.id, requester))
    assert pdf.content_type == "application/pdf" and pdf.filename.endswith(".pdf")
    assert pdf.content.startswith(b"%PDF")

    # no initiative: everyone, and the definition's default format (xlsx)
    everyone = await module.build(db, await _run(db, definition, {}, None, requester))
    assert everyone.content_type == XLSX_MIME
    assert "All initiatives" in everyone.filename
    _, rows = _sheet_rows(everyone.content)
    assert "Initiative" in rows[0]


async def test_report_cells_are_inert_text(db, seeded_user):
    """A name that starts with = must not become a formula in Excel."""
    move, dress, *_ = await _scenario(db)
    evil = Person(first_name="=HYPERLINK(1)", last_name="Evil", email="evil@test.example.com")
    db.add(evil)
    await db.commit()
    await _on(db, move, evil)
    definition = await _definition(db)
    requester = await db.scalar(select(Person).where(Person.email == "alice@test.example.com"))
    result = await learning_compliance.build(db, await _run(
        db, definition, {"format": "xlsx"}, move.id, requester))
    wb = openpyxl.load_workbook(BytesIO(result.content))
    cell = next(c for row in wb["Compliance"].iter_rows() for c in row
                if isinstance(c.value, str) and "HYPERLINK" in c.value)
    assert cell.data_type == "s"


# ── the run gate ─────────────────────────────────────────────────────


async def test_create_run_without_initiative_for_managers_only(client, db, seeded_user):
    hdrs = await _manager(db, client)
    definition = await _definition(db)
    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(definition.id), "options": {"format": "pdf"}})
    assert resp.status_code == 201, resp.text
    assert resp.json()["initiative_id"] is None
    assert resp.json()["report_type"] == "learning_compliance"

    move = await _initiative(db, "Acme move")
    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(definition.id), "initiative_id": str(move.id), "options": {}})
    assert resp.status_code == 201 and resp.json()["initiative_id"] == str(move.id)

    # the initiative may come in the options instead
    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(definition.id), "options": {"initiative_id": str(move.id)}})
    assert resp.status_code == 201 and resp.json()["initiative_id"] == str(move.id)
    resp = await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(definition.id), "initiative_id": str(move.id),
        "options": {"initiative_id": str(uuid.uuid4())}})
    assert resp.status_code == 422
    assert (await client.post("/reports/runs", headers=hdrs, json={
        "definition_id": str(definition.id),
        "options": {"initiative_id": str(uuid.uuid4())}})).status_code == 404

    # staff can run reports; take away their Learning view and the type is closed to them
    staff = await _person(db, "Sue", "Staff", "sue@test.example.com")
    db.add(PersonRole(person_id=staff.id, role="staff"))
    await db.commit()
    sue = await make_login(db, client, staff, "sue@test.example.com")
    assert (await client.post("/reports/runs", headers=sue, json={
        "definition_id": str(definition.id), "options": {}})).status_code == 201
    run_id = (await client.get("/reports/runs", headers=sue)).json()[0]["id"]
    db.add(PermissionOverride(person_id=staff.id, resource="learning", action="view",
                              allow=False))
    await db.commit()
    resp = await client.post("/reports/runs", headers=sue, json={
        "definition_id": str(definition.id), "options": {}})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "learning_view_required"
    # ...and their earlier run no longer shows in the history
    listed = (await client.get("/reports/runs", headers=sue)).json()
    assert all(r["report_type"] != "learning_compliance" for r in listed)
    assert (await client.get(f"/reports/runs/{run_id}", headers=sue)).status_code == 404


# ── the worker ───────────────────────────────────────────────────────


async def test_worker_keeps_the_file_on_the_run_and_names_everyone(db, seeded_user):
    """Files are readable with attachments:view; who signed what is for
    learning managers, so the file lives only on the run."""
    move, *_ = await _scenario(db)
    definition = await _definition(db)
    requester = await db.scalar(select(Person).where(Person.email == "alice@test.example.com"))
    for initiative_id, key_dir in ((move.id, str(move.id)), (None, "standalone")):
        run = ReportRun(definition_id=definition.id, report_type="learning_compliance",
                        initiative_id=initiative_id, options={"format": "xlsx"},
                        requested_by=requester.id, requested_rank=60, notify=True,
                        status="queued")
        db.add(run)
        await db.commit()
        run_id = run.id
        assert await worker.run_once(get_sessionmaker()) is True
        await db.refresh(run)
        assert run.status == "completed", run.error
        assert run.attachment_id is None
        assert run.storage_key == f"reports/{key_dir}/{run_id}.xlsx"
        assert run.filename.startswith("Learning compliance - ")
    assert await db.scalar(select(Attachment).where(
        Attachment.entity_type == "initiative", Attachment.entity_id == move.id)) is None
    bodies = sorted(n.body for n in await db.scalars(select(Notification)))
    assert bodies == ["Acme move", "All initiatives"]
