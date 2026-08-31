"""Rule evaluation for one processed scan, inside the worker's scan
transaction. All enabled rules for (scan.status, match_type) run in
priority order — no first-match-wins (V2 semantics). Every triggered
rule adds one StatusRuleExecution row to the SESSION (never commits);
a real action failure raises RuleExecutionError so the worker can roll
back the whole scan and log an error execution afterward.

The rule cache is per-process with a 60s TTL — API writes land within
one TTL without any cross-process signal (same posture as V2)."""

import logging
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from serversherpa.db.models import (
    Asset, Container, Initiative, InitiativeAsset, Person, ProcessedScan,
    StatusRule, StatusRuleExecution,
)
from serversherpa.status_rules.catalog import ACTIONS, evaluate_condition
from serversherpa.status_rules.context import Context

logger = logging.getLogger("serversherpa.status_rules.engine")
RULE_CACHE_SECONDS = 60

# (trigger_status, match_type) -> (loaded_monotonic, [rule snapshot dicts])
_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}


class RuleExecutionError(Exception):
    def __init__(self, rule_id, rule_name: str, cause: Exception):
        super().__init__(f"rule '{rule_name}' failed: {cause}")
        self.rule_id = rule_id
        self.rule_name = rule_name


def invalidate_cache() -> None:
    _cache.clear()


async def _load_rules(db: AsyncSession, trigger_status: str,
                      match_type: str) -> list[dict]:
    key = (trigger_status, match_type)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < RULE_CACHE_SECONDS:
        return hit[1]
    rows = (await db.scalars(
        select(StatusRule)
        .options(selectinload(StatusRule.conditions),
                 selectinload(StatusRule.actions))
        .where(StatusRule.trigger_status == trigger_status,
               StatusRule.trigger_match_type == match_type,
               StatusRule.enabled.is_(True))
        .order_by(StatusRule.priority, StatusRule.id))).all()
    # Snapshot to plain dicts — cached entries outlive their session.
    rules = [{
        "id": r.id, "name": r.name,
        "conditions": [(c.field, c.operator, c.value) for c in r.conditions],
        "actions": [(a.action_type, a.params) for a in r.actions],
    } for r in rows]
    _cache[key] = (time.monotonic(), rules)
    return rules


async def _build_context(db: AsyncSession, scan: ProcessedScan) -> Context:
    ctx = Context(scan=scan)
    if scan.match_type == "asset":
        ctx.asset = await db.get(Asset, scan.asset_id)
        pair = (await db.execute(
            select(InitiativeAsset, Initiative)
            .join(Initiative,
                  InitiativeAsset.initiative_id == Initiative.id)
            .where(InitiativeAsset.asset_id == scan.asset_id,
                   Initiative.status == "in_progress",
                   Initiative.archived_at.is_(None))
            .order_by(func.abs(func.extract(
                "epoch",
                Initiative.scheduled_start - func.now())).nulls_last())
            .limit(1))).first()
        if pair is not None:
            ctx.initiative_asset, ctx.initiative = pair
    elif scan.match_type == "container":
        ctx.container = await db.get(Container, scan.container_id)
    elif scan.match_type == "person":
        ctx.person = await db.get(Person, scan.person_id)
    return ctx


async def apply_rules(db: AsyncSession, scan: ProcessedScan) -> int:
    if scan.status is None:
        return 0
    rules = await _load_rules(db, scan.status, scan.match_type)
    if not rules:
        return 0
    ctx = await _build_context(db, scan)
    for rule in rules:
        started = time.monotonic()
        met = all(evaluate_condition(ctx.get(f), op, v)
                  for f, op, v in rule["conditions"])
        applied: list[dict] = []
        if met:
            for action_type, params in rule["actions"]:
                try:
                    outcome = await ACTIONS[action_type].apply(
                        db, ctx, params)
                    await db.flush()   # surface FK/CHECK errors per action
                except Exception as exc:
                    raise RuleExecutionError(
                        rule["id"], rule["name"], exc) from exc
                entry = {"action_type": action_type,
                         "applied": outcome.applied}
                if outcome.reason:
                    entry["reason"] = outcome.reason
                applied.append(entry)
        db.add(StatusRuleExecution(
            rule_id=rule["id"], rule_name=rule["name"],
            processed_scan_id=scan.id, conditions_met=met,
            actions_applied=applied,
            duration_ms=int((time.monotonic() - started) * 1000)))
    return len(rules)
