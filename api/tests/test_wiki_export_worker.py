"""The wiki worker's `export` job (Phase 3, spec §8): a page as PDF, Word
or Markdown, and folders/spaces as a .zip — published content only, only
what the requester can view (rebuilt from their access when the job
runs), never-published pages named in `_skipped.txt`, links between
exported pages made relative, images inlined (PDF/Word) or written into
`assets/` (Markdown), files at their current version. Then the upload,
the requester's notification, failures (at once for what can't be
exported, retried otherwise) and the 7-day retention sweep.

The wiki server's renderer is an httpx MockTransport with a tiny
renderer of its own, WeasyPrint is replaced by a stand-in that records
the HTML it was given, LibreOffice by a stand-in `convert.run`, and
storage by a dict — except in the one test that runs WeasyPrint for
real (skipped where it can't be imported)."""
import base64
import html
import io
import json
import os
import struct
import sys
import types
import uuid
import zipfile
import zlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Notification,
    WikiFile,
    WikiFileVersion,
    WikiJob,
    WikiNode,
    WikiPageAsset,
    WikiSpace,
)
from serversherpa.services import storage
from serversherpa.wiki import convert, export, export_html, tree, worker
from serversherpa.wiki.content import PUBLIC_PAGE_TEXT
from tests.wiki_helpers import _create, _setup, publish_via_db

TOKEN = "export-service-token-for-tests"


def _png() -> bytes:
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * 4 for _ in range(4))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PNG = _png()


# ── stand-ins ────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def service_token():
    before = os.environ.get("SS_WIKI_SERVICE_TOKEN")
    os.environ["SS_WIKI_SERVICE_TOKEN"] = TOKEN
    get_settings.cache_clear()
    yield
    if before is None:
        os.environ.pop("SS_WIKI_SERVICE_TOKEN", None)
    else:
        os.environ["SS_WIKI_SERVICE_TOKEN"] = before
    get_settings.cache_clear()


@pytest.fixture
def settings_env():
    """Set SS_* settings for one test (the cached settings are rebuilt)."""
    saved: dict[str, str | None] = {}

    def set_env(name, value):
        saved.setdefault(name, os.environ.get(name))
        os.environ[name] = str(value)
        get_settings.cache_clear()
    yield set_env
    for name, value in saved.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    get_settings.cache_clear()


class FakeStorage:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.uploads: list[tuple[str, str, bytes]] = []
        self.deleted: list[str] = []

    async def download_to(self, key, path):
        Path(path).write_bytes(self.objects[key])

    async def upload_from(self, path, key, content_type):
        data = Path(path).read_bytes()
        self.uploads.append((key, content_type, data))
        self.objects[key] = data

    async def delete_object(self, key):
        self.deleted.append(key)
        self.objects.pop(key, None)

    async def list_keys(self, prefix):
        return sorted(k for k in self.objects if k.startswith(prefix))


@pytest.fixture
def store(monkeypatch):
    fake = FakeStorage()
    monkeypatch.setattr(storage, "download_to", fake.download_to)
    monkeypatch.setattr(storage, "upload_from", fake.upload_from)
    monkeypatch.setattr(storage, "delete_object", fake.delete_object)
    monkeypatch.setattr(storage, "list_keys", fake.list_keys)
    return fake


def _render(node) -> str:
    """Just enough of the shared schema's HTML for the export to work on."""
    kind = node.get("type")
    inner = "".join(_render(c) for c in node.get("content") or [])
    attrs = node.get("attrs") or {}
    if kind == "paragraph":
        return f"<p>{inner}</p>"
    if kind == "heading":
        return f"<h{attrs.get('level', 1)}>{inner}</h{attrs.get('level', 1)}>"
    if kind == "text":
        out = html.escape(node["text"])
        for mark in node.get("marks") or []:
            if mark["type"] == "link":
                out = f'<a target="_blank" href="{html.escape(mark["attrs"]["href"])}">{out}</a>'
            elif mark["type"] == "bold":
                out = f"<strong>{out}</strong>"
            elif mark["type"] == "commentThread":
                out = f'<span class="wiki-comment-mark">{out}</span>'
        return out
    if kind == "wikiImage":
        return (f'<figure data-wiki-image="{attrs["assetId"]}"><img '
                f'alt="{html.escape(attrs.get("alt", ""))}"></figure>')
    if kind == "pageLink":
        return f'<a data-page-link="{attrs["nodeId"]}" href="/n/{attrs["nodeId"]}"></a>'
    return inner


class FakeRenderer:
    """The wiki server's /internal/render, as an httpx transport."""

    def __init__(self, status=200):
        self.status = status
        self.requests: list[httpx.Request] = []
        self.docs: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        doc = json.loads(request.content)["doc"]
        self.docs.append(doc)
        if self.status != 200:
            return httpx.Response(self.status, json={"detail": {"code": "boom"}})
        return httpx.Response(200, json={"html": _render(doc)})


@pytest.fixture
def renderer(monkeypatch):
    fake = FakeRenderer()
    monkeypatch.setattr(export_html, "_transport", httpx.MockTransport(fake.handler))
    return fake


@pytest.fixture
def pdfs(monkeypatch):
    """WeasyPrint's stand-in: records each document, returns a tiny PDF."""
    documents: list[str] = []

    async def fake(document, workdir):
        documents.append(document)
        return f"%PDF-fake {len(documents)}".encode()
    monkeypatch.setattr(export_html, "html_to_pdf", fake)
    return documents


class FakeSoffice:
    def __init__(self):
        self.calls: list[list[str]] = []

    async def run(self, cmd, *, timeout, max_stdout=None):
        self.calls.append(list(cmd))
        outdir = Path(cmd[cmd.index("--outdir") + 1])
        for src in cmd[cmd.index("--outdir") + 2:]:
            (outdir / f"{Path(src).stem}.docx").write_bytes(
                b"DOCX from " + Path(src).read_bytes()[:4000])
        return 0, b"", b""


@pytest.fixture
def soffice(monkeypatch):
    fake = FakeSoffice()
    monkeypatch.setattr(convert, "run", fake.run)
    return fake


# ── fixtures ─────────────────────────────────────────────────────────


def t(value, *marks):
    node = {"type": "text", "text": value}
    if marks:
        node["marks"] = list(marks)
    return node


def p(*content):
    return {"type": "paragraph", "content": list(content)}


def page_link(node_id):
    return {"type": "pageLink", "attrs": {"nodeId": str(node_id)}}


def link(node_id):
    return {"type": "link", "attrs": {"href": f"/n/{node_id}"}}


def image(asset_id, alt="Rack"):
    return {"type": "wikiImage", "attrs": {"assetId": str(asset_id), "alt": alt, "caption": ""}}


async def _hide(client, s, node):
    """Only the space's manager (the owner) can see `node` now."""
    resp = await client.put(f"/wiki/nodes/{node['id']}/permissions", headers=s["owner"],
                            json={"inherit": False, "grants": []})
    assert resp.status_code == 200, resp.text


async def _asset(db, store, page, filename="rack.png", data=PNG, content_type="image/png"):
    key = f"wiki/assets/{uuid.uuid4()}/{filename}"
    store.objects[key] = data
    asset = WikiPageAsset(node_id=uuid.UUID(page["id"]), storage_key=key, filename=filename,
                          content_type=content_type, size_bytes=len(data))
    db.add(asset)
    await db.commit()
    return asset.id


async def _file(db, store, s, parent, title="manual.pdf", data=b"%PDF manual"):
    space = await db.get(WikiSpace, uuid.UUID(s["space"]["id"]))
    parent_row = await db.get(WikiNode, uuid.UUID(parent["id"]))
    node = await tree.create_node(db, space=space, parent=parent_row, kind="file",
                                  title=title, actor_id=None)
    key = f"wiki/files/{uuid.uuid4()}/{title}"
    store.objects[key] = data
    db.add(WikiFile(node_id=node.id, description=""))
    version = WikiFileVersion(node_id=node.id, version_no=1, storage_key=key, filename=title,
                              content_type="application/pdf", size_bytes=len(data),
                              preview_kind="native", preview_status="ready",
                              extract_status="skipped")
    db.add(version)
    await db.flush()
    (await db.get(WikiFile, node.id)).current_version_id = version.id
    await db.commit()
    return node


async def _request(client, headers, expect=202, **body):
    resp = await client.post("/wiki/exports", headers=headers, json=body)
    assert resp.status_code == expect, resp.text
    return uuid.UUID(resp.json()["job_id"])


async def _run(db, job_id) -> WikiJob:
    assert await worker.run_once() is True
    return await db.scalar(select(WikiJob).where(WikiJob.id == job_id)
                           .execution_options(populate_existing=True))


async def _notes(db, person_id):
    return (await db.scalars(select(Notification).where(Notification.person_id == person_id)
                             .execution_options(populate_existing=True))).all()


def _zip(store) -> zipfile.ZipFile:
    assert len(store.uploads) == 1
    return zipfile.ZipFile(io.BytesIO(store.uploads[0][2]))


# ── a single page ────────────────────────────────────────────────────


async def test_a_page_as_pdf(client, db, store, renderer, pdfs):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    cabling = await _create(client, s["owner"], s["space"], "Cabling", kind="page")
    await publish_via_db(db, cabling["id"])
    secret = await _create(client, s["owner"], s["space"], "Secret plans", kind="page")
    await publish_via_db(db, secret["id"])
    await _hide(client, s, secret)
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page",
                         parent=folder)
    asset_id = await _asset(db, store, page)
    await publish_via_db(db, page["id"], {"type": "doc", "content": [
        p(t("See "), page_link(cabling["id"]), t(" and "), page_link(secret["id"]), t(".")),
        p(t("the checklist", link(cabling["id"])), t(" or "), t("the plan", link(secret["id"]))),
        p(t("Web", {"type": "link", "attrs": {"href": "https://example.com/g"}})),
        p(t("spare", {"type": "commentThread", "attrs": {"threadId": "x"}})),
        image(asset_id),
    ]})

    job_id = await _request(client, s["viewer"], node_id=page["id"], format="pdf")
    job = await _run(db, job_id)

    assert job.status == "done", job.error
    key = f"wiki/exports/{job_id}/Rack Guide.pdf"
    assert job.result["key"] == key and job.result["filename"] == "Rack Guide.pdf"
    assert store.uploads == [(key, "application/pdf", b"%PDF-fake 1")]

    # the renderer: the service token, and no comment anchors or page links
    request = renderer.requests[0]
    assert request.url.path == "/internal/render"
    assert request.headers["X-Wiki-Service-Token"] == TOKEN
    sent = json.dumps(renderer.docs[0])
    assert "commentThread" not in sent and "pageLink" not in sent

    [document] = pdfs
    assert "<title>Rack Guide</title>" in document
    assert "Tree Space › Runbooks" in document
    assert "Published " in document
    assert "See Cabling and " + PUBLIC_PAGE_TEXT in document
    assert "Secret plans" not in document
    assert "/n/" not in document                       # a single page links nowhere inside
    assert 'href="https://example.com/g"' in document
    assert "the checklist" in document and "the plan" in document
    assert "data:image/png;base64," in document
    assert "wiki-comment-mark" not in document

    [note] = await _notes(db, s["viewer_id"])
    assert note.kind == "wiki_export_ready"
    assert note.link.endswith(f"/exports/{job_id}")
    assert note.title == "Your export of “Rack Guide” is ready"
    assert note.payload["job_id"] == str(job_id)


async def test_a_page_as_markdown(client, db, store, renderer):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page")
    asset_id = await _asset(db, store, page)
    await publish_via_db(db, page["id"], {"type": "doc", "content": [
        p(t("Check the "), t("breaker", {"type": "bold"})), image(asset_id)]})

    job = await _run(db, await _request(client, s["viewer"], node_id=page["id"], format="md"))

    assert job.status == "done", job.error
    [(key, content_type, data)] = store.uploads
    assert key.endswith("/Rack Guide.md") and content_type.startswith("text/markdown")
    # a lone Markdown file has nowhere to put images
    assert data.decode() == "# Rack Guide\n\nCheck the **breaker**\n\n*\\[Image: Rack\\]*\n"
    assert renderer.requests == []


async def test_a_page_as_word(client, db, store, renderer, soffice):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page")
    await publish_via_db(db, page["id"], {"type": "doc", "content": [p(t("Body"))]})

    job = await _run(db, await _request(client, s["viewer"], node_id=page["id"], format="docx"))

    assert job.status == "done", job.error
    [cmd] = soffice.calls
    assert cmd[0] == "soffice" and "docx:MS Word 2007 XML" in cmd
    assert cmd[-1].endswith(".html")
    [(key, content_type, data)] = store.uploads
    assert key.endswith("/Rack Guide.docx")
    assert content_type == export.CONTENT_TYPES["docx"]
    assert data.startswith(b"DOCX from <!doctype html>")


# ── zips and permissions ─────────────────────────────────────────────


async def _tree(client, db, store, s):
    """Runbooks/ with: A (links to D and Hidden, embeds an image),
    Hidden (only the owner), C (never published) holding D, a file."""
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    a = await _create(client, s["owner"], s["space"], "A", kind="page", parent=folder)
    hidden = await _create(client, s["owner"], s["space"], "Hidden", kind="page", parent=folder)
    await publish_via_db(db, hidden["id"])
    await _hide(client, s, hidden)
    c = await _create(client, s["owner"], s["space"], "C", kind="page", parent=folder)
    d = await _create(client, s["owner"], s["space"], "D", kind="page", parent=c)
    await publish_via_db(db, d["id"], {"type": "doc", "content": [p(t("Dee"))]})
    await _file(db, store, s, folder)
    asset_id = await _asset(db, store, a)
    await publish_via_db(db, a["id"], {"type": "doc", "content": [
        p(t("Go to "), page_link(d["id"]), t(", not "), page_link(hidden["id"])),
        image(asset_id)]})
    return folder


async def test_a_folder_zip_for_a_reader(client, db, store, renderer):
    s = await _setup(client, db)
    folder = await _tree(client, db, store, s)

    job = await _run(db, await _request(client, s["viewer"], node_id=folder["id"],
                                        format="zip", zip_format="md"))

    assert job.status == "done", job.error
    assert store.uploads[0][0].endswith("/Runbooks.zip")
    assert store.uploads[0][1] == "application/zip"
    zf = _zip(store)
    # a reader never sees the unpublished C — nor, under it, D; nor Hidden
    assert sorted(zf.namelist()) == ["Runbooks/", "Runbooks/A.md", "Runbooks/manual.pdf",
                                     "assets/rack.png"]
    assert zf.read("Runbooks/manual.pdf") == b"%PDF manual"
    assert zf.read("assets/rack.png") == PNG
    text = zf.read("Runbooks/A.md").decode()
    assert text.startswith("# A\n")
    # D is viewable (just not in this export): its title, unlinked
    assert f"Go to D, not {PUBLIC_PAGE_TEXT}" in text
    assert "![Rack](../assets/rack.png)" in text
    for name in zf.namelist():
        assert "Hidden" not in name
        assert b"Hidden" not in zf.read(name)


async def test_a_folder_zip_for_an_editor(client, db, store, renderer):
    s = await _setup(client, db)
    folder = await _tree(client, db, store, s)

    job = await _run(db, await _request(client, s["editor"], node_id=folder["id"],
                                        format="zip", zip_format="md"))

    assert job.status == "done", job.error
    assert job.result["skipped"] == 1 and job.result["files"] == 1
    zf = _zip(store)
    assert sorted(zf.namelist()) == ["Runbooks/", "Runbooks/A.md", "Runbooks/C/D.md",
                                     "Runbooks/manual.pdf", "_skipped.txt", "assets/rack.png"]
    assert "Runbooks/C" in zf.read("_skipped.txt").decode().splitlines()
    assert f"Go to [D](C/D.md), not {PUBLIC_PAGE_TEXT}" in zf.read("Runbooks/A.md").decode()


async def test_a_space_zip_as_pdf(client, db, store, renderer, pdfs):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    first = await _create(client, s["owner"], s["space"], "Same", kind="page", parent=folder)
    second = await _create(client, s["owner"], s["space"], "same", kind="page", parent=folder)
    await _create(client, s["owner"], s["space"], "Empty")
    for page in (first, second):
        await publish_via_db(db, page["id"], {"type": "doc", "content": [
            p(t("to the other", link(second["id"] if page is first else first["id"])))]})

    job = await _run(db, await _request(client, s["viewer"], space_key=s["space"]["key"],
                                        format="zip"))

    assert job.status == "done", job.error
    names = sorted(_zip(store).namelist())
    # the home page (published when the space was made), and unique names
    # however the titles differ only in case
    assert names == ["Empty/", "Guides/", "Guides/Same.pdf", "Guides/same (2).pdf",
                     "Tree Space.pdf"]
    assert job.result["filename"] == "Tree Space.zip"
    by_title = {d.split("<title>")[1].split("</title>")[0]: d for d in pdfs}
    assert 'href="same%20%282%29.pdf"' in by_title["Same"]
    assert 'href="Same.pdf"' in by_title["same"]


async def test_a_word_zip_converts_every_page_in_one_run(client, db, store, renderer, soffice):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    for title in ("One", "Two"):
        page = await _create(client, s["owner"], s["space"], title, kind="page", parent=folder)
        await publish_via_db(db, page["id"], {"type": "doc", "content": [p(t(title))]})

    job = await _run(db, await _request(client, s["viewer"], node_id=folder["id"],
                                        format="zip", zip_format="docx"))

    assert job.status == "done", job.error
    [cmd] = soffice.calls
    assert len([c for c in cmd if c.endswith(".html")]) == 2
    zf = _zip(store)
    assert sorted(zf.namelist()) == ["Guides/", "Guides/One.docx", "Guides/Two.docx"]
    assert b"<title>Two</title>" in zf.read("Guides/Two.docx")


# ── failures ─────────────────────────────────────────────────────────


async def test_a_deleted_page_fails_at_once(client, db, store, renderer, pdfs):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page")
    await publish_via_db(db, page["id"])
    job_id = await _request(client, s["viewer"], node_id=page["id"], format="pdf")
    resp = await client.delete(f"/wiki/nodes/{page['id']}", headers=s["owner"])
    assert resp.status_code == 200, resp.text

    job = await _run(db, job_id)

    assert job.status == "failed" and job.attempts == 1
    assert "Rack Guide" in job.result["message"]
    assert store.uploads == [] and pdfs == []
    [note] = await _notes(db, s["viewer_id"])
    assert note.kind == "wiki_export_failed"
    assert note.title == "Your export of “Rack Guide” failed"
    assert note.body == job.result["message"]
    body = (await client.get(f"/wiki/exports/{job_id}", headers=s["viewer"])).json()
    assert body["status"] == "failed" and body["error"] == job.result["message"]


async def test_losing_access_before_the_job_runs(client, db, store, renderer, pdfs):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page")
    await publish_via_db(db, page["id"])
    job_id = await _request(client, s["viewer"], node_id=page["id"], format="pdf")
    await _hide(client, s, page)

    job = await _run(db, job_id)

    assert job.status == "failed"
    assert store.uploads == []


async def test_a_render_failure_is_retried_then_fails(client, db, store, renderer, pdfs):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page")
    await publish_via_db(db, page["id"])
    renderer.status = 503
    job_id = await _request(client, s["viewer"], node_id=page["id"], format="pdf")

    job = await _run(db, job_id)
    assert job.status == "queued" and job.attempts == 1
    assert "RenderError" in job.error
    assert await _notes(db, s["viewer_id"]) == []

    # the last try
    job.attempts = worker.MAX_ATTEMPTS - 1
    job.progress_at = None
    await db.commit()
    job = await _run(db, job_id)
    assert job.status == "failed"
    [note] = await _notes(db, s["viewer_id"])
    assert note.kind == "wiki_export_failed" and note.body == export.FAILED_MESSAGE


# ── progress, attempts and limits ────────────────────────────────────


async def test_word_export_progress_advances_between_batches(client, db, store, renderer,
                                                             monkeypatch):
    monkeypatch.setattr(export, "TOUCH_SECONDS", 0)
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    for i in range(7):
        page = await _create(client, s["owner"], s["space"], f"P{i}", kind="page", parent=folder)
        await publish_via_db(db, page["id"], {"type": "doc", "content": [p(t(f"P{i}"))]})
    job_id = await _request(client, s["viewer"], node_id=folder["id"], format="zip",
                            zip_format="docx")
    maker = get_sessionmaker()
    seen: list[tuple[datetime, float, int]] = []

    async def run(cmd, *, timeout, max_stdout=None):
        async with maker() as other:
            at = await other.scalar(select(WikiJob.progress_at).where(WikiJob.id == job_id))
        sources = cmd[cmd.index("--outdir") + 2:]
        seen.append((at, timeout, len(sources)))
        for src in sources:
            Path(src).with_suffix(".docx").write_bytes(b"DOCX")
        return 0, b"", b""
    monkeypatch.setattr(convert, "run", run)

    job = await _run(db, job_id)

    assert job.status == "done", job.error
    # batches of five, each with its own timeout, and progress between them
    assert [(timeout, n) for _, timeout, n in seen] == [(160, 5), (100, 2)]
    assert seen[1][0] > seen[0][0]
    assert job.progress_at > seen[1][0]


async def test_a_superseded_attempt_records_nothing(client, db, store, renderer, monkeypatch):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page")
    await publish_via_db(db, page["id"])
    job_id = await _request(client, s["viewer"], node_id=page["id"], format="pdf")
    maker = get_sessionmaker()

    async def slow_pdf(document, workdir):
        # meanwhile the stale sweep gave the job up and another worker took it
        async with maker() as other:
            row = await other.get(WikiJob, job_id)
            row.attempts += 1
            await other.commit()
        return b"%PDF-late"
    monkeypatch.setattr(export_html, "html_to_pdf", slow_pdf)

    job = await _run(db, job_id)

    assert job.status == "running" and job.attempts == 2 and job.result is None
    assert await _notes(db, s["viewer_id"]) == []


async def test_a_superseded_attempt_does_not_record_its_failure(client, db, store, renderer,
                                                                monkeypatch):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page")
    await publish_via_db(db, page["id"])
    job_id = await _request(client, s["viewer"], node_id=page["id"], format="pdf")
    maker = get_sessionmaker()

    async def failing_pdf(document, workdir):
        async with maker() as other:
            row = await other.get(WikiJob, job_id)
            row.status = "queued"
            await other.commit()
        raise RuntimeError("too late anyway")
    monkeypatch.setattr(export_html, "html_to_pdf", failing_pdf)

    job = await _run(db, job_id)

    assert job.status == "queued" and job.error is None
    assert await _notes(db, s["viewer_id"]) == []


async def test_touch_stops_a_superseded_attempt_before_it_uploads(client, db, store, renderer,
                                                                   monkeypatch):
    """Unlike a plain single-page export (no progress heartbeat at all —
    see `test_a_superseded_attempt_records_nothing`, which leaves an
    orphan upload the retention sweep has to clean up later), a batched
    export's `touch()` calls notice the lost ownership itself and stop
    the attempt before it ever uploads anything."""
    monkeypatch.setattr(export, "TOUCH_SECONDS", 0)
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    for title in ("One", "Two"):
        page = await _create(client, s["owner"], s["space"], title, kind="page", parent=folder)
        await publish_via_db(db, page["id"], {"type": "doc", "content": [p(t(title))]})
    job_id = await _request(client, s["viewer"], node_id=folder["id"], format="zip",
                            zip_format="docx")
    maker = get_sessionmaker()

    async def run(cmd, *, timeout, max_stdout=None):
        # meanwhile the stale sweep gave the job up and another worker
        # claimed it — this attempt is about to find out
        async with maker() as other:
            row = await other.get(WikiJob, job_id)
            row.attempts += 1
            await other.commit()
        sources = cmd[cmd.index("--outdir") + 2:]
        for src in sources:
            Path(src).with_suffix(".docx").write_bytes(b"DOCX")
        return 0, b"", b""
    monkeypatch.setattr(convert, "run", run)

    job = await _run(db, job_id)

    assert job.status == "running" and job.attempts == 2 and job.result is None
    assert store.uploads == []
    assert await _notes(db, s["viewer_id"]) == []


async def test_an_export_over_the_page_limit_fails(client, db, store, renderer, pdfs,
                                                   settings_env):
    settings_env("SS_WIKI_EXPORT_MAX_PAGES", 1)
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    for title in ("One", "Two"):
        page = await _create(client, s["owner"], s["space"], title, kind="page", parent=folder)
        await publish_via_db(db, page["id"])

    job = await _run(db, await _request(client, s["viewer"], node_id=folder["id"],
                                        format="zip"))

    assert job.status == "failed" and job.attempts == 1
    assert "2 pages" in job.result["message"] and "1 page" in job.result["message"]
    assert pdfs == [] and store.uploads == []


async def test_an_export_over_the_size_limit_fails(client, db, store, renderer, pdfs,
                                                   settings_env):
    settings_env("SS_WIKI_EXPORT_MAX_BYTES", 100)
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    await _file(db, store, s, folder, data=b"x" * 60)
    page = await _create(client, s["owner"], s["space"], "Rack", kind="page", parent=folder)
    asset_id = await _asset(db, store, page, data=b"y" * 60)
    await publish_via_db(db, page["id"], {"type": "doc", "content": [image(asset_id)]})

    job = await _run(db, await _request(client, s["viewer"], node_id=folder["id"],
                                        format="zip"))

    assert job.status == "failed"
    assert "too large" in job.result["message"]
    assert store.uploads == []


async def test_a_page_inlines_images_up_to_its_budget(client, db, store, renderer, pdfs,
                                                      monkeypatch):
    monkeypatch.setattr(export, "MAX_INLINE_PAGE_IMAGE_BYTES", len(PNG) + 1)
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page")
    first = await _asset(db, store, page)
    second = await _asset(db, store, page, filename="rear.png")
    await publish_via_db(db, page["id"], {"type": "doc", "content": [
        image(first, alt="Front"), image(second, alt="Rear")]})

    job = await _run(db, await _request(client, s["viewer"], node_id=page["id"], format="pdf"))

    assert job.status == "done", job.error
    [document] = pdfs
    assert document.count("data:image/png;base64,") == 1
    assert 'alt="Rear"' in document                      # past the budget: alt text only


# ── retention ────────────────────────────────────────────────────────


async def test_old_exports_are_purged(db, store):
    now = datetime.now(UTC)
    old = WikiJob(kind="export", status="done", created_at=now - timedelta(days=9),
                  finished_at=now - timedelta(days=8))
    failed = WikiJob(kind="export", status="failed", created_at=now - timedelta(days=9),
                     finished_at=now - timedelta(days=8), result={"message": "x"})
    recent = WikiJob(kind="export", status="done", created_at=now - timedelta(days=2),
                     finished_at=now - timedelta(days=2))
    running = WikiJob(kind="export", status="running", created_at=now - timedelta(days=9))
    other = WikiJob(kind="purge", status="done", created_at=now - timedelta(days=9),
                    finished_at=now - timedelta(days=8))
    db.add_all([old, failed, recent, running, other])
    await db.commit()
    old.result = {"key": f"wiki/exports/{old.id}/a.pdf", "filename": "a.pdf"}
    recent.result = {"key": f"wiki/exports/{recent.id}/b.pdf", "filename": "b.pdf"}
    await db.commit()
    store.objects.update({
        old.result["key"]: b"a",
        # a superseded attempt's orphan upload, made under the same job
        # id but never named by any job's result — only a prefix listing
        # finds it (see export.purge_old_exports)
        f"wiki/exports/{old.id}/orphan.pdf": b"orphan",
        recent.result["key"]: b"b",
    })

    retention = WikiJob(kind="retention", status="running")
    db.add(retention)
    await db.commit()
    await worker.process_job(db, retention)

    assert retention.result["exports"] == 2
    assert set(store.deleted) == {old.result["key"], f"wiki/exports/{old.id}/orphan.pdf"}
    assert old.result["key"] not in store.objects
    assert recent.result["key"] in store.objects
    left = set((await db.scalars(select(WikiJob.id).execution_options(
        populate_existing=True))).all())
    assert {recent.id, running.id, other.id, retention.id} <= left
    assert old.id not in left and failed.id not in left


# ── the pieces ───────────────────────────────────────────────────────


@pytest.mark.parametrize(("title", "expected"), [
    ("Rack Guide", "Rack Guide"),
    ("a/b\\c: d*?", "a-b-c- d--"),
    ("  ..hidden..  ", "hidden"),
    ("", "Untitled"),
    ("CON", "CON_"),
    ("x" * 300, "x" * export.MAX_NAME_CHARS),
    ("tab\there", "tab here"),
])
def test_safe_name(title, expected):
    assert export.safe_name(title) == expected


def test_finish_fragment():
    fragment = ('<p><a target="_blank" href="/n/B7C8D9E0-F1A2-4B3C-9D4E-5F6A7B8C9D0E">x</a>'
                '<a href="/n/00000000-0000-4000-8000-000000000000">y</a></p>'
                '<figure data-wiki-image="img" data-width="480"><img alt="A"></figure>'
                '<figure data-wiki-image="none"><img alt="B"></figure>'
                '<details data-details=""><summary>s</summary></details>')
    out = export_html.finish_fragment(
        fragment, hrefs={"b7c8d9e0-f1a2-4b3c-9d4e-5f6a7b8c9d0e": "../Other/Cab & le.pdf"},
        images={"img": "data:image/png;base64,AAAA"})
    assert 'href="../Other/Cab%20%26%20le.pdf"' in out
    assert '<a >y</a>' in out                             # unresolved: no link
    assert ('<img src="data:image/png;base64,AAAA" style="width: 480px; max-width: 100%" '
            'alt="A">') in out
    assert '<figure data-wiki-image="none"><img alt="B">' in out
    assert "<details open data-details" in out


async def test_real_weasyprint_pdf(tmp_path):
    pytest.importorskip("weasyprint")
    body = export_html.finish_fragment(
        '<h2>Setup</h2><p data-text-align="center">See <a href="/n/'
        'b7c8d9e0-f1a2-4b3c-9d4e-5f6a7b8c9d0e">Cabling</a></p>'
        '<div data-callout="warning"><p>Careful.</p></div>'
        '<figure data-wiki-image="img"><img alt="Rack"></figure>'
        # anything but a data: URI is never fetched
        '<p><img src="http://127.0.0.1:9/tracker.png" alt=""></p>'
        '<ul data-type="taskList"><li data-checked data-type="taskItem"><label>'
        '<input type="checkbox" checked="checked"><span></span></label><div><p>Done</p>'
        '</div></li></ul>',
        hrefs={"b7c8d9e0-f1a2-4b3c-9d4e-5f6a7b8c9d0e": "Other/Cabling.pdf"},
        images={"img": "data:image/png;base64," + base64.b64encode(PNG).decode()})
    document = export_html.page_document(title="Rack Guide", breadcrumbs=["Ops", "Runbooks"],
                                         published_at=datetime(2026, 9, 26, tzinfo=UTC),
                                         body=body)
    # the real thing: WeasyPrint in its own process
    pdf = await export_html.html_to_pdf(document, tmp_path)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 1000


async def test_html_to_pdf_error_reuses_converts_shared_tail(monkeypatch, tmp_path):
    """The WeasyPrint subprocess's error message is built from
    `convert.tail` — the same truncation/decoding soffice and pdftotext
    errors go through — not a second, inline copy of that logic."""
    stderr = ("boom: " + "z" * 600).encode()

    async def fake_run(cmd, *, timeout):
        return 1, b"", stderr
    monkeypatch.setattr(convert, "run", fake_run)

    with pytest.raises(convert.ConvertError) as exc_info:
        await export_html.html_to_pdf("<html></html>", tmp_path)
    assert str(exc_info.value) == f"WeasyPrint exited 1: {convert.tail(stderr)}"


def test_render_pdf_uses_the_data_only_fetcher_by_default(monkeypatch):
    """`render_pdf` called with no explicit `url_fetcher` wires up
    `_data_only_fetcher()` — never WeasyPrint's own, unrestricted default
    fetcher, which would happily load a `file://` image straight off the
    worker's disk. `test_the_pdf_fetcher_loads_data_uris_only` (below)
    covers what that fetcher itself refuses; this covers that
    `render_pdf`'s default path is actually wired to it, with a stand-in
    `weasyprint` module so the test needs no real WeasyPrint install."""
    calls: list[bool] = []

    def stand_in():
        calls.append(True)

        def fetch(url, *args, **kwargs):
            raise AssertionError(f"render_pdf's default path tried to fetch {url}")
        return fetch
    monkeypatch.setattr(export_html, "_data_only_fetcher", stand_in)

    class FakeHTML:
        def __init__(self, *, string, url_fetcher):
            self.string, self.url_fetcher = string, url_fetcher

        def write_pdf(self):
            return b"%PDF-fake"

    monkeypatch.setitem(sys.modules, "weasyprint", types.SimpleNamespace(HTML=FakeHTML))

    assert export_html.render_pdf("<html></html>") == b"%PDF-fake"
    assert calls == [True]


def test_the_pdf_fetcher_loads_data_uris_only():
    pytest.importorskip("weasyprint")
    fetcher = export_html._data_only_fetcher()
    for url in ("file:///etc/hosts", "http://127.0.0.1:9/x"):
        with pytest.raises(ValueError):
            fetcher(url)
    fetcher("data:text/plain;base64,aGk=")


def test_a_print_document_asks_only_for_data_uris():
    pytest.importorskip("weasyprint")
    urls_mod = pytest.importorskip("weasyprint.urls")
    if not hasattr(urls_mod, "URLFetcher"):
        pytest.skip("this WeasyPrint has no URLFetcher class")

    class Recording(urls_mod.URLFetcher):
        def __init__(self):
            super().__init__(allowed_protocols={"data"})
            self.urls: list[str] = []

        def fetch(self, url, headers=None):
            self.urls.append(url)
            return super().fetch(url, headers)

    body = export_html.finish_fragment(
        '<p>Hi</p><figure data-wiki-image="img"><img alt="Rack"></figure>',
        hrefs={}, images={"img": "data:image/png;base64," + base64.b64encode(PNG).decode()})
    document = export_html.page_document(title="T", breadcrumbs=["Ops"], published_at=None,
                                         body=body)
    recording = Recording()
    assert export_html.render_pdf(document, url_fetcher=recording).startswith(b"%PDF")
    assert recording.urls
    assert all(u.startswith("data:") for u in recording.urls)
