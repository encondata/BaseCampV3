"""Status rules CRUD — the /admin/status-rules backing. Rules are
validated against the code-side catalog at save time (the same catalog
the worker executes — one source of truth); status-typed action params
are additionally checked against the vocabulary here, where we have a
DB. PUT replaces children wholesale: child ids are not stable and
nothing may reference them. All writes audit through services.audit."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    StatusRuleExecStat, StatusRuleExecutionItem, StatusRuleIn, StatusRuleOut,
    StatusRulePatch,
)
from serversherpa.db.models import (
    ProcessedScan, Site, StatusRule, StatusRuleAction, StatusRuleCondition,
    StatusRuleExecution, StatusValue,
)
from serversherpa.services.audit import audit
from serversherpa.status_rules.catalog import (
    ACTIONS, CONDITION_FIELDS, OPERATORS, validate_action, validate_condition,
)
from serversherpa.status_rules.engine import invalidate_cache

router = APIRouter(prefix="/status-rules", tags=["status-rules"])


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _out(rule: StatusRule) -> dict:
    return {
        "id": rule.id, "name": rule.name, "description": rule.description,
        "trigger_status": rule.trigger_status,
        "trigger_match_type": rule.trigger_match_type,
        "priority": rule.priority, "enabled": rule.enabled,
        "conditions": [{"field": c.field, "operator": c.operator,
                        "value": c.value} for c in rule.conditions],
        "actions": [{"action_type": a.action_type, "params": a.params}
                    for a in rule.actions],
        "created_at": rule.created_at, "updated_at": rule.updated_at,
    }


async def _vocab_keys(db: DbSession, record_type: str) -> set[str]:
    return set((await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == record_type))).all())


async def _validate(db: DbSession, body: StatusRuleIn) -> None:
    if body.trigger_status not in await _vocab_keys(db, "asset"):
        raise _err(422, "bad_trigger", field="trigger_status")
    if body.trigger_match_type not in await _vocab_keys(db, "processed_scan"):
        raise _err(422, "bad_trigger", field="trigger_match_type")
    for i, c in enumerate(body.conditions):
        code = validate_condition(c.field, c.operator, c.value)
        if code:
            raise _err(422, "bad_condition", index=i, reason=code)
    for i, a in enumerate(body.actions):
        code = validate_action(a.action_type, a.params)
        if code:
            raise _err(422, "bad_action", index=i, reason=code)
        # status-typed params must be real vocabulary keys.
        action = ACTIONS[a.action_type]
        for p in action.params:
            if p.type == "status":
                record_type = p.options_source.removeprefix("status:")
                if a.params[p.name] not in await _vocab_keys(db, record_type):
                    raise _err(422, "bad_action", index=i,
                               reason="unknown_status_key")


def _children(body: StatusRuleIn) -> tuple[list, list]:
    conditions = [StatusRuleCondition(position=i, field=c.field,
                                      operator=c.operator, value=c.value)
                  for i, c in enumerate(body.conditions, 1)]
    actions = [StatusRuleAction(position=i, action_type=a.action_type,
                                params=a.params)
               for i, a in enumerate(body.actions, 1)]
    return conditions, actions


_LOAD = (selectinload(StatusRule.conditions),
         selectinload(StatusRule.actions))


async def _get(db: DbSession, rule_id: uuid.UUID) -> StatusRule:
    rule = await db.scalar(select(StatusRule).options(*_LOAD)
                           .where(StatusRule.id == rule_id))
    if rule is None:
        raise _err(404, "rule_not_found")
    return rule


@router.get("", response_model=list[StatusRuleOut])
async def list_rules(
    db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
) -> list[dict]:
    rules = (await db.scalars(
        select(StatusRule).options(*_LOAD)
        .order_by(StatusRule.priority, StatusRule.created_at))).all()
    return [_out(r) for r in rules]


@router.post("", response_model=StatusRuleOut, status_code=201)
async def create_rule(
    body: StatusRuleIn, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "add"),
) -> dict:
    await _validate(db, body)
    conditions, actions = _children(body)
    rule = StatusRule(
        name=body.name, description=body.description,
        trigger_status=body.trigger_status,
        trigger_match_type=body.trigger_match_type,
        priority=body.priority, enabled=body.enabled,
        created_by=actor.person.id,
        conditions=conditions, actions=actions)
    db.add(rule)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="status_rule",
          entity_id=str(rule.id), action="create",
          changes=body.model_dump(mode="json"))
    await db.commit()
    invalidate_cache()
    return _out(await _get(db, rule.id))


@router.get("/schema")
async def rule_schema(
    db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
) -> dict:
    vocab = (await db.scalars(select(StatusValue).where(
        StatusValue.is_active.is_(True)).order_by(
        StatusValue.record_type, StatusValue.sort_order))).all()
    by_type: dict[str, list[dict]] = {}
    for v in vocab:
        by_type.setdefault(v.record_type, []).append(
            {"value": v.key, "label": v.label, "color": v.color})
    sites = [{"value": str(sid), "label": name}
             for sid, name in (await db.execute(
                 select(Site.id, Site.name).order_by(Site.name))).all()]

    def options_for(source: str | None):
        if source is None:
            return None
        if source == "sites":
            return sites
        return by_type.get(source.removeprefix("status:"), [])

    return {
        "trigger_statuses": by_type.get("asset", []),
        "match_types": by_type.get("processed_scan", []),
        "operators": [{"key": k, "label": k.replace("_", " "),
                       "needs_value": k not in ("is_null", "is_not_null")}
                      for k in OPERATORS],
        "condition_fields": [
            {"key": f.key, "label": f.label, "type": f.type,
             **({"options": options_for(f.options_source)}
                if f.options_source else {})}
            for f in CONDITION_FIELDS.values()],
        "actions": [
            {"key": a.key, "label": a.label,
             "params": [
                 {"name": p.name, "type": p.type,
                  **({"options": list(p.options)} if p.options else {}),
                  **({"options": options_for(p.options_source)}
                     if p.options_source else {})}
                 for p in a.params]}
            for a in ACTIONS.values()],
        "sites": sites,
    }


@router.get("/executions", response_model=list[StatusRuleExecutionItem])
async def list_executions(
    db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
    rule_id: uuid.UUID | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[dict]:
    query = (select(StatusRuleExecution, ProcessedScan.scanned_value,
                    ProcessedScan.status)
             .outerjoin(ProcessedScan,
                        StatusRuleExecution.processed_scan_id
                        == ProcessedScan.id)
             .order_by(StatusRuleExecution.executed_at.desc(),
                       StatusRuleExecution.id.desc())
             .limit(limit).offset(offset))
    if rule_id is not None:
        query = query.where(StatusRuleExecution.rule_id == rule_id)
    rows = (await db.execute(query)).all()
    return [{
        "id": ex.id, "rule_id": ex.rule_id, "rule_name": ex.rule_name,
        "processed_scan_id": ex.processed_scan_id,
        "conditions_met": ex.conditions_met,
        "actions_applied": ex.actions_applied, "error": ex.error,
        "executed_at": ex.executed_at, "duration_ms": ex.duration_ms,
        "scanned_value": value, "scan_status": status,
    } for ex, value, status in rows]


@router.get("/executions/stats", response_model=list[StatusRuleExecStat])
async def execution_stats(
    db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
) -> list[dict]:
    rows = (await db.execute(
        select(StatusRuleExecution.rule_id,
               func.count().label("run_count"),
               func.count().filter(
                   StatusRuleExecution.conditions_met).label("met_count"),
               func.max(StatusRuleExecution.executed_at),
               func.avg(StatusRuleExecution.duration_ms))
        .where(StatusRuleExecution.rule_id.is_not(None))
        .group_by(StatusRuleExecution.rule_id))).all()
    return [{"rule_id": r[0], "run_count": r[1], "met_count": r[2],
             "last_run_at": r[3],
             "avg_duration_ms": float(r[4]) if r[4] is not None else None}
            for r in rows]


@router.get("/{rule_id}", response_model=StatusRuleOut)
async def get_rule(
    rule_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
) -> dict:
    return _out(await _get(db, rule_id))


@router.put("/{rule_id}", response_model=StatusRuleOut)
async def replace_rule(
    rule_id: uuid.UUID, body: StatusRuleIn, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "change"),
) -> dict:
    rule = await _get(db, rule_id)
    await _validate(db, body)
    rule.name = body.name
    rule.description = body.description
    rule.trigger_status = body.trigger_status
    rule.trigger_match_type = body.trigger_match_type
    rule.priority = body.priority
    rule.enabled = body.enabled
    conditions, actions = _children(body)
    rule.conditions[:] = conditions      # delete-orphan replaces children
    rule.actions[:] = actions
    rule.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="status_rule",
          entity_id=str(rule.id), action="update",
          changes=body.model_dump(mode="json"))
    await db.commit()
    invalidate_cache()
    return _out(await _get(db, rule.id))


@router.patch("/{rule_id}", response_model=StatusRuleOut)
async def toggle_rule(
    rule_id: uuid.UUID, body: StatusRulePatch, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "change"),
) -> dict:
    rule = await _get(db, rule_id)
    rule.enabled = body.enabled
    rule.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="status_rule",
          entity_id=str(rule.id), action="toggle",
          changes={"enabled": body.enabled})
    await db.commit()
    invalidate_cache()
    return _out(await _get(db, rule.id))


@router.delete("/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "delete"),
) -> None:
    rule = await _get(db, rule_id)
    audit(db, actor_id=actor.person.id, entity_type="status_rule",
          entity_id=str(rule.id), action="delete",
          changes={"name": rule.name})
    await db.delete(rule)
    await db.commit()
    invalidate_cache()
