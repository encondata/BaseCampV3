"""import_jobs also carries Bulk Actions - Update assets in bulk: those jobs
belong to no move (initiative_id NULL) and keep their parsed rows in
`payload` while the admin previews and picks (migration 0073)."""

from serversherpa.db.models import ImportJob


async def test_asset_bulk_update_job_has_no_initiative_and_keeps_payload(db):
    job = ImportJob(kind="asset_bulk_update", initiative_id=None,
                    filename="a.csv", payload=[{"row": 2}])
    db.add(job)
    await db.commit()
    await db.refresh(job)
    assert job.initiative_id is None
    assert job.payload == [{"row": 2}]
