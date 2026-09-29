"""wiki-worker: claiming wiki_jobs, text extraction (pdf / office / text),
PDF previews for office files, retries with backoff, purge (reference
counted across every row that can share a storage key), the trash
expiry sweep, stale re-queue, the read-only pause, and the CLI command.

Storage is patched at `serversherpa.services.storage` (`download_to`,
`upload_from`, `delete_object`) and every subprocess goes through a
patched `wiki.convert.run`, so nothing here touches MinIO or starts
LibreOffice."""
import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select, text, update
from typer.testing import CliRunner

from serversherpa import cli
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    AuditLog,
    SystemProcess,
    WikiFile,
    WikiFileVersion,
    WikiJob,
    WikiNode,
    WikiPageAsset,
    WikiSpace,
)
from serversherpa.services import storage
from serversherpa.wiki import convert, tree, worker
from serversherpa.wiki.files import enqueue

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


# ── fixtures ─────────────────────────────────────────────────────────


async def _space(db) -> WikiSpace:
    space = WikiSpace(key=f"w-{uuid.uuid4().hex[:10]}", name="Worker space")
    db.add(space)
    await db.flush()
    return space


async def _file(db, *, filename="spec.pdf", content_type="application/pdf",
                key=None, preview_kind="native", preview_status="ready",
                preview_key=None, extract_status="pending", space=None, parent=None):
    """A file node + current version 1, committed."""
    space = space or await _space(db)
    node = await tree.create_node(db, space=space, parent=parent, kind="file",
                                  title=filename, actor_id=None)
    db.add(WikiFile(node_id=node.id, description=""))
    version = WikiFileVersion(
        node_id=node.id, version_no=1, storage_key=key or f"wiki/{space.id}/{uuid.uuid4()}/f",
        filename=filename, content_type=content_type, size_bytes=10,
        preview_kind=preview_kind, preview_status=preview_status, preview_key=preview_key,
        extract_status=extract_status)
    db.add(version)
    await db.flush()
    (await db.get(WikiFile, node.id)).current_version_id = version.id
    await db.commit()
    return node, version


async def _job(db, kind, *, version=None, payload=None) -> uuid.UUID:
    job = await enqueue(db, kind, node_id=version.node_id if version else None,
                        file_version_id=version.id if version else None, payload=payload)
    await db.commit()
    return job.id


async def _fresh(db, model, row_id):
    return await db.scalar(select(model).where(model.id == row_id)
                           .execution_options(populate_existing=True))


class FakeStorage:
    """Stands in for services.storage: objects live in a dict."""

    def __init__(self, objects=None):
        self.objects: dict[str, bytes] = dict(objects or {})
        self.downloads: list[str] = []
        self.uploads: list[tuple[str, str, bytes]] = []
        self.deleted: list[str] = []

    async def download_to(self, key, path):
        self.downloads.append(key)
        Path(path).write_bytes(self.objects[key])

    async def upload_from(self, path, key, content_type):
        self.uploads.append((key, content_type, Path(path).read_bytes()))
        self.objects[key] = Path(path).read_bytes()

    async def delete_object(self, key):
        self.deleted.append(key)
        self.objects.pop(key, None)


@pytest.fixture
def store(monkeypatch):
    fake = FakeStorage()
    monkeypatch.setattr(storage, "download_to", fake.download_to)
    monkeypatch.setattr(storage, "upload_from", fake.upload_from)
    monkeypatch.setattr(storage, "delete_object", fake.delete_object)
    return fake


class FakeTools:
    """Stands in for convert.run: soffice writes `<stem>.pdf` into its
    --outdir; pdftotext prints `pdf_text`. Either can be made to fail."""

    def __init__(self, *, pdf_text="", soffice_rc=0, pdftotext_rc=0):
        self.pdf_text = pdf_text
        self.soffice_rc = soffice_rc
        self.pdftotext_rc = pdftotext_rc
        self.calls: list[list[str]] = []

    async def run(self, cmd, *, timeout, max_stdout=None):
        self.calls.append(list(cmd))
        if cmd[0] == "soffice":
            if self.soffice_rc:
                return self.soffice_rc, b"", b"Error: source file could not be loaded"
            outdir, src = Path(cmd[cmd.index("--outdir") + 1]), Path(cmd[-1])
            (outdir / f"{src.stem}.pdf").write_bytes(b"%PDF-1.4 converted")
            return 0, b"", b""
        if cmd[0] == "pdftotext":
            if self.pdftotext_rc:
                return self.pdftotext_rc, b"", b"Syntax Error"
            return 0, self.pdf_text.encode(), b""
        raise AssertionError(f"unexpected command {cmd}")

    def commands(self):
        return [c[0] for c in self.calls]


@pytest.fixture
def tools(monkeypatch):
    fake = FakeTools()
    monkeypatch.setattr(convert, "run", fake.run)
    return fake


async def _run_once() -> bool:
    return await worker.run_once(get_sessionmaker())


async def _matches(db, node_id, word) -> bool:
    return bool(await db.scalar(
        text("SELECT search_tsv @@ to_tsquery('english', :w) FROM wiki_nodes WHERE id = :id"),
        {"w": word, "id": node_id}))


# ── claiming ─────────────────────────────────────────────────────────


async def test_run_once_on_an_empty_queue(db):
    assert await _run_once() is False


async def test_claim_next_takes_the_oldest_queued_job_and_counts_the_attempt(db):
    first = await _job(db, "purge", payload={"keys": []})
    await _job(db, "purge", payload={"keys": []})
    async with get_sessionmaker()() as session:
        job = await worker.claim_next(session)
        assert job.id == first
        assert job.status == "running"
        assert job.attempts == 1
        assert job.started_at is not None and job.progress_at is not None


async def test_a_retried_job_waits_out_its_backoff(db):
    job_id = await _job(db, "purge", payload={"keys": []})
    await db.execute(update(WikiJob).where(WikiJob.id == job_id).values(
        attempts=1, progress_at=datetime.now(UTC)))
    await db.commit()
    async with get_sessionmaker()() as session:
        assert await worker.claim_next(session) is None
    await db.execute(update(WikiJob).where(WikiJob.id == job_id).values(
        progress_at=datetime.now(UTC) - timedelta(seconds=worker.RETRY_BASE_SECONDS + 1)))
    await db.commit()
    async with get_sessionmaker()() as session:
        assert (await worker.claim_next(session)).id == job_id


async def test_claim_next_claims_other_kinds_before_exports(db):
    """A long export must not hold up previews, search text and purges
    for everyone else: an older export waits behind them."""
    export = await _job(db, "export", payload={})
    purge = await _job(db, "purge", payload={"keys": []})
    async with get_sessionmaker()() as session:
        assert (await worker.claim_next(session)).id == purge
        assert (await worker.claim_next(session)).id == export


async def test_claim_next_only_claims_the_kinds_asked_for(db):
    export = await _job(db, "export", payload={})
    purge = await _job(db, "purge", payload={"keys": []})
    async with get_sessionmaker()() as session:
        assert await worker.claim_next(session, kinds=frozenset({"reminders"})) is None
        assert (await worker.claim_next(session, kinds=frozenset({"export"}))).id == export
        assert await worker.claim_next(session, kinds=frozenset({"export"})) is None
        assert (await worker.claim_next(session, kinds=frozenset({"purge"}))).id == purge


async def test_run_once_leaves_kinds_it_does_not_handle(db):
    await _job(db, "export", payload={})
    assert await worker.run_once(get_sessionmaker(), kinds=frozenset({"purge"})) is False
    assert await db.scalar(select(WikiJob.status)) == "queued"


def test_resolve_kinds():
    every = worker.JOB_KINDS
    assert worker.resolve_kinds(None, None) == every
    assert worker.resolve_kinds("export", None) == frozenset({"export"})
    assert worker.resolve_kinds(" file_preview , purge ", None) == frozenset(
        {"file_preview", "purge"})
    assert worker.resolve_kinds(None, "export") == every - {"export"}
    for kinds, exclude in (("export", "purge"), ("nope", None), (None, "nope"),
                           ("", None), (None, ",".join(sorted(every)))):
        with pytest.raises(ValueError):
            worker.resolve_kinds(kinds, exclude)


def test_process_name_follows_the_kinds():
    every = worker.JOB_KINDS
    assert worker.process_name(every) == "wiki-worker"
    assert worker.process_name(every - {"export"}) == "wiki-worker"
    assert worker.process_name(frozenset({"export"})) == "wiki-export-worker"
    assert worker.process_name(frozenset({"purge", "file_preview"})) == (
        "wiki-worker:file_preview,purge")


# ── file_extract ─────────────────────────────────────────────────────


async def test_extract_pdf(db, store, tools):
    node, version = await _file(db, filename="guide.pdf", content_type="application/pdf")
    store.objects[version.storage_key] = b"%PDF-1.4 original"
    tools.pdf_text = "Zebracorn cabling guide\x00 page one"
    job_id = await _job(db, "file_extract", version=version)

    assert await _run_once() is True

    row = await _fresh(db, WikiFileVersion, version.id)
    assert row.extract_status == "ready"
    assert row.text_extract == "Zebracorn cabling guide page one"      # NUL dropped
    assert tools.commands() == ["pdftotext"]
    assert store.downloads == [version.storage_key]
    job = await _fresh(db, WikiJob, job_id)
    assert job.status == "done" and job.finished_at is not None and job.error is None
    assert await _matches(db, node.id, "zebracorn")


async def test_extract_office_converts_when_no_preview_is_ready(db, store, tools):
    node, version = await _file(db, filename="Plan.docx", content_type=DOCX,
                                preview_kind="pdf", preview_status="pending")
    store.objects[version.storage_key] = b"docx bytes"
    tools.pdf_text = "Quokka migration plan"
    await _job(db, "file_extract", version=version)

    assert await _run_once() is True

    assert tools.commands() == ["soffice", "pdftotext"]
    # the source keeps its extension so LibreOffice knows the format
    assert tools.calls[0][-1].endswith(".docx")
    row = await _fresh(db, WikiFileVersion, version.id)
    assert row.extract_status == "ready"
    assert row.text_extract == "Quokka migration plan"
    assert row.preview_status == "pending"       # extraction leaves the preview alone
    assert await _matches(db, node.id, "quokka")


async def test_extract_office_reuses_a_ready_preview(db, store, tools):
    _, version = await _file(db, filename="Plan.docx", content_type=DOCX,
                                preview_kind="pdf", preview_status="ready",
                                preview_key="wiki/previews/x.pdf")
    store.objects["wiki/previews/x.pdf"] = b"%PDF-1.4 preview"
    tools.pdf_text = "Narwhal rollout"
    await _job(db, "file_extract", version=version)

    assert await _run_once() is True

    assert tools.commands() == ["pdftotext"]
    assert store.downloads == ["wiki/previews/x.pdf"]
    assert (await _fresh(db, WikiFileVersion, version.id)).text_extract == "Narwhal rollout"


async def test_extract_text_file_decodes_and_truncates(db, store, tools, monkeypatch):
    monkeypatch.setattr(convert, "TEXT_LIMIT", 12)
    node, version = await _file(db, filename="notes.md", content_type="text/markdown")
    store.objects[version.storage_key] = "Axolotl \xe9\x00 notes and more".encode() \
        + b"\xff"
    await _job(db, "file_extract", version=version)

    assert await _run_once() is True

    assert tools.calls == []                       # read directly, no tools
    row = await _fresh(db, WikiFileVersion, version.id)
    assert row.extract_status == "ready"
    assert row.text_extract == "Axolotl é no"      # NUL dropped, capped at TEXT_LIMIT
    assert await _matches(db, node.id, "axolotl")


async def test_extract_skips_a_version_that_is_gone(db, store, tools):
    node, version = await _file(db)
    job_id = await _job(db, "file_extract", version=version)
    await db.execute(update(WikiFile).where(WikiFile.node_id == node.id)
                     .values(current_version_id=None))
    await db.delete(await db.get(WikiFileVersion, version.id))
    await db.commit()

    assert await _run_once() is True
    job = await _fresh(db, WikiJob, job_id)
    assert job.status == "done"
    assert store.downloads == []


async def test_extract_failure_retries_then_marks_the_version_failed(db, store, tools):
    _, version = await _file(db, filename="guide.pdf")
    store.objects[version.storage_key] = b"%PDF broken"
    tools.pdftotext_rc = 1
    job_id = await _job(db, "file_extract", version=version)

    for attempt in range(1, worker.MAX_ATTEMPTS + 1):
        await db.execute(update(WikiJob).where(WikiJob.id == job_id).values(
            progress_at=datetime.now(UTC) - timedelta(hours=1)))       # skip the backoff
        await db.commit()
        assert await _run_once() is True
        job = await _fresh(db, WikiJob, job_id)
        assert job.attempts == attempt
        assert "Syntax Error" in job.error
        row = await _fresh(db, WikiFileVersion, version.id)
        if attempt < worker.MAX_ATTEMPTS:
            assert job.status == "queued"
            assert row.extract_status == "pending"
        else:
            assert job.status == "failed"
            assert job.finished_at is not None
            assert row.extract_status == "failed"
    assert await _run_once() is False


# ── file_preview ─────────────────────────────────────────────────────


async def test_preview_converts_and_uploads(db, store, tools):
    _, version = await _file(db, filename="Deck.pptx", content_type="application/vnd.ms-powerpoint",
                                preview_kind="pdf", preview_status="pending",
                                extract_status="skipped")
    store.objects[version.storage_key] = b"pptx bytes"
    job_id = await _job(db, "file_preview", version=version)

    assert await _run_once() is True

    key = f"wiki/previews/{version.id}.pdf"
    assert store.uploads == [(key, "application/pdf", b"%PDF-1.4 converted")]
    row = await _fresh(db, WikiFileVersion, version.id)
    assert row.preview_key == key
    assert row.preview_status == "ready"
    assert (await _fresh(db, WikiJob, job_id)).status == "done"
    assert tools.commands() == ["soffice"]
    assert tools.calls[0][-1].endswith(".pptx")


async def test_preview_failure_retries_then_marks_the_version_failed(db, store, tools):
    _, version = await _file(db, filename="Deck.pptx", content_type="application/vnd.ms-powerpoint",
                                preview_kind="pdf", preview_status="pending",
                                extract_status="skipped")
    store.objects[version.storage_key] = b"pptx bytes"
    tools.soffice_rc = 1
    job_id = await _job(db, "file_preview", version=version)

    assert await _run_once() is True
    job = await _fresh(db, WikiJob, job_id)
    assert (job.status, job.attempts) == ("queued", 1)
    assert "could not be loaded" in job.error
    assert (await _fresh(db, WikiFileVersion, version.id)).preview_status == "pending"
    # still backing off: nothing to claim yet
    assert await _run_once() is False

    await db.execute(update(WikiJob).where(WikiJob.id == job_id).values(
        attempts=worker.MAX_ATTEMPTS - 1, progress_at=datetime.now(UTC) - timedelta(hours=1)))
    await db.commit()
    assert await _run_once() is True
    job = await _fresh(db, WikiJob, job_id)
    assert (job.status, job.attempts) == ("failed", worker.MAX_ATTEMPTS)
    row = await _fresh(db, WikiFileVersion, version.id)
    assert row.preview_status == "failed"
    assert row.preview_key is None
    assert store.uploads == []


# ── purge ────────────────────────────────────────────────────────────


async def test_purge_deletes_only_keys_nothing_references(db, store):
    shared = "wiki/s/shared/spec.pdf"
    shared_preview = "wiki/previews/shared.pdf"
    shared_asset = "wiki/s/shared/diagram.png"
    # a copy of the purged file still points at the same object, a restored
    # version at the same preview, and a copied page at the same asset
    await _file(db, key=shared, preview_key=shared_preview)
    page_space = await _space(db)
    page = await tree.create_node(db, space=page_space, parent=None, kind="page",
                                  title="Copy", actor_id=None)
    db.add(WikiPageAsset(node_id=page.id, storage_key=shared_asset, filename="d.png",
                         content_type="image/png", size_bytes=1))
    await db.commit()
    job_id = await _job(db, "purge", payload={"keys": [
        shared, shared_preview, shared_asset, "wiki/s/gone/a.pdf", "wiki/previews/gone.pdf",
        "wiki/s/gone/a.pdf"]})

    assert await _run_once() is True

    assert sorted(store.deleted) == ["wiki/previews/gone.pdf", "wiki/s/gone/a.pdf"]
    job = await _fresh(db, WikiJob, job_id)
    assert job.status == "done"
    assert job.result == {"deleted": 2, "kept": 3}


async def test_purge_failure_is_retried(db, store, monkeypatch):
    async def broken_delete(key):
        raise RuntimeError("storage is down")

    monkeypatch.setattr(storage, "delete_object", broken_delete)
    job_id = await _job(db, "purge", payload={"keys": ["wiki/s/x/a"]})
    assert await _run_once() is True
    job = await _fresh(db, WikiJob, job_id)
    assert (job.status, job.attempts) == ("queued", 1)
    assert "storage is down" in job.error


# ── trash expiry sweep ───────────────────────────────────────────────


async def test_expiry_sweep_purges_batches_past_the_trash_window(db):
    space = await _space(db)
    old_folder = await tree.create_node(db, space=space, parent=None, kind="folder",
                                        title="Old", actor_id=None)
    await db.commit()
    await _file(db, space=space, parent=old_folder, key="wiki/s/old/a.pdf")
    recent = await tree.create_node(db, space=space, parent=None, kind="folder",
                                    title="Recent", actor_id=None)
    old_batch, recent_batch = uuid.uuid4(), uuid.uuid4()
    long_ago = datetime.now(UTC) - timedelta(days=31)
    await db.execute(update(WikiNode).where(WikiNode.space_id == space.id,
                                            WikiNode.title != "Recent")
                     .values(deleted_at=long_ago, deleted_batch=old_batch))
    await db.execute(update(WikiNode).where(WikiNode.id == recent.id).values(
        deleted_at=datetime.now(UTC) - timedelta(days=29), deleted_batch=recent_batch))
    await db.commit()

    async with get_sessionmaker()() as session:
        swept = await worker.sweep_expired(session)
    assert swept == 1

    remaining = (await db.scalars(select(WikiNode.id).where(
        WikiNode.space_id == space.id))).all()
    assert remaining == [recent.id]
    purge = await db.scalar(select(WikiJob).where(WikiJob.kind == "purge"))
    assert purge.payload == {"keys": ["wiki/s/old/a.pdf"]}
    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.action == "purge"))
    assert audit_row.actor_person_id is None
    assert audit_row.changes["batch_id"] == str(old_batch)
    assert audit_row.changes["reason"] == "expired"


# ── stale re-queue ───────────────────────────────────────────────────


async def test_requeue_stale_requeues_or_fails_abandoned_jobs(db):
    _, version = await _file(db, filename="Plan.docx", content_type=DOCX,
                             preview_kind="pdf", preview_status="pending")
    retry_id = await _job(db, "purge", payload={"keys": []})
    spent_id = await _job(db, "file_preview", version=version)
    fresh_id = await _job(db, "purge", payload={"keys": []})
    old = datetime.now(UTC) - timedelta(minutes=worker.STALE_MINUTES + 1)
    await db.execute(update(WikiJob).where(WikiJob.id == retry_id).values(
        status="running", attempts=1, progress_at=old))
    await db.execute(update(WikiJob).where(WikiJob.id == spent_id).values(
        status="running", attempts=worker.MAX_ATTEMPTS, progress_at=old))
    await db.execute(update(WikiJob).where(WikiJob.id == fresh_id).values(
        status="running", attempts=1, progress_at=datetime.now(UTC)))
    await db.commit()

    async with get_sessionmaker()() as session:
        assert await worker.requeue_stale(session) == 2

    assert (await _fresh(db, WikiJob, retry_id)).status == "queued"
    spent = await _fresh(db, WikiJob, spent_id)
    assert spent.status == "failed"
    assert (await _fresh(db, WikiFileVersion, version.id)).preview_status == "failed"
    assert (await _fresh(db, WikiJob, fresh_id)).status == "running"


# ── the loop ─────────────────────────────────────────────────────────


async def test_run_forever_idles_while_paused_then_resumes(db, monkeypatch):
    from serversherpa.system import registry

    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    monkeypatch.setattr(registry, "start_heartbeat",
                        lambda name, kind, meta_fn=None: asyncio.create_task(
                            registry.heartbeat_loop(name, kind, interval=0.05,
                                                    meta_fn=meta_fn)))
    paused = {"on": True}

    async def fake_paused(sessionmaker):
        return paused["on"]

    monkeypatch.setattr("serversherpa.system.admin_config.workers_paused", fake_paused)
    calls = {"n": 0}

    async def counting_claim(session, kinds=None):
        calls["n"] += 1

    monkeypatch.setattr(worker, "claim_next", counting_claim)
    backfills = {"n": 0}

    async def counting_backfill(session):
        backfills["n"] += 1
        return 0

    # the start-up search backfill writes, so it waits out a freeze too
    monkeypatch.setattr(worker, "backfill_search_vectors", counting_backfill)
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05))
    try:
        row = None
        for _ in range(60):
            await asyncio.sleep(0.05)
            row = await db.scalar(
                select(SystemProcess).where(SystemProcess.name == "wiki-worker")
                .execution_options(populate_existing=True))
            if row is not None and row.meta == {"paused": True}:
                break
        assert row is not None and row.meta == {"paused": True}
        assert calls["n"] == 0
        assert backfills["n"] == 0
        paused["on"] = False
        for _ in range(60):
            await asyncio.sleep(0.05)
            if calls["n"]:
                break
        assert calls["n"] > 0
        assert backfills["n"] == 1
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize(("env", "origin", "warns"), [
    ("production", "http://localhost:5176", True),
    ("production", "http://127.0.0.1:5176/", True),
    ("production", "https://wiki.example.com", False),
    ("development", "http://localhost:5176", False),
])
def test_local_origin_warning(monkeypatch, env, origin, warns):
    from types import SimpleNamespace

    monkeypatch.setattr(worker, "get_settings",
                        lambda: SimpleNamespace(env=env, wiki_origin=origin))
    message = worker.local_origin_warning()
    assert (message is not None) is warns
    if warns:
        assert "SS_WIKI_ORIGIN" in message


async def _loop_queues(db, monkeypatch, kinds):
    """Run the loop briefly with `kinds` and no job claims; return the
    kinds of the jobs it queued itself (the daily schedule)."""
    from serversherpa.system import registry

    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    names = []
    monkeypatch.setattr(registry, "start_heartbeat",
                        lambda name, kind, meta_fn=None: names.append(name)
                        or asyncio.create_task(asyncio.sleep(0)))

    async def not_paused(maker, state):
        return False

    monkeypatch.setattr("serversherpa.system.admin_config.poll_workers_paused", not_paused)
    claimed = []

    async def no_claim(session, kinds=None):
        claimed.append(kinds)

    monkeypatch.setattr(worker, "claim_next", no_claim)
    swept = []

    async def fake_sweep(maker, state):
        swept.append(True)

    monkeypatch.setattr(worker, "_sweep_expired", fake_sweep)
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05, kinds=kinds))
    try:
        for _ in range(20):
            await asyncio.sleep(0.05)
            if claimed:
                break
        await asyncio.sleep(0.1)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert claimed and claimed[0] == kinds
    queued = sorted((await db.scalars(select(WikiJob.kind)
                                      .execution_options(populate_existing=True))).all())
    return queued, names, bool(swept)


async def test_an_export_only_worker_leaves_the_daily_jobs_to_the_other(db, monkeypatch):
    queued, names, swept = await _loop_queues(db, monkeypatch, frozenset({"export"}))
    assert queued == []
    assert names == ["wiki-export-worker"]
    assert swept is False                 # the trash sweep queues purges


async def test_the_main_worker_schedules_the_daily_jobs(db, monkeypatch):
    queued, names, swept = await _loop_queues(
        db, monkeypatch, worker.JOB_KINDS - {"export"})
    assert queued == ["reminders", "retention"]
    assert names == ["wiki-worker"]
    assert swept is True


# ── storage helpers ──────────────────────────────────────────────────


async def test_storage_download_to_and_upload_from_use_the_file_transfer_calls(
        monkeypatch, tmp_path):
    seen = []

    class FakeClient:
        def download_file(self, bucket, key, filename):
            seen.append(("download", bucket, key, filename))

        def upload_file(self, filename, bucket, key, ExtraArgs=None):
            seen.append(("upload", bucket, key, filename, ExtraArgs))

    monkeypatch.setattr(storage, "_client", lambda: FakeClient())
    bucket = storage.get_settings().spaces_bucket
    await storage.download_to("wiki/a/b", tmp_path / "src")
    await storage.upload_from(tmp_path / "out.pdf", "wiki/previews/v.pdf", "application/pdf")
    assert seen == [
        ("download", bucket, "wiki/a/b", str(tmp_path / "src")),
        ("upload", bucket, "wiki/previews/v.pdf", str(tmp_path / "out.pdf"),
         {"ContentType": "application/pdf"}),
    ]


# ── CLI ──────────────────────────────────────────────────────────────

runner = CliRunner()


def test_cli_wiki_worker_flags():
    result = runner.invoke(cli.app, ["wiki-worker", "--help"])
    assert result.exit_code == 0
    for flag in ("--reload", "--once", "--poll-seconds", "--kinds", "--exclude-kinds"):
        assert flag in result.output
    result = runner.invoke(cli.app, ["wiki-worker", "--reload", "--once"])
    assert result.exit_code == 1
    assert "cannot be combined" in result.output


@pytest.mark.parametrize("args", [
    ["--kinds", "export", "--exclude-kinds", "export"],
    ["--kinds", "exports"],
    ["--exclude-kinds", "file_extract,file_preview,purge,reminders,export,retention"],
])
def test_cli_wiki_worker_refuses_bad_kinds(args):
    result = runner.invoke(cli.app, ["wiki-worker", *args])
    assert result.exit_code == 1, result.output


def test_cli_wiki_worker_passes_its_kinds_on(monkeypatch):
    seen = {}

    async def fake_forever(poll_seconds, kinds=None):
        seen["kinds"] = kinds

    async def fake_dispose():
        pass

    monkeypatch.setattr(worker, "run_forever", fake_forever)
    monkeypatch.setattr(cli, "dispose_engine", fake_dispose)
    result = runner.invoke(cli.app, ["wiki-worker", "--exclude-kinds", "export"])
    assert result.exit_code == 0, result.output
    assert seen["kinds"] == worker.JOB_KINDS - {"export"}


def test_cli_wiki_worker_reload_uses_watchfiles(monkeypatch):
    import watchfiles

    calls = {}

    def fake_run_process(*paths, target, args=(), **kwargs):
        calls.update(paths=paths, target=target, args=args)

    monkeypatch.setattr(watchfiles, "run_process", fake_run_process)
    result = runner.invoke(cli.app, ["wiki-worker", "--reload", "--poll-seconds", "1.5",
                                     "--kinds", "export"])
    assert result.exit_code == 0, result.output
    assert calls["target"] is cli._run_wiki_worker_process
    assert calls["args"] == (1.5, frozenset({"export"}))
    assert str(calls["paths"][0]).endswith("/src")
