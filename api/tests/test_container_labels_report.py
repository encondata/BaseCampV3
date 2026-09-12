"""Container Labels report module: migration 0057 (column + seed + single
head), run-option validation, gather() (order + container-must-belong-to-
this-initiative), build()'s exact payload to the Node renderer, the
renderer subprocess bridge itself (mirrors test_rack_renderer.py), and a
true end-to-end worker run (registry -> build -> renderer -> storage ->
attachment), not the FakeModule test_report_worker.py otherwise uses."""

import importlib.util
import json
import re
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select, text

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Attachment, Container, Initiative, Person, ReportDefinition, ReportRun, Site,
)
from serversherpa.reports import container_label_renderer, container_labels, worker
from serversherpa.reports.container_label_renderer import ContainerLabelRendererUnavailable
from serversherpa.reports.container_labels.gather import gather
from serversherpa.reports.move_report.gather import InitiativeUnavailable
from serversherpa.reports.registry import OptionsError
from serversherpa.services.storage import get_object

API_DIR = Path(__file__).resolve().parents[1]
MIGRATION_PATH = API_DIR / "migrations" / "versions" / "0057_container_labels.py"


def _load_migration_0057():
    spec = importlib.util.spec_from_file_location("_migration_0057_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── migration: column + index + seed + single head ───────────────────

def test_migration_module_matches_the_report_module():
    migration = _load_migration_0057()
    assert migration.REPORT_TYPE == container_labels.report_type == "container_labels"
    assert json.loads(migration.DEFAULT_OPTIONS) == container_labels.default_options() == {}


async def test_containers_gained_the_initiative_column_and_index(db):
    cols = (await db.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'containers' AND column_name = 'initiative_id'"))).all()
    assert len(cols) == 1
    idx = (await db.execute(text(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'containers' "
        "AND indexname = 'containers_initiative_idx'"))).all()
    assert len(idx) == 1


async def test_migration_insert_sql_seeds_and_is_idempotent(db):
    """Executes the migration's own INSERT_DEFINITION_SQL constant (the
    exact statement upgrade() runs) directly against the (freshly
    truncated — clean_db wipes data, not schema) report_definitions
    table, the same way test_site_move_survey_fixtures.py proves 0052's
    own constant — a row in report_definitions never survives to the
    next test, so it must be re-seeded here rather than looked up."""
    migration = _load_migration_0057()
    params = {"name": migration.DEFINITION_NAME, "description": migration.DEFINITION_DESCRIPTION,
              "report_type": migration.REPORT_TYPE, "options": migration.DEFAULT_OPTIONS}
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)   # idempotent
    await db.commit()

    rows = (await db.execute(text(
        "SELECT report_type, options, is_system, description FROM report_definitions "
        "WHERE name = :name"), {"name": migration.DEFINITION_NAME})).all()
    assert len(rows) == 1, "ON CONFLICT should have prevented a duplicate row"
    report_type, options, is_system, description = rows[0]
    assert report_type == "container_labels" and is_system is True
    assert options == json.loads(migration.DEFAULT_OPTIONS) == {}
    assert "Avery 5164" in description


def test_alembic_single_head_and_container_migrations_in_history():
    """One head only (a competing migration shows two) and both container
    migrations are in the chain. Not pinned to a head number — every later
    migration would otherwise have to edit this test."""
    result = subprocess.run(
        [str(API_DIR / ".venv/bin/alembic"), "heads"],
        cwd=API_DIR, capture_output=True, text=True, check=True)
    heads = [line for line in result.stdout.splitlines() if line.strip()]
    assert len(heads) == 1, f"expected a single alembic head, got: {heads}"
    history = subprocess.run(
        [str(API_DIR / ".venv/bin/alembic"), "history"],
        cwd=API_DIR, capture_output=True, text=True, check=True).stdout
    assert "-> 0057" in history and "-> 0058" in history


# ── validate_options / validate_run_options ───────────────────────────

def test_default_and_definition_options_are_empty():
    assert container_labels.default_options() == {}
    assert container_labels.validate_options({}) == {}


def test_validate_options_rejects_any_key():
    with pytest.raises(OptionsError):
        container_labels.validate_options({"bogus": 1})


def test_validate_run_options_happy_path_with_tags():
    cid = str(uuid.uuid4())
    assert container_labels.validate_run_options(
        {"container_ids": [cid], "tags": {cid: "priority"}}
    ) == {"container_ids": [cid], "tags": {cid: "priority"}}


def test_validate_run_options_defaults_missing_tags_to_empty():
    cid = str(uuid.uuid4())
    assert container_labels.validate_run_options({"container_ids": [cid]}) == {
        "container_ids": [cid], "tags": {}}


def test_validate_run_options_rejects_unknown_key():
    with pytest.raises(OptionsError):
        container_labels.validate_run_options(
            {"container_ids": [str(uuid.uuid4())], "bogus": 1})


def test_validate_run_options_requires_nonempty_container_ids():
    with pytest.raises(OptionsError):
        container_labels.validate_run_options({})
    with pytest.raises(OptionsError):
        container_labels.validate_run_options({"container_ids": []})
    with pytest.raises(OptionsError):
        container_labels.validate_run_options({"container_ids": "not-a-list"})


def test_validate_run_options_rejects_non_uuid_container_ids():
    with pytest.raises(OptionsError):
        container_labels.validate_run_options({"container_ids": ["not-a-uuid"]})


def test_validate_run_options_rejects_bad_tag_value():
    cid = str(uuid.uuid4())
    with pytest.raises(OptionsError):
        container_labels.validate_run_options(
            {"container_ids": [cid], "tags": {cid: "nope"}})


def test_validate_run_options_rejects_non_uuid_tag_key():
    cid = str(uuid.uuid4())
    with pytest.raises(OptionsError):
        container_labels.validate_run_options(
            {"container_ids": [cid], "tags": {"not-a-uuid": "priority"}})


def test_validate_run_options_accepts_explicit_null_tag():
    cid = str(uuid.uuid4())
    assert container_labels.validate_run_options(
        {"container_ids": [cid], "tags": {cid: None}}
    ) == {"container_ids": [cid], "tags": {cid: None}}


def test_validate_run_options_rejects_a_tag_for_a_container_not_in_the_run():
    cid = str(uuid.uuid4())
    stray = str(uuid.uuid4())
    with pytest.raises(OptionsError) as exc_info:
        container_labels.validate_run_options(
            {"container_ids": [cid], "tags": {stray: "priority"}})
    assert exc_info.value.problems == [f"tag_for_unknown_container:{stray}"]


def test_validate_run_options_canonicalizes_uppercase_ids_and_tag_keys():
    cid = uuid.uuid4()
    # The portal, the DB, and this module all agree on str(uuid.UUID(...))'s
    # lowercase-hyphenated form — an upper-cased id must still match so
    # build()'s `tags.get(c.id)` lookup doesn't silently drop the tag.
    result = container_labels.validate_run_options(
        {"container_ids": [str(cid).upper()], "tags": {str(cid).upper(): "vendor"}})
    assert result == {"container_ids": [str(cid)], "tags": {str(cid): "vendor"}}


# ── gather() ───────────────────────────────────────────────────────

async def test_gather_returns_move_fields_and_containers_in_given_order(db):
    src = Site(name="DC-A")
    dst = Site(name="DC-B")
    db.add_all([src, dst])
    await db.flush()
    ini = Initiative(name="NAP11", initiative_type="move", status="planned",
                     origin_site_id=src.id, destination_site_id=dst.id,
                     scheduled_start=datetime(2026, 9, 20, 8, 0, tzinfo=UTC))
    db.add(ini)
    await db.flush()
    c1 = Container(name="Crate A", initiative_id=ini.id)
    c2 = Container(name="Crate B", initiative_id=ini.id)
    db.add_all([c1, c2])
    await db.commit()

    data = await gather(db, ini.id, [c2.id, c1.id])    # deliberately reversed
    assert data.initiative_id == str(ini.id)
    assert data.initiative_name == "NAP11"
    assert data.origin_site_name == "DC-A" and data.destination_site_name == "DC-B"
    assert data.scheduled_start == datetime(2026, 9, 20, 8, 0, tzinfo=UTC)
    assert [c.id for c in data.containers] == [str(c2.id), str(c1.id)]
    assert [c.name for c in data.containers] == ["Crate B", "Crate A"]


async def test_gather_handles_unscheduled_move_with_no_sites(db):
    ini = Initiative(name="Ad Hoc", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    c1 = Container(name="Only Crate", initiative_id=ini.id)
    db.add(c1)
    await db.commit()

    data = await gather(db, ini.id, [c1.id])
    assert data.scheduled_start is None
    assert data.origin_site_name is None and data.destination_site_name is None


async def test_gather_rejects_missing_or_archived_initiative(db):
    with pytest.raises(InitiativeUnavailable):
        await gather(db, uuid.uuid4(), [])
    ini = Initiative(name="Old", initiative_type="move", status="completed",
                     archived_at=datetime.now(UTC))
    db.add(ini)
    await db.commit()
    with pytest.raises(InitiativeUnavailable):
        await gather(db, ini.id, [])


async def test_gather_rejects_containers_not_on_this_initiative(db):
    ini1 = Initiative(name="NAP11", initiative_type="move", status="planned")
    ini2 = Initiative(name="NAP12", initiative_type="move", status="planned")
    db.add_all([ini1, ini2])
    await db.flush()
    on_other = Container(name="Elsewhere", initiative_id=ini2.id)
    unlinked = Container(name="Unlinked")
    db.add_all([on_other, unlinked])
    await db.commit()

    with pytest.raises(OptionsError) as exc_info:
        await gather(db, ini1.id, [on_other.id])
    assert exc_info.value.problems == [f"container_not_on_initiative:{on_other.id}"]

    with pytest.raises(OptionsError) as exc_info:
        await gather(db, ini1.id, [unlinked.id])
    assert exc_info.value.problems == [f"container_not_on_initiative:{unlinked.id}"]

    missing_id = uuid.uuid4()
    with pytest.raises(OptionsError) as exc_info:
        await gather(db, ini1.id, [missing_id])
    assert exc_info.value.problems == [f"container_not_on_initiative:{missing_id}"]


# ── build() ────────────────────────────────────────────────────────

async def _seed_run(db, *, container_ids, tags):
    person = Person(first_name="Rae", last_name="Requester")
    definition = ReportDefinition(name=f"Container Labels {uuid.uuid4()}",
                                  report_type="container_labels", options={},
                                  is_system=True)
    ini = Initiative(name="NAP11", initiative_type="move", status="planned")
    db.add_all([person, definition, ini])
    await db.flush()
    run = ReportRun(definition_id=definition.id, report_type="container_labels",
                    initiative_id=ini.id,
                    options={"container_ids": container_ids, "tags": tags},
                    requested_by=person.id, requested_rank=0)
    db.add(run)
    await db.commit()
    return run, ini, person


async def test_build_sends_the_expected_payload_and_returns_the_pdf(db, monkeypatch):
    src = Site(name="DC-A")
    dst = Site(name="DC-B")
    db.add_all([src, dst])
    await db.flush()
    ini = Initiative(name="NAP11", initiative_type="move", status="planned",
                     origin_site_id=src.id, destination_site_id=dst.id,
                     scheduled_start=datetime(2026, 9, 20, 8, 0, tzinfo=UTC))
    db.add(ini)
    await db.flush()
    c1 = Container(name="Crate A", initiative_id=ini.id)
    c2 = Container(name="Crate B", initiative_id=ini.id)
    db.add_all([c1, c2])
    person = Person(first_name="Rae", last_name="Requester")
    definition = ReportDefinition(name="Container Labels", report_type="container_labels",
                                  options={}, is_system=True)
    db.add_all([person, definition])
    await db.flush()
    run = ReportRun(
        definition_id=definition.id, report_type="container_labels", initiative_id=ini.id,
        options={"container_ids": [str(c1.id), str(c2.id)],
                "tags": {str(c1.id): "priority"}},
        requested_by=person.id, requested_rank=0)
    db.add(run)
    await db.commit()

    captured = {}

    async def fake_render(payload):
        captured["payload"] = payload
        return b"%PDF-1.4 fake"

    monkeypatch.setattr(container_label_renderer, "render", fake_render)

    result = await container_labels.build(db, run)

    payload = captured["payload"]
    assert payload["move"] == {
        "id": str(ini.id), "name": "NAP11", "sourceSite": "DC-A", "destSite": "DC-B",
        "scheduledStart": "2026-09-20T08:00:00+00:00",
    }
    assert payload["containers"] == [
        {"id": str(c1.id), "name": "Crate A", "tag": "priority"},
        {"id": str(c2.id), "name": "Crate B", "tag": None},
    ]
    assert payload["tag_image_dir"].endswith("portal/public/images")

    assert result.content == b"%PDF-1.4 fake"
    assert result.content_type == "application/pdf"
    assert result.filename.startswith("Container Labels - NAP11 - ")
    assert result.filename.endswith(".pdf")


async def test_build_requires_an_initiative(db):
    person = Person(first_name="Rae", last_name="Requester")
    definition = ReportDefinition(name="Container Labels 2", report_type="container_labels",
                                  options={}, is_system=True)
    db.add_all([person, definition])
    await db.flush()
    run = ReportRun(definition_id=definition.id, report_type="container_labels",
                    initiative_id=None, options={"container_ids": [str(uuid.uuid4())]},
                    requested_by=person.id, requested_rank=0)
    db.add(run)
    await db.commit()
    with pytest.raises(InitiativeUnavailable):
        await container_labels.build(db, run)


async def test_build_surfaces_run_option_errors(db):
    run, _ini, _person = await _seed_run(db, container_ids=["not-a-uuid"], tags={})
    with pytest.raises(OptionsError):
        await container_labels.build(db, run)


async def test_build_surfaces_container_not_on_initiative(db):
    other_ini = Initiative(name="NAP12", initiative_type="move", status="planned")
    db.add(other_ini)
    await db.flush()
    stray = Container(name="Stray", initiative_id=other_ini.id)
    db.add(stray)
    await db.commit()
    run, _ini, _person = await _seed_run(db, container_ids=[str(stray.id)], tags={})
    with pytest.raises(OptionsError) as exc_info:
        await container_labels.build(db, run)
    assert exc_info.value.problems == [f"container_not_on_initiative:{stray.id}"]


# ── container_label_renderer: the Node subprocess bridge ─────────────

OK_SCRIPT = (
    "import sys, json, base64; "
    "d = json.load(sys.stdin); "
    "out = ('%PDF-1.4 ' + d['move']['name']).encode(); "
    "sys.stdout.write(base64.b64encode(out).decode())"
)


def _script(tmp_path, body: str) -> str:
    p = tmp_path / "render-container-labels.js"
    p.write_text(body)
    return str(p)


@pytest.fixture
def python_as_node(monkeypatch):
    """Run the 'script' with python instead of node so the test needs no
    Node toolchain — same shim as test_rack_renderer.py."""
    shim = ("import sys, runpy; sys.argv = sys.argv[1:]; "
            "exec(open(sys.argv[0]).read())")
    monkeypatch.setattr(container_label_renderer, "_command",
                        lambda script: [sys.executable, "-c", shim, script])


async def test_render_pipes_json_and_decodes_base64_pdf(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(container_label_renderer, "_script_path",
                        lambda: _script(tmp_path, OK_SCRIPT))
    out = await container_label_renderer.render(
        {"move": {"name": "NAP11"}, "containers": [], "tag_image_dir": "/x"})
    assert out == b"%PDF-1.4 NAP11"


async def test_missing_bundle_is_unavailable(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(container_label_renderer, "_script_path",
                        lambda: str(tmp_path / "nope.js"))
    with pytest.raises(ContainerLabelRendererUnavailable, match="not found"):
        await container_label_renderer.render({})


async def test_nonzero_exit_surfaces_stderr(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(
        container_label_renderer, "_script_path",
        lambda: _script(tmp_path, "import sys; sys.stderr.write('kaboom'); sys.exit(2)"))
    with pytest.raises(ContainerLabelRendererUnavailable, match="kaboom"):
        await container_label_renderer.render({})


async def test_timeout_is_unavailable(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(container_label_renderer, "_script_path",
                        lambda: _script(tmp_path, "import time; time.sleep(5)"))
    monkeypatch.setattr(container_label_renderer,
                        "CONTAINER_LABEL_RENDER_TIMEOUT_SECONDS", 0.2)
    with pytest.raises(ContainerLabelRendererUnavailable, match="timed out"):
        await container_label_renderer.render({})


async def test_bad_base64_output_is_unavailable(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(
        container_label_renderer, "_script_path",
        lambda: _script(tmp_path, "import sys; sys.stdout.write('not base64 !!!')"))
    with pytest.raises(ContainerLabelRendererUnavailable, match="invalid renderer output"):
        await container_label_renderer.render({})


async def test_empty_stdout_is_unavailable(tmp_path, monkeypatch, python_as_node):
    """An exit-0 script that prints nothing used to decode to b'' (valid,
    empty base64 under the old `validate=False` decode) and ship as a
    0-byte 'PDF' the worker would happily store and attach. `render()`
    must refuse anything that doesn't actually start with %PDF."""
    monkeypatch.setattr(container_label_renderer, "_script_path",
                        lambda: _script(tmp_path, "pass"))
    with pytest.raises(ContainerLabelRendererUnavailable, match="no PDF"):
        await container_label_renderer.render({})


async def test_non_pdf_output_is_unavailable(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(
        container_label_renderer, "_script_path",
        lambda: _script(tmp_path,
                        "import sys, base64; "
                        "sys.stdout.write(base64.b64encode(b'hello world').decode())"))
    with pytest.raises(ContainerLabelRendererUnavailable, match="no PDF"):
        await container_label_renderer.render({})


TZ_PROBE_SCRIPT = (
    "import sys, os, base64; "
    "out = ('%PDF-1.4 TZ=' + os.environ.get('TZ', '<unset>')).encode(); "
    "sys.stdout.write(base64.b64encode(out).decode())"
)


async def test_render_sets_tz_to_the_report_timezone(tmp_path, monkeypatch, python_as_node):
    """The Node side prints `toLocaleDateString()` in the *process* time
    zone — without a fixed TZ, a worker in a UTC container prints a
    different date than a browser in the company zone. This proves the
    subprocess env carries TZ=America/New_York (services.timezone's
    report_timezone()), independent of whatever the host's own TZ is."""
    monkeypatch.setattr(container_label_renderer, "_script_path",
                        lambda: _script(tmp_path, TZ_PROBE_SCRIPT))
    out = await container_label_renderer.render({"move": {"name": "x"}})
    assert out == b"%PDF-1.4 TZ=America/New_York"


def test_tag_image_dir_ends_with_portal_public_images():
    assert container_label_renderer.tag_image_dir().endswith("portal/public/images")


@pytest.mark.skipif(
    not Path(container_label_renderer._script_path()).exists(),
    reason="dist-node bundle not built (run `npm run build:container-labels` in portal/)")
async def test_real_bundle_renders_two_pages_with_a_tag_image():
    """Guards against a payload-contract drift between this module and
    the real portal/dist-node/render-container-labels.js (Task 2) that
    the python-as-node shim tests above can't catch — skipped when the
    bundle isn't built (e.g. a fresh checkout without `npm run build`)."""
    payload = {
        "move": {"id": "ini-1", "name": "NAP11", "sourceSite": "DC-A",
                 "destSite": "DC-B", "scheduledStart": "2026-09-20T08:00:00+00:00"},
        "containers": [
            {"id": "c1", "name": "Crate A", "tag": "priority"},
            {"id": "c2", "name": "Crate B", "tag": None},
        ],
        "tag_image_dir": container_label_renderer.tag_image_dir(),
    }
    content = await container_label_renderer.render(payload)
    assert content.startswith(b"%PDF")
    # "/Type /Page" also matches the "/Type /Pages" tree root — excluded
    # with a negative lookahead so only leaf page objects are counted.
    pages = re.findall(rb"/Type\s*/Page(?!s)\b", content)
    assert len(pages) == 2


# ── worker: real end-to-end, not FakeModule ───────────────────────────

async def test_worker_runs_container_labels_end_to_end(db, monkeypatch):
    """Unlike test_report_worker.py's own tests (which fake the module
    entirely), this goes through the real registry entry — get_module
    -> container_labels.build -> gather -> the renderer — with only the
    Node subprocess itself faked, proving the whole chain is wired up."""
    ini = Initiative(name="NAP11", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    c1 = Container(name="Crate A", initiative_id=ini.id)
    c2 = Container(name="Crate B", initiative_id=ini.id)
    person = Person(first_name="Rae", last_name="Requester")
    # clean_db truncates report_definitions before every test — the
    # migration's seeded row never survives to here, so a definition is
    # (re-)created inline, same as test_report_worker.py's own _run().
    d = ReportDefinition(name="Container Labels", report_type="container_labels",
                        options={}, is_system=True)
    db.add_all([c1, c2, person, d])
    await db.flush()
    run = ReportRun(definition_id=d.id, report_type="container_labels",
                    initiative_id=ini.id,
                    options={"container_ids": [str(c1.id), str(c2.id)],
                            "tags": {str(c1.id): "vendor"}},
                    requested_by=person.id, requested_rank=40, notify=False,
                    status="queued")
    db.add(run)
    await db.commit()

    fake_pdf = b"%PDF-1.4 fake container labels"

    async def fake_render(payload):
        return fake_pdf

    monkeypatch.setattr(container_label_renderer, "render", fake_render)

    assert await worker.run_once(get_sessionmaker()) is True

    # This session's own `run` object was never expired (expire_on_commit
    # is False on this sessionmaker) and — unlike test_report_worker.py's
    # own _run() helper, which returns only the id and lets the local
    # reference die — is still held here, so db.get() would hand back the
    # stale pre-worker copy from the identity map. refresh() forces a
    # re-read of the row the worker's own (separate) session committed.
    await db.refresh(run)
    assert run.status == "completed" and run.finished_at is not None
    assert run.storage_key == f"reports/{ini.id}/{run.id}.pdf"
    assert run.filename.startswith("Container Labels - NAP11")
    assert run.size_bytes == len(fake_pdf)
    assert await get_object(run.storage_key) == fake_pdf

    att = await db.get(Attachment, run.attachment_id)
    assert (att.entity_type, str(att.entity_id), att.kind, att.content_type) == (
        "initiative", str(ini.id), "document", "application/pdf")


async def test_worker_maps_renderer_unavailable_to_a_readable_error(db, monkeypatch):
    """worker.py's bespoke branch for ContainerLabelRendererUnavailable
    (mirroring its RackRendererUnavailable one) — without it this falls
    into the generic `except Exception`, which still fails the run but
    logs a full stack trace for what is an expected, operational
    condition (missing bundle, timeout, bad output)."""
    ini = Initiative(name="NAP11", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    c1 = Container(name="Crate A", initiative_id=ini.id)
    person = Person(first_name="Rae", last_name="Requester")
    d = ReportDefinition(name="Container Labels", report_type="container_labels",
                        options={}, is_system=True)
    db.add_all([c1, person, d])
    await db.flush()
    run = ReportRun(definition_id=d.id, report_type="container_labels",
                    initiative_id=ini.id, options={"container_ids": [str(c1.id)]},
                    requested_by=person.id, requested_rank=40, notify=False,
                    status="queued")
    db.add(run)
    await db.commit()

    async def failing_render(payload):
        raise ContainerLabelRendererUnavailable("renderer script not found: x")

    monkeypatch.setattr(container_label_renderer, "render", failing_render)

    assert await worker.run_once(get_sessionmaker()) is True   # a handled failure, not a crash
    await db.refresh(run)
    assert run.status == "failed" and run.attachment_id is None
    assert run.error == "container label renderer unavailable: renderer script not found: x"
