"""Task 1 of the Site & Move Survey report: the reconstructed Champagne
fixtures and the migration 0052 framework groundwork (nullable
`report_runs.initiative_id` + the seeded system definition). The report
module itself (`reports/site_move_survey/`) lands in a later task — these
tests only cover what Task 1 delivers.

The fixture checks import the rebuild scripts' own placeholder maps (by
file path — `api/scripts/` isn't a package) rather than duplicating them,
the same way test_report_seed.py and test_migration_0013_pinning.py read
a migration's own literals instead of a second hand-typed copy: if a
placeholder cell drifts between the script and this test, one hand-typed
copy can't silently agree with the other.
"""

import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path

try:
    import defusedxml.ElementTree as ET
except ImportError:                                     # pragma: no cover
    from xml.etree import ElementTree as ET

import openpyxl
import pytest
from sqlalchemy import text

from serversherpa.db.models import Initiative, Person, ReportDefinition, ReportRun

API_DIR = Path(__file__).resolve().parents[1]
FIXTURES = API_DIR / "tests" / "fixtures"
ANNOTATED_TEMPLATE = FIXTURES / "champagne_annotated_template.xlsx"
STANDARDS_DOCX = FIXTURES / "transportation_standards.docx"

W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None, f"could not load {path}"
    module = importlib.util.module_from_spec(spec)
    # dataclasses (used by rebuild_transportation_standards.py) needs the
    # module registered in sys.modules before exec — it looks itself up via
    # sys.modules[cls.__module__] while processing @dataclass.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _rebuild_template_module():
    return _load_module(API_DIR / "scripts" / "rebuild_champagne_template.py",
                        "_rebuild_champagne_template_under_test")


def _rebuild_standards_module():
    return _load_module(API_DIR / "scripts" / "rebuild_transportation_standards.py",
                        "_rebuild_transportation_standards_under_test")


def _migration_module():
    return _load_module(API_DIR / "migrations" / "versions" / "0052_site_move_survey.py",
                        "_migration_0052_under_test")


# ── champagne_annotated_template.xlsx ───────────────────────────────

def test_annotated_template_fixture_exists():
    assert ANNOTATED_TEMPLATE.exists(), (
        "run scripts/rebuild_champagne_template.py to (re)generate this fixture")


def test_annotated_template_drops_the_transportation_standards_sheet():
    wb = openpyxl.load_workbook(ANNOTATED_TEMPLATE)
    assert not any("transport" in title.lower() for title in wb.sheetnames), wb.sheetnames


def test_annotated_template_has_every_customer_and_site_placeholder():
    script = _rebuild_template_module()
    wb = openpyxl.load_workbook(ANNOTATED_TEMPLATE)
    ws = wb[script.CUSTOMER_SHEET]
    for cell, placeholder in script.CUSTOMER_PLACEHOLDERS.items():
        assert ws[cell].value == placeholder, f"{cell} expected {placeholder!r}, got {ws[cell].value!r}"
    for cell in script.CUSTOMER_STRAY_CELLS:
        assert ws[cell].value in (None, ""), f"{cell} should have been cleared, got {ws[cell].value!r}"


def test_annotated_template_has_every_general_questions_placeholder():
    script = _rebuild_template_module()
    wb = openpyxl.load_workbook(ANNOTATED_TEMPLATE)
    ws = wb[script.QUESTIONS_SHEET]
    for cell, placeholder in script.QUESTIONS_PLACEHOLDERS.items():
        assert ws[cell].value == placeholder, f"{cell} expected {placeholder!r}, got {ws[cell].value!r}"
    # D8/D9 stay static company-default answers, not placeholders
    for cell, value in script.QUESTIONS_STATIC.items():
        assert ws[cell].value == value


def test_annotated_template_has_the_equipment_row_placeholders():
    script = _rebuild_template_module()
    wb = openpyxl.load_workbook(ANNOTATED_TEMPLATE)
    ws = wb[script.EQUIPMENT_SHEET]
    for col, placeholder in script.EQUIPMENT_PLACEHOLDERS.items():
        cell = f"{col}{script.EQUIPMENT_ROW}"
        assert ws[cell].value == placeholder, f"{cell} expected {placeholder!r}, got {ws[cell].value!r}"


def test_rebuild_template_script_is_idempotent(tmp_path):
    """Running the script again from the same generated survey reproduces
    the tracked fixture byte-for-byte in content (cell values), so it can
    truly be re-derived per the spec's "Fixtures and tooling" section."""
    script = _rebuild_template_module()
    out = tmp_path / "rebuilt.xlsx"
    script.rebuild(FIXTURES / "champagne_generated.xlsx", out)
    fresh = openpyxl.load_workbook(out)
    tracked = openpyxl.load_workbook(ANNOTATED_TEMPLATE)
    assert fresh.sheetnames == tracked.sheetnames
    for cell in script.CUSTOMER_PLACEHOLDERS:
        assert (fresh[script.CUSTOMER_SHEET][cell].value
                == tracked[script.CUSTOMER_SHEET][cell].value)


# ── transportation_standards.docx ───────────────────────────────────

def test_standards_docx_fixture_exists():
    assert STANDARDS_DOCX.exists(), (
        "run scripts/rebuild_transportation_standards.py to (re)generate this fixture")


def _document_paragraphs(docx_bytes: bytes) -> list[ET.Element]:
    zf = zipfile.ZipFile(io.BytesIO(docx_bytes))
    root = ET.fromstring(zf.read("word/document.xml"))
    return list(root.iter(f"{W_NS}p"))


def test_standards_docx_has_at_least_six_images():
    """A tiny stdlib check (not the real V2-ported parser, which lands in
    Task 3): count media parts and a:blip embed relationships directly."""
    data = STANDARDS_DOCX.read_bytes()
    zf = zipfile.ZipFile(io.BytesIO(data))
    media = [n for n in zf.namelist() if n.startswith("word/media/")]
    assert len(media) >= 6, media

    paragraphs = _document_paragraphs(data)
    a_ns = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    blips = [b for p in paragraphs for b in p.iter(f"{a_ns}blip")]
    assert len(blips) >= 6, len(blips)


def test_standards_docx_parses_to_at_least_40_paragraphs_with_text():
    data = STANDARDS_DOCX.read_bytes()
    paragraphs = _document_paragraphs(data)
    with_text = [p for p in paragraphs
                if "".join(t.text or "" for t in p.iter(f"{W_NS}t")).strip()]
    assert len(with_text) >= 40, len(with_text)


def test_standards_docx_bullets_carry_list_paragraph_and_ilvl():
    """Spot-check the docx structure the V2-ported parser (Task 3) depends
    on: ListParagraph style + w:numPr/w:ilvl for indentation levels."""
    data = STANDARDS_DOCX.read_bytes()
    paragraphs = _document_paragraphs(data)
    bullet_paragraphs = [
        p for p in paragraphs
        if (style := p.find(f"{W_NS}pPr/{W_NS}pStyle")) is not None
        and style.get(f"{W_NS}val") == "ListParagraph"
    ]
    assert len(bullet_paragraphs) >= 40, len(bullet_paragraphs)
    levels = set()
    for p in bullet_paragraphs:
        ilvl = p.find(f"{W_NS}pPr/{W_NS}numPr/{W_NS}ilvl")
        assert ilvl is not None, ET.tostring(p)
        levels.add(int(ilvl.get(f"{W_NS}val")))
    assert levels >= {0, 1, 2}, levels    # the source sheet nests at least 3 deep


def test_standards_docx_headings_are_bold_or_heading_styled():
    data = STANDARDS_DOCX.read_bytes()
    paragraphs = _document_paragraphs(data)
    heading_texts = {
        "Transportation Partner Requirements", "Device Packing Standards – See Appendix A for reference pictures",
        "Appendix A - Sample Pictures:",
    }
    found = set()
    for p in paragraphs:
        text_value = "".join(t.text or "" for t in p.iter(f"{W_NS}t")).strip()
        if text_value not in heading_texts:
            continue
        is_bold = p.find(f"{W_NS}r/{W_NS}rPr/{W_NS}b") is not None
        style = p.find(f"{W_NS}pPr/{W_NS}pStyle")
        is_heading_style = style is not None and style.get(f"{W_NS}val", "").startswith("Heading")
        assert is_bold or is_heading_style, text_value
        found.add(text_value)
    assert found == heading_texts


def test_rebuild_standards_script_extracts_expected_item_counts():
    script = _rebuild_standards_module()
    items = script.extract_items(FIXTURES / "champagne_generated.xlsx")
    kinds = {"heading": 0, "bullet": 0, "text": 0, "image": 0}
    for item in items:
        kinds["image" if not hasattr(item, "kind") else item.kind] += 1
    assert kinds["heading"] == 7
    assert kinds["image"] == 6
    assert kinds["bullet"] + kinds["text"] >= 40


# ── migration 0052 ───────────────────────────────────────────────────

def test_migration_seeds_the_expected_definition_literals():
    migration = _migration_module()
    assert migration.DEFINITION_NAME == "Site & Move Survey"
    assert migration.REPORT_TYPE == "site_move_survey"
    assert json.loads(migration.DEFAULT_OPTIONS) == {
        "company_name": "Cumulus Solutions Group",
        "include_transportation_standards": True,
        "include_site_photos": True,
        "condensed_assets": True,
    }


async def test_report_runs_initiative_id_column_is_nullable(db):
    """The column-level DDL survives clean_db's per-test TRUNCATE (schema
    isn't reset), so this checks the migration's real effect directly —
    unlike a row in report_definitions, which TRUNCATE wipes before every
    test (see test_migration_inserts_and_is_idempotent below for how that
    part is covered instead)."""
    is_nullable = await db.scalar(text(
        "SELECT is_nullable FROM information_schema.columns "
        "WHERE table_name = 'report_runs' AND column_name = 'initiative_id'"))
    assert is_nullable == "YES"


async def test_report_run_can_be_created_with_no_initiative(db):
    person = Person(first_name="Rae", last_name="Requester")
    definition = ReportDefinition(name="Site & Move Survey Test", report_type="site_move_survey",
                                  options={}, is_system=False)
    db.add_all([person, definition])
    await db.flush()
    run = ReportRun(definition_id=definition.id, report_type="site_move_survey",
                    initiative_id=None, requested_by=person.id, requested_rank=0)
    db.add(run)
    await db.commit()
    await db.refresh(run)
    assert run.initiative_id is None


async def test_migration_insert_sql_seeds_and_is_idempotent(db):
    """Executes the migration's own INSERT_DEFINITION_SQL constant (the
    exact statement upgrade() runs) directly against the (freshly
    truncated) report_definitions table — proving it is valid SQL that
    seeds the right row, and that ON CONFLICT makes re-running it (as
    happens if the migration is ever replayed against a DB that already
    has the row) a no-op rather than a duplicate-key error."""
    migration = _migration_module()
    params = {"name": migration.DEFINITION_NAME, "description": migration.DEFINITION_DESCRIPTION,
              "report_type": migration.REPORT_TYPE, "options": migration.DEFAULT_OPTIONS}
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)   # idempotent
    await db.commit()

    rows = (await db.execute(text(
        "SELECT report_type, options, is_system FROM report_definitions WHERE name = :name"),
        {"name": migration.DEFINITION_NAME})).all()
    assert len(rows) == 1, "ON CONFLICT should have prevented a duplicate row"
    report_type, options, is_system = rows[0]
    assert report_type == "site_move_survey" and is_system is True
    assert options == json.loads(migration.DEFAULT_OPTIONS)


async def test_migration_downgrade_guard_refuses_when_runs_have_no_initiative(db):
    """downgrade() must not silently restore NOT NULL over data it would
    violate — exercise the same guard clause directly against a run with a
    null initiative_id (the state Site & Move Survey leaves behind)."""
    migration = _migration_module()
    person = Person(first_name="Rae", last_name="Requester")
    definition = ReportDefinition(name="Downgrade Guard Test", report_type="site_move_survey",
                                  options={}, is_system=False)
    db.add_all([person, definition])
    await db.flush()
    db.add(ReportRun(definition_id=definition.id, report_type="site_move_survey",
                     initiative_id=None, requested_by=person.id, requested_rank=0))
    await db.commit()

    with pytest.raises(RuntimeError, match="cannot restore"):
        await db.run_sync(
            lambda session: migration.assert_no_standalone_runs(session.connection()))

    # The guard is quiet once no standalone runs remain.
    await db.execute(text("DELETE FROM report_runs WHERE initiative_id IS NULL"))
    await db.run_sync(
        lambda session: migration.assert_no_standalone_runs(session.connection()))
