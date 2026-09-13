"""Import-job routes: creation, gating, lifecycle transitions, template."""

import uuid

from serversherpa.db.models import ImportJob
from serversherpa.services.storage import get_object

from .test_assets_api import login
from .test_initiative_assets_api import _move, _project, _view_only_headers

CSV = b"Serial Number,Asset Name\nSN-1,web-01\n"


def _upload(client, headers, iid, content=CSV, filename="ft.csv", **form):
    data = {"make_model_mode": "fuzzy", "generate_serials": "false", **form}
    return client.post(f"/initiatives/{iid}/assets/import-jobs",
                       headers=headers, data=data,
                       files={"file": (filename, content, "text/csv")})


async def test_create_job_stores_file_and_queues(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    resp = await _upload(client, headers, iid,
                         make_model_mode="hybrid", generate_serials="true")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["phase"] == "validate"
    assert body["status"] == "queued"
    assert body["filename"] == "ft.csv"
    assert body["options"] == {"make_model_mode": "hybrid",
                               "generate_serials": True}
    job = await db.get(ImportJob, uuid.UUID(body["id"]))
    assert job.kind == "move_assets"
    assert await get_object(job.file_key) == CSV

    status = await client.get(
        f"/initiatives/assets/import-jobs/{body['id']}", headers=headers)
    assert status.status_code == 200
    assert status.json()["id"] == body["id"]


async def test_create_job_validation_errors(client, db, seeded_user):
    headers = await login(client)
    pid = await _project(client, headers)
    resp = await _upload(client, headers, pid)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "not_a_move"

    iid = await _move(client, headers)
    resp = await _upload(client, headers, iid, filename="ft.txt")
    assert resp.json()["detail"]["code"] == "unsupported_file"
    resp = await _upload(client, headers, iid, content=b"")
    assert resp.json()["detail"]["code"] == "empty_file"
    resp = await _upload(client, headers, iid, make_model_mode="yolo")
    assert resp.json()["detail"]["code"] == "invalid_make_model_mode"


async def test_permission_gate(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    viewer = await _view_only_headers(db, client)
    resp = await _upload(client, viewer, iid)
    assert resp.status_code == 403
    resp = await client.get("/initiatives/assets/import-template",
                            headers=viewer)
    assert resp.status_code == 403


async def test_commit_requires_completed_validate(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    job_id = (await _upload(client, headers, iid)).json()["id"]

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/commit", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "job_not_ready"

    job = await db.get(ImportJob, uuid.UUID(job_id))
    job.status = "completed"
    job.results = {"summary": {}, "details": []}
    job.processed_rows = 1
    await db.commit()

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/commit", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["phase"] == "commit"
    assert body["status"] == "queued"
    assert body["processed_rows"] == 0
    assert body["results"] is None


async def test_cancel_lifecycle(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    job_id = (await _upload(client, headers, iid)).json()["id"]

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/cancel", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"   # queued -> cancelled directly

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/cancel", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "job_already_finished"


async def test_job_not_found(client, seeded_user):
    headers = await login(client)
    resp = await client.get(
        f"/initiatives/assets/import-jobs/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "import_job_not_found"


async def test_storage_key_never_embeds_the_uploaded_filename(
        client, db, seeded_user):
    """The object key is derived from the job id plus the (validated)
    extension — an attacker-chosen filename must not steer where the
    bytes land. The original name is kept on the job row for the worker
    and the UI."""
    headers = await login(client)
    iid = await _move(client, headers)
    resp = await _upload(client, headers, iid, filename="../../x.csv")
    assert resp.status_code == 201, resp.text
    job = await db.get(ImportJob, uuid.UUID(resp.json()["id"]))
    assert ".." not in job.file_key
    assert "x.csv" not in job.file_key
    assert job.file_key == f"import-jobs/{iid}/{job.id}/{job.id}.csv"
    assert job.filename == "../../x.csv"
    assert await get_object(job.file_key) == CSV

    resp = await _upload(client, headers, iid, filename="Roster.XLSX",
                         content=b"not really xlsx")
    job = await db.get(ImportJob, uuid.UUID(resp.json()["id"]))
    assert job.file_key.endswith(".xlsx")


async def test_template_downloads(client, seeded_user):
    headers = await login(client)
    resp = await client.get(
        "/initiatives/assets/import-template?format=csv", headers=headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert resp.text.splitlines()[0].startswith("Serial Number,Asset Name")

    resp = await client.get(
        "/initiatives/assets/import-template?format=xlsx", headers=headers)
    assert resp.status_code == 200
    assert "spreadsheetml" in resp.headers["content-type"]

    resp = await client.get(
        "/initiatives/assets/import-template?format=pdf", headers=headers)
    assert resp.status_code == 422
