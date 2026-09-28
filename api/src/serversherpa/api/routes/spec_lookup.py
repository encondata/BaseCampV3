"""Makes / Models spec lookup: queue, status, suggestion review, and the
Developer › System Config panel. Global (internal) users only — the same
rule as /asset-models."""

import logging
import time
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.routes.asset_models import _err, _require_global
from serversherpa.api.schemas import (
    SpecLookupQueueIn, SpecSuggestionBulkIn, SpecSuggestionOut,
)
from serversherpa.config import get_settings
from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion, SystemProcess
from serversherpa.spec_lookup import provider as provider_mod
from serversherpa.spec_lookup import service
from serversherpa.spec_lookup.fields import current_value, enabled_fields
from serversherpa.spec_lookup.worker import PROCESS_NAME
from serversherpa.system.config_store import read_section
from serversherpa.system.registry import derive_status

logger = logging.getLogger("serversherpa.spec_lookup.routes")

router = APIRouter(prefix="/spec-lookup", tags=["assets"])


def _out(s: SpecSuggestion, m: AssetModel) -> SpecSuggestionOut:
    return SpecSuggestionOut(
        id=s.id, model_id=s.model_id, make=m.make, model=m.model, field=s.field,
        value=s.value, unit=s.unit, current_value=current_value(m, s.field, s.unit),
        source_url=s.source_url, quote=s.quote, status=s.status,
        created_at=s.created_at, decided_at=s.decided_at)


@router.get("/status")
async def status(db: DbSession,
                 actor: AuthContext = require_permission("asset_models", "view")) -> dict:
    _require_global(actor)
    cfg = await read_section(db, service.AI_LOOKUP)
    queued = await db.scalar(select(func.count()).select_from(SpecLookupJob)
                             .where(SpecLookupJob.status == "queued"))
    running = (await db.execute(
        select(AssetModel.id, AssetModel.make, AssetModel.model)
        .join(SpecLookupJob, SpecLookupJob.model_id == AssetModel.id)
        .where(SpecLookupJob.status == "running").limit(1))).first()
    last = await db.scalar(select(func.max(SpecLookupJob.finished_at)))
    pending = await db.scalar(select(func.count()).select_from(SpecSuggestion)
                              .where(SpecSuggestion.status == "pending"))
    month_start = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    lookups, inp, out, searches = (await db.execute(
        select(func.count(), func.coalesce(func.sum(SpecLookupJob.input_tokens), 0),
               func.coalesce(func.sum(SpecLookupJob.output_tokens), 0),
               func.coalesce(func.sum(SpecLookupJob.search_count), 0))
        .where(SpecLookupJob.finished_at >= month_start,
               SpecLookupJob.input_tokens > 0))).one()
    failed = await db.scalar(select(func.count()).select_from(SpecLookupJob)
                             .where(SpecLookupJob.status == "failed",
                                    SpecLookupJob.finished_at >= month_start))
    configured = provider_mod.is_configured()
    last_job = await service.last_finished_job(db)
    return {
        "configured": configured,
        "failed_this_month": failed,
        "last_error": last_job.error if last_job else None,
        "key_rejected": configured and await service.key_rejected(db),
        "background_enabled": bool(cfg.get("background_enabled")),
        "queued": queued, "last_finished_at": last, "pending_count": pending,
        "running_model": ({"id": running.id, "make": running.make, "model": running.model}
                          if running else None),
        "month": {"lookups": lookups, "input_tokens": inp, "output_tokens": out,
                  "searches": searches,
                  "est_cost_usd": round(provider_mod.estimate_cost(inp, out, searches), 2)},
    }


@router.post("/queue")
async def queue(body: SpecLookupQueueIn, db: DbSession,
                actor: AuthContext = require_permission("asset_models", "change")) -> dict:
    _require_global(actor)
    if not provider_mod.is_configured():
        raise _err(409, "not_configured")
    skipped: list[dict] = []
    if body.model_ids is None:
        cfg = await read_section(db, service.AI_LOOKUP)
        if not enabled_fields(cfg):
            return {"queued": 0, "skipped": [], "reason": "no_fields_enabled"}
        ids = await service.eligible_model_ids(db, cfg)
        priority = service.PRIORITY_BATCH
    else:
        rows = {m.id: m for m in await db.scalars(
            select(AssetModel).where(AssetModel.id.in_(body.model_ids)))}
        ids = []
        for mid in body.model_ids:
            m = rows.get(mid)
            reason = ("not_found" if m is None else "private" if m.private
                      else "skipped" if m.spec_lookup_skip else None)
            if reason:
                skipped.append({"id": mid, "reason": reason})
            else:
                ids.append(mid)
        priority = service.PRIORITY_MODEL
    n = await service.enqueue(db, ids, priority, actor.person.id)
    await db.commit()
    return {"queued": n, "skipped": skipped}


@router.get("/suggestions", response_model=list[SpecSuggestionOut])
async def list_suggestions(
    db: DbSession, status: str = "pending", model_id: uuid.UUID | None = None,
    actor: AuthContext = require_permission("asset_models", "view"),
) -> list[SpecSuggestionOut]:
    _require_global(actor)
    q = (select(SpecSuggestion, AssetModel)
         .join(AssetModel, AssetModel.id == SpecSuggestion.model_id)
         .order_by(SpecSuggestion.created_at.desc()).limit(1000))
    if status == "applied":
        q = q.where(SpecSuggestion.status.in_(("applied", "approved")))
    elif status != "all":
        q = q.where(SpecSuggestion.status == status)
    if model_id is not None:
        q = q.where(SpecSuggestion.model_id == model_id)
    return [_out(s, m) for s, m in (await db.execute(q)).all()]


async def _act(db, s: SpecSuggestion, action: str, actor_id: uuid.UUID) -> None:
    fn = {"approve": service.approve, "reject": service.reject, "undo": service.undo}[action]
    await fn(db, s, actor_id)


@router.post("/suggestions/{suggestion_id}/{action}", response_model=SpecSuggestionOut)
async def act(suggestion_id: uuid.UUID, action: str, db: DbSession,
              actor: AuthContext = require_permission("asset_models", "change")
              ) -> SpecSuggestionOut:
    _require_global(actor)
    if action not in ("approve", "reject", "undo"):
        raise _err(404, "not_found")
    s = await db.get(SpecSuggestion, suggestion_id)
    if s is None:
        raise _err(404, "suggestion_not_found")
    try:
        await _act(db, s, action, actor.person.id)
    except service.FieldChanged as exc:
        await db.rollback()
        raise _err(409, "field_changed", current=exc.args[0] if exc.args else None)
    except service.BadState:
        await db.rollback()
        raise _err(409, "bad_state")
    await db.commit()
    m = await db.get(AssetModel, s.model_id)
    return _out(s, m)


@router.post("/suggestions/bulk")
async def bulk(body: SpecSuggestionBulkIn, db: DbSession,
               actor: AuthContext = require_permission("asset_models", "change")) -> dict:
    _require_global(actor)
    results = []
    for sid in body.ids:
        s = await db.get(SpecSuggestion, sid)
        if s is None:
            results.append({"id": sid, "ok": False, "error": "suggestion_not_found",
                            "make": None, "model": None, "field": None, "value": None})
            continue
        m = await db.get(AssetModel, s.model_id)
        row = {"id": sid, "make": m.make, "model": m.model, "field": s.field, "value": s.value}
        try:
            async with db.begin_nested():
                await _act(db, s, body.action, actor.person.id)
            results.append({**row, "ok": True, "error": None})
        except service.FieldChanged:
            results.append({**row, "ok": False, "error": "field_changed"})
        except service.BadState:
            results.append({**row, "ok": False, "error": "bad_state"})
        except Exception:
            logger.exception("bulk %s failed for suggestion %s", body.action, sid)
            results.append({**row, "ok": False, "error": "failed"})
    await db.commit()
    return {"results": results}


@router.get("/dev")
async def dev_info(db: DbSession,
                   actor: AuthContext = require_permission("devtools", "view")) -> dict:
    _require_global(actor)
    s = get_settings()
    key = s.anthropic_api_key.get_secret_value()
    proc = await db.get(SystemProcess, PROCESS_NAME)
    worker_status = ("missing" if proc is None else
                     derive_status(proc.heartbeat_at, proc.stopped_at, datetime.now(UTC),
                                   proc.meta))
    return {"model": s.spec_lookup_model, "max_searches": s.spec_lookup_max_searches,
            "max_fetches": s.spec_lookup_max_fetches, "key_set": bool(key),
            "key_last4": key[-4:] if len(key) >= 8 else None,
            "worker_status": worker_status,
            "worker_heartbeat_at": proc.heartbeat_at if proc else None}


@router.post("/dev/test")
async def dev_test(actor: AuthContext = require_permission("devtools", "change")) -> dict:
    _require_global(actor)             # a real (billed) API call
    p = provider_mod.get_provider()
    if p is None:
        return {"ok": False, "latency_ms": None, "error": "not_configured"}
    started = time.monotonic()
    try:
        await p.ping()
        return {"ok": True, "latency_ms": int((time.monotonic() - started) * 1000),
                "error": None}
    except provider_mod.ProviderError as exc:
        return {"ok": False, "latency_ms": None, "error": str(exc)[:300]}
    finally:
        await p.aclose()
