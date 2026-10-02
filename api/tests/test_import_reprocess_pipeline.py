"""Reprocess pipeline: structured review details + only_rows filtering.

Harness mirrors test_import_worker.py (upload -> queued job -> run_once)
and test_move_asset_import_validate.py (parse_row/run_import shapes).
"""

import uuid

from sqlalchemy import func, select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import Asset, AssetModel, ImportJob, Initiative
from serversherpa.imports.worker import run_once
from serversherpa.services.storage import put_object

CSV = (b"Serial Number,Asset Name,Asset Make,Asset Model\n"
       b"S1,cisco-sw,Cisco,Nexus 9336C\n"
       b"S2,dell-srv,Dell,Dell PowerEdge R720\n"
       b"S3,hpe-srv,HPE,DL380\n")
# row 2: S1/Cisco Nexus 9336C -> matches a seeded AssetModel -> created
# row 3: S2/Dell "Dell PowerEdge R720" -> unmatched -> review (doubled make)
# row 4: S3/HPE DL380 -> unmatched -> review


async def _job(db, *, phase="validate", content=CSV, filename="ft.csv",
               status="queued", options=None):
    ini = Initiative(name=f"Move {uuid.uuid4().hex[:6]}",
                     initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    job = ImportJob(kind="move_assets", initiative_id=ini.id,
                    filename=filename, phase=phase, status=status,
                    options=options or {})
    db.add(job)
    await db.flush()
    key = f"import-jobs/{ini.id}/{job.id}/{filename}"
    await put_object(key, content, "text/csv")
    job.file_key = key
    await db.commit()
    return job.id, ini.id


async def test_review_details_carry_make_model_fields(db):
    db.add(AssetModel(make="Cisco", model="Nexus 9336C"))
    await db.commit()
    job_id, _ = await _job(db)

    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, job_id)
    assert job.status == "completed"

    details = job.results["details"]
    review = [d for d in details if d["status"] == "review"]
    assert {d["make_model"] for d in review} == {
        "Dell Dell PowerEdge R720", "HPE DL380"}
    dell = next(d for d in review if d["make_model"].startswith("Dell"))
    assert dell["suggested_make"] == "Dell"
    assert dell["suggested_model"] == "PowerEdge R720"   # doubled-make stripped

    created = [d for d in details if d["status"] == "created"]
    assert created
    assert all("make_model" not in d or d.get("match_method") != "review"
               for d in created)


async def test_only_rows_filters_both_phases(db):
    job_id, _ = await _job(db, options={"only_rows": [3]})

    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, job_id)
    assert job.status == "completed"
    assert job.total_rows == 1
    summary = job.results["summary"]
    assert summary["total_rows"] == 1
    assert summary["review"] == 1
    details = job.results["details"]
    assert len(details) == 1
    assert details[0]["row"] == 3

    # flip to commit the way the commit endpoint does
    job.phase = "commit"
    job.status = "queued"
    job.processed_rows = 0
    job.created_count = 0
    job.updated_count = 0
    job.error_count = 0
    job.results = None
    job.cancel_requested = False
    job.started_at = None
    job.finished_at = None
    await db.commit()

    assert await run_once(get_sessionmaker()) is True
    await db.refresh(job)
    assert job.status == "completed"
    assert job.total_rows == 1
    assert job.results["summary"]["total_rows"] == 1
    assert len(job.results["details"]) == 1
    assert job.results["details"][0]["row"] == 3

    # rows 2 and 4 (S1/S3) were never touched by either phase
    assert await db.scalar(select(func.count()).select_from(Asset)
                           .where(Asset.serial_number.in_(["s1", "s3"]))) == 0


async def test_review_reprocess_never_reuses_a_same_name_asset(db):
    """Two blank-serial rows share a name; row 3 goes to review. Reprocessing
    only row 3 sees a lone "patch panel" in its subset, but it must still get
    its OWN asset instead of reusing row 2's and overwriting its placement."""
    from serversherpa.db.models import InitiativeAsset
    csv = (b"Serial Number,Asset Name,Asset Make,Asset Model,Source Rack\n"
           b",patch panel,,,R1\n"
           b",patch panel,Zzz,Nope 9,R2\n")
    job_id, ini_id = await _job(
        db, phase="commit", content=csv,
        options={"generate_serials": True, "make_model_mode": "fuzzy"})
    assert await run_once(get_sessionmaker()) is True
    first = await db.get(ImportJob, job_id)
    assert first.results["summary"]["created"] == 1
    assert first.results["summary"]["review"] == 1
    row2 = next(d for d in first.results["details"] if d["row"] == 2)
    assert row2["status"] == "created" and row2["serial_number"].startswith("gnrtd-")

    key = f"import-jobs/{ini_id}/reprocess/ft.csv"
    await put_object(key, csv, "text/csv")
    child = ImportJob(kind="move_assets", initiative_id=ini_id,
                      filename="ft.csv", phase="commit", status="queued",
                      file_key=key,
                      options={"generate_serials": True,
                               "make_model_mode": "force", "only_rows": [3]})
    db.add(child)
    await db.commit()
    child_id = child.id

    assert await run_once(get_sessionmaker()) is True
    child = await db.get(ImportJob, child_id)
    await db.refresh(child)
    assert child.status == "completed"
    detail = child.results["details"][0]
    assert detail["row"] == 3
    assert detail["status"] == "created"             # not "updated"
    assert detail["asset_created"] is True
    assert detail["serial_generated"] is True
    assert detail["serial_number"] != row2["serial_number"]
    assert detail["match_method"] == "force_created"  # model matching ran as normal

    assets = (await db.scalars(select(Asset).where(
        Asset.name == "patch panel"))).all()
    assert len(assets) == 2
    racks = {a.serial_number: assoc.source_rack for a, assoc in (await db.execute(
        select(Asset, InitiativeAsset)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id)
        .where(InitiativeAsset.initiative_id == ini_id))).all()}
    assert racks[row2["serial_number"]] == "R1"      # row 2's placement untouched
    assert racks[detail["serial_number"]] == "R2"
