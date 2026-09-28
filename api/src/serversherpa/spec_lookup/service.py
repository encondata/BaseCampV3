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
    COLUMNS, blank_conditions, column_payload, current_value, enabled_fields, is_blank,
)
from serversherpa.spec_lookup.provider import LookupResult
from serversherpa.spec_lookup.verify import Verified, height_fits_ru, verify_finding, weight_is_heavy

AI_LOOKUP = "ai_lookup"
PRIORITY_SWEEP = 0
PRIORITY_BATCH = 10
PRIORITY_MODEL = 20
ACTIVE = ("queued", "running")
FAILED_COOLDOWN = timedelta(days=1)


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
        recently_failed = exists().where(
            SpecLookupJob.model_id == AssetModel.id, SpecLookupJob.status == "failed",
            SpecLookupJob.finished_at >= now - FAILED_COOLDOWN)
        q = q.where(~recently_failed)
    return list(await db.scalars(q))


async def last_finished_job(db: AsyncSession) -> SpecLookupJob | None:
    return await db.scalar(
        select(SpecLookupJob).where(SpecLookupJob.finished_at.is_not(None))
        .order_by(SpecLookupJob.finished_at.desc()).limit(1))


async def key_rejected(db: AsyncSession) -> bool:
    """True when the most recent finished lookup failed because the API
    refused the key (callers check that a key is actually set)."""
    last = await last_finished_job(db)
    return last is not None and last.status == "failed" and last.error == "not_configured"


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


def _known_ru(verified: list[Verified], m: AssetModel) -> int | None:
    """The ru to cross-check other fields against: the verified ru_size from
    this same result if present (order-independent of the other findings),
    else the model's current ru_size."""
    ru_finding = next((v for v in verified if v.field == "ru_size"), None)
    if ru_finding is not None:
        return int(float(ru_finding.value))
    if m.ru_size is not None:
        return int(m.ru_size)
    return None


async def record_result(db: AsyncSession, job: SpecLookupJob, m: AssetModel,
                        result: LookupResult, cfg: dict) -> list[SpecSuggestion]:
    now = datetime.now(UTC)
    job.input_tokens += result.input_tokens
    job.output_tokens += result.output_tokens
    job.search_count += result.search_count
    m.specs_looked_up_at = now

    # 1. Collect every verified finding first (first verified value per field wins).
    verified: list[Verified] = []
    seen_fields: set[str] = set()
    for f in result.findings:
        if f.field in seen_fields:
            continue
        v = verify_finding(f.field, f.value, f.unit, f.quote, f.source_url, result.seen_urls)
        if v is None:
            continue
        seen_fields.add(v.field)
        verified.append(v)

    # 2. Apply the cross-field plausibility check: a height that doesn't fit
    # the (known) rack size never becomes a suggestion at all.
    ru = _known_ru(verified, m)
    if ru is not None and ru >= 1:
        verified = [v for v in verified
                   if v.field != "height" or height_fits_ru(float(v.value), v.unit, ru)]

    # 3. Write suggestions.
    out: list[SpecSuggestion] = []
    for v in verified:
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
        heavy = v.field == "weight" and weight_is_heavy(float(v.value), v.unit, ru)
        if cfg.get("auto_apply") and v.field != "knowledge" and is_blank(m, v.field) and not heavy:
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


def _filled_partner(m: AssetModel, field: str) -> str | None:
    """The first non-empty column of a unit pair, with its unit ("13.6 kg")."""
    for unit in COLUMNS[field]:
        v = current_value(m, field, unit)
        if v is not None:
            return f"{v} {unit}" if unit else v
    return None


async def approve(db: AsyncSession, s: SpecSuggestion, actor_id: uuid.UUID) -> None:
    if s.status != "pending":
        raise BadState(s.status)
    m = await _model(db, s)
    if current_value(m, s.field, s.unit) != s.previous_value:
        raise FieldChanged(current_value(m, s.field, s.unit))
    if s.previous_value is None and not is_blank(m, s.field):
        raise FieldChanged(_filled_partner(m, s.field))
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
