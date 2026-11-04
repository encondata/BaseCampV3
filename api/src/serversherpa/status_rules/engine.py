"""Rule evaluation for one processed scan, inside the worker's scan
transaction. All enabled rules for (scan.status, match_type) run in
priority order — no first-match-wins (V2 semantics). Every triggered
rule adds one StatusRuleExecution row to the SESSION (never commits);
a real action failure raises RuleExecutionError so the worker can roll
back the whole scan and log an error execution afterward.

`apply_rules`/`_build_context` accept an optional `initiative_asset`
anchor so a manual status edit on that row can run through the same
rule engine as a scan, without the context resolving to whichever
initiative happens to be "in progress".

An off-move sighting (an RFID read of an asset from another of the
client's moves) runs only the rules that ask for it with an "Off-move
sighting equals true" condition; every other rule skips it. Its
initiative is the station's move, passed in by the scan worker — never
the in-progress guess.

The rule cache is per-process with a 60s TTL — API writes land within
one TTL without any cross-process signal (same posture as V2)."""

import logging
import time
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from serversherpa.db.models import (
    Asset, Container, ContainerAsset, Initiative, InitiativeAsset, Person,
    ProcessedScan, StatusRule, StatusRuleExecution,
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


def _asks_for_off_move(rule: dict) -> bool:
    """True when the rule carries an "Off-move sighting equals true"
    condition — the only way a rule opts in to running for a sighting.
    Any other condition on the field (equals false, not equals, ...)
    leaves the rule skipping sightings, as every rule did before."""
    return any(field == "scan.off_move" and op == "equals"
               and str(value).lower() == "true"
               for field, op, value in rule["conditions"])


async def _build_context(db: AsyncSession, scan: ProcessedScan, *,
                         initiative_asset: InitiativeAsset | None = None,
                         off_move_initiative_id: uuid.UUID | None = None
                         ) -> Context:
    """Build the rule-evaluation context for one scan. If
    `initiative_asset` is given (a manual status edit on that row), the
    context is anchored to it directly and the in-progress-initiative
    lookup is skipped — the caller's row wins even if it isn't the
    "active" initiative. An off-move sighting is neither: the asset
    belongs to some other move, so its initiative is the station's
    (`off_move_initiative_id`, None when the sighting named none) and the
    in-progress guess is never made."""
    ctx = Context(scan=scan)
    if scan.match_type == "asset":
        ctx.asset = await db.get(Asset, scan.asset_id)
        # For asset matches ctx.container is the CONTAINING container
        # (container_assets.asset_id is unique); for container matches
        # it stays the matched container.
        ctx.container = await db.scalar(
            select(Container)
            .join(ContainerAsset,
                  ContainerAsset.container_id == Container.id)
            .where(ContainerAsset.asset_id == scan.asset_id))
    elif scan.match_type == "container":
        ctx.container = await db.get(Container, scan.container_id)
    elif scan.match_type == "person":
        ctx.person = await db.get(Person, scan.person_id)
    if scan.off_move:
        if off_move_initiative_id is not None:
            ctx.initiative = await db.get(Initiative, off_move_initiative_id)
    elif scan.match_type == "asset":
        if initiative_asset is not None:
            # A manual edit is anchored to the initiative being edited —
            # never re-resolved to "the in-progress one".
            ctx.initiative_asset = initiative_asset
            ctx.initiative = await db.get(
                Initiative, initiative_asset.initiative_id)
        else:
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
    return ctx


def match_entry(ctx: Context, matched_on: str | None) -> dict:
    """The execution log's record of what the scan matched and how: the
    first entry of every execution's actions_applied, as {"match": ...}.
    `matched_on` is the field the scanned value hit (id, legacy_id,
    rfid_tag, serial_number, name) or manual for a portal status edit."""
    scan = ctx.scan
    match = {"match_type": scan.match_type, "matched_on": matched_on,
             "scan_type": scan.scan_type, "scanned_value": scan.scanned_value}
    if scan.match_type == "asset" and ctx.asset is not None:
        a = ctx.asset
        match.update(id=str(a.id), name=a.name, serial_number=a.serial_number,
                     asset_id=str(a.legacy_id) if a.legacy_id is not None else None,
                     rfid_tag=a.rfid_tag)
    elif scan.match_type == "container" and ctx.container is not None:
        c = ctx.container
        match.update(id=str(c.id), name=c.name, rfid_tag=c.rfid_tag)
    elif scan.match_type == "person" and ctx.person is not None:
        p = ctx.person
        match.update(id=str(p.id), name=p.display_name, rfid_tag=p.rfid_tag)
    return {"match": match}


async def apply_rules(db: AsyncSession, scan: ProcessedScan, *,
                      initiative_asset: InitiativeAsset | None = None,
                      off_move_initiative_id: uuid.UUID | None = None,
                      matched_on: str | None = None) -> int:
    """Evaluate and apply all enabled rules for this scan's
    (status, match_type). Pass `initiative_asset` to anchor the rule
    context to a specific initiative-asset row (a manual status edit)
    instead of re-resolving the in-progress initiative — the worker's
    normal scan path leaves this unset.

    An off-move sighting (`scan.off_move`) runs only the rules that ask
    for it (an "Off-move sighting equals true" condition); every other
    rule skips it and writes no execution, so rules written before
    sightings could run rules behave exactly as before. Its context's
    initiative is `off_move_initiative_id` — the move the station
    uploaded it for. Any other scan ignores that argument."""
    if scan.status is None:
        return 0
    rules = await _load_rules(db, scan.status, scan.match_type)
    if scan.off_move:
        rules = [r for r in rules if _asks_for_off_move(r)]
    if not rules:
        return 0
    ctx = await _build_context(db, scan, initiative_asset=initiative_asset,
                               off_move_initiative_id=off_move_initiative_id)
    match = match_entry(ctx, matched_on)
    for rule in rules:
        started = time.monotonic()
        # Name the rule for its actions. Set on every pass, so a rule's
        # actions never see the rule before it.
        ctx.rule_id, ctx.rule_name = rule["id"], rule["name"]
        met = all(evaluate_condition(ctx.get(f), op, v)
                  for f, op, v in rule["conditions"])
        applied: list[dict] = [match]
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
