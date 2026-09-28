"""Spec lookup business rules — shared by the worker and the routes.
Nothing here commits; callers own the transaction."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import exists, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.assets.units import apply_unit_pairs
from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.spec_lookup.fields import (
    blank_conditions, column_payload, current_value, enabled_fields, is_blank,
)
from serversherpa.spec_lookup.provider import LookupResult
from serversherpa.spec_lookup.verify import verify_finding

AI_LOOKUP = "ai_lookup"
PRIORITY_SWEEP = 0
PRIORITY_BATCH = 10
PRIORITY_MODEL = 20
ACTIVE = ("queued", "running")


class FieldChanged(Exception):
    pass


class BadState(Exception):
    pass


async def eligible_model_ids(db: AsyncSession, cfg: dict, *, respect_retry: bool = True,
                             now: datetime | None = None) -> list[uuid.UUID]:
    fields = enabled_fields(cfg)
    if not fields:
        return []
    now = now or datetime.now(UTC)
    active = exists().where(SpecLookupJob.model_id == AssetModel.id,
                            SpecLookupJob.status.in_(ACTIVE))
    q = (select(AssetModel.id)
         .where(AssetModel.private.is_(False), AssetModel.spec_lookup_skip.is_(False),
                or_(*blank_conditions(fields)), ~active)
         .order_by(AssetModel.make, AssetModel.model))
    if respect_retry:
        days = int(cfg.get("retry_after_days") or 0)
        never = AssetModel.specs_looked_up_at.is_(None)
        if days > 0:
            q = q.where(or_(never, AssetModel.specs_looked_up_at < now - timedelta(days=days)))
        else:
            q = q.where(never)
    return list(await db.scalars(q))


async def enqueue(db: AsyncSession, model_ids: list[uuid.UUID], priority: int,
                  requested_by: uuid.UUID | None) -> int:
    if not model_ids:
        return 0
    await db.execute(
        update(SpecLookupJob)
        .where(SpecLookupJob.model_id.in_(model_ids), SpecLookupJob.status == "queued",
               SpecLookupJob.priority < priority)
        .values(priority=priority, next_attempt_at=None))
    stmt = (insert(SpecLookupJob)
            .values([{"model_id": mid, "priority": priority, "requested_by": requested_by}
                     for mid in model_ids])
            .on_conflict_do_nothing()
            .returning(SpecLookupJob.id))
    return len((await db.execute(stmt)).all())


async def _apply(db: AsyncSession, m: AssetModel, s: SpecSuggestion,
                 actor_id: uuid.UUID | None, value: str | None, action: str) -> None:
    data = apply_unit_pairs(column_payload(s.field, value, s.unit))
    fields = list(data.keys())
    before = snapshot(m, fields)
    for col, v in data.items():
        setattr(m, col, v)
    changes = diff(before, snapshot(m, fields))
    if changes:
        m.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor_id, entity_type="asset_model", entity_id=str(m.id),
              action=action, changes=changes)


async def record_result(db: AsyncSession, job: SpecLookupJob, m: AssetModel,
                        result: LookupResult, cfg: dict) -> list[SpecSuggestion]:
    now = datetime.now(UTC)
    job.input_tokens += result.input_tokens
    job.output_tokens += result.output_tokens
    job.search_count += result.search_count
    m.specs_looked_up_at = now
    out: list[SpecSuggestion] = []
    seen_fields: set[str] = set()
    for f in result.findings:
        if f.field in seen_fields:          # first verified value per field wins
            continue
        v = verify_finding(f.field, f.value, f.unit, f.quote, f.source_url, result.seen_urls)
        if v is None:
            continue
        seen_fields.add(v.field)
        await db.execute(
            update(SpecSuggestion)
            .where(SpecSuggestion.model_id == m.id, SpecSuggestion.field == v.field,
                   SpecSuggestion.status == "pending")
            .values(status="rejected", decided_at=now))
        s = SpecSuggestion(model_id=m.id, job_id=job.id, field=v.field, value=v.value,
                           unit=v.unit, quote=v.quote[:2000], source_url=v.source_url,
                           previous_value=current_value(m, v.field, v.unit),
                           status="pending")
        db.add(s)
        if cfg.get("auto_apply") and v.field != "knowledge" and is_blank(m, v.field):
            await _apply(db, m, s, None, v.value, "spec_lookup.apply")
            s.status = "applied"
            s.decided_at = now
        out.append(s)
    await db.flush()
    return out


async def _model(db: AsyncSession, s: SpecSuggestion) -> AssetModel:
    m = await db.get(AssetModel, s.model_id)
    if m is None:
        raise BadState("model_gone")
    return m


async def approve(db: AsyncSession, s: SpecSuggestion, actor_id: uuid.UUID) -> None:
    if s.status != "pending":
        raise BadState(s.status)
    m = await _model(db, s)
    if current_value(m, s.field, s.unit) != s.previous_value:
        raise FieldChanged(current_value(m, s.field, s.unit))
    await _apply(db, m, s, actor_id, s.value, "spec_lookup.apply")
    s.status = "approved"
    s.decided_by = actor_id
    s.decided_at = datetime.now(UTC)


async def reject(db: AsyncSession, s: SpecSuggestion, actor_id: uuid.UUID) -> None:
    if s.status != "pending":
        raise BadState(s.status)
    s.status = "rejected"
    s.decided_by = actor_id
    s.decided_at = datetime.now(UTC)


async def undo(db: AsyncSession, s: SpecSuggestion, actor_id: uuid.UUID) -> None:
    if s.status not in ("applied", "approved"):
        raise BadState(s.status)
    m = await _model(db, s)
    if current_value(m, s.field, s.unit) != s.value:
        raise FieldChanged(current_value(m, s.field, s.unit))
    await _apply(db, m, s, actor_id, s.previous_value, "spec_lookup.undo")
    s.status = "reverted"
    s.decided_by = actor_id
    s.decided_at = datetime.now(UTC)
