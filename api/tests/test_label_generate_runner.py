"""labels/generate: engine (render_label), runner (process_run), jobs
(claim_next/requeue_stale), worker (run_once), enqueue_run, and a
migration/head smoke test.

Port of V2's process_label_generation_job (portal_routes.py) test
coverage, adapted for the deliberate V3 differences: a missing template
fails only that label type, unknown tokens land in error_summary instead
of being silently blanked, and labels live in generated_labels rather
than JSON on the roster row."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, AssetModel, GeneratedLabel, Initiative, InitiativeAsset, LabelGenerationRun,
    LabelTemplate, Notification, Person, Site,
)
from serversherpa.labels.generate import InvalidLabelTypes, RunActive, enqueue_run
from serversherpa.labels.generate.engine import render_label
from serversherpa.labels.generate.jobs import STALE_MINUTES, claim_next, requeue_stale
from serversherpa.labels.generate import runner as runner_module
from serversherpa.labels.generate import worker
from serversherpa.labels.generate.runner import process_run

# ── seeding helper ────────────────────────────────────────────────────

CODE_TEMPLATE_BODY = "{asset_id}|{asset_name}|{make_model}"


async def _seed_initiative(db, *, n_assets=3, top_template=True, destination_site=True,
                           model_name="Nexus 9336C", legacy_base=9000):
    person = Person(first_name="Rae", last_name="Requester")
    origin = Site(name="NAP7")
    db.add_all([person, origin])
    await db.flush()
    destination = None
    if destination_site:
        destination = Site(name="NAP11")
        db.add(destination)
        await db.flush()

    initiative = Initiative(
        name="NAP11 Migration", initiative_type="move", status="planned",
        origin_site_id=origin.id, destination_site_id=destination.id if destination else None,
        scheduled_start=datetime(2026, 9, 15, 18, 0, tzinfo=UTC))
    db.add(initiative)
    await db.flush()

    model = AssetModel(make="Cisco", model=model_name)
    db.add(model)
    await db.flush()

    assets = []
    for i in range(n_assets):
        asset = Asset(legacy_id=legacy_base + i, name=f"asset-{i}", serial_number=f"SN-{i}",
                      model_id=model.id)
        db.add(asset)
        assets.append(asset)
    await db.flush()
    for i, asset in enumerate(assets):
        db.add(InitiativeAsset(
            initiative_id=initiative.id, asset_id=asset.id, source_rack=f"NAP7 R{i}",
            source_ru=Decimal(str(10 + i)), destination_rack=f"NAP11 R{i}",
            destination_ru=Decimal(str(20 + i))))

    template = None
    if top_template:
        template = LabelTemplate(
            name=f"top-tpl-{uuid.uuid4()}", label_type="top", size_key="4x2", dpi_key="203",
            language_key="zpl", kind="code", code=CODE_TEMPLATE_BODY)
        db.add(template)
    await db.commit()
    return initiative, person, assets, template


def _queued_run(initiative_id, requested_by, *, label_types=("top",), notify=False,
               regenerate_existing=False):
    return LabelGenerationRun(
        initiative_id=initiative_id, label_types=list(label_types),
        regenerate_existing=regenerate_existing, requested_by=requested_by,
        notify=notify, status="running", started_at=datetime.now(UTC))


# ── engine.render_label ────────────────────────────────────────────

def _code_template(code="{asset_id} {mystery}"):
    return LabelTemplate(name="engine-code", label_type="top", size_key="4x2", dpi_key="203",
                         language_key="zpl", kind="code", code=code)


def _design_template():
    design = {"size": {"w": 4, "h": 2}, "elements": [
        {"id": "e1", "type": "text", "x": 0, "y": 0, "w": 4, "h": 1, "rotation": 0,
         "content": "{asset_id} {mystery}", "fontSizePt": 10, "align": "left"},
    ]}
    return LabelTemplate(name="engine-design", label_type="top", size_key="4x2", dpi_key="203",
                         language_key="zpl", kind="design", design=design)


SIZE_META = {"width_in": 4, "height_in": 2}
DPI_META = {"dots": 203}


def test_render_label_code_kind_substitutes_and_reports_unknown():
    code, unknown = render_label(_code_template(), {"asset_id": "10482"},
                                 size_meta=SIZE_META, dpi_meta=DPI_META, language_key="zpl")
    assert code == "10482 "
    assert unknown == {"mystery"}


def test_render_label_design_kind_compiles_and_reports_unknown():
    code, unknown = render_label(_design_template(), {"asset_id": "10482"},
                                 size_meta=SIZE_META, dpi_meta=DPI_META, language_key="zpl")
    assert "^XA" in code and "10482" in code
    assert unknown == {"mystery"}


def test_render_label_no_unknown_tokens_when_all_resolved():
    _, unknown = render_label(_code_template("{asset_id}"), {"asset_id": "10482"},
                              size_meta=SIZE_META, dpi_meta=DPI_META, language_key="zpl")
    assert unknown == set()


# ── runner.process_run ──────────────────────────────────────────────

async def test_runner_counters_across_types_incl_missing_template(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=3)
    run = _queued_run(initiative.id, person.id, label_types=["top", "rail"])
    db.add(run)
    await db.commit()

    status = await process_run(db, run, sessionmaker=get_sessionmaker())

    assert status == "completed"
    await db.refresh(run)
    assert run.total == 6 and run.processed == 6
    assert run.generated == 3          # top: 3 assets, real template
    assert run.errors == 3             # rail: 3 assets, no template
    assert run.skipped == 0
    assert run.error_summary.get("no_template:rail") == 3
    assert run.status == "completed" and run.finished_at is not None
    assert run.current_label_type is None and run.current_item is None
    rail_errors = [d for d in run.error_details if d["label_type"] == "rail"]
    assert len(rail_errors) == 3
    assert rail_errors[0]["type"] == "no_template"
    assert rail_errors[0]["message"] == "No active template for rail"

    rows = (await db.execute(select(GeneratedLabel).where(
        GeneratedLabel.label_type == "top"))).scalars().all()
    assert len(rows) == 3
    codes = sorted(r.code for r in rows)
    assert codes == ["9000|asset-0|Cisco Nexus 9336C", "9001|asset-1|Cisco Nexus 9336C",
                     "9002|asset-2|Cisco Nexus 9336C"]
    assert all(r.template_id == template.id and r.template_version == template.version
              for r in rows)
    assert all(r.initiative_id == initiative.id and r.run_id == run.id for r in rows)


async def test_runner_skips_existing_current_label_unless_regenerate(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=2)
    run = _queued_run(initiative.id, person.id, label_types=["top"])
    db.add(run)
    await db.commit()
    await process_run(db, run, sessionmaker=get_sessionmaker())
    await db.refresh(run)
    assert run.generated == 2 and run.skipped == 0

    run2 = _queued_run(initiative.id, person.id, label_types=["top"])
    db.add(run2)
    await db.commit()
    await process_run(db, run2, sessionmaker=get_sessionmaker())
    await db.refresh(run2)
    assert run2.generated == 0 and run2.skipped == 2      # nothing changed -> all skipped

    run3 = _queued_run(initiative.id, person.id, label_types=["top"],
                       regenerate_existing=True)
    db.add(run3)
    await db.commit()
    await process_run(db, run3, sessionmaker=get_sessionmaker())
    await db.refresh(run3)
    assert run3.generated == 2 and run3.skipped == 0       # regenerate forces re-render

    rows = (await db.execute(select(GeneratedLabel).where(
        GeneratedLabel.label_type == "top"))).scalars().all()
    assert len(rows) == 2                                   # upsert, not duplicate rows
    assert all(r.run_id == run3.id for r in rows)            # last run to touch them


async def test_runner_per_asset_exception_is_recorded_and_run_continues(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=3)
    boom_asset_id = assets[1].id
    real = runner_module.placeholder_values

    def flaky(row, *args, **kwargs):
        if row.asset_id == boom_asset_id:
            raise ValueError("boom")
        return real(row, *args, **kwargs)

    run = _queued_run(initiative.id, person.id, label_types=["top"])
    db.add(run)
    await db.commit()

    orig = runner_module.placeholder_values
    runner_module.placeholder_values = flaky
    try:
        status = await process_run(db, run, sessionmaker=get_sessionmaker())
    finally:
        runner_module.placeholder_values = orig

    assert status == "completed"
    await db.refresh(run)
    assert run.generated == 2 and run.errors == 1 and run.skipped == 0
    assert run.error_summary.get("ValueError") == 1
    bad = [d for d in run.error_details if d["type"] == "ValueError"]
    assert len(bad) == 1 and bad[0]["message"] == "boom" and bad[0]["label_type"] == "top"


async def test_runner_reports_unknown_tokens_without_failing_the_label(db):
    initiative, person, assets, _tpl = await _seed_initiative(db, n_assets=1, top_template=False)
    template = LabelTemplate(
        name=f"unknown-tok-{uuid.uuid4()}", label_type="top", size_key="4x2", dpi_key="203",
        language_key="zpl", kind="code", code="{asset_id} {totally_made_up}")
    db.add(template)
    await db.commit()

    run = _queued_run(initiative.id, person.id, label_types=["top"])
    db.add(run)
    await db.commit()
    status = await process_run(db, run, sessionmaker=get_sessionmaker())

    assert status == "completed"
    await db.refresh(run)
    assert run.generated == 1 and run.errors == 0             # unknown token doesn't fail it
    assert run.error_summary.get("unknown_token:totally_made_up") == 1
    row = await db.scalar(select(GeneratedLabel))
    assert row.code == "9000 "                                 # unresolved token -> ""


async def test_runner_notifies_ready_and_failed(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    run = _queued_run(initiative.id, person.id, label_types=["top"], notify=True)
    db.add(run)
    await db.commit()
    await process_run(db, run, sessionmaker=get_sessionmaker())

    note = await db.scalar(select(Notification).where(Notification.person_id == person.id))
    assert note is not None and note.kind == "labels_ready"
    assert note.link == f"/labels/generate?run={run.id}"
    assert note.payload == {"run_id": str(run.id)}
    assert note.body == "NAP11 Migration"


async def test_runner_marks_failed_on_unexpected_error_and_notifies(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    run = _queued_run(initiative.id, person.id, label_types=["top"], notify=True)
    db.add(run)
    await db.commit()
    run_id = run.id
    person_id = person.id            # process_run's failure path rolls `db` back
                                     # (see runner.py docstring), which expires
                                     # every ORM object in this session — read
                                     # plain ids out BEFORE calling it.

    async def boom_load_roster(*args, **kwargs):
        raise RuntimeError("db exploded")

    orig = runner_module._load_roster
    runner_module._load_roster = boom_load_roster
    try:
        status = await process_run(db, run, sessionmaker=get_sessionmaker())
    finally:
        runner_module._load_roster = orig

    assert status == "failed"
    async with get_sessionmaker()() as fresh:
        row = await fresh.get(LabelGenerationRun, run_id)
        assert row.status == "failed" and "db exploded" in row.error
        note = await fresh.scalar(select(Notification).where(
            Notification.person_id == person_id))
        assert note is not None and note.kind == "labels_failed"
        assert "db exploded" in note.body


async def test_runner_cancel_mid_run_via_second_session(db, monkeypatch):
    monkeypatch.setattr(runner_module, "BATCH_SIZE", 1)
    initiative, person, assets, template = await _seed_initiative(db, n_assets=5)
    run = _queued_run(initiative.id, person.id, label_types=["top"])
    db.add(run)
    await db.commit()
    run_id = run.id

    task = asyncio.create_task(process_run(db, run, sessionmaker=get_sessionmaker()))
    try:
        poller = get_sessionmaker()()
        try:
            for _ in range(200):
                await asyncio.sleep(0.02)
                processed = await poller.scalar(
                    select(LabelGenerationRun.processed).where(LabelGenerationRun.id == run_id))
                if processed and processed >= 1:
                    break
            assert processed and processed >= 1, "runner never reached its first batch commit"
            await poller.execute(
                text("UPDATE label_generation_runs SET cancel_requested = true WHERE id = :id"),
                {"id": run_id})
            await poller.commit()
        finally:
            await poller.close()
        status = await asyncio.wait_for(task, timeout=10)
    finally:
        if not task.done():
            task.cancel()

    assert status == "canceled"
    async with get_sessionmaker()() as fresh:
        row = await fresh.get(LabelGenerationRun, run_id)
        assert row.status == "canceled" and row.finished_at is not None
        assert row.processed < row.total                  # stopped before finishing all 5


# ── jobs.claim_next / requeue_stale ─────────────────────────────────

async def test_claim_next_oldest_first_skip_locked_and_requeue_stale(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    r1 = LabelGenerationRun(initiative_id=initiative.id, label_types=["top"],
                            requested_by=person.id, status="queued")
    db.add(r1)
    await db.commit()

    initiative2, person2, *_ = await _seed_initiative(
        db, n_assets=1, model_name="Nexus 9336C-2", legacy_base=9100)
    r2 = LabelGenerationRun(initiative_id=initiative2.id, label_types=["top"],
                            requested_by=person2.id, status="queued")
    db.add(r2)
    await db.commit()

    claimed = await claim_next(db)
    assert claimed.id == r1.id and claimed.status == "running" and claimed.started_at is not None
    assert (await claim_next(db)).id == r2.id
    assert await claim_next(db) is None

    stale = await db.get(LabelGenerationRun, r1.id)
    stale.started_at = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES + 1)
    await db.commit()
    assert await requeue_stale(db) == 1
    await db.refresh(stale)
    assert stale.status == "queued" and stale.started_at is None
    fresh_r2 = await db.get(LabelGenerationRun, r2.id)
    assert fresh_r2.status == "running"                     # not stale — untouched


# ── worker.run_once ──────────────────────────────────────────────────

async def test_run_once_end_to_end(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=2)
    run = LabelGenerationRun(initiative_id=initiative.id, label_types=["top"],
                             requested_by=person.id, status="queued")
    db.add(run)
    await db.commit()
    run_id = run.id

    assert await worker.run_once(get_sessionmaker()) is True
    async with get_sessionmaker()() as fresh:
        row = await fresh.get(LabelGenerationRun, run_id)
        assert row.status == "completed" and row.generated == 2
    assert await worker.run_once(get_sessionmaker()) is False       # queue empty


# ── enqueue_run ──────────────────────────────────────────────────────

async def test_enqueue_run_rejects_empty_types(db):
    initiative, person, *_ = await _seed_initiative(db, n_assets=1)
    with pytest.raises(InvalidLabelTypes) as exc:
        await enqueue_run(db, initiative_id=initiative.id, label_types=[],
                          regenerate_existing=False, requested_by=person.id, notify=False)
    assert exc.value.problems == []


async def test_enqueue_run_rejects_unknown_types(db):
    initiative, person, *_ = await _seed_initiative(db, n_assets=1)
    with pytest.raises(InvalidLabelTypes) as exc:
        await enqueue_run(db, initiative_id=initiative.id, label_types=["top", "not_a_type"],
                          regenerate_existing=False, requested_by=person.id, notify=False)
    assert exc.value.problems == ["not_a_type"]


async def test_enqueue_run_rejects_inactive_type(db):
    from serversherpa.db.models import LabelVocab

    initiative, person, *_ = await _seed_initiative(db, n_assets=1)
    row = await db.get(LabelVocab, ("type", "container"))
    row.is_active = False
    await db.commit()
    with pytest.raises(InvalidLabelTypes) as exc:
        await enqueue_run(db, initiative_id=initiative.id, label_types=["container"],
                          regenerate_existing=False, requested_by=person.id, notify=False)
    assert exc.value.problems == ["container"]


async def test_enqueue_run_queues_and_rejects_second_active_run(db):
    initiative, person, *_ = await _seed_initiative(db, n_assets=1)
    run = await enqueue_run(db, initiative_id=initiative.id, label_types=["top", "top"],
                            regenerate_existing=True, requested_by=person.id, notify=True)
    assert run.status == "queued" and run.label_types == ["top"]        # de-duped
    assert run.regenerate_existing is True and run.notify is True

    with pytest.raises(RunActive) as exc:
        await enqueue_run(db, initiative_id=initiative.id, label_types=["front"],
                          regenerate_existing=False, requested_by=person.id, notify=False)
    assert exc.value.run_id == run.id


# ── migration / head ──────────────────────────────────────────────

async def test_single_alembic_head_is_0055():
    import subprocess
    from pathlib import Path

    api_dir = Path(__file__).resolve().parents[1]
    out = subprocess.run([str(api_dir / ".venv/bin/alembic"), "heads"], cwd=api_dir,
                         capture_output=True, text=True, check=True).stdout
    assert out.strip().split()[0] == "0055"


async def test_migration_0055_schema_and_unique_indexes(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    # capture plain values BEFORE any rollback below expires these ORM
    # objects — touching an expired attribute outside an awaited SQLAlchemy
    # call raises MissingGreenlet, so nothing past this point reads them.
    assert template.generation_rules == {}
    initiative_id, person_id = initiative.id, person.id
    asset_id, template_id, template_version = assets[0].id, template.id, template.version

    run = LabelGenerationRun(initiative_id=initiative_id, label_types=["top"],
                             requested_by=person_id, status="queued")
    db.add(run)
    await db.commit()

    dup = LabelGenerationRun(initiative_id=initiative_id, label_types=["front"],
                             requested_by=person_id, status="queued")
    db.add(dup)
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    label = GeneratedLabel(entity_type="asset", entity_id=asset_id, initiative_id=None,
                           label_type="top", template_id=template_id,
                           template_version=template_version, language_key="zpl",
                           dpi_key="203", size_key="4x2", code="x", values={})
    db.add(label)
    await db.commit()
    dup_label = GeneratedLabel(entity_type="asset", entity_id=asset_id, initiative_id=None,
                               label_type="top", template_id=template_id,
                               template_version=template_version, language_key="zpl",
                               dpi_key="203", size_key="4x2", code="y", values={})
    db.add(dup_label)
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
