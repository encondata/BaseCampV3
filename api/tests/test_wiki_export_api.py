"""HTTP tests for exports (Phase 3, spec §8): `POST /wiki/exports` — what
each kind of node (and a space) may be exported as, view level, the
per-person limit on exports in progress — and `GET /wiki/exports/{id}`,
which only the requester can read, with a fresh download URL once done.

The worker side (rendering, zips, permissions at run time) is
test_wiki_export_worker.py. Presigning is local signing and runs for real."""
import uuid
from urllib.parse import parse_qs, unquote, urlparse

from sqlalchemy import select

from serversherpa.db.models import Client, WikiFile, WikiFileVersion, WikiJob, WikiNode
from serversherpa.wiki.export import FAILED_MESSAGE, MAX_ACTIVE_EXPORTS
from tests.wiki_helpers import _create, _setup, login_as, publish_via_db


async def _export(client, headers, expect=202, **body):
    resp = await client.post("/wiki/exports", headers=headers, json=body)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _page(client, s, db, title="Rack Guide", parent=None, publish=True):
    page = await _create(client, s["owner"], s["space"], title, kind="page", parent=parent)
    if publish:
        await publish_via_db(db, page["id"])
    return page


async def _job(db, job_id) -> WikiJob:
    return await db.scalar(select(WikiJob).where(WikiJob.id == uuid.UUID(job_id))
                           .execution_options(populate_existing=True))


async def test_export_a_page_queues_an_export_job(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)

    out = await _export(client, s["viewer"], node_id=page["id"], format="pdf")
    job = await _job(db, out["job_id"])
    assert job.kind == "export" and job.status == "queued"
    assert job.created_by == s["viewer_id"]
    assert job.node_id == uuid.UUID(page["id"])
    assert job.payload == {
        "requester": str(s["viewer_id"]), "node_id": page["id"], "format": "pdf",
        "zip_format": None, "title": "Rack Guide", "filename": "Rack Guide.pdf"}


async def test_formats_by_kind(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    lone = await _page(client, s, db, "Lone page", parent=folder)
    parent = await _page(client, s, db, "Parent page", parent=folder)
    await _page(client, s, db, "Child page", parent=parent)

    for fmt in ("pdf", "docx", "md"):
        await _export(client, s["owner"], node_id=lone["id"], format=fmt)
        await _export(client, s["owner"], node_id=parent["id"], format=fmt)
        # finished, so they don't count against the in-progress limit
        await db.execute(WikiJob.__table__.update().values(status="done"))
        await db.commit()

    resp = await _export(client, s["owner"], 422, node_id=lone["id"], format="zip")
    assert resp["detail"]["code"] == "bad_format"
    resp = await _export(client, s["owner"], 422, node_id=folder["id"], format="pdf")
    assert resp["detail"]["code"] == "bad_format"

    out = await _export(client, s["owner"], node_id=parent["id"], format="zip")
    assert (await _job(db, out["job_id"])).payload["zip_format"] == "pdf"
    out = await _export(client, s["owner"], node_id=folder["id"], format="zip", zip_format="md")
    job = await _job(db, out["job_id"])
    assert job.payload["zip_format"] == "md" and job.payload["filename"] == "Runbooks.zip"


async def test_a_zip_counts_only_subpages_the_caller_can_view(client, db):
    s = await _setup(client, db)
    parent = await _page(client, s, db, "Parent page")
    child = await _page(client, s, db, "Hidden child", parent=parent)
    resp = await client.put(f"/wiki/nodes/{child['id']}/permissions", headers=s["owner"],
                            json={"inherit": False, "grants": []})
    assert resp.status_code == 200, resp.text
    # to the reader the page has no subpages: like a leaf page
    resp = await _export(client, s["viewer"], 422, node_id=parent["id"], format="zip")
    assert resp["detail"]["code"] == "bad_format"
    await _export(client, s["owner"], node_id=parent["id"], format="zip")
    # a never-published subpage is invisible to a reader too
    other = await _page(client, s, db, "Other parent")
    await _page(client, s, db, "Draft child", parent=other, publish=False)
    await _export(client, s["viewer"], 422, node_id=other["id"], format="zip")
    await _export(client, s["editor"], node_id=other["id"], format="zip")


async def test_files_are_downloaded_not_exported(client, db):
    s = await _setup(client, db)
    node = WikiNode(space_id=uuid.UUID(s["space"]["id"]), kind="file", title="manual.pdf")
    db.add(node)
    await db.flush()
    db.add(WikiFile(node_id=node.id, description=""))
    db.add(WikiFileVersion(node_id=node.id, version_no=1, storage_key="k", filename="manual.pdf",
                           content_type="application/pdf", size_bytes=1, preview_kind="native"))
    await db.commit()
    resp = await _export(client, s["owner"], 422, node_id=str(node.id), format="pdf")
    assert resp["detail"]["code"] == "use_download"


async def test_a_single_page_must_be_published(client, db):
    s = await _setup(client, db)
    draft = await _page(client, s, db, "Draft", publish=False)
    resp = await _export(client, s["editor"], 422, node_id=draft["id"], format="md")
    assert resp["detail"]["code"] == "not_published"
    # a reader can't see a never-published page at all
    resp = await _export(client, s["viewer"], 404, node_id=draft["id"], format="md")
    assert resp["detail"]["code"] == "not_found"


async def test_needs_view_on_the_node(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    resp = await client.put(f"/wiki/nodes/{page['id']}/permissions", headers=s["owner"],
                            json={"inherit": False, "grants": []})
    assert resp.status_code == 200, resp.text
    resp = await _export(client, s["viewer"], 404, node_id=page["id"], format="pdf")
    assert resp["detail"]["code"] == "not_found"
    await _export(client, s["viewer"], 404, node_id=str(uuid.uuid4()), format="pdf")


async def test_export_a_space(client, db):
    s = await _setup(client, db)
    out = await _export(client, s["viewer"], space_key=s["space"]["key"], format="zip")
    job = await _job(db, out["job_id"])
    assert job.node_id is None
    assert job.payload["space_id"] == s["space"]["id"]
    assert job.payload["space_key"] == s["space"]["key"]
    assert job.payload["filename"] == "Tree Space.zip"

    resp = await _export(client, s["viewer"], 422, space_key=s["space"]["key"], format="pdf")
    assert resp["detail"]["code"] == "bad_format"
    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()
    outsider, _ = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    await _export(client, outsider, 404, space_key=s["space"]["key"], format="zip")
    await _export(client, s["viewer"], 404, space_key="no-such-space", format="zip")


async def test_body_validation(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    await _export(client, s["owner"], 422, format="pdf")
    await _export(client, s["owner"], 422, node_id=page["id"],
                  space_key=s["space"]["key"], format="zip")
    await _export(client, s["owner"], 422, node_id=page["id"], format="pdf", zip_format="md")
    await _export(client, s["owner"], 422, node_id=page["id"], format="html")


async def test_too_many_exports_in_progress(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    jobs = [await _export(client, s["viewer"], node_id=page["id"], format="pdf")
            for _ in range(MAX_ACTIVE_EXPORTS)]
    resp = await _export(client, s["viewer"], 429, node_id=page["id"], format="pdf")
    assert resp["detail"]["code"] == "too_many_exports"
    # someone else's exports don't count against you
    await _export(client, s["editor"], node_id=page["id"], format="pdf")

    job = await _job(db, jobs[0]["job_id"])
    job.status = "running"
    await db.commit()
    await _export(client, s["viewer"], 429, node_id=page["id"], format="pdf")
    job.status = "done"
    await db.commit()
    await _export(client, s["viewer"], node_id=page["id"], format="pdf")


async def test_only_the_requester_reads_an_export(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    out = await _export(client, s["viewer"], node_id=page["id"], format="md")

    resp = await client.get(f"/wiki/exports/{out['job_id']}", headers=s["viewer"])
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"id": out["job_id"], "status": "queued",
                           "filename": "Rack Guide.md", "url": None, "error": None}

    for other in (s["owner"], s["editor"]):
        resp = await client.get(f"/wiki/exports/{out['job_id']}", headers=other)
        assert resp.status_code == 404
    resp = await client.get(f"/wiki/exports/{uuid.uuid4()}", headers=s["viewer"])
    assert resp.status_code == 404

    # a job that isn't an export is never one
    purge = WikiJob(kind="purge", created_by=s["viewer_id"], payload={"keys": []})
    db.add(purge)
    await db.commit()
    resp = await client.get(f"/wiki/exports/{purge.id}", headers=s["viewer"])
    assert resp.status_code == 404


async def test_a_done_export_has_a_fresh_download_url(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    out = await _export(client, s["viewer"], node_id=page["id"], format="pdf")
    job = await _job(db, out["job_id"])
    key = f"wiki/exports/{job.id}/Rack Guide.pdf"
    job.status = "done"
    job.result = {"key": key, "filename": "Rack Guide.pdf"}
    await db.commit()

    body = (await client.get(f"/wiki/exports/{job.id}", headers=s["viewer"])).json()
    assert body["status"] == "done" and body["error"] is None
    url = urlparse(body["url"])
    assert unquote(url.path).endswith(key)
    query = parse_qs(url.query)
    assert "attachment" in query["response-content-disposition"][0]
    assert "Rack%20Guide.pdf" in query["response-content-disposition"][0]
    assert int(query["X-Amz-Expires"][0]) <= 600


async def test_a_failed_export_says_why(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    first = await _export(client, s["viewer"], node_id=page["id"], format="pdf")
    second = await _export(client, s["viewer"], node_id=page["id"], format="pdf")
    for job_id, result in ((first["job_id"], {"message": "“Rack Guide” was deleted."}),
                           (second["job_id"], None)):
        job = await _job(db, job_id)
        job.status = "failed"
        job.error = "RenderError: boom"
        job.result = result
    await db.commit()

    body = (await client.get(f"/wiki/exports/{first['job_id']}", headers=s["viewer"])).json()
    assert body["status"] == "failed" and body["url"] is None
    assert body["error"] == "“Rack Guide” was deleted."
    body = (await client.get(f"/wiki/exports/{second['job_id']}", headers=s["viewer"])).json()
    # the internal error never reaches the requester
    assert body["error"] == FAILED_MESSAGE
