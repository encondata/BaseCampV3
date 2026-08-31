"""Status rules CRUD — the /admin/status-rules backing. Rules are
validated against the code-side catalog at save time (the same catalog
the worker executes — one source of truth); status-typed action params
are additionally checked against the vocabulary here, where we have a
DB. PUT replaces children wholesale: child ids are not stable and
nothing may reference them. All writes audit through services.audit."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    StatusRuleIn, StatusRuleOut, StatusRulePatch,
)
from serversherpa.db.models import (
    StatusRule, StatusRuleAction, StatusRuleCondition, StatusValue,
)
from serversherpa.services.audit import audit
from serversherpa.status_rules.catalog import (
    ACTIONS, validate_action, validate_condition,
)

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
    return _out(await _get(db, rule.id))


# NOTE(task 8): schema/executions endpoints (GET /status-rules/schema,
# GET /status-rules/executions) must be added ABOVE the /{rule_id}
# routes below — otherwise "schema"/"executions" would be swallowed by
# the {rule_id} path param.


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
