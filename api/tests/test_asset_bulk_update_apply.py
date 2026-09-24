"""Update assets in bulk — apply: the import worker runs a queued
`asset_bulk_update` job all-or-nothing (approved changes, status changes as
manual scans through the rules engine, placement rechecks, progress)."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from serversherpa.assets import bulk_update as bu
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset,
    AssetModel,
    AuditLog,
    ImportJob,
    Initiative,
    InitiativeAsset,
    Person,
    ProcessedScan,
    StatusRuleExecution,
)
from serversherpa.imports import worker
from serversherpa.imports.jobs import claim_next, requeue_stale
from serversherpa.imports.worker import run_once
from serversherpa.scans.manual import SOURCE_ASSET_BULK_UPDATE
from serversherpa.status_rules.engine import invalidate_cache
from tests.test_import_worker import _job as mk_move_job
from tests.test_status_rules_engine import _rule


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_cache()
    yield
    invalidate_cache()


# ── fixtures ────────────────────────────────────────────────────────

async def mk_person(db):
    p = Person(first_name="Ada", last_name="Admin")
    db.add(p)
    await db.commit()
    return p


async def mk_asset(db, number, serial, **fields):
    a = Asset(legacy_id=number, serial_number=serial, **fields)
    db.add(a)
    await db.commit()
    await db.refresh(a)
    return a


async def mk_job(db, creator, csv_text, *, options=None, status="queued",
                 filename="assets.csv"):
    numbered = bu.parse_upload(filename, csv_text.encode())
    job = ImportJob(kind="asset_bulk_update", initiative_id=None, created_by=creator.id,
                    filename=filename, phase="commit", status=status,
                    options=options or {}, total_rows=len(numbered),
                    payload=[{"row": n, "cells": c} for n, c in numbered])
    db.add(job)
    await db.commit()
    return job.id


async def fresh_job(job_id):
    """The job row as a brand-new session sees it (what was committed)."""
    async with get_sessionmaker()() as s:
        return await s.get(ImportJob, job_id)


async def fresh_asset(asset_id):
    async with get_sessionmaker()() as s:
        return await s.get(Asset, asset_id)


# ── apply ───────────────────────────────────────────────────────────

async def test_applies_approved_updates_and_skips_unapproved(db):
    me = await mk_person(db)
    a = await mk_asset(db, 100, "SN-A", name="old-a")
    b = await mk_asset(db, 101, "SN-B", name="old-b")
    await mk_asset(db, 102, "SN-C", name="same-c")
    job_id = await mk_job(db, me, "asset_id,name,pod\n100,new-a,P1\n101,new-b,\n102,same-c,\n",
                          options={"approved_updates": [2]})

    assert await run_once(get_sessionmaker()) is True

    job = await fresh_job(job_id)
    assert job.status == "completed" and job.error is None
    assert job.processed_rows == 3 and job.updated_count == 1
    assert job.finished_at is not None
    # no model_id change in this job, so no placement recheck ran and the
    # summary carries no "placement" key
    assert job.results["summary"] == {"updated": 1, "skipped": 1, "unchanged": 1}
    # unchanged rows are counted in the summary only, not listed (15,000-row jobs
    # shouldn't store 15,000 result rows for no-op rows)
    assert {r["row"] for r in job.results["rows"]} == {2, 3}
    rows = {r["row"]: r for r in job.results["rows"]}
    assert rows[2] == {"row": 2, "name": "old-a", "asset_id": str(a.id), "asset_number": 100,
                       "action": "updated",
                       "diff": {"name": {"old": "old-a", "new": "new-a"},
                                "pod": {"old": None, "new": "P1"}}}
    assert rows[3]["asset_number"] == 101
    assert job.payload is None                 # the parsed file is dropped once done
    assert rows[3]["action"] == "skipped"
    assert rows[3]["diff"] == {"name": {"old": "old-b", "new": "new-b"}}

    fa, fb = await fresh_asset(a.id), await fresh_asset(b.id)
    assert (fa.name, fa.pod_number) == ("new-a", "P1")
    assert fa.updated_at > a.updated_at
    assert fb.name == "old-b"


async def test_approve_all_applies_every_update_with_ids_as_uuids(db):
    me = await mk_person(db)
    model = AssetModel(make="Dell", model="R740")
    db.add(model)
    await db.commit()
    a = await mk_asset(db, 100, "SN-A")
    b = await mk_asset(db, 101, "SN-B")
    job_id = await mk_job(
        db, me, "asset_id,make,model,has_rails,rfid_tag\n100,Dell,R740,yes,ab12\n101,,,no,\n",
        options={"approve_all": True})

    await run_once(get_sessionmaker())

    job = await fresh_job(job_id)
    assert job.status == "completed"
    assert job.results["summary"] == {
        "updated": 2, "skipped": 0, "unchanged": 0,
        "placement": {"collisions": 0, "orphans": 0, "cleared": 0}}
    fa, fb = await fresh_asset(a.id), await fresh_asset(b.id)
    assert fa.model_id == model.id and fa.has_rails is True
    assert fa.rfid_tag == "AB12".rjust(24, "0")
    assert fb.has_rails is False


async def test_audits_each_asset_and_one_bulk_import(db):
    me = await mk_person(db)
    a = await mk_asset(db, 100, "SN-A", name="old-a")
    b = await mk_asset(db, 101, "SN-B", name="old-b")
    await mk_asset(db, 102, "SN-C", name="c")
    await mk_job(db, me, "asset_id,name\n100,new-a\n101,new-b\n102,c\n",
                 options={"approve_all": True}, filename="fleet.csv")

    await run_once(get_sessionmaker())

    logs = (await db.scalars(select(AuditLog).order_by(AuditLog.entity_id))).all()
    updates = [x for x in logs if x.action == "update"]
    assert {x.entity_id for x in updates} == {str(a.id), str(b.id)}
    assert all(x.entity_type == "asset" and x.actor_person_id == me.id for x in updates)
    by_id = {x.entity_id: x.changes for x in updates}
    assert by_id[str(a.id)] == {"name": {"from": "old-a", "to": "new-a"}}
    [summary] = [x for x in logs if x.action == "bulk_import"]
    assert summary.entity_type == "asset" and summary.entity_id is None
    assert summary.actor_person_id == me.id
    assert summary.changes == {"updated": 2, "skipped": 0, "unchanged": 1,
                               "source": "fleet.csv"}


async def test_status_change_records_a_manual_scan_and_runs_rules(db):
    me = await mk_person(db)
    a = await mk_asset(db, 100, "SN-A", status="active")
    b = await mk_asset(db, 101, "SN-B", status="active", name="same")
    db.add(_rule("Racked means labeled", status="racked",
                 actions=(("set_asset_status", {"status": "labeled"}),)))
    await db.commit()
    job_id = await mk_job(db, me, "asset_id,status,name\n100,Racked,\n101,,same\n",
                          options={"approve_all": True})

    await run_once(get_sessionmaker())

    assert (await fresh_job(job_id)).status == "completed"
    scan = (await db.scalars(select(ProcessedScan))).one()     # b had no status change
    assert scan.scan_type == "manual" and scan.status == "racked"
    assert scan.source == SOURCE_ASSET_BULK_UPDATE == "asset_bulk_update"
    assert scan.device_id == "portal" and scan.operator_id == me.id
    assert scan.match_type == "asset" and scan.asset_id == a.id
    assert scan.site_id is None and scan.location_detail == ""
    assert scan.scanned_value == "SN-A"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.processed_scan_id == scan.id and ex.conditions_met is True
    assert (await fresh_asset(a.id)).status == "labeled"          # the rule ran
    assert (await fresh_asset(b.id)).status == "active"
    # the per-asset audit is the bulk edit itself, not the rule's follow-up
    log = await db.scalar(select(AuditLog).where(AuditLog.entity_id == str(a.id)))
    assert log.changes == {"status": {"from": "active", "to": "racked"}}


async def test_rule_failure_fails_the_job_and_changes_nothing(db):
    me = await mk_person(db)
    a = await mk_asset(db, 100, "SN-A", name="old-a")
    b = await mk_asset(db, 101, "SN-B", name="old-b", status="active")
    db.add(_rule("Broken", status="racked",
                 actions=(("set_asset_status", {"status": "no-such-status"}),)))
    await db.commit()
    job_id = await mk_job(db, me, "asset_id,name,status\n100,new-a,\n101,new-b,racked\n",
                          options={"approve_all": True})

    assert await run_once(get_sessionmaker()) is True

    job = await fresh_job(job_id)              # committed, seen from a new session
    assert job.status == "failed" and job.error == "rule_failed"
    assert job.finished_at is not None
    assert job.processed_rows == 0
    assert job.results["row"] == 3
    assert job.results["rule_name"] == "Broken"
    assert "Broken" in job.results["message"]
    fa, fb = await fresh_asset(a.id), await fresh_asset(b.id)
    assert fa.name == "old-a"                  # row 2 was rolled back too
    assert (fb.name, fb.status) == ("old-b", "active")
    assert await db.scalar(select(func.count()).select_from(ProcessedScan)) == 0
    assert await db.scalar(select(func.count()).select_from(AuditLog)) == 0
    assert job.payload is None
    # the rollback took the rule's own execution row with it; one error row
    # is stamped afterwards so the rules admin UI shows the failure
    [ex] = (await db.scalars(select(StatusRuleExecution))).all()
    assert ex.rule_name == "Broken" and ex.processed_scan_id is None
    assert ex.error and "Broken" in ex.error


async def test_a_failing_rule_failure_stamp_never_masks_rule_failed(db, monkeypatch):
    """The stamp is best-effort: if its own session can't write, the job
    still fails cleanly as rule_failed."""
    from serversherpa.db import engine

    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", status="active")
    db.add(_rule("Broken", status="racked",
                 actions=(("set_asset_status", {"status": "no-such-status"}),)))
    await db.commit()
    job_id = await mk_job(db, me, "asset_id,status\n100,racked\n",
                          options={"approve_all": True})
    job = await db.get(ImportJob, job_id)

    def broken_sessionmaker():
        raise RuntimeError("no database")

    monkeypatch.setattr(engine, "get_sessionmaker", broken_sessionmaker)
    await bu.apply_job(db, job)
    await db.commit()
    monkeypatch.undo()

    job = await fresh_job(job_id)
    assert job.status == "failed" and job.error == "rule_failed"
    assert await db.scalar(select(func.count()).select_from(StatusRuleExecution)) == 0


async def test_progress_resets_to_zero_on_rule_failure(db):
    """A rule failure late in a big job must not leave the page showing
    "250 of 300" beside a job that actually wrote nothing."""
    me = await mk_person(db)
    db.add_all([Asset(legacy_id=2000 + i, serial_number=f"SN-F{i}", status="active")
                for i in range(300)])
    db.add(_rule("Broken", status="racked",
                 actions=(("set_asset_status", {"status": "no-such-status"}),)))
    await db.commit()
    # every row changes its pod (an update); only the last row also sets a
    # status, so the broken rule fires only after the 250-row heartbeat
    body = "asset_id,pod,status\n" + "".join(
        f"{2000 + i},P{i}," + ("racked\n" if i == 299 else "\n") for i in range(300))
    job_id = await mk_job(db, me, body, options={"approve_all": True})

    assert await run_once(get_sessionmaker()) is True

    job = await fresh_job(job_id)
    assert job.status == "failed" and job.error == "rule_failed"
    assert job.processed_rows == 0


async def test_integrity_error_at_apply_fails_friendly(db, monkeypatch):
    """A concurrent write (e.g. someone else's own edit landing a duplicate
    RFID or serial) can only surface here as a raw SQL / constraint
    IntegrityError at flush or commit. Forced directly by making the
    apply's own commit raise one on its first call, same as the brief
    suggests ("monkeypatch the flush") — everything must roll back and the
    job must fail with a friendly message, never the raw SQL text."""
    me = await mk_person(db)
    a = await mk_asset(db, 100, "SN-A", name="old-a")
    asset_id = a.id                 # captured before any further commit expires `a`
    job_id = await mk_job(db, me, "asset_id,name\n100,new-a\n",
                          options={"approve_all": True})
    job = await db.get(ImportJob, job_id)

    real_commit = db.commit
    calls = {"n": 0}

    async def flaky_commit():
        calls["n"] += 1
        if calls["n"] == 1:
            raise IntegrityError(
                "UPDATE assets", {},
                Exception('duplicate key value violates unique constraint '
                          '"assets_rfid_uniq"'))
        await real_commit()

    monkeypatch.setattr(db, "commit", flaky_commit)
    await bu.apply_job(db, job)
    await db.commit()               # the caller's commit, persisting the failure

    assert calls["n"] == 2
    job = await fresh_job(job_id)
    assert job.status == "failed" and job.error == "apply_conflict"
    assert job.processed_rows == 0
    assert job.finished_at is not None
    assert job.results == {"message": bu.CONFLICT_MESSAGE}
    assert "constraint" not in job.results["message"]        # never the raw SQL message
    asset = await fresh_asset(asset_id)
    assert asset.name == "old-a"                              # the update was rolled back
    assert await db.scalar(select(func.count()).select_from(ProcessedScan)) == 0
    assert job.payload is None


async def test_stale_job_fails_rows_invalid(db):
    me = await mk_person(db)
    a = await mk_asset(db, 100, "SN-A", name="old-a")
    await mk_asset(db, 101, "SN-B", name="old-b")
    job_id = await mk_job(db, me, "asset_id,name\n100,new-a\n101,new-b\n",
                          options={"approve_all": True})
    b = await db.scalar(select(Asset).where(Asset.legacy_id == 101))
    b.archived_at = datetime.now(UTC)          # changed after the preview
    await db.commit()

    await run_once(get_sessionmaker())

    job = await fresh_job(job_id)
    assert job.status == "failed" and job.error == "rows_invalid"
    assert job.finished_at is not None
    assert job.processed_rows == 0
    [bad] = job.results["rows"]
    assert bad["row"] == 3 and bad["action"] == "error"
    assert bad["errors"] == ["Asset 101 is archived."]
    assert "changes" not in bad
    assert job.payload is None
    assert (await fresh_asset(a.id)).name == "old-a"


async def test_stored_picks_and_skips_are_used(db):
    me = await mk_person(db)
    a1 = await mk_asset(db, 100, "DUP", name="one")
    a2 = await mk_asset(db, 101, "DUP", name="two")
    job_id = await mk_job(db, me, "serial_number,pod\nDUP,P9\nNOPE,P1\n",
                          options={"overrides": {"2": {"asset": str(a2.id)}},
                                   "skip": [3], "approve_all": True})

    await run_once(get_sessionmaker())

    job = await fresh_job(job_id)
    assert job.status == "completed"
    assert job.results["summary"] == {"updated": 1, "skipped": 1, "unchanged": 0}
    assert (await fresh_asset(a2.id)).pod_number == "P9"
    assert (await fresh_asset(a1.id)).pod_number is None


async def test_approved_updates_and_skip_coerce_string_row_numbers(db):
    """`approved_updates` / `skip` round-trip through JSON options; a caller
    that sends row numbers as strings must be honored the same as ints."""
    me = await mk_person(db)
    a = await mk_asset(db, 100, "SN-A", name="old-a")
    b = await mk_asset(db, 101, "SN-B", name="old-b")
    c = await mk_asset(db, 102, "SN-C", name="old-c")
    job_id = await mk_job(
        db, me, "asset_id,name\n100,new-a\n101,new-b\n102,new-c\n",
        options={"approved_updates": ["2", 3], "skip": ["4"]})

    await run_once(get_sessionmaker())

    job = await fresh_job(job_id)
    assert job.status == "completed"
    assert job.results["summary"]["updated"] == 2
    fa, fb, fc = await fresh_asset(a.id), await fresh_asset(b.id), await fresh_asset(c.id)
    assert (fa.name, fb.name, fc.name) == ("new-a", "new-b", "old-c")


async def test_model_change_rechecks_placement_of_the_move(db):
    me = await mk_person(db)
    one_u = AssetModel(make="M", model="1U", ru_size=1)
    four_u = AssetModel(make="M", model="4U", ru_size=4)
    move = Initiative(name="Move", initiative_type="move", status="planned")
    other = Initiative(name="Other", initiative_type="move", status="planned")
    db.add_all([one_u, four_u, move, other])
    await db.flush()
    big = await mk_asset(db, 100, "SN-BIG", model_id=one_u.id)
    hit = await mk_asset(db, 101, "SN-HIT", model_id=one_u.id)
    far = await mk_asset(db, 102, "SN-FAR", model_id=one_u.id)
    rows = {
        "big": InitiativeAsset(initiative_id=move.id, asset_id=big.id, status="loaded_in_system",
                               destination_rack="R1", destination_ru=Decimal(10)),
        "hit": InitiativeAsset(initiative_id=move.id, asset_id=hit.id, status="loaded_in_system",
                               destination_rack="R1", destination_ru=Decimal(12)),
        # a collision in a move no changed asset belongs to is left alone
        "far": InitiativeAsset(initiative_id=other.id, asset_id=far.id,
                               status="location_collision",
                               destination_rack="R9", destination_ru=Decimal(1)),
    }
    db.add_all(rows.values())
    await db.commit()
    job_id = await mk_job(db, me, "asset_id,make,model\n100,M,4U\n",
                          options={"approve_all": True})

    await run_once(get_sessionmaker())

    statuses = dict((await db.execute(
        select(InitiativeAsset.asset_id, InitiativeAsset.status)
        .execution_options(populate_existing=True))).all())
    assert statuses == {big.id: "location_collision", hit.id: "location_collision",
                        far.id: "location_collision"}
    job = await fresh_job(job_id)
    # only "move"'s two rows were restated; "other" never went through
    # recheck_placement (its collision was already there, not one this job
    # caused), so it isn't counted
    assert job.results["summary"]["placement"] == {
        "collisions": 2, "orphans": 0, "cleared": 0}


async def test_recheck_only_covers_live_move_initiatives(db, monkeypatch):
    me = await mk_person(db)
    one_u = AssetModel(make="M", model="1U", ru_size=1)
    four_u = AssetModel(make="M", model="4U", ru_size=4)
    move = Initiative(name="Move", initiative_type="move", status="planned")
    archived_move = Initiative(name="Archived move", initiative_type="move",
                               status="planned", archived_at=datetime.now(UTC))
    project = Initiative(name="Project", initiative_type="project", status="planned")
    db.add_all([one_u, four_u, move, archived_move, project])
    await db.flush()
    on_move = await mk_asset(db, 100, "SN-MOVE", model_id=one_u.id)
    on_archived = await mk_asset(db, 101, "SN-ARCH", model_id=one_u.id)
    on_project = await mk_asset(db, 102, "SN-PROJ", model_id=one_u.id)
    db.add_all([
        InitiativeAsset(initiative_id=move.id, asset_id=on_move.id,
                        status="loaded_in_system", destination_rack="R1",
                        destination_ru=Decimal(10)),
        InitiativeAsset(initiative_id=archived_move.id, asset_id=on_archived.id,
                        status="loaded_in_system", destination_rack="R1",
                        destination_ru=Decimal(10)),
        InitiativeAsset(initiative_id=project.id, asset_id=on_project.id,
                        status="loaded_in_system", destination_rack="R1",
                        destination_ru=Decimal(10)),
    ])
    await db.commit()
    job_id = await mk_job(
        db, me, "asset_id,make,model\n100,M,4U\n101,M,4U\n102,M,4U\n",
        options={"approve_all": True})

    checked: list = []
    real_recheck = bu.recheck_placement

    async def spy(db_, initiative_id):
        checked.append(initiative_id)
        return await real_recheck(db_, initiative_id)

    monkeypatch.setattr(bu, "recheck_placement", spy)
    await run_once(get_sessionmaker())

    # only the live ("move", not archived) initiative was rechecked — not
    # the archived move, and not the non-move "project"
    assert checked == [move.id]
    job = await fresh_job(job_id)
    assert job.status == "completed"


async def test_progress_is_reported_every_250_rows(db):
    me = await mk_person(db)
    db.add_all([Asset(legacy_id=1000 + i, serial_number=f"SN-{i}", name=f"n-{i}")
                for i in range(600)])
    await db.commit()
    body = "asset_id,pod\n" + "".join(f"{1000 + i},P{i}\n" for i in range(600))
    job_id = await mk_job(db, me, body, options={"approve_all": True})

    seen: list[int] = []

    async def progress(n: int) -> None:
        seen.append(n)

    job = await db.get(ImportJob, job_id)
    await bu.apply_job(db, job, progress=progress)
    await db.commit()

    # the periodic 250 / 500 heartbeats, plus one more with the full count
    # right before the recheck/commit tail (fix for a stale progress_at
    # during a long placement recheck on a big job)
    assert seen == [250, 500, 600]
    job = await fresh_job(job_id)
    assert job.status == "completed" and job.processed_rows == 600
    assert job.updated_count == 600


async def test_worker_writes_progress_through_a_second_session(db, monkeypatch):
    """While the apply transaction is still open, each progress call is
    already committed and visible to any other session (the page polls) —
    but the job's own row changes are NOT: the main transaction stays
    uncommitted the whole time progress is being reported."""
    me = await mk_person(db)
    db.add_all([Asset(legacy_id=1000 + i, serial_number=f"SN-{i}")
                for i in range(600)])
    await db.commit()
    body = "asset_id,pod\n" + "".join(f"{1000 + i},P{i}\n" for i in range(600))
    job_id = await mk_job(db, me, body, options={"approve_all": True})

    real_apply = bu.apply_job
    observed: list[tuple[int, int]] = []

    async def watched(progress, n: int) -> None:
        await progress(n)
        seen = await fresh_job(job_id)
        observed.append((seen.processed_rows, seen.total_rows))
        # row 1 (legacy_id 1000) is one of this job's updates — proving it
        # is still untouched in a brand-new session proves the main
        # transaction hasn't committed yet, even though progress has
        async with get_sessionmaker()() as fresh:
            pod = await fresh.scalar(
                select(Asset.pod_number).where(Asset.legacy_id == 1000))
        assert pod is None

    async def spy_apply(session, job, *, progress=None):
        await real_apply(session, job,
                         progress=lambda n: watched(progress, n))

    monkeypatch.setattr(worker, "apply_job", spy_apply)
    await run_once(get_sessionmaker())

    assert observed == [(250, 600), (500, 600), (600, 600)]
    job = await fresh_job(job_id)
    assert job.status == "completed" and job.processed_rows == 600


async def test_run_once_runs_both_kinds_each_on_its_own_path(db):
    """A roster job next to a bulk job: both reach `completed`, each by its
    own pipeline (the roster job reads its file; the bulk job has none)."""
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")
    move_id, ini_id = await mk_move_job(db, phase="commit")
    bulk_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", options={"approve_all": True})

    assert await run_once(get_sessionmaker()) is True
    assert await run_once(get_sessionmaker()) is True
    assert await run_once(get_sessionmaker()) is False

    move = await fresh_job(move_id)
    assert move.status == "completed" and move.created_count == 2
    assert await db.scalar(select(func.count()).select_from(InitiativeAsset)
                           .where(InitiativeAsset.initiative_id == ini_id)) == 2
    bulk = await fresh_job(bulk_id)
    assert bulk.status == "completed" and bulk.file_key == "" and bulk.updated_count == 1
    assert await db.scalar(select(Asset.name).where(Asset.legacy_id == 100)) == "new-a"


async def test_cancel_requested_before_claim_cancels(db):
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")
    job_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", options={"approve_all": True})
    job = await db.get(ImportJob, job_id)
    job.cancel_requested = True
    await db.commit()
    await run_once(get_sessionmaker())
    job = await fresh_job(job_id)
    assert job.status == "cancelled" and job.payload is None
    assert (await db.scalar(select(Asset.name).where(Asset.legacy_id == 100))) == "old-a"


async def test_an_unexpected_worker_error_fails_the_job_and_drops_its_payload(db, monkeypatch):
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")
    job_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", options={"approve_all": True})

    async def boom(session, job, *, progress=None):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(worker, "apply_job", boom)
    assert await run_once(get_sessionmaker()) is True

    job = await fresh_job(job_id)
    assert job.status == "failed" and job.error == "worker_error: disk on fire"
    assert job.finished_at is not None
    assert job.payload is None


async def test_a_preview_job_is_never_claimed_or_requeued(db):
    me = await mk_person(db)
    await mk_asset(db, 100, "SN-A", name="old-a")
    job_id = await mk_job(db, me, "asset_id,name\n100,new-a\n", status="preview")
    job = await db.get(ImportJob, job_id)
    job.progress_at = datetime.now(UTC) - timedelta(hours=1)
    await db.commit()

    assert await claim_next(db) is None
    assert await run_once(get_sessionmaker()) is False
    assert await requeue_stale(db) == 0
    assert (await fresh_job(job_id)).status == "preview"

