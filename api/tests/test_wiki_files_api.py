"""HTTP tests for the wiki uploads/files API — Task 6: presigned
uploads (POST /uploads, POST /uploads/complete), file versions and
their presigned read URLs, restore, page-asset URLs — plus direct tests
of `wiki.files`' filename/preview-kind/upload-token helpers.

Storage is mocked at the `serversherpa.services.storage` module (the
module `routes/wiki/files.py` imports and calls through, so patching
its attributes is enough — no real network for `head_object`;
`presign_put`/`presign_get` are pure local signing and run for real)."""
import uuid
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import event, select

from serversherpa.config import get_settings
from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    AuditLog,
    WikiFile,
    WikiJob,
    WikiPageAsset,
)
from serversherpa.services import storage
from serversherpa.wiki import files as wiki_files
from serversherpa.wiki.files import (
    UploadTokenError,
    inline_content_type,
    make_upload_token,
    needs_extract,
    normalize_content_type,
    preview_kind_for,
    read_upload_token,
    sanitize_filename,
)
from tests.wiki_helpers import _create, _setup, _space, publish_via_db

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


# ── wiki.files: sanitize_filename ────────────────────────────────────


@pytest.mark.parametrize("name, expected", [
    ("../../etc/passwd", "passwd"),
    ("..\\..\\windows\\win.ini", "win.ini"),
    ("a" * 200 + ".txt", "a" * 120),                    # truncated at 120, blind cut
    ("  spaced   out  name.txt  ", "spaced out name.txt"),
    ("héllo wörld.txt", "hllo wrld.txt"),                # non-ASCII dropped
    ("", "file"),
    ("   ", "file"),
    ("日本語", "file"),
])
def test_sanitize_filename(name, expected):
    assert sanitize_filename(name) == expected


# ── wiki.files: preview_kind_for / needs_extract ─────────────────────


@pytest.mark.parametrize("filename, content_type, expected", [
    ("photo.png", "image/png", "native"),
    ("photo.PNG", "IMAGE/PNG", "native"),                # case-insensitive
    ("icon.svg", "image/svg+xml", "none"),               # svg: safety exception
    ("icon.SVG", "application/octet-stream", "none"),    # svg by extension too
    ("report.pdf", "application/pdf", "native"),
    ("clip.mp4", "video/mp4", "native"),
    ("song.mp3", "audio/mpeg", "native"),
    ("notes.md", "application/octet-stream", "native"),  # text-like by extension
    ("data.csv", "text/csv", "native"),
    ("readme.txt", "text/plain", "native"),
    ("report.docx", DOCX, "pdf"),
    ("sheet.xlsx",
     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "pdf"),
    ("archive.zip", "application/zip", "none"),
    ("unknown", "", "none"),
    # parameters are ignored — svg stays 'none' even under an image name
    ("x.png", "image/svg+xml; charset=utf-8", "none"),
    ("photo.png", "image/png; charset=binary", "native"),
    # active markup never renders natively, even though it's text/*
    ("page.xhtml", "application/xhtml+xml", "none"),
    ("page.html", "text/html", "none"),
    ("page.txt", "text/html; charset=utf-8", "none"),
])
def test_preview_kind_for(filename, content_type, expected):
    assert preview_kind_for(filename, content_type) == expected


@pytest.mark.parametrize("filename, content_type, expected", [
    ("report.pdf", "application/pdf", True),
    ("report.docx", DOCX, True),
    ("notes.md", "application/octet-stream", True),
    ("data.csv", "text/csv", True),
    ("photo.png", "image/png", False),
    ("clip.mp4", "video/mp4", False),
    ("icon.svg", "image/svg+xml", False),
    ("archive.zip", "application/zip", False),
])
def test_needs_extract(filename, content_type, expected):
    assert needs_extract(filename, content_type) == expected


@pytest.mark.parametrize("raw, expected", [
    ("image/png", "image/png"),
    ("Image/SVG+XML; charset=utf-8", "image/svg+xml"),
    ("  text/plain ;charset=utf-8", "text/plain"),
    ("", "application/octet-stream"),
    ("  ", "application/octet-stream"),
    ("; charset=utf-8", "application/octet-stream"),
])
def test_normalize_content_type(raw, expected):
    assert normalize_content_type(raw) == expected


@pytest.mark.parametrize("filename, content_type, expected", [
    ("photo.png", "image/png", "image/png"),
    ("clip.mp4", "video/mp4", "video/mp4"),
    ("song.mp3", "audio/mpeg", "audio/mpeg"),
    ("report.pdf", "application/pdf", "application/pdf"),
    ("notes.md", "application/octet-stream", "text/plain; charset=utf-8"),
    ("data.csv", "text/csv", "text/plain; charset=utf-8"),
    ("icon.svg", "image/svg+xml", None),
    ("x.png", "image/svg+xml; charset=utf-8", None),
    ("page.xhtml", "application/xhtml+xml", None),
    ("page.html", "text/html", None),
    ("report.docx", DOCX, None),
    ("archive.zip", "application/zip", None),
    ("unknown", "", None),
])
def test_inline_content_type(filename, content_type, expected):
    assert inline_content_type(filename, content_type) == expected


def test_inline_content_type_honors_a_stored_preview_kind():
    # a version whose stored preview_kind isn't native is never inline
    assert inline_content_type("photo.png", "image/png", preview_kind="none") is None


# ── wiki.files: upload tokens ────────────────────────────────────────


def test_upload_token_round_trips_claims():
    claims = {"key": "wiki/x/y/z.png", "target": "node", "space_id": str(uuid.uuid4()),
             "parent_id": None, "node_id": None, "page_id": None,
             "filename": "z.png", "content_type": "image/png", "size": 10,
             "person": str(uuid.uuid4())}
    token = make_upload_token(claims)
    read = read_upload_token(token)
    for k, v in claims.items():
        assert read[k] == v
    assert read["aud"] == "wiki-upload"


def test_read_upload_token_rejects_garbage():
    with pytest.raises(UploadTokenError):
        read_upload_token("not-a-jwt")


def test_read_upload_token_rejects_an_expired_token(monkeypatch):
    monkeypatch.setattr(wiki_files, "UPLOAD_TOKEN_TTL", timedelta(seconds=-1))
    token = make_upload_token({"key": "k", "target": "node"})
    with pytest.raises(UploadTokenError):
        read_upload_token(token)


# ── HTTP: helpers ─────────────────────────────────────────────────────


async def _start(client, headers, **body):
    return await client.post("/wiki/uploads", headers=headers, json=body)


async def _complete(client, headers, upload_id, expect=201):
    resp = await client.post("/wiki/uploads/complete", headers=headers,
                             json={"upload_id": upload_id})
    assert resp.status_code == expect, resp.text
    return resp.json()


def _mock_head(monkeypatch, *, size, content_type="application/octet-stream"):
    async def _head(key):
        return {"size": size, "content_type": content_type}
    monkeypatch.setattr(storage, "head_object", _head)


def _mock_head_missing(monkeypatch):
    async def _head(key):
        return None
    monkeypatch.setattr(storage, "head_object", _head)


def _query(url):
    return parse_qs(urlparse(url).query)


async def _upload_node(client, s, monkeypatch, filename, content_type, *, size=5,
                       parent_id=None, headers=None):
    """Start + complete a new file node upload as the editor (or
    `headers`); returns the NodeOut."""
    headers = headers or s["editor"]
    resp = await _start(client, headers, target="node", space_id=s["space"]["id"],
                        parent_id=parent_id, filename=filename,
                        content_type=content_type, size=size)
    assert resp.status_code == 200, resp.text
    _mock_head(monkeypatch, size=size, content_type=content_type)
    return await _complete(client, headers, resp.json()["upload_id"])


async def _upload_asset(client, headers, monkeypatch, page_id, filename, content_type,
                        size=10):
    resp = await _start(client, headers, target="asset", page_id=page_id,
                        filename=filename, content_type=content_type, size=size)
    assert resp.status_code == 200, resp.text
    _mock_head(monkeypatch, size=size, content_type=content_type)
    return await _complete(client, headers, resp.json()["upload_id"])


async def _audits(db, entity_id, action):
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.entity_id == str(entity_id),
        AuditLog.action == action))).all()


def _capture_statements():
    statements: list[str] = []

    def _capture(conn, cursor, statement, *args):
        statements.append(statement)

    return statements, _capture


# ── POST /uploads ────────────────────────────────────────────────────


async def test_upload_start_normalizes_content_type_and_builds_the_key(client, db):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="Runbook.pdf",
                        content_type="Application/PDF", size=1234)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["headers"] == {"Content-Type": "application/pdf"}
    assert f"wiki/{s['space']['id']}/" in body["url"]
    assert "Runbook.pdf" in body["url"]
    assert isinstance(body["upload_id"], str) and body["upload_id"]


async def test_upload_too_large_is_refused(client, db):
    s = await _setup(client, db)
    max_bytes = get_settings().wiki_max_upload_bytes
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="huge.bin",
                        content_type="application/octet-stream", size=max_bytes + 1)
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "too_large"


async def test_upload_non_positive_size_is_422(client, db):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="empty.bin",
                        content_type="application/octet-stream", size=0)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_size"


async def test_viewer_cannot_start_an_upload(client, db):
    s = await _setup(client, db)
    resp = await _start(client, s["viewer"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="f.bin",
                        content_type="application/octet-stream", size=10)
    assert resp.status_code == 403

    # a space the viewer can't see at all is 404, not 403
    private = await _space(client, s["owner"], default_access="private", name="Private")
    resp2 = await _start(client, s["viewer"], target="node", space_id=private["id"],
                         parent_id=None, filename="f.bin",
                         content_type="application/octet-stream", size=10)
    assert resp2.status_code == 404


# ── POST /uploads/complete: node ────────────────────────────────────


async def test_upload_node_pdf_queues_extract_only(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="Runbook.pdf",
                        content_type="application/pdf", size=1234)
    body = resp.json()
    _mock_head(monkeypatch, size=1234, content_type="application/pdf")
    node = await _complete(client, s["editor"], body["upload_id"])

    assert node["kind"] == "file"
    assert node["title"] == "Runbook.pdf"
    assert node["owner"]["id"] == str(s["editor_id"])
    version = node["file"]["current_version"]
    assert version["filename"] == "Runbook.pdf"
    assert version["content_type"] == "application/pdf"
    assert version["preview_kind"] == "native"
    assert version["preview_status"] == "ready"
    assert version["extract_status"] == "pending"

    jobs = (await db.scalars(select(WikiJob).where(
        WikiJob.node_id == uuid.UUID(node["id"])))).all()
    assert [j.kind for j in jobs] == ["file_extract"]


async def test_upload_node_docx_queues_extract_and_preview(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="Policy.docx", content_type=DOCX, size=500)
    body = resp.json()
    _mock_head(monkeypatch, size=500, content_type=DOCX)
    node = await _complete(client, s["editor"], body["upload_id"])

    version = node["file"]["current_version"]
    assert version["preview_kind"] == "pdf"
    assert version["preview_status"] == "pending"
    assert version["extract_status"] == "pending"

    jobs = (await db.scalars(select(WikiJob).where(
        WikiJob.node_id == uuid.UUID(node["id"])))).all()
    assert sorted(j.kind for j in jobs) == ["file_extract", "file_preview"]
    assert {j.file_version_id for j in jobs} == {uuid.UUID(version["id"])}


async def test_upload_node_png_queues_no_jobs(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="Diagram.png",
                        content_type="image/png", size=200)
    body = resp.json()
    _mock_head(monkeypatch, size=200, content_type="image/png")
    node = await _complete(client, s["editor"], body["upload_id"])

    version = node["file"]["current_version"]
    assert version["preview_kind"] == "native"
    assert version["extract_status"] == "skipped"
    jobs = (await db.scalars(select(WikiJob).where(
        WikiJob.node_id == uuid.UUID(node["id"])))).all()
    assert jobs == []


async def test_upload_node_rejects_a_file_parent(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="a.txt",
                        content_type="text/plain", size=1)
    body = resp.json()
    _mock_head(monkeypatch, size=1, content_type="text/plain")
    file_node = await _complete(client, s["editor"], body["upload_id"])

    resp2 = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                         parent_id=file_node["id"], filename="b.txt",
                         content_type="text/plain", size=1)
    assert resp2.status_code == 422
    assert resp2.json()["detail"]["code"] == "bad_parent"


async def test_upload_complete_rejects_a_size_mismatch(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="f.bin",
                        content_type="application/octet-stream", size=100)
    body = resp.json()
    _mock_head(monkeypatch, size=99)
    resp2 = await client.post("/wiki/uploads/complete", headers=s["editor"],
                              json={"upload_id": body["upload_id"]})
    assert resp2.status_code == 422
    assert resp2.json()["detail"]["code"] == "upload_mismatch"


async def test_upload_complete_rejects_a_missing_object(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="f.bin",
                        content_type="application/octet-stream", size=100)
    body = resp.json()
    _mock_head_missing(monkeypatch)
    resp2 = await client.post("/wiki/uploads/complete", headers=s["editor"],
                              json={"upload_id": body["upload_id"]})
    assert resp2.status_code == 422
    assert resp2.json()["detail"]["code"] == "upload_mismatch"


async def test_upload_complete_rejects_a_garbled_token(client, db):
    s = await _setup(client, db)
    resp = await client.post("/wiki/uploads/complete", headers=s["editor"],
                             json={"upload_id": "not-a-jwt"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "stale_upload"


async def test_upload_complete_rejects_an_expired_token(client, db, monkeypatch):
    s = await _setup(client, db)
    monkeypatch.setattr(wiki_files, "UPLOAD_TOKEN_TTL", timedelta(seconds=-1))
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="f.bin",
                        content_type="application/octet-stream", size=10)
    body = resp.json()
    resp2 = await client.post("/wiki/uploads/complete", headers=s["editor"],
                              json={"upload_id": body["upload_id"]})
    assert resp2.status_code == 422
    assert resp2.json()["detail"]["code"] == "stale_upload"


async def test_upload_complete_rejects_someone_elses_token(client, db):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="f.bin",
                        content_type="application/octet-stream", size=10)
    body = resp.json()
    resp2 = await client.post("/wiki/uploads/complete", headers=s["owner"],
                              json={"upload_id": body["upload_id"]})
    assert resp2.status_code == 403


# ── POST /uploads/complete: version ─────────────────────────────────


async def test_upload_version_increments_and_updates_current(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="Data.csv",
                        content_type="text/csv", size=10)
    body = resp.json()
    _mock_head(monkeypatch, size=10, content_type="text/csv")
    node = await _complete(client, s["editor"], body["upload_id"])
    node_id = node["id"]

    resp = await _start(client, s["editor"], target="version", node_id=node_id,
                        filename="Data-v2.csv", content_type="text/csv", size=20)
    assert resp.status_code == 200, resp.text
    body2 = resp.json()
    _mock_head(monkeypatch, size=20, content_type="text/csv")
    node2 = await _complete(client, s["editor"], body2["upload_id"])
    assert node2["file"]["current_version"]["filename"] == "Data-v2.csv"
    assert node2["file"]["current_version"]["version_no"] == 2

    resp = await client.get(f"/wiki/files/{node_id}/versions", headers=s["editor"])
    assert resp.status_code == 200
    versions = resp.json()
    assert [v["version_no"] for v in versions] == [2, 1]
    assert [v["filename"] for v in versions] == ["Data-v2.csv", "Data.csv"]


async def test_viewer_cannot_upload_a_version(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="f.txt",
                        content_type="text/plain", size=1)
    body = resp.json()
    _mock_head(monkeypatch, size=1, content_type="text/plain")
    node = await _complete(client, s["editor"], body["upload_id"])

    resp = await _start(client, s["viewer"], target="version", node_id=node["id"],
                        filename="g.txt", content_type="text/plain", size=1)
    assert resp.status_code == 403


# ── POST /uploads/complete: asset ───────────────────────────────────


async def test_upload_asset_returns_asset_out(client, db, monkeypatch):
    s = await _setup(client, db)
    page = await _create(client, s["editor"], s["space"], "Doc", kind="page")
    resp = await _start(client, s["editor"], target="asset", page_id=page["id"],
                        filename="inline.png", content_type="image/png", size=99)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    _mock_head(monkeypatch, size=99, content_type="image/png")
    result = await _complete(client, s["editor"], body["upload_id"])

    assert result["filename"] == "inline.png"
    assert result["content_type"] == "image/png"
    assert result["size_bytes"] == 99
    assert uuid.UUID(result["id"])

    assets = (await db.scalars(select(WikiPageAsset).where(
        WikiPageAsset.node_id == uuid.UUID(page["id"])))).all()
    assert len(assets) == 1
    assert assets[0].filename == "inline.png"


# ── GET /files/{id}/url ──────────────────────────────────────────────


async def test_files_url_for_a_viewer_attachment_and_inline(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="Notes.txt",
                        content_type="text/plain", size=5)
    body = resp.json()
    _mock_head(monkeypatch, size=5, content_type="text/plain")
    node = await _complete(client, s["editor"], body["upload_id"])

    resp = await client.get(f"/wiki/files/{node['id']}/url", headers=s["viewer"])
    assert resp.status_code == 200
    out = resp.json()
    assert out["content_type"] == "text/plain"
    assert out["preview_status"] == "ready"
    qs = _query(out["url"])
    assert qs["response-content-disposition"][0].startswith("attachment")
    assert "response-content-type" not in qs

    resp2 = await client.get(f"/wiki/files/{node['id']}/url", headers=s["viewer"],
                             params={"disposition": "inline"})
    assert resp2.status_code == 200
    qs2 = _query(resp2.json()["url"])
    assert qs2["response-content-disposition"][0].startswith("inline")
    # text-like inline is forced to text/plain regardless of stored type,
    # so the bucket's origin can't serve it back as HTML/SVG
    assert qs2["response-content-type"][0] == "text/plain; charset=utf-8"


async def test_files_url_inline_image_keeps_its_stored_content_type(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="Pic.png",
                        content_type="image/png", size=5)
    body = resp.json()
    _mock_head(monkeypatch, size=5, content_type="image/png")
    node = await _complete(client, s["editor"], body["upload_id"])

    resp = await client.get(f"/wiki/files/{node['id']}/url", headers=s["viewer"],
                            params={"disposition": "inline"})
    qs = _query(resp.json()["url"])
    assert qs["response-content-type"][0] == "image/png"


async def test_files_url_preview_pending_returns_null(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="Policy.docx", content_type=DOCX, size=50)
    body = resp.json()
    _mock_head(monkeypatch, size=50, content_type=DOCX)
    node = await _complete(client, s["editor"], body["upload_id"])

    resp = await client.get(f"/wiki/files/{node['id']}/url", headers=s["editor"],
                            params={"preview": "true"})
    assert resp.status_code == 200
    assert resp.json() == {"url": None, "content_type": "application/pdf",
                           "preview_status": "pending"}


async def test_files_url_404_for_a_non_file_node(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["editor"], s["space"], "Folder")
    resp = await client.get(f"/wiki/files/{folder['id']}/url", headers=s["editor"])
    assert resp.status_code == 404


# ── PATCH /files/{id} ────────────────────────────────────────────────


async def test_patch_file_updates_description(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="f.txt",
                        content_type="text/plain", size=3)
    body = resp.json()
    _mock_head(monkeypatch, size=3, content_type="text/plain")
    node = await _complete(client, s["editor"], body["upload_id"])

    resp = await client.patch(f"/wiki/files/{node['id']}", headers=s["editor"],
                              json={"description": "A short note."})
    assert resp.status_code == 200, resp.text
    assert resp.json()["file"]["description"] == "A short note."


# ── restore ──────────────────────────────────────────────────────────


async def test_restore_file_version(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="v1.txt",
                        content_type="text/plain", size=3)
    body = resp.json()
    _mock_head(monkeypatch, size=3, content_type="text/plain")
    node = await _complete(client, s["editor"], body["upload_id"])
    node_id = node["id"]
    v1_id = node["file"]["current_version"]["id"]

    resp = await _start(client, s["editor"], target="version", node_id=node_id,
                        filename="v2.txt", content_type="text/plain", size=4)
    body2 = resp.json()
    _mock_head(monkeypatch, size=4, content_type="text/plain")
    await _complete(client, s["editor"], body2["upload_id"])

    resp = await client.post(f"/wiki/files/{node_id}/versions/{v1_id}/restore",
                             headers=s["editor"])
    assert resp.status_code == 201, resp.text
    restored = resp.json()
    assert restored["version_no"] == 3
    assert restored["filename"] == "v1.txt"
    assert restored["note"] == "Restored from version 1"

    row = await db.get(WikiFile, uuid.UUID(node_id))
    assert str(row.current_version_id) == restored["id"]


# ── POST /assets/urls ────────────────────────────────────────────────


async def test_asset_urls_omits_unknown_and_unviewable_ids(client, db, monkeypatch):
    s = await _setup(client, db)
    page = await _create(client, s["editor"], s["space"], "Doc", kind="page")
    await publish_via_db(db, page["id"])
    resp = await _start(client, s["editor"], target="asset", page_id=page["id"],
                        filename="visible.png", content_type="image/png", size=10)
    body = resp.json()
    _mock_head(monkeypatch, size=10, content_type="image/png")
    visible = await _complete(client, s["editor"], body["upload_id"])

    private = await _space(client, s["owner"], default_access="private", name="Private2")
    hidden_page = await _create(client, s["owner"], private, "Secret", kind="page")
    resp2 = await _start(client, s["owner"], target="asset", page_id=hidden_page["id"],
                         filename="hidden.png", content_type="image/png", size=10)
    body2 = resp2.json()
    _mock_head(monkeypatch, size=10, content_type="image/png")
    hidden = await _complete(client, s["owner"], body2["upload_id"])

    resp = await client.post("/wiki/assets/urls", headers=s["viewer"], json={
        "ids": [visible["id"], hidden["id"], str(uuid.uuid4())]})
    assert resp.status_code == 200
    urls = resp.json()["urls"]
    assert list(urls.keys()) == [visible["id"]]
    assert urls[visible["id"]]


async def test_asset_urls_empty_ids_returns_empty(client, db):
    s = await _setup(client, db)
    resp = await client.post("/wiki/assets/urls", headers=s["editor"], json={"ids": []})
    assert resp.status_code == 200
    assert resp.json() == {"urls": {}}


# ── fix wave 1: safe inline serving ─────────────────────────────────


async def test_upload_start_strips_content_type_parameters(client, db, monkeypatch):
    s = await _setup(client, db)
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=None, filename="x.png",
                        content_type="Image/SVG+XML; charset=utf-8", size=5)
    assert resp.status_code == 200, resp.text
    assert resp.json()["headers"] == {"Content-Type": "image/svg+xml"}
    _mock_head(monkeypatch, size=5, content_type="image/svg+xml")
    node = await _complete(client, s["editor"], resp.json()["upload_id"])
    version = node["file"]["current_version"]
    assert version["content_type"] == "image/svg+xml"
    assert version["preview_kind"] == "none"


@pytest.mark.parametrize("filename, content_type", [
    ("icon.svg", "image/svg+xml"),
    ("x.png", "image/svg+xml; charset=utf-8"),
    ("page.xhtml", "application/xhtml+xml"),
    ("page.html", "text/html"),
])
async def test_files_url_inline_active_content_is_served_as_an_attachment(
        client, db, monkeypatch, filename, content_type):
    s = await _setup(client, db)
    node = await _upload_node(client, s, monkeypatch, filename, content_type)
    resp = await client.get(f"/wiki/files/{node['id']}/url", headers=s["viewer"],
                            params={"disposition": "inline"})
    assert resp.status_code == 200, resp.text
    qs = _query(resp.json()["url"])
    assert qs["response-content-disposition"][0].startswith("attachment")
    assert qs["response-content-type"][0] == "application/octet-stream"


async def test_files_url_inline_office_original_is_served_as_an_attachment(
        client, db, monkeypatch):
    s = await _setup(client, db)
    node = await _upload_node(client, s, monkeypatch, "Policy.docx", DOCX)
    resp = await client.get(f"/wiki/files/{node['id']}/url", headers=s["viewer"],
                            params={"disposition": "inline"})
    qs = _query(resp.json()["url"])
    assert qs["response-content-disposition"][0].startswith("attachment")
    assert qs["response-content-type"][0] == "application/octet-stream"


async def test_asset_urls_serve_non_allowlisted_assets_as_attachments(
        client, db, monkeypatch):
    s = await _setup(client, db)
    page = await _create(client, s["editor"], s["space"], "Doc", kind="page")
    html = await _upload_asset(client, s["editor"], monkeypatch, page["id"],
                               "evil.html", "text/html")
    png = await _upload_asset(client, s["editor"], monkeypatch, page["id"],
                              "pic.png", "image/png")
    resp = await client.post("/wiki/assets/urls", headers=s["editor"],
                             json={"ids": [html["id"], png["id"]]})
    assert resp.status_code == 200, resp.text
    urls = resp.json()["urls"]

    html_qs = _query(urls[html["id"]])
    assert html_qs["response-content-disposition"][0].startswith("attachment")
    assert html_qs["response-content-type"][0] == "application/octet-stream"

    png_qs = _query(urls[png["id"]])
    assert png_qs["response-content-disposition"][0].startswith("inline")
    assert png_qs["response-content-type"][0] == "image/png"


# ── fix wave 1: upload re-validation ────────────────────────────────


async def test_upload_complete_rechecks_the_parent(client, db, monkeypatch):
    s = await _setup(client, db)
    folder = await _create(client, s["editor"], s["space"], "Folder")
    resp = await _start(client, s["editor"], target="node", space_id=s["space"]["id"],
                        parent_id=folder["id"], filename="a.pdf",
                        content_type="application/pdf", size=5)
    assert resp.status_code == 200, resp.text
    assert (await client.delete(f"/wiki/nodes/{folder['id']}",
                                headers=s["editor"])).status_code == 200

    _mock_head(monkeypatch, size=5, content_type="application/pdf")
    resp2 = await client.post("/wiki/uploads/complete", headers=s["editor"],
                              json={"upload_id": resp.json()["upload_id"]})
    assert resp2.status_code == 422, resp2.text
    assert resp2.json()["detail"]["code"] == "bad_parent"


@pytest.mark.parametrize("field", ["filename", "content_type"])
async def test_upload_start_bounds_filename_and_content_type(client, db, field):
    s = await _setup(client, db)
    body = {"target": "node", "space_id": s["space"]["id"], "parent_id": None,
            "filename": "a.txt", "content_type": "text/plain", "size": 5}
    body[field] = "a" * 256
    resp = await client.post("/wiki/uploads", headers=s["editor"], json=body)
    assert resp.status_code == 422, resp.text


# ── fix wave 1: restore re-queues pending work ──────────────────────


async def test_restoring_a_pending_version_queues_jobs_for_the_new_version(
        client, db, monkeypatch):
    s = await _setup(client, db)
    node = await _upload_node(client, s, monkeypatch, "Policy.docx", DOCX)
    v1_id = node["file"]["current_version"]["id"]
    resp = await _start(client, s["editor"], target="version", node_id=node["id"],
                        filename="Policy.png", content_type="image/png", size=7)
    _mock_head(monkeypatch, size=7, content_type="image/png")
    await _complete(client, s["editor"], resp.json()["upload_id"])

    resp = await client.post(f"/wiki/files/{node['id']}/versions/{v1_id}/restore",
                             headers=s["editor"])
    assert resp.status_code == 201, resp.text
    restored = resp.json()
    assert restored["preview_status"] == "pending"

    jobs = (await db.scalars(select(WikiJob).where(
        WikiJob.file_version_id == uuid.UUID(restored["id"])))).all()
    assert sorted(j.kind for j in jobs) == ["file_extract", "file_preview"]
    assert {j.node_id for j in jobs} == {uuid.UUID(node["id"])}


async def test_restoring_a_finished_version_queues_nothing(client, db, monkeypatch):
    s = await _setup(client, db)
    node = await _upload_node(client, s, monkeypatch, "Pic.png", "image/png")
    v1_id = node["file"]["current_version"]["id"]
    resp = await client.post(f"/wiki/files/{node['id']}/versions/{v1_id}/restore",
                             headers=s["editor"])
    assert resp.status_code == 201, resp.text
    jobs = (await db.scalars(select(WikiJob).where(
        WikiJob.file_version_id == uuid.UUID(resp.json()["id"])))).all()
    assert jobs == []


# ── fix wave 1: audit rows ──────────────────────────────────────────


async def test_file_changes_are_audited(client, db, monkeypatch):
    s = await _setup(client, db)
    node = await _upload_node(client, s, monkeypatch, "v1.txt", "text/plain", size=3)
    node_id = node["id"]
    v1_id = node["file"]["current_version"]["id"]
    [upload] = await _audits(db, node_id, "upload")
    assert upload.actor_person_id == s["editor_id"]
    assert upload.changes["filename"] == {"from": None, "to": "v1.txt"}

    resp = await _start(client, s["editor"], target="version", node_id=node_id,
                        filename="v2.txt", content_type="text/plain", size=4)
    _mock_head(monkeypatch, size=4, content_type="text/plain")
    await _complete(client, s["editor"], resp.json()["upload_id"])
    [version] = await _audits(db, node_id, "upload_version")
    assert version.changes["version_no"] == 2
    assert version.changes["filename"] == "v2.txt"

    resp = await client.post(f"/wiki/files/{node_id}/versions/{v1_id}/restore",
                             headers=s["editor"])
    assert resp.status_code == 201
    [restore] = await _audits(db, node_id, "restore")
    assert restore.changes["from_version_id"] == v1_id
    assert restore.changes["version_no"] == 3

    resp = await client.patch(f"/wiki/files/{node_id}", headers=s["editor"],
                              json={"description": "Now described."})
    assert resp.status_code == 200
    [update] = await _audits(db, node_id, "update")
    assert update.changes == {"description": {"from": "", "to": "Now described."}}


async def test_page_asset_upload_is_audited_on_the_page(client, db, monkeypatch):
    s = await _setup(client, db)
    page = await _create(client, s["editor"], s["space"], "Doc", kind="page")
    asset = await _upload_asset(client, s["editor"], monkeypatch, page["id"],
                                "inline.png", "image/png")
    [row] = await _audits(db, page["id"], "asset_upload")
    assert row.actor_person_id == s["editor_id"]
    assert row.changes == {"asset_id": asset["id"], "filename": "inline.png"}


# ── fix wave 1: version numbering locks the file row ────────────────


async def test_version_upload_and_restore_lock_the_file_row(client, db, monkeypatch):
    s = await _setup(client, db)
    node = await _upload_node(client, s, monkeypatch, "v1.txt", "text/plain", size=3)
    v1_id = node["file"]["current_version"]["id"]
    resp = await _start(client, s["editor"], target="version", node_id=node["id"],
                        filename="v2.txt", content_type="text/plain", size=4)
    _mock_head(monkeypatch, size=4, content_type="text/plain")

    engine = get_engine().sync_engine
    statements, listener = _capture_statements()
    event.listen(engine, "before_cursor_execute", listener)
    try:
        await _complete(client, s["editor"], resp.json()["upload_id"])
        upload_statements = list(statements)
        statements.clear()
        assert (await client.post(
            f"/wiki/files/{node['id']}/versions/{v1_id}/restore",
            headers=s["editor"])).status_code == 201
        restore_statements = list(statements)
    finally:
        event.remove(engine, "before_cursor_execute", listener)

    for captured in (upload_statements, restore_statements):
        locks = [i for i, st in enumerate(captured)
                 if "FROM wiki_files" in st and "FOR UPDATE" in st]
        numbering = [i for i, st in enumerate(captured)
                     if "max(wiki_file_versions.version_no)" in st]
        assert locks and numbering, captured
        assert locks[0] < numbering[0]


# ── fix wave 1: /assets/urls limits and visibility ──────────────────


async def test_asset_urls_caps_the_batch(client, db):
    s = await _setup(client, db)
    resp = await client.post("/wiki/assets/urls", headers=s["editor"],
                             json={"ids": [str(uuid.uuid4()) for _ in range(201)]})
    assert resp.status_code == 422


async def test_asset_urls_hide_never_published_pages_from_view_only_callers(
        client, db, monkeypatch):
    s = await _setup(client, db)
    draft = await _create(client, s["editor"], s["space"], "Draft", kind="page")
    asset = await _upload_asset(client, s["editor"], monkeypatch, draft["id"],
                                "pic.png", "image/png")

    resp = await client.post("/wiki/assets/urls", headers=s["viewer"],
                             json={"ids": [asset["id"]]})
    assert resp.json() == {"urls": {}}
    resp = await client.post("/wiki/assets/urls", headers=s["editor"],
                             json={"ids": [asset["id"]]})
    assert list(resp.json()["urls"]) == [asset["id"]]

    await publish_via_db(db, uuid.UUID(draft["id"]))
    resp = await client.post("/wiki/assets/urls", headers=s["viewer"],
                             json={"ids": [asset["id"]]})
    assert list(resp.json()["urls"]) == [asset["id"]]
