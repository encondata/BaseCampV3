"""The wiki worker loop (`serversherpa wiki-worker`) — a separate process
from the API. Claims queued wiki_jobs rows (FOR UPDATE SKIP LOCKED, so
any number of workers can run without a broker) and runs them:

- `file_extract` — searchable text for a file version: a PDF through
  `pdftotext`; an office file through its ready preview PDF, or a fresh
  LibreOffice conversion; a text-like file decoded directly. Capped at
  `convert.TEXT_LIMIT` characters, then the node's search vector is
  refreshed.
- `file_preview` — an office file converted to PDF and uploaded to
  `wiki/previews/<file_version_id>.pdf`.
- `purge` — deletes the storage keys in its payload that no row
  references any more (copies, restored versions and copied page assets
  share objects, so every key is reference-counted first).
- `reminders` — first schedules published pages a space-level interval
  now covers (and clears due dates no interval covers), then sends
  `wiki_review_due` to the owner (else the last publisher) of each page
  whose periodic review has come due, once per due date
  (`review_notified_for`). The loop queues one at start-up and then
  whenever the last was queued more than a day ago — the job rows are
  the record of when it last ran (`ensure_reminders_job`).
- `retention` — the daily sweep: page views older than a year, search
  log rows older than 90 days (`wiki.analytics`), finished jobs older
  than JOB_RETENTION (never the newest `reminders`/`retention` row —
  the schedule markers), and old exports (`purge_old_exports`).
  Scheduled exactly like `reminders` (`ensure_retention_job`).

A failed job is retried with backoff — `attempts` counts claims, and a
re-queued job waits RETRY_BASE_SECONDS * 2^(attempts-1) from its last
try (`progress_at`) — until MAX_ATTEMPTS, then it is `failed` and a
file job marks its version's preview/extract status `failed` (the
upload itself is never blocked). A job a dead worker left `running` is
re-queued the same way (or failed, if it has used up its attempts).
At most hourly the loop also runs the trash expiry sweep: batches
deleted more than `wiki_trash_days` ago are deleted forever, exactly
like `DELETE /wiki/trash/{batch_id}`.

Not done here (Phase 1): the orphan-object sweep of spec §9 (objects PUT
without an upload complete).

Session discipline: a job's DB reads are committed before any download
or subprocess starts, so a two-minute LibreOffice run never holds a
transaction open; the result is written in a fresh transaction after."""
from __future__ import annotations

import asyncio
import logging
import tempfile
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath

from sqlalchemy import func, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import (
    WikiFileVersion,
    WikiJob,
    WikiNode,
    WikiPage,
    WikiPageAsset,
    WikiPageVersion,
    WikiSpace,
)
from serversherpa.services import storage
from serversherpa.wiki import analytics, convert, notify, reviews, trash, tree
from serversherpa.wiki.files import (
    enqueue,
    is_office,
    is_text_like,
    normalize_content_type,
    sanitize_filename,
)
from serversherpa.wiki.search import backfill_search_vectors, refresh_search

logger = logging.getLogger("serversherpa.wiki.worker")

PROCESS_NAME = "wiki-worker"
MAX_ATTEMPTS = 3
RETRY_BASE_SECONDS = 30
STALE_MINUTES = 30              # longer than any one job's download + conversion
STALE_SWEEP_SECONDS = 60
EXPIRY_SWEEP_SECONDS = 3600
REMINDERS_CHECK_SECONDS = 600   # how often the loop asks whether the daily jobs are due
REMINDERS_EVERY = timedelta(hours=24)
# transaction-scoped advisory locks: two workers never both queue the day's run
REMINDERS_LOCK_KEY = 0x5715_0005
RETENTION_LOCK_KEY = 0x5715_0006
# finished (done/failed) jobs are kept this long
JOB_RETENTION = timedelta(days=30)
# the daily jobs whose newest row records when they last ran
SCHEDULE_MARKER_KINDS = ("reminders", "retention")
ERROR_MAX = 2000
PREVIEW_KEY = "wiki/previews/{version_id}.pdf"

# a text-like file is decoded from at most this many bytes (UTF-8 is at
# most 4 bytes a character, so this always covers TEXT_LIMIT characters)
_TEXT_BYTES_PER_CHAR = 4

# which version status a failed file job marks
_STATUS_FIELD = {"file_extract": "extract_status", "file_preview": "preview_status"}


def _now() -> datetime:
    return datetime.now(UTC)


# ── the queue ────────────────────────────────────────────────────────


def _backoff_elapsed():
    """WHERE clause: a job that has been tried before has waited out its
    backoff since its last try."""
    wait = func.make_interval(
        0, 0, 0, 0, 0, 0, RETRY_BASE_SECONDS * func.power(2, WikiJob.attempts - 1))
    return or_(WikiJob.attempts == 0, WikiJob.progress_at.is_(None),
               WikiJob.progress_at + wait <= func.now())


async def claim_next(db: AsyncSession) -> WikiJob | None:
    """Claim the oldest queued job that is due (SKIP LOCKED), mark it
    running and count the attempt. Commits the claim."""
    job = await db.scalar(
        select(WikiJob)
        .where(WikiJob.status == "queued", _backoff_elapsed())
        .order_by(WikiJob.created_at, WikiJob.id)
        .limit(1)
        .with_for_update(skip_locked=True))
    if job is None:
        return None
    now = _now()
    job.status = "running"
    job.attempts += 1
    job.started_at = now
    job.progress_at = now
    await db.commit()
    return job


async def _mark_version_failed(db: AsyncSession, job: WikiJob) -> None:
    field = _STATUS_FIELD.get(job.kind)
    if field is None or job.file_version_id is None:
        return
    version = await db.get(WikiFileVersion, job.file_version_id)
    if version is not None:
        setattr(version, field, "failed")


async def _retry_or_fail(db: AsyncSession, job: WikiJob, error: str) -> None:
    """A try failed: back to the queue (its backoff runs from now), or —
    out of attempts — failed for good, with its file version marked."""
    job.error = error[:ERROR_MAX]
    job.progress_at = _now()
    if job.attempts >= MAX_ATTEMPTS:
        job.status = "failed"
        job.finished_at = _now()
        await _mark_version_failed(db, job)
    else:
        job.status = "queued"
        job.started_at = None


async def requeue_stale(db: AsyncSession) -> int:
    """Jobs a crashed worker left `running` for STALE_MINUTES count as a
    failed try. Commits; returns how many it touched."""
    cutoff = _now() - timedelta(minutes=STALE_MINUTES)
    jobs = (await db.scalars(
        select(WikiJob)
        .where(WikiJob.status == "running", WikiJob.progress_at < cutoff)
        .with_for_update(skip_locked=True))).all()
    for job in jobs:
        await _retry_or_fail(db, job, "worker_stopped: the job was abandoned mid-run")
    await db.commit()
    return len(jobs)


def _done(job: WikiJob, result: dict | None = None) -> None:
    job.status = "done"
    job.error = None
    job.result = result
    job.finished_at = _now()


# ── file jobs ────────────────────────────────────────────────────────


def _source_path(workdir: Path, filename: str) -> Path:
    # LibreOffice picks the import filter by extension, so keep it — but
    # never the user's name itself (it becomes the output's stem too)
    return workdir / f"source{PurePosixPath(sanitize_filename(filename)).suffix.lower()}"


async def _read_text_file(path: Path) -> str:
    def _read() -> bytes:
        with path.open("rb") as fh:
            return fh.read(convert.TEXT_LIMIT * _TEXT_BYTES_PER_CHAR)
    return (await asyncio.to_thread(_read)).decode("utf-8", errors="replace")


async def _extract_text(workdir: Path, *, storage_key: str, filename: str,
                        content_type: str, preview_key: str | None) -> str | None:
    """The version's text, or None when it isn't a kind that has any."""
    is_pdf = normalize_content_type(content_type) == "application/pdf"
    office = is_office(filename)
    if not (is_pdf or office or is_text_like(filename, content_type)):
        return None
    if office and not is_pdf and preview_key:
        pdf = workdir / "preview.pdf"
        await storage.download_to(preview_key, pdf)
        return await convert.pdf_to_text(pdf)

    src = _source_path(workdir, filename)
    await storage.download_to(storage_key, src)
    if is_pdf:
        return await convert.pdf_to_text(src)
    if office:
        outdir = workdir / "out"
        outdir.mkdir()
        return await convert.pdf_to_text(await convert.office_to_pdf(src, outdir))
    return await _read_text_file(src)


async def _run_extract(db: AsyncSession, job: WikiJob) -> None:
    version = await db.get(WikiFileVersion, job.file_version_id) \
        if job.file_version_id else None
    if version is None:
        _done(job, {"skipped": "version_gone"})
        await db.commit()
        return
    version_id = version.id
    source = {"storage_key": version.storage_key, "filename": version.filename,
              "content_type": version.content_type,
              "preview_key": version.preview_key if version.preview_status == "ready" else None}
    await db.commit()                    # no transaction held across the work

    with tempfile.TemporaryDirectory(prefix="wiki-extract-",
                                     ignore_cleanup_errors=True) as tmp:
        extracted = await _extract_text(Path(tmp), **source)

    version = await db.get(WikiFileVersion, version_id, populate_existing=True)
    if version is None:
        _done(job, {"skipped": "version_gone"})
    elif extracted is None:
        version.extract_status = "skipped"
        _done(job, {"skipped": "no_text"})
    else:
        version.text_extract = convert._clean_text(extracted)
        version.extract_status = "ready"
        await refresh_search(db, version.node_id)
        _done(job, {"chars": len(version.text_extract)})
    await db.commit()


async def _run_preview(db: AsyncSession, job: WikiJob) -> None:
    version = await db.get(WikiFileVersion, job.file_version_id) \
        if job.file_version_id else None
    if version is None or version.preview_kind != "pdf":
        _done(job, {"skipped": "version_gone" if version is None else "not_pdf"})
        await db.commit()
        return
    version_id, storage_key, filename = version.id, version.storage_key, version.filename
    await db.commit()

    key = PREVIEW_KEY.format(version_id=version_id)
    with tempfile.TemporaryDirectory(prefix="wiki-preview-",
                                     ignore_cleanup_errors=True) as tmp:
        workdir = Path(tmp)
        src = _source_path(workdir, filename)
        await storage.download_to(storage_key, src)
        outdir = workdir / "out"
        outdir.mkdir()
        pdf = await convert.office_to_pdf(src, outdir)
        await storage.upload_from(pdf, key, "application/pdf")

    version = await db.get(WikiFileVersion, version_id, populate_existing=True)
    if version is None:
        # deleted mid-conversion: nothing will ever point at the preview
        await enqueue(db, "purge", payload={"keys": [key]})
        _done(job, {"skipped": "version_gone"})
    else:
        version.preview_key = key
        version.preview_status = "ready"
        _done(job, {"preview_key": key})
    await db.commit()


# ── purge ────────────────────────────────────────────────────────────


async def _referenced(db: AsyncSession, keys: list[str]) -> set[str]:
    """The keys some remaining row still points at."""
    q = union_all(
        select(WikiFileVersion.storage_key.label("key"))
        .where(WikiFileVersion.storage_key.in_(keys)),
        select(WikiFileVersion.preview_key).where(WikiFileVersion.preview_key.in_(keys)),
        select(WikiPageAsset.storage_key).where(WikiPageAsset.storage_key.in_(keys)))
    return set((await db.scalars(q)).all())


async def _run_purge(db: AsyncSession, job: WikiJob) -> None:
    keys = sorted({k for k in (job.payload or {}).get("keys", []) if k})
    kept = await _referenced(db, keys) if keys else set()
    await db.commit()
    doomed = [k for k in keys if k not in kept]
    for key in doomed:
        await storage.delete_object(key)       # idempotent: a re-run is safe
    _done(job, {"deleted": len(doomed), "kept": len(kept)})
    await db.commit()


# ── review reminders ─────────────────────────────────────────────────


async def _ensure_daily_job(db: AsyncSession, kind: str, lock_key: int,
                            now: datetime | None) -> WikiJob | None:
    """Queue a `kind` job unless one was queued within REMINDERS_EVERY
    (whatever became of it — a failed run waits for the next day rather
    than retrying every check). Commits; returns the new job, or None."""
    now = now or _now()
    await db.execute(select(func.pg_advisory_xact_lock(lock_key)))
    recent = await db.scalar(select(WikiJob.id).where(
        WikiJob.kind == kind, WikiJob.created_at > now - REMINDERS_EVERY).limit(1))
    if recent is not None:
        await db.commit()
        return None
    job = WikiJob(kind=kind, created_at=now)
    db.add(job)
    await db.commit()
    return job


async def ensure_reminders_job(db: AsyncSession, *, now: datetime | None = None,
                               ) -> WikiJob | None:
    """Queue the day's `reminders` job, if it's due (`_ensure_daily_job`)."""
    return await _ensure_daily_job(db, "reminders", REMINDERS_LOCK_KEY, now)


async def ensure_retention_job(db: AsyncSession, *, now: datetime | None = None,
                               ) -> WikiJob | None:
    """Queue the day's `retention` job, if it's due (`_ensure_daily_job`)."""
    return await _ensure_daily_job(db, "retention", RETENTION_LOCK_KEY, now)


async def _due_page_ids(db: AsyncSession, now: datetime) -> list[uuid.UUID]:
    """The pages due by `now` not yet notified for that date, soonest first."""
    return list((await db.scalars(
        select(WikiNode.id)
        .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
        .where(reviews.due_filter(now), reviews.not_yet_notified())
        .order_by(WikiNode.next_review_at, WikiNode.id))).all())


async def _run_reminders(db: AsyncSession, job: WikiJob) -> None:
    """First bring due dates in line with space-level interval changes
    (`reviews.backfill_due_dates`). Then notify each due page's owner —
    or, with no owner, whoever published its current version — and
    record the due date as notified, so the next run skips it until the
    date moves (`mark-reviewed`, a publish). Each page is re-checked
    under its row lock, so one marked reviewed since the scan is left
    alone. A recipient who can't view the page any more gets nothing,
    but the date is still spent. Commits after each page."""
    now = _now()
    scheduled, cleared = await reviews.backfill_due_dates(db)
    await db.commit()
    ids = await _due_page_ids(db, now)
    await db.commit()
    notified = 0
    for node_id in ids:
        node = await db.scalar(
            select(WikiNode)
            .join(WikiSpace, WikiSpace.id == WikiNode.space_id)
            .where(WikiNode.id == node_id, reviews.due_filter(now),
                   reviews.not_yet_notified())
            .with_for_update(of=WikiNode, skip_locked=True)
            .execution_options(populate_existing=True))
        if node is None:                 # rescheduled, notified or busy since the scan
            await db.rollback()
            continue
        owner_id = node.owner_id or await db.scalar(
            select(WikiPageVersion.created_by)
            .join(WikiPage, WikiPage.published_version_id == WikiPageVersion.id)
            .where(WikiPage.node_id == node.id))
        notified += len(await notify.on_review_due(db, node, owner_id=owner_id))
        node.review_notified_for = node.next_review_at
        await db.commit()
    _done(job, {"notified": notified, "pages": len(ids), "scheduled": scheduled,
                "cleared": cleared})
    await db.commit()


# ── retention ────────────────────────────────────────────────────────


async def purge_old_exports(db: AsyncSession, now: datetime) -> int:
    """Delete export files and their records older than 7 days; returns
    how many went. Exports arrive in the next task (Phase 3 Task 5), which
    fills this in — until then there is nothing to delete."""
    return 0


async def purge_old_jobs(db: AsyncSession, now: datetime) -> int:
    """Delete `done`/`failed` jobs that finished (or, never having
    finished, were queued) more than JOB_RETENTION ago — except the
    newest row of each SCHEDULE_MARKER_KINDS kind, which is how the loop
    knows the day's run already happened. Returns how many went."""
    markers = (select(WikiJob.id)
               .where(WikiJob.kind.in_(SCHEDULE_MARKER_KINDS))
               .distinct(WikiJob.kind)
               .order_by(WikiJob.kind, WikiJob.created_at.desc(), WikiJob.id.desc()))
    result = await db.execute(
        WikiJob.__table__.delete().where(
            WikiJob.status.in_(("done", "failed")),
            func.coalesce(WikiJob.finished_at, WikiJob.created_at) < now - JOB_RETENTION,
            WikiJob.id.not_in(markers)))
    return result.rowcount


async def _run_retention(db: AsyncSession, job: WikiJob) -> None:
    """The daily sweep of what analytics, the queue and exports leave
    behind (see the module docstring). One transaction."""
    now = _now()
    counts = {
        "views": await analytics.purge_old_views(db, now),
        "searches": await analytics.purge_old_searches(db, now),
        "jobs": await purge_old_jobs(db, now),
        "exports": await purge_old_exports(db, now),
    }
    _done(job, counts)
    await db.commit()


_HANDLERS = {"file_extract": _run_extract, "file_preview": _run_preview,
             "purge": _run_purge, "reminders": _run_reminders,
             "retention": _run_retention}


async def process_job(db: AsyncSession, job: WikiJob) -> None:
    """Run one claimed (status='running') job to `done`; raises on failure."""
    handler = _HANDLERS.get(job.kind)
    if handler is None:
        raise ValueError(f"unknown wiki job kind {job.kind!r}")
    await handler(db, job)


async def run_once(sessionmaker=None) -> bool:
    """Claim and process at most one job. False when nothing is due."""
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.db_logging import install
    install(PROCESS_NAME)

    maker = sessionmaker or get_sessionmaker()
    async with maker() as db:
        job = await claim_next(db)
        if job is None:
            return False
        job_id, kind = job.id, job.kind
        logger.info("claimed job %s (%s, attempt %s)", job_id, kind, job.attempts)
        try:
            await process_job(db, job)
            status = "done"
        except Exception as exc:
            logger.warning("job %s (%s) failed: %s", job_id, kind, exc, exc_info=True)
            try:
                await db.rollback()
            except Exception:
                logger.warning("could not roll back job %s's session", job_id, exc_info=True)
            async with maker() as fin:
                row = await fin.get(WikiJob, job_id)
                if row is not None:
                    await _retry_or_fail(fin, row, f"{type(exc).__name__}: {exc}")
                    status = row.status
                    await fin.commit()
                else:
                    status = "gone"
        logger.info("job %s finished status=%s", job_id, status)
        return True


# ── trash expiry ─────────────────────────────────────────────────────


async def sweep_expired(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Delete forever every trash batch older than `wiki_trash_days`, one
    transaction per batch. Returns how many batches went."""
    cutoff = (now or _now()) - timedelta(days=get_settings().wiki_trash_days)
    batch_ids = (await db.scalars(
        select(WikiNode.deleted_batch)
        .where(WikiNode.deleted_batch.is_not(None), WikiNode.deleted_at < cutoff)
        .group_by(WikiNode.deleted_batch))).all()
    await db.commit()
    swept = 0
    for batch_id in batch_ids:
        try:
            root = await trash.batch_root(db, batch_id)
        except tree.TreeError:                              # moved meanwhile: next sweep
            await db.rollback()
            continue
        if root is None or root.deleted_at >= cutoff:       # restored meanwhile
            await db.rollback()
            continue
        await trash.delete_batch_forever(db, root, actor_id=None, reason="expired")
        await db.commit()
        swept += 1
    return swept


async def _sweep_expired(maker, state: dict) -> None:
    """One expiry pass that can never stop the loop: a failure is logged
    (once per outage) and the next hour's pass tries again."""
    try:
        async with maker() as db:
            swept = await sweep_expired(db)
        if swept:
            logger.info("deleted %d expired trash batch(es)", swept)
        state["failed"] = False
    except Exception:
        if not state["failed"]:
            logger.warning("trash expiry sweep failed — retrying in an hour", exc_info=True)
        state["failed"] = True


async def _requeue_stale(maker, state: dict) -> None:
    try:
        async with maker() as db:
            requeued = await requeue_stale(db)
        if requeued:
            logger.info("re-queued %d stale job(s)", requeued)
        state["failed"] = False
    except Exception:
        if not state["failed"]:
            logger.warning("could not re-queue stale jobs — retrying", exc_info=True)
        state["failed"] = True


async def _schedule_daily(maker, state: dict, ensure, what: str) -> None:
    """Queue the day's job (`ensure`: `ensure_reminders_job` or
    `ensure_retention_job`) if it's due. Never stops the loop: a failure
    is logged (once per outage) and the next check retries."""
    try:
        async with maker() as db:
            job = await ensure(db)
        if job is not None:
            logger.info("queued %s (job %s)", what, job.id)
        state["failed"] = False
    except Exception:
        if not state["failed"]:
            logger.warning("could not queue %s — retrying", what, exc_info=True)
        state["failed"] = True


async def _backfill_search(maker) -> None:
    """Once per start (after any read-only freeze lifts — it writes):
    index by title any node from before every node was indexed at
    creation. Best effort — search just misses them until the
    next start if this fails."""
    try:
        async with maker() as db:
            count = await backfill_search_vectors(db)
            await db.commit()
        if count:
            logger.info("indexed %s wiki nodes that had no search vector", count)
    except Exception:
        logger.warning("could not backfill wiki search vectors", exc_info=True)


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install(PROCESS_NAME)
    pause_state = {"paused": False}
    check_state: dict = {}
    claim_state = {"failed": False}
    stale_state = {"failed": False}
    expiry_state = {"failed": False}
    reminders_state = {"failed": False}
    retention_state = {"failed": False}
    backfilled = False
    heartbeat = start_heartbeat(PROCESS_NAME, "worker", meta_fn=lambda: dict(pause_state))
    maker = get_sessionmaker()
    try:
        await _requeue_stale(maker, stale_state)            # startup sweep
        stale_at = time.monotonic()
        expired_at = -EXPIRY_SWEEP_SECONDS                  # first pass = start-up
        daily_at = -REMINDERS_CHECK_SECONDS                 # first check = start-up
        logger.info("wiki worker online — watching the queue")
        while True:
            # read-only mode's "also pause background services": idle (still
            # heart-beating as paused) until the flag clears — no work lost
            if await poll_workers_paused(maker, check_state):
                if not pause_state["paused"]:
                    logger.info("paused by read-only maintenance mode")
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            if pause_state["paused"]:
                logger.info("resumed")
            pause_state["paused"] = False
            if not backfilled:                              # a write: after any freeze
                backfilled = True
                await _backfill_search(maker)
            if time.monotonic() - stale_at >= STALE_SWEEP_SECONDS:
                stale_at = time.monotonic()
                await _requeue_stale(maker, stale_state)
            if time.monotonic() - expired_at >= EXPIRY_SWEEP_SECONDS:
                expired_at = time.monotonic()               # even after a failure
                await _sweep_expired(maker, expiry_state)
            if time.monotonic() - daily_at >= REMINDERS_CHECK_SECONDS:
                daily_at = time.monotonic()                 # even after a failure
                await _schedule_daily(maker, reminders_state, ensure_reminders_job,
                                      "review reminders")
                await _schedule_daily(maker, retention_state, ensure_retention_job,
                                      "the retention sweep")
            try:
                worked = await run_once(maker)
                claim_state["failed"] = False
            except Exception:
                if not claim_state["failed"]:
                    logger.warning("could not poll the wiki queue — retrying", exc_info=True)
                claim_state["failed"] = True
                worked = False
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)

