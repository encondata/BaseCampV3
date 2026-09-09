"""The report worker loop (`serversherpa report-worker`) — a separate
process from the API. Claims queued report_runs, renders the PDF through
the module registry, uploads it, attaches it to the initiative, and
writes an inbox row when asked. A bad run never kills the loop; a DB blip
on the claim is swallowed and logged once (same rule as the pause check
and the heartbeat: a DB blip must never kill the host process)."""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Attachment, Initiative, ReportDefinition, ReportRun
from serversherpa.notifications.inbox import notify
from serversherpa.reports.jobs import claim_next, requeue_stale
from serversherpa.reports.move_report.gather import InitiativeUnavailable
from serversherpa.reports.rack_renderer import RackRendererUnavailable
from serversherpa.reports.registry import get_module
from serversherpa.services.storage import put_object

logger = logging.getLogger("serversherpa.reports.worker")

RUN_TIMEOUT_SECONDS = 300.0
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


async def process_run(db: AsyncSession, run: ReportRun, *, renderer=None) -> None:
    """Run one claimed (status='running') run to a terminal status."""
    definition = await db.get(ReportDefinition, run.definition_id)
    initiative = await db.get(Initiative, run.initiative_id)
    definition_name = definition.name if definition else run.report_type
    initiative_name = initiative.name if initiative else "?"
    try:
        module = get_module(run.report_type)
        kwargs = {"renderer": renderer} if renderer is not None else {}
        result = await asyncio.wait_for(module.build(db, run, **kwargs), RUN_TIMEOUT_SECONDS)
        key = f"reports/{run.initiative_id}/{run.id}.pdf"
        await put_object(key, result.pdf, "application/pdf")
        attachment = Attachment(
            entity_type="initiative", entity_id=run.initiative_id, kind="document",
            storage_key=key, filename=result.filename, content_type="application/pdf",
            size_bytes=len(result.pdf), uploaded_by=run.requested_by)
        db.add(attachment)
        await db.flush()
        run.storage_key = key
        run.attachment_id = attachment.id
        run.filename = result.filename
        run.size_bytes = len(result.pdf)
        _finish(run, "completed")
    except InitiativeUnavailable:
        _finish(run, "failed", "initiative_unavailable")
    except RackRendererUnavailable as exc:
        _finish(run, "failed", f"rack renderer unavailable: {exc}")
    except TimeoutError:
        _finish(run, "failed", f"timed out after {RUN_TIMEOUT_SECONDS:g}s")
    except Exception as exc:                                    # run must terminate
        logger.exception("run %s failed: %s", run.id, exc)
        _finish(run, "failed", f"{type(exc).__name__}: {exc}")
    await _notify(db, run, definition_name, initiative_name)
    await db.commit()


async def run_once(sessionmaker, *, renderer=None) -> bool:
    """Claim and process at most one run. False when the queue is empty."""
    async with sessionmaker() as db:
        run = await claim_next(db)
        if run is None:
            return False
        logger.info("claimed run %s (%s)", run.id, run.report_type)
        try:
            await process_run(db, run, renderer=renderer)
        except Exception as exc:                                # e.g. commit failed
            logger.exception("run %s crashed in worker: %s", run.id, exc)
            await db.rollback()
            _finish(run, "failed", f"worker_error: {exc}")
            await db.commit()
        logger.info("run %s finished status=%s", run.id, run.status)
        return True


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("report-worker")
    pause_state = {"paused": False}
    check_state: dict = {}
    claim_state = {"failed": False}
    heartbeat = start_heartbeat("report-worker", "worker", meta_fn=lambda: dict(pause_state))
    maker = get_sessionmaker()
    try:
        try:
            async with maker() as db:
                requeued = await requeue_stale(db)
                if requeued:
                    logger.info("re-queued %d stale run(s)", requeued)
        except Exception:
            logger.warning("could not re-queue stale runs at startup", exc_info=True)
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
