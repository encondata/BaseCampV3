"""Reprocess endpoint: filtered child jobs over review-flagged rows.

Harness mirrors test_move_asset_import_api.py (client-driven upload +
lifecycle) plus test_import_reprocess_pipeline.py's worker driving
(run_once against the same real Postgres session used by `db`/`client`)."""

import uuid

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, ImportJob,
)
from serversherpa.imports.worker import run_once

from .test_assets_api import login
from .test_initiative_assets_api import _move, _view_only_headers

# row 2: S1/Cisco Nexus 9336C -> matches a seeded AssetModel -> created
# row 3: S2/Dell "Dell PowerEdge R720" -> unmatched -> review (doubled make)
# row 4: S3/HPE DL380 -> unmatched -> review
CSV = (b"Serial Number,Asset Name,Asset Make,Asset Model\n"
       b"S1,cisco-sw,Cisco,Nexus 9336C\n"
       b"S2,dell-srv,Dell,Dell PowerEdge R720\n"
       b"S3,hpe-srv,HPE,DL380\n")
REVIEW_ROWS = [3, 4]


def _upload(client, headers, iid, content=CSV, filename="ft.csv", **form):
    data = {"make_model_mode": "fuzzy", "generate_serials": "false", **form}
    return client.post(f"/initiatives/{iid}/assets/import-jobs",
                       headers=headers, data=data,
                       files={"file": (filename, content, "text/csv")})


async def _run_to_completed_parent(client, db, headers, iid):
    """Upload the fixture CSV, validate it, commit it, and return the
    completed parent job id. Row 1 (S1/Cisco) matches a seeded AssetModel
    and gets created; rows 2-3 (S2/S3) land in review both times."""
    db.add(AssetModel(make="Cisco", model="Nexus 9336C"))
    await db.commit()

    resp = await _upload(client, headers, iid)
    assert resp.status_code == 201, resp.text
    job_id = resp.json()["id"]

    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, uuid.UUID(job_id))
    assert job.status == "completed"
    assert job.results["summary"]["review"] == 2

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/commit", headers=headers)
    assert resp.status_code == 200, resp.text

    assert await run_once(get_sessionmaker()) is True
    await db.refresh(job)
    assert job.status == "completed"
    assert job.results["summary"]["review"] == 2
    return job_id


async def test_reprocess_creates_filtered_child(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    job_id = await _run_to_completed_parent(client, db, headers, iid)
    parent = await db.get(ImportJob, uuid.UUID(job_id))

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/reprocess", headers=headers)
    assert resp.status_code == 201, resp.text
    child = resp.json()
    assert child["id"] != str(job_id)
    assert child["phase"] == "validate" and child["status"] == "queued"
    assert child["filename"] == parent.filename

    child_row = await db.get(ImportJob, uuid.UUID(child["id"]))
    assert child_row.options["only_rows"] == REVIEW_ROWS
    assert child_row.options["reprocess_of"] == str(job_id)
    assert child_row.options["make_model_mode"] == "fuzzy"
    assert child_row.file_key == parent.file_key

    await db.refresh(parent)
    assert parent.results["summary"]["review"] == 2
    assert parent.phase == "commit" and parent.status == "completed"


async def test_reprocess_child_runs_only_flagged(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    job_id = await _run_to_completed_parent(client, db, headers, iid)

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/reprocess", headers=headers)
    assert resp.status_code == 201, resp.text
    child_id = resp.json()["id"]

    # supply the two catalog entries the review rows needed: Dell's model
    # string in the CSV double-counts the make ("Dell Dell PowerEdge
    # R720"), so it needs an alias; HPE's concatenation matches exactly.
    dell = AssetModel(make="Dell", model="PowerEdge R720")
    db.add(dell)
    await db.flush()
    db.add(AssetModelAlias(model_id=dell.id, alias="Dell Dell PowerEdge R720"))
    db.add(AssetModel(make="HPE", model="DL380"))
    await db.commit()

    assert await run_once(get_sessionmaker()) is True
    child = await db.get(ImportJob, uuid.UUID(child_id))
    assert child.status == "completed"
    assert child.total_rows == 2
    assert child.results["summary"]["total_rows"] == 2
    assert child.results["summary"]["created"] == 2
    assert child.results["summary"]["review"] == 0

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{child_id}/commit", headers=headers)
    assert resp.status_code == 200, resp.text

    assert await run_once(get_sessionmaker()) is True
    await db.refresh(child)
    assert child.status == "completed"
    assets = (await db.scalars(
        select(Asset).where(Asset.serial_number.in_(["s2", "s3"])))).all()
    assert {a.serial_number for a in assets} == {"s2", "s3"}


async def test_reprocess_gates_and_409s(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)

    # not completed (still queued right after upload) -> job_not_ready
    resp = await _upload(client, headers, iid)
    assert resp.status_code == 201, resp.text
    queued_job_id = resp.json()["id"]
    job = await db.get(ImportJob, uuid.UUID(queued_job_id))
    job.status = "running"
    await db.commit()
    resp = await client.post(
        f"/initiatives/assets/import-jobs/{queued_job_id}/reprocess",
        headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "job_not_ready"

    # completed with no review rows -> no_review_rows
    clean_csv = b"Serial Number,Asset Name\nSN-1,web-01\n"
    resp = await _upload(client, headers, iid, content=clean_csv,
                         filename="clean.csv")
    assert resp.status_code == 201, resp.text
    clean_job_id = resp.json()["id"]
    assert await run_once(get_sessionmaker()) is True
    clean_job = await db.get(ImportJob, uuid.UUID(clean_job_id))
    assert clean_job.status == "completed"
    assert clean_job.results["summary"]["review"] == 0
    resp = await client.post(
        f"/initiatives/assets/import-jobs/{clean_job_id}/reprocess",
        headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "no_review_rows"

    # ghost id -> import_job_not_found
    resp = await client.post(
        f"/initiatives/assets/import-jobs/{uuid.uuid4()}/reprocess",
        headers=headers)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "import_job_not_found"

    # no initiatives:change permission -> 403
    viewer = await _view_only_headers(db, client)
    resp = await client.post(
        f"/initiatives/assets/import-jobs/{clean_job_id}/reprocess",
        headers=viewer)
    assert resp.status_code == 403
