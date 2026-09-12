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
    LabelTemplate, LabelVocab, Notification, Person, Site,
)
from serversherpa.labels.generate import InvalidLabelTypes, InvalidTemplates, RunActive, enqueue_run
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


async def test_runner_db_failure_on_one_asset_does_not_lose_other_writes_in_batch(db):
    """A REAL failing statement (not a pure-Python exception) for one
    asset must not roll back the OTHER assets' already-executed upserts
    in the same in-flight batch. `_upsert_label` runs inside its own
    SAVEPOINT (db.begin_nested()) for exactly this reason — an earlier
    version called Session.rollback() on the whole session instead, which
    discarded every upsert already queued in the batch while `generated`
    kept counting them, so the run reported labels that were never
    written.

    The failure is injected by making `render_label` return a None code
    for one asset — `code` is NOT NULL on generated_labels, so the REAL
    `_upsert_label` (not a stand-in) hits a genuine IntegrityError inside
    its own db.begin_nested() block. Assert run.generated == the REAL row
    count, not just that the run finishes 'completed'."""
    initiative, person, assets, template = await _seed_initiative(db, n_assets=3)
    real_render = runner_module.render_label

    def flaky_render(template, values, **kwargs):
        code, unknown = real_render(template, values, **kwargs)
        if values.get("asset_id") == "9001":            # assets[1]'s legacy_id
            return None, unknown                         # code NOT NULL -> real DB failure
        return code, unknown

    run = _queued_run(initiative.id, person.id, label_types=["top"])
    db.add(run)
    await db.commit()

    runner_module.render_label = flaky_render
    try:
        status = await process_run(db, run, sessionmaker=get_sessionmaker())
    finally:
        runner_module.render_label = real_render

    assert status == "completed"
    await db.refresh(run)
    assert run.generated == 2 and run.errors == 1
    rows = (await db.execute(select(GeneratedLabel).where(
        GeneratedLabel.label_type == "top"))).scalars().all()
    assert len(rows) == run.generated == 2                 # the load-bearing assertion
    assert {r.entity_id for r in rows} == {assets[0].id, assets[2].id}


async def test_runner_error_message_capped_at_500_chars(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    real_render = runner_module.render_label

    def flaky_render(*args, **kwargs):
        raise ValueError("x" * 1000)

    runner_module.render_label = flaky_render
    try:
        run = _queued_run(initiative.id, person.id, label_types=["top"])
        db.add(run)
        await db.commit()
        await process_run(db, run, sessionmaker=get_sessionmaker())
    finally:
        runner_module.render_label = real_render

    await db.refresh(run)
    assert run.errors == 1
    message = run.error_details[0]["message"]
    assert len(message) == 500 and message == "x" * 500


async def test_runner_reports_unknown_tokens_without_failing_the_label(db):
    """Two assets both hit the SAME unknown token — error_summary must
    stay at 1 ('counted once per run', spec §Worker), not accumulate one
    per occurrence. A single-asset version of this test would pass even
    if the runner incremented per occurrence (1 == 1 either way)."""
    initiative, person, assets, _tpl = await _seed_initiative(db, n_assets=2, top_template=False)
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
    assert run.generated == 2 and run.errors == 0              # unknown token doesn't fail it
    assert run.error_summary.get("unknown_token:totally_made_up") == 1
    rows = (await db.execute(select(GeneratedLabel))).scalars().all()
    assert sorted(r.code for r in rows) == ["9000 ", "9001 "]  # unresolved token -> ""


async def test_runner_error_details_cap_at_50_but_errors_count_all(db):
    """> 50 errors in one run: error_details keeps only the first 50
    (spec §Data), but the `errors` counter and error_summary tally the
    REAL total. 60 assets, requested type has no template so every one
    is an error."""
    initiative, person, assets, _tpl = await _seed_initiative(
        db, n_assets=60, top_template=False)
    run = _queued_run(initiative.id, person.id, label_types=["top"])
    db.add(run)
    await db.commit()

    status = await process_run(db, run, sessionmaker=get_sessionmaker())

    assert status == "completed"
    await db.refresh(run)
    assert run.errors == 60
    assert run.error_summary.get("no_template:top") == 60
    assert len(run.error_details) == 50


async def test_runner_notifies_labels_ready_kind(db):
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
    # enough assets that the poller reliably wins the race to set
    # cancel_requested before the runner (now faster: no more per-asset
    # SELECT, see _load_existing_for_type) finishes all of them on its own.
    initiative, person, assets, template = await _seed_initiative(db, n_assets=80)
    run = _queued_run(initiative.id, person.id, label_types=["top"], notify=True)
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
        assert row.processed < row.total                  # stopped before finishing all 80
        # a user-requested cancel is not a failure — no labels_failed (or
        # any other) inbox row, even though notify=True was requested.
        assert await fresh.scalar(select(Notification).where(
            Notification.person_id == person.id)) is None


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
    assert claimed.heartbeat_at is not None and claimed.worker_id      # claim stamps both
    assert (await claim_next(db)).id == r2.id
    assert await claim_next(db) is None

    # staleness is judged on heartbeat_at (bumped at every batch flush),
    # not started_at — a long-running-but-still-progressing run must
    # never be swept just because it started long ago.
    stale = await db.get(LabelGenerationRun, r1.id)
    old = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES + 1)
    stale.started_at, stale.heartbeat_at = old, old
    await db.commit()
    assert await requeue_stale(db) == 1
    await db.refresh(stale)
    assert stale.status == "queued" and stale.started_at is None
    assert stale.heartbeat_at is None and stale.worker_id is None
    fresh_r2 = await db.get(LabelGenerationRun, r2.id)
    assert fresh_r2.status == "running"                     # not stale — untouched

    # a run with a fresh heartbeat is never swept even if started_at is
    # old (a long roster still actively making progress).
    still_going = await db.get(LabelGenerationRun, r2.id)
    still_going.started_at = old
    still_going.heartbeat_at = datetime.now(UTC)
    await db.commit()
    assert await requeue_stale(db) == 0
    await db.refresh(still_going)
    assert still_going.status == "running"

    # absent a heartbeat entirely (an older worker build that claimed but
    # never wrote one), staleness falls back to started_at.
    no_heartbeat = await db.get(LabelGenerationRun, r2.id)
    no_heartbeat.heartbeat_at = None
    no_heartbeat.started_at = old
    await db.commit()
    assert await requeue_stale(db) == 1
    await db.refresh(no_heartbeat)
    assert no_heartbeat.status == "queued"


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


async def test_enqueue_run_rejects_container_type_even_when_active(db):
    """`container` is an active vocab type, but container labels are Avery
    sheets from the Container Labels page — never an asset run type."""
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    if await db.get(LabelVocab, ("type", "container")) is None:
        db.add(LabelVocab(kind="type", key="container", label="Container Label", is_active=True))
    await db.commit()
    with pytest.raises(InvalidLabelTypes) as exc:
        await enqueue_run(db, initiative_id=initiative.id, label_types=["top", "container"],
                          regenerate_existing=False, requested_by=person.id, notify=False)
    assert exc.value.problems == ["container: container labels are generated from the Container Labels page"]


async def test_enqueue_run_rejects_unknown_types(db):
    initiative, person, *_ = await _seed_initiative(db, n_assets=1)
    with pytest.raises(InvalidLabelTypes) as exc:
        await enqueue_run(db, initiative_id=initiative.id, label_types=["top", "not_a_type"],
                          regenerate_existing=False, requested_by=person.id, notify=False)
    assert exc.value.problems == ["not_a_type"]


async def test_enqueue_run_rejects_inactive_type(db):
    from serversherpa.db.models import LabelVocab

    initiative, person, *_ = await _seed_initiative(db, n_assets=1)
    # `rail` is a real asset type; deactivating it makes it "unknown" to a run.
    row = await db.get(LabelVocab, ("type", "rail"))
    row.is_active = False
    await db.commit()
    with pytest.raises(InvalidLabelTypes) as exc:
        await enqueue_run(db, initiative_id=initiative.id, label_types=["rail"],
                          regenerate_existing=False, requested_by=person.id, notify=False)
    assert exc.value.problems == ["rail"]


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


# ── enqueue_run template_overrides ───────────────────────────────────

async def test_enqueue_run_stores_valid_template_override(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    run = await enqueue_run(
        db, initiative_id=initiative.id, label_types=["top"], regenerate_existing=False,
        requested_by=person.id, notify=False,
        template_overrides={"top": str(template.id)})
    assert run.template_overrides == {"top": str(template.id)}


async def test_enqueue_run_rejects_override_key_not_in_label_types(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    with pytest.raises(InvalidTemplates) as exc:
        await enqueue_run(
            db, initiative_id=initiative.id, label_types=["top"], regenerate_existing=False,
            requested_by=person.id, notify=False,
            template_overrides={"rail": str(template.id)})
    assert exc.value.problems == ["rail: not one of the run's label types"]


async def test_enqueue_run_rejects_override_wrong_template_type(db):
    from serversherpa.db.models import LabelTemplate

    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    front_tpl = LabelTemplate(name=f"front-{uuid.uuid4()}", label_type="front", size_key="4x2",
                              dpi_key="203", language_key="zpl", kind="code", code="{asset_id}")
    db.add(front_tpl)
    await db.commit()
    with pytest.raises(InvalidTemplates) as exc:
        await enqueue_run(
            db, initiative_id=initiative.id, label_types=["top"], regenerate_existing=False,
            requested_by=person.id, notify=False,
            template_overrides={"top": str(front_tpl.id)})
    assert exc.value.problems == ["top: template is a 'front' template"]


async def test_enqueue_run_rejects_override_inactive_template(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    template.is_active = False
    await db.commit()
    with pytest.raises(InvalidTemplates) as exc:
        await enqueue_run(
            db, initiative_id=initiative.id, label_types=["top"], regenerate_existing=False,
            requested_by=person.id, notify=False,
            template_overrides={"top": str(template.id)})
    assert exc.value.problems == [f"top: template {template.id} is not active"]


async def test_enqueue_run_rejects_override_unknown_template_id(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    bogus = uuid.uuid4()
    with pytest.raises(InvalidTemplates) as exc:
        await enqueue_run(
            db, initiative_id=initiative.id, label_types=["top"], regenerate_existing=False,
            requested_by=person.id, notify=False,
            template_overrides={"top": str(bogus)})
    assert exc.value.problems == [f"top: template {bogus} is not active"]


async def test_enqueue_run_accumulates_multiple_override_problems(db):
    initiative, person, assets, template = await _seed_initiative(db, n_assets=1)
    with pytest.raises(InvalidTemplates) as exc:
        await enqueue_run(
            db, initiative_id=initiative.id, label_types=["top"], regenerate_existing=False,
            requested_by=person.id, notify=False,
            template_overrides={"top": str(uuid.uuid4()), "rail": str(uuid.uuid4())})
    assert len(exc.value.problems) == 2
    assert any("rail" in p and "not one of" in p for p in exc.value.problems)
    assert any(p.startswith("top: template") for p in exc.value.problems)


async def test_enqueue_run_no_overrides_defaults_to_empty_dict(db):
    initiative, person, *_ = await _seed_initiative(db, n_assets=1)
    run = await enqueue_run(db, initiative_id=initiative.id, label_types=["top"],
                            regenerate_existing=False, requested_by=person.id, notify=False)
    assert run.template_overrides == {}


# ── runner honors template_overrides ─────────────────────────────────

async def test_runner_override_wins_over_auto_match(db):
    """A destination-site auto-match exists, but the override points at
    a DIFFERENT active template of the same type — the override wins."""
    initiative, person, assets, auto_template = await _seed_initiative(db, n_assets=2)
    override_template = LabelTemplate(
        name=f"override-top-{uuid.uuid4()}", label_type="top", size_key="4x2", dpi_key="203",
        language_key="zpl", kind="code", code="OVERRIDE-{asset_id}",
        # Older than the seeded template so it can never BE the auto-match
        # (select_template orders version desc, updated_at desc) — otherwise
        # this test could pass with the override branch deleted.
        updated_at=datetime(2020, 1, 1, tzinfo=UTC))
    db.add(override_template)
    await db.commit()
    from serversherpa.labels.generate.select import select_template
    auto = await select_template(db, "top", initiative.destination_site_id)
    assert auto is not None and auto.id == auto_template.id and auto.id != override_template.id

    run = _queued_run(initiative.id, person.id, label_types=["top"])
    run.template_overrides = {"top": str(override_template.id)}
    db.add(run)
    await db.commit()

    status = await process_run(db, run, sessionmaker=get_sessionmaker())
    assert status == "completed"
    await db.refresh(run)
    assert run.generated == 2 and run.errors == 0

    rows = (await db.execute(select(GeneratedLabel).where(
        GeneratedLabel.label_type == "top"))).scalars().all()
    assert len(rows) == 2
    assert all(r.template_id == override_template.id for r in rows)
    assert sorted(r.code for r in rows) == ["OVERRIDE-9000", "OVERRIDE-9001"]


async def test_runner_falls_back_to_no_template_when_override_deactivated(db):
    """The override was valid at enqueue time but the template was
    deactivated before the worker processed the run — the type is
    treated like it has no template at all (no_template:{type} errors),
    NOT silently reverted to the auto-match."""
    initiative, person, assets, auto_template = await _seed_initiative(db, n_assets=2)
    override_template = LabelTemplate(
        name=f"deactivated-top-{uuid.uuid4()}", label_type="top", size_key="4x2", dpi_key="203",
        language_key="zpl", kind="code", code="X-{asset_id}")
    db.add(override_template)
    await db.commit()

    run = _queued_run(initiative.id, person.id, label_types=["top"])
    run.template_overrides = {"top": str(override_template.id)}
    db.add(run)
    await db.commit()

    override_template.is_active = False
    await db.commit()

    status = await process_run(db, run, sessionmaker=get_sessionmaker())
    assert status == "completed"
    await db.refresh(run)
    assert run.generated == 0 and run.errors == 2
    assert run.error_summary.get("no_template:top") == 2

    rows = (await db.execute(select(GeneratedLabel).where(
        GeneratedLabel.label_type == "top"))).scalars().all()
    assert rows == []                       # not silently generated with the auto-match


# ── migration / head ──────────────────────────────────────────────

async def test_single_alembic_head_and_0056_in_history():
    """One head only (a competing migration would show two), and the
    label-run override migration is part of the chain. Not pinned to a
    specific head number — every later migration would otherwise have
    to edit this test."""
    import subprocess
    from pathlib import Path

    api_dir = Path(__file__).resolve().parents[1]
    heads = subprocess.run([str(api_dir / ".venv/bin/alembic"), "heads"], cwd=api_dir,
                           capture_output=True, text=True, check=True).stdout
    assert len(heads.strip().splitlines()) == 1, heads
    history = subprocess.run([str(api_dir / ".venv/bin/alembic"), "history"], cwd=api_dir,
                             capture_output=True, text=True, check=True).stdout
    assert "-> 0056" in history


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
    assert run.template_overrides == {}          # migration 0056's column default

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


async def test_runner_upsert_survives_postgres_generic_plan_switch(db):
    """Regression: the ON CONFLICT target for generated_labels includes
    `coalesce(initiative_id, <nil uuid>)`. When that nil uuid was a bound
    parameter, Postgres matched the unique index only while asyncpg's
    prepared statement used custom plans — after five executions it switches
    to a generic plan, the parameter no longer folds to the index constant,
    and EVERY label from the sixth on failed with "no unique or exclusion
    constraint matching the ON CONFLICT specification". Eight assets in one
    session crosses that threshold; the sentinel must render inline."""
    initiative, person, assets, template = await _seed_initiative(db, n_assets=8)
    run = _queued_run(initiative.id, person.id, label_types=["top"])
    db.add(run)
    await db.commit()

    status = await process_run(db, run, sessionmaker=get_sessionmaker())

    assert status == "completed"
    await db.refresh(run)
    assert run.generated == 8 and run.errors == 0, run.error_summary
    rows = (await db.execute(select(GeneratedLabel).where(
        GeneratedLabel.initiative_id == initiative.id))).scalars().all()
    assert len(rows) == 8
