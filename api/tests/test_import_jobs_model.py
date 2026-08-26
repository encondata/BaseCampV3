"""import_jobs table + the two deferred v2 columns on initiative_assets."""

from serversherpa.db.models import (
    Asset, ImportJob, Initiative, InitiativeAsset,
)


async def _move(db):
    ini = Initiative(name="Move X", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    return ini


async def test_import_job_defaults(db):
    ini = await _move(db)
    job = ImportJob(kind="move_assets", initiative_id=ini.id,
                    filename="ft.csv")
    db.add(job)
    await db.commit()
    await db.refresh(job)
    assert job.phase == "validate"
    assert job.status == "queued"
    assert job.file_key == ""
    assert job.options == {}
    assert (job.total_rows, job.processed_rows) == (0, 0)
    assert (job.created_count, job.updated_count, job.error_count) == (0, 0, 0)
    assert job.results is None
    assert job.cancel_requested is False
    assert job.error is None
    assert job.progress_at is None and job.started_at is None
    assert job.finished_at is None
    assert job.created_at is not None


async def test_initiative_asset_raw_ft_and_label_info(db):
    ini = await _move(db)
    asset = Asset(serial_number="sn-raw")
    db.add(asset)
    await db.flush()
    assoc = InitiativeAsset(
        initiative_id=ini.id, asset_id=asset.id,
        raw_ft={"Serial Number": "sn-raw", "Extra Col": "kept"})
    db.add(assoc)
    await db.commit()
    await db.refresh(assoc)
    assert assoc.raw_ft == {"Serial Number": "sn-raw", "Extra Col": "kept"}
    assert assoc.label_info is None
