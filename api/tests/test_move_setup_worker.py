"""Create a move in steps — the worker's move_setup job: everything in one
transaction, progress through a second session, failures that leave nothing
behind and keep the draft for a retry, and the 24-hour sweep."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset,
    AuditLog,
    Container,
    ImportJob,
    Initiative,
    InitiativeAsset,
    Truck,
)
from serversherpa.imports import move_setup
from serversherpa.imports.jobs import claim_next, sweep_stale
from serversherpa.imports.worker import run_once
from tests.test_move_setup_api import (
    BASE,
    CRATES,
    TRUCKS,
    admin_login,
    make_sites,
    move_body,
    new_draft,
    reload,
    upload_assets,
)


@pytest.fixture
async def admin_hdrs(db, client):
    return await admin_login(db, client, "ada@test.example.com")


async def count(db, model) -> int:
    return await db.scalar(select(func.count()).select_from(model))


async def full_draft(client, db, hdrs, *, crates=CRATES, trucks=TRUCKS):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, hdrs, origin, destination, scheduled_start="2026-10-01")
    assert (await upload_assets(client, hdrs, draft["id"])).status_code == 201
    assert await run_once(get_sessionmaker()) is True          # the From-To check
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=hdrs,
                              json={"crates": crates, "trucks": trucks})
    assert resp.status_code == 200, resp.text
    return draft, origin, destination


async def queue(client, hdrs, draft_id) -> None:
    resp = await client.post(f"{BASE}/{draft_id}/create", headers=hdrs)
    assert resp.status_code == 200, resp.text


async def test_create_builds_the_move_assets_crates_and_trucks(client, db, admin_hdrs):
    draft, origin, destination = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])
    assert await run_once(get_sessionmaker()) is True
    done = await reload(draft["id"])
    assert (done.status, done.error, done.payload) == ("completed", None, None)
    ini = await db.get(Initiative, done.initiative_id)
    assert (ini.name, ini.initiative_type) == ("SJC to DAL", "move")
    assert (ini.origin_site_id, ini.destination_site_id) == (origin.id, destination.id)
    assert ini.color is not None
    # dates land exactly as POST /initiatives stores them
    ref = await client.post("/initiatives", headers=admin_hdrs,
                            json=move_body(origin, destination, name="ref",
                                           scheduled_start="2026-10-01"))
    assert ini.scheduled_start == (await db.get(
        Initiative, uuid.UUID(ref.json()["id"]))).scheduled_start
    assert await db.scalar(select(func.count()).select_from(InitiativeAsset).where(
        InitiativeAsset.initiative_id == ini.id)) == 2
    crates = (await db.scalars(select(Container).where(
        Container.initiative_id == ini.id).order_by(Container.name))).all()
    assert [c.name for c in crates] == ["CRT-SJC-DAL-001", "CRT-SJC-DAL-002",
                                        "CRT-SJC-DAL-003"]
    assert [c.label_tag for c in crates] == ["priority", None, None]
    assert {(c.site_id, c.container_type, c.status) for c in crates} == {
        (origin.id, "pallet", "available")}
    trucks = (await db.scalars(select(Truck).where(
        Truck.initiative_id == ini.id).order_by(Truck.name))).all()
    assert [t.name for t in trucks] == ["TRK-SJC-DAL-001", "TRK-SJC-DAL-002"]
    assert {(t.start_site_id, t.end_site_id) for t in trucks} == {(origin.id, destination.id)}
    assert done.results["move_id"] == str(ini.id)
    assert (done.results["crates"], done.results["trucks"]) == (3, 2)
    assert done.results["assets"]["summary"]["created"] == 2
    assert len(done.results["assets"]["details"]) == 2
    assert (done.processed_rows, done.total_rows) == (7, 7)
    actions = [(a.entity_type, a.action) for a in await db.scalars(select(AuditLog))]
    assert actions.count(("initiative", "create")) == 2           # this move + the ref
    assert actions.count(("container", "create")) == 3
    assert actions.count(("truck", "create")) == 2
    assert actions.count(("initiative", "asset_import")) == 1
    assert actions.count(("initiative", "bulk_import")) == 1
    assert await db.scalar(select(func.count()).select_from(ImportJob).where(
        ImportJob.kind == "move_assets")) == 0                      # the check is gone


async def test_create_with_every_optional_step_skipped(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                       json={"skip": ["assets", "crates", "trucks"]})
    await queue(client, admin_hdrs, draft["id"])
    assert await run_once(get_sessionmaker()) is True
    done = await reload(draft["id"])
    assert done.status == "completed"
    assert done.results == {"move_id": str(done.initiative_id), "assets": None,
                            "crates": 0, "trucks": 0}
    assert (done.processed_rows, done.total_rows) == (0, 0)
    assert (await count(db, Initiative), await count(db, Container),
            await count(db, Truck), await count(db, Asset)) == (1, 0, 0, 0)


async def test_a_clash_after_the_check_leaves_nothing_behind(client, db, admin_hdrs):
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])
    db.add(Truck(name="trk-sjc-dal-002"))      # lands after validation, before the worker
    await db.commit()
    assert await run_once(get_sessionmaker()) is True
    failed = await reload(draft["id"])
    assert (failed.status, failed.error) == ("failed", "name_taken")
    assert failed.results == {"reasons": ["These truck names already exist: TRK-SJC-DAL-002."]}
    assert failed.payload["trucks"] == TRUCKS                     # kept for a retry
    assert (failed.processed_rows, failed.initiative_id) == (0, None)
    # the move, its assets and its crates were already flushed — all rolled back
    assert await count(db, Initiative) == 0
    assert await count(db, Asset) == 0
    assert await count(db, InitiativeAsset) == 0
    assert await count(db, Container) == 0
    assert await count(db, Truck) == 1                            # only the planted one
    assert await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action.in_(("create", "asset_import", "bulk_import")))) == 0
    assert await reload(failed.payload["assets"]["check_job_id"]) is not None


async def test_a_failed_draft_can_be_fixed_and_created(client, db, admin_hdrs):
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])
    db.add(Truck(name="TRK-SJC-DAL-002"))
    await db.commit()
    await run_once(get_sessionmaker())
    fixed = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                               json={"trucks": {**TRUCKS, "start": 10}})
    assert fixed.json()["status"] == "preview"
    await queue(client, admin_hdrs, draft["id"])
    assert await run_once(get_sessionmaker()) is True
    done = await reload(draft["id"])
    assert done.status == "completed"
    names = set(await db.scalars(select(Truck.name).where(
        Truck.initiative_id == done.initiative_id)))
    assert names == {"TRK-SJC-DAL-010", "TRK-SJC-DAL-011"}


async def test_an_unexpected_error_rolls_back_as_worker_error(
        client, db, admin_hdrs, monkeypatch):
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])

    async def boom(*args, **kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(move_setup, "create_trucks", boom)
    assert await run_once(get_sessionmaker()) is True
    failed = await reload(draft["id"])
    assert (failed.status, failed.error) == ("failed", "worker_error")
    assert failed.results == {"reasons": [move_setup.WORKER_ERROR_MESSAGE]}
    assert failed.payload is not None
    assert (await count(db, Initiative), await count(db, Asset),
            await count(db, Container)) == (0, 0, 0)


async def test_a_crash_before_the_apply_still_keeps_the_payload(
        client, db, admin_hdrs, monkeypatch):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                       json={"skip": ["assets", "crates", "trucks"]})
    await queue(client, admin_hdrs, draft["id"])

    async def boom(db, job):
        raise RuntimeError("storage down")

    monkeypatch.setattr(move_setup, "prepare", boom)
    assert await run_once(get_sessionmaker()) is True
    failed = await reload(draft["id"])
    assert (failed.status, failed.error) == ("failed", "worker_error")
    assert failed.results == {"reasons": [move_setup.WORKER_ERROR_MESSAGE]}
    assert failed.payload is not None


async def test_a_site_removed_after_queueing_is_setup_invalid(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                       json={"skip": ["assets", "crates", "trucks"]})
    await queue(client, admin_hdrs, draft["id"])
    await db.delete(destination)
    await db.commit()
    assert await run_once(get_sessionmaker()) is True
    failed = await reload(draft["id"])
    assert (failed.status, failed.error) == ("failed", "setup_invalid")
    assert failed.results == {"reasons": [
        "A site on the first step no longer exists. Pick another."]}
    assert await count(db, Initiative) == 0


async def test_apply_reports_progress_by_units(client, db, admin_hdrs, monkeypatch):
    monkeypatch.setattr(move_setup, "PROGRESS_EVERY", 2)
    draft, _, _ = await full_draft(client, db, admin_hdrs)      # 2 assets, 3 crates, 2 trucks
    await queue(client, admin_hdrs, draft["id"])
    seen: list[int] = []

    async def progress(n: int) -> None:
        seen.append(n)

    async with get_sessionmaker()() as work:
        job = await claim_next(work)
        plan = await move_setup.prepare(work, job)
        assert plan.total == 7
        await work.commit()
        await move_setup.apply_job(work, job, plan, progress=progress)
    assert seen == [2, 2, 5, 7]           # asset boundary, asset tail, +crates, +trucks
    assert (await reload(draft["id"])).status == "completed"


async def test_progress_is_visible_while_the_create_is_still_open(
        client, db, admin_hdrs, monkeypatch):
    """The create's own transaction stays open to the end; progress goes
    through a second session, so another reader sees it mid-run."""
    monkeypatch.setattr(move_setup, "PROGRESS_EVERY", 2)
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])
    real = move_setup.create_containers
    observed: list[int] = []

    async def spy(*args, **kwargs):
        async with get_sessionmaker()() as other:
            observed.append(await other.scalar(select(ImportJob.processed_rows).where(
                ImportJob.id == uuid.UUID(draft["id"]))))
            assert await other.scalar(select(func.count()).select_from(Initiative)) == 0
        return await real(*args, **kwargs)

    monkeypatch.setattr(move_setup, "create_containers", spy)
    assert await run_once(get_sessionmaker()) is True
    assert observed == [2]
    done = await reload(draft["id"])
    assert (done.processed_rows, done.total_rows) == (7, 7)


async def test_sweep_removes_stale_drafts_their_checks_and_old_previews(
        client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    stale = await new_draft(client, admin_hdrs, origin, destination)
    stale_check = (await upload_assets(client, admin_hdrs, stale["id"])).json()
    fresh = await new_draft(client, admin_hdrs, origin, destination)
    fresh_check = (await upload_assets(client, admin_hdrs, fresh["id"])).json()
    queued = await new_draft(client, admin_hdrs, origin, destination)
    await client.patch(f"{BASE}/{queued['id']}", headers=admin_hdrs,
                       json={"skip": ["assets", "crates", "trucks"]})
    await queue(client, admin_hdrs, queued["id"])
    preview = ImportJob(kind="asset_bulk_update", initiative_id=None, filename="a.csv",
                        status="preview", phase="preview", payload=[{"row": 2, "cells": {}}])
    db.add(preview)
    await db.flush()
    old = datetime.now(UTC) - timedelta(hours=25)
    await db.execute(update(ImportJob).where(ImportJob.id.in_([
        uuid.UUID(stale["id"]), uuid.UUID(queued["id"]), preview.id,
    ])).values(progress_at=old, created_at=old))
    await db.commit()

    assert await sweep_stale(db) == {"drafts": 1, "checks": 1, "previews": 1}
    assert await reload(stale["id"]) is None
    assert await reload(stale_check["id"]) is None
    assert (await reload(fresh["id"])).status == "preview"
    assert await reload(fresh_check["id"]) is not None            # still referenced
    assert (await reload(queued["id"])).status == "queued"          # never swept
    swept = await reload(preview.id)
    assert (swept.status, swept.error, swept.payload) == ("cancelled", "expired", None)


async def _age(db, *ids) -> None:
    old = datetime.now(UTC) - timedelta(hours=25)
    await db.execute(update(ImportJob).where(ImportJob.id.in_([uuid.UUID(str(i)) for i in ids]))
                     .values(progress_at=old, created_at=old))
    await db.commit()


async def test_sweep_removes_an_old_failed_draft(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    old = await new_draft(client, admin_hdrs, origin, destination)
    old_check = (await upload_assets(client, admin_hdrs, old["id"])).json()
    recent = await new_draft(client, admin_hdrs, origin, destination)
    await db.execute(update(ImportJob).where(ImportJob.id.in_([
        uuid.UUID(old["id"]), uuid.UUID(recent["id"]),
    ])).values(status="failed", error="name_taken"))
    await db.commit()
    await _age(db, old["id"])

    assert await sweep_stale(db) == {"drafts": 1, "checks": 1, "previews": 0}
    assert await reload(old["id"]) is None
    assert await reload(old_check["id"]) is None
    assert (await reload(recent["id"])).status == "failed"          # touched within 24 h


async def test_sweep_leaves_an_unreferenced_running_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    check = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    await db.execute(update(ImportJob).where(ImportJob.id == uuid.UUID(check["id"]))
                     .values(status="running"))
    await db.commit()
    skipped = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                                 json={"skip": ["assets"]})          # no longer referenced
    assert skipped.json()["payload"]["assets"] is None
    await _age(db, check["id"])

    assert await sweep_stale(db) == {"drafts": 0, "checks": 0, "previews": 0}
    running = await reload(check["id"])
    assert (running.status, running.cancel_requested) == ("running", True)


async def test_sweep_leaves_old_bulk_updates_that_are_past_preview(db):
    jobs = [ImportJob(kind="asset_bulk_update", initiative_id=None, filename=f"{status}.csv",
                      status=status, phase="commit", payload=[{"row": 2, "cells": {}}])
            for status in ("queued", "running", "completed", "failed", "cancelled")]
    db.add_all(jobs)
    await db.commit()
    await _age(db, *(job.id for job in jobs))

    assert await sweep_stale(db) == {"drafts": 0, "checks": 0, "previews": 0}
    for job in jobs:
        kept = await reload(job.id)
        assert (kept.status, kept.error, kept.payload) == (
            job.status, None, [{"row": 2, "cells": {}}])
