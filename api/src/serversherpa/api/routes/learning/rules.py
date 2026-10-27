"""Assignment-rule routes: ordered rules that hand a packet to the people
they match. Reads need `learning:view`; create `add`; edits and reordering
`change`; delete `delete` (`require_manager`)."""
import uuid

from fastapi import APIRouter, HTTPException, Response

from serversherpa.api.deps import AuthContext, DbSession
from serversherpa.learning import rules
from serversherpa.learning.access import require_manager
from serversherpa.learning.models import LearningRule
from serversherpa.learning.schemas import (
    RuleCreateIn,
    RuleOut,
    RulePatchIn,
    RuleReorderIn,
)

router = APIRouter()


async def _rule(db, rule_id: uuid.UUID) -> LearningRule:
    rule = await db.get(LearningRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Not found."})
    return rule


@router.get("/rules", response_model=list[RuleOut])
async def list_rules(
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> list[dict]:
    return await rules.list_rules(db)


@router.post("/rules", response_model=RuleOut, status_code=201)
async def create_rule(
    body: RuleCreateIn,
    db: DbSession,
    actor: AuthContext = require_manager("add"),
) -> dict:
    rule = await rules.create_rule(
        db, actor_id=actor.person.id, name=body.name, packet_id=body.packet_id,
        conditions=body.conditions, enabled=body.enabled)
    await db.commit()
    await db.refresh(rule)
    return await rules.rule_view(db, rule)


# declared before /rules/{rule_id} so "reorder" is never read as an id
@router.post("/rules/reorder", response_model=list[RuleOut])
async def reorder_rules(
    body: RuleReorderIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> list[dict]:
    await rules.reorder_rules(db, body.ids, actor_id=actor.person.id)
    await db.commit()
    return await rules.list_rules(db)


@router.patch("/rules/{rule_id}", response_model=RuleOut)
async def patch_rule(
    rule_id: uuid.UUID,
    body: RulePatchIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> dict:
    rule = await _rule(db, rule_id)
    await rules.update_rule(db, rule, actor_id=actor.person.id,
                            changes=body.model_dump(exclude_unset=True))
    await db.commit()
    await db.refresh(rule)
    return await rules.rule_view(db, rule)


@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("delete"),
) -> Response:
    await rules.delete_rule(db, await _rule(db, rule_id), actor_id=actor.person.id)
    await db.commit()
    return Response(status_code=204)
