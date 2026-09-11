"""The report worker loop (`serversherpa report-worker`) — a separate
process from the API. Claims queued report_runs, renders the result
through the module registry (usually a PDF; Site & Move Survey produces
an xlsx), uploads it, attaches it to the initiative when the run has one,
and writes an inbox row when asked. A bad run never kills the loop; a DB
blip on the claim is swallowed and logged once (same rule as the pause
check and the heartbeat: a DB blip must never kill the host process).

Session discipline — the build gets its own session and nothing else
does. A build can poison its transaction (a bad query) or leave a
cancelled statement behind (the timeout), so once it has failed that
session is only ever rolled back, never reused. The terminal status is
written through a FRESH session, and the inbox row through another one
AFTER that status is committed. That ordering is what keeps a completed
report completed when the inbox is down, and what keeps a build's real
error from being overwritten by the PendingRollbackError of a session
someone tried to reuse."""

import asyncio
import logging
import time
import uuid
from datetime import UTC, datetime
from pathlib import PurePosixPath

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Attachment, Initiative, Partner, ReportDefinition, ReportRun,
)
from serversherpa.notifications.inbox import notify
from serversherpa.reports.jobs import claim_next, requeue_stale
from serversherpa.reports.move_report.gather import InitiativeUnavailable
from serversherpa.reports.rack_renderer import RackRendererUnavailable
from serversherpa.reports.registry import get_module
from serversherpa.reports.site_move_survey.gather import SurveyGatherError
from serversherpa.services.audit import audit
from serversherpa.services.storage import put_object

logger = logging.getLogger("serversherpa.reports.worker")

RUN_TIMEOUT_SECONDS = 300.0
STALE_SWEEP_SECONDS = 60
ERROR_MAX = 2000


def _finish(run: ReportRun, status: str, error: str | None = None) -> None:
    run.status = status
    run.error = error[:ERROR_MAX] if error else None
    run.finished_at = datetime.now(UTC)


async def _notify(db: AsyncSession, run: ReportRun, definition_name: str,
                  initiative_name: str) -> None:
    await db.refresh(run, ["notify"])          # a "notify me" click mid-run counts
    if not run.notify:
        return
    link = f"/reports?tab=history&run={run.id}"
    payload = {"run_id": str(run.id)}
    if run.status == "completed":
        await notify(db, run.requested_by, "report_ready", f"{definition_name} is ready",
                     body=initiative_name, link=link, payload=payload)
    else:
        await notify(db, run.requested_by, "report_failed", f"{definition_name} failed",
                     body=run.error or "unknown error", link=link, payload=payload)


async def process_run(db: AsyncSession, run: ReportRun, *, sessionmaker,
                      renderer=None) -> str:
    """Run one claimed (status='running') run to a terminal status, and
    return it. `db` is the BUILD session and is never used once the build
    has failed (see the module docstring)."""
    run_id = run.id
    definition = await db.get(ReportDefinition, run.definition_id)
    initiative = await db.get(Initiative, run.initiative_id) if run.initiative_id else None
    definition_name = definition.name if definition else run.report_type
    initiative_name = initiative.name if initiative else ("—" if run.initiative_id is None else "?")
    if run.initiative_id is None and run.report_type == "site_move_survey":
        # A standalone survey (partner + manually chosen sites, no
        # initiative) has no initiative name to show in the "report_ready"
        # inbox row — the partner is the closest equivalent, and beats a
        # bare "—" for a requester juggling several partners' surveys.
        raw_partner_id = (run.options or {}).get("partner_id")
        partner = None
        if raw_partner_id:
            try:
                partner = await db.get(Partner, uuid.UUID(str(raw_partner_id)))
            except ValueError:
                partner = None
        if partner is not None:
            initiative_name = partner.name
    error: str | None = None
    try:
        module = get_module(run.report_type)
        kwargs = {"renderer": renderer} if renderer is not None else {}
        result = await asyncio.wait_for(module.build(db, run, **kwargs), RUN_TIMEOUT_SECONDS)
        ext = PurePosixPath(result.filename).suffix or ".bin"
        key = f"reports/{run.initiative_id or 'standalone'}/{run_id}{ext}"
        await put_object(key, result.content, result.content_type)
        if run.initiative_id is not None:
            # no initiative to attach to when the survey was generated for
            # a partner + manually-chosen sites — see the module docstring
            attachment = Attachment(
                entity_type="initiative", entity_id=run.initiative_id, kind="document",
                storage_key=key, filename=result.filename, content_type=result.content_type,
                size_bytes=len(result.content), uploaded_by=run.requested_by)
            db.add(attachment)
            await db.flush()
            # same audit row a manual upload writes (routes/attachments.py), so
            # the initiative's Files history reads the same either way
            audit(db, actor_id=run.requested_by, entity_type="initiative",
                  entity_id=str(run.initiative_id), action="attachment.add",
                  changes={"filename": {"from": None, "to": result.filename}})
            run.attachment_id = attachment.id
        run.storage_key = key
        run.filename = result.filename
        run.size_bytes = len(result.content)
        _finish(run, "completed")
        await db.commit()                   # a failure here is a failed run too
    except InitiativeUnavailable:
        error = "initiative_unavailable"
    except SurveyGatherError as exc:
        error = exc.code
    except RackRendererUnavailable as exc:
        error = f"rack renderer unavailable: {exc}"
    except TimeoutError:
        error = f"timed out after {RUN_TIMEOUT_SECONDS:g}s"
    except Exception as exc:                                    # run must terminate
        logger.exception("run %s failed: %s", run_id, exc)
        error = f"{type(exc).__name__}: {exc}"

    status = "completed" if error is None else "failed"
    if error is not None:
        try:
            await db.rollback()             # the ONLY thing the build session
        except Exception:                   # is still good for — and even this
            logger.warning("could not roll back the build session for run %s",
                           run_id, exc_info=True)
        async with sessionmaker() as fin:   # terminal state through a fresh one
            row = await fin.get(ReportRun, run_id)
            if row is not None:
                _finish(row, "failed", error)
                await fin.commit()
    try:                                    # best-effort, and always last
        async with sessionmaker() as nb:
            row = await nb.get(ReportRun, run_id)
            if row is not None:
                await _notify(nb, row, definition_name, initiative_name)
                await nb.commit()
    except Exception:
        logger.warning("could not write the inbox row for run %s", run_id, exc_info=True)
    return status


async def run_once(sessionmaker, *, renderer=None) -> bool:
    """Claim and process at most one run. False when the queue is empty."""
    from serversherpa.system.db_logging import install
    install("report-worker")

    async with sessionmaker() as db:
        run = await claim_next(db)
        if run is None:
            return False
        run_id = run.id
        logger.info("claimed run %s (%s)", run_id, run.report_type)
        try:
            status = await process_run(db, run, sessionmaker=sessionmaker,
                                       renderer=renderer)
        except Exception as exc:            # last resort: process_run owns its
            logger.exception("run %s crashed in worker: %s", run_id, exc)
            try:
                await db.rollback()
            except Exception:
                logger.warning("could not roll back the build session for run %s",
                               run_id, exc_info=True)
            async with sessionmaker() as fin:
                row = await fin.get(ReportRun, run_id)
                if row is not None:
                    _finish(row, "failed", f"worker_error: {exc}")
                    await fin.commit()
            status = "failed"
        logger.info("run %s finished status=%s", run_id, status)
        return True


async def _sweep_stale(maker, state: dict) -> None:
    """Re-queue runs a dead worker left 'running'. A DB blip must never kill
    the loop: log once per outage, same rule as the claim and pause checks."""
    try:
        async with maker() as db:
            requeued = await requeue_stale(db)
        if requeued:
            logger.info("re-queued %d stale run(s)", requeued)
        state["failed"] = False
    except Exception:
        if not state["failed"]:
            logger.warning("could not re-queue stale runs — retrying", exc_info=True)
        state["failed"] = True


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("report-worker")
    pause_state = {"paused": False}
    check_state: dict = {}
    claim_state = {"failed": False}
    sweep_state = {"failed": False}
    heartbeat = start_heartbeat("report-worker", "worker", meta_fn=lambda: dict(pause_state))
    maker = get_sessionmaker()
    try:
        await _sweep_stale(maker, sweep_state)          # startup sweep
        swept_at = time.monotonic()
        logger.info("report worker online — watching the queue")
        while True:
            if await poll_workers_paused(maker, check_state):
                if not pause_state["paused"]:
                    logger.info("paused by read-only maintenance mode")
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            if pause_state["paused"]:
                logger.info("resumed")
            pause_state["paused"] = False
            # a worker that died mid-run leaves its row 'running' forever
            # unless somebody sweeps: at startup is not enough for a process
            # that then stays up for weeks.
            if time.monotonic() - swept_at >= STALE_SWEEP_SECONDS:
                swept_at = time.monotonic()
                await _sweep_stale(maker, sweep_state)
            try:
                worked = await run_once(maker)
                claim_state["failed"] = False
            except Exception:
                if not claim_state["failed"]:
                    logger.warning("could not poll the report queue — retrying", exc_info=True)
                claim_state["failed"] = True
                worked = False
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
