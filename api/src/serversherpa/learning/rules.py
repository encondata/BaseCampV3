"""Learning assignment rules: ordered, each a list of conditions ANDed
together that points at one packet. `build_context` gathers the facts a
rule can test about a person (and the initiative they're joining),
`matches` is the pure test, and `matching_packets` walks the enabled rules
in order. The CRUD below keeps the stored conditions canonical.

A condition is `{field, values}` and holds when any of its values match
the context; `everyone` takes no values and always holds. A rule with no
conditions matches nobody (an empty AND would otherwise be "everyone" by
accident); the API refuses to store one.

Services never commit; each mutation adds a `learning_rule_*` audit row
to the session."""
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, InitiativePerson, Site, WorkerProfile
from serversherpa.learning.models import LearningPacket, LearningRule
from serversherpa.services.audit import audit, diff

ENTITY = "learning_rule"
RULE_FIELDS = ("everyone", "initiative", "client", "site", "site_country",
               "worker_role", "partner", "person")
_UUID_FIELDS = ("initiative", "client", "site", "partner", "person")
_MAX_VALUE = 100


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _now() -> datetime:
    return datetime.now(UTC)


# ── matching ─────────────────────────────────────────────────────────


@dataclass
class RuleContext:
    """What a rule can test. With no initiative (the general set) only the
    person-level facts are filled in."""
    person_id: uuid.UUID
    initiative_id: uuid.UUID | None = None
    client_id: uuid.UUID | None = None
    # the initiative's origin, destination and own site
    site_ids: set[uuid.UUID] = field(default_factory=set)
    site_countries: set[str] = field(default_factory=set)
    # the person's work type on the initiative
    work_type: str | None = None
    # the worker's partner
    partner_id: uuid.UUID | None = None


async def build_context(db: AsyncSession, person_id: uuid.UUID,
                        initiative_id: uuid.UUID | None) -> RuleContext:
    ctx = RuleContext(person_id=person_id, initiative_id=initiative_id)
    ctx.partner_id = await db.scalar(
        select(WorkerProfile.partner_id).where(WorkerProfile.person_id == person_id))
    initiative = await db.get(Initiative, initiative_id) if initiative_id else None
    if initiative is None:
        return ctx
    ctx.client_id = initiative.client_id
    ctx.site_ids = {s for s in (initiative.origin_site_id, initiative.destination_site_id,
                                initiative.site_id) if s is not None}
    if ctx.site_ids:
        ctx.site_countries = {c.upper() for c in await db.scalars(
            select(Site.country).where(Site.id.in_(ctx.site_ids)))}
    ctx.work_type = await db.scalar(
        select(InitiativePerson.work_type)
        .where(InitiativePerson.initiative_id == initiative.id,
               InitiativePerson.person_id == person_id)
        .order_by(InitiativePerson.created_at).limit(1))
    return ctx


def _condition_holds(cond: dict, ctx: RuleContext) -> bool:
    kind = cond.get("field")
    values = {str(v).strip().lower() for v in cond.get("values") or []}
    if kind == "everyone":
        return True
    if kind == "initiative":
        return ctx.initiative_id is not None and str(ctx.initiative_id) in values
    if kind == "client":
        return ctx.client_id is not None and str(ctx.client_id) in values
    if kind == "site":
        return any(str(s) in values for s in ctx.site_ids)
    if kind == "site_country":
        return any(c.lower() in values for c in ctx.site_countries)
    if kind == "worker_role":
        return ctx.work_type is not None and ctx.work_type.lower() in values
    if kind == "partner":
        return ctx.partner_id is not None and str(ctx.partner_id) in values
    if kind == "person":
        return str(ctx.person_id) in values
    return False                        # an unknown field never matches


def matches(rule: LearningRule, ctx: RuleContext) -> bool:
    """Every condition holds (each when any of its values match). Pure; it
    ignores `enabled`."""
    conditions = rule.conditions or []
    return bool(conditions) and all(_condition_holds(c, ctx) for c in conditions)


async def matching_packets(db: AsyncSession, ctx: RuleContext,
                           ) -> list[tuple[LearningRule, LearningPacket]]:
    """The enabled rules that match `ctx`, in position order, with their
    packets; rules whose packet is archived are skipped."""
    rows = (await db.execute(
        select(LearningRule, LearningPacket)
        .join(LearningPacket, LearningPacket.id == LearningRule.packet_id)
        .where(LearningRule.enabled.is_(True), LearningPacket.archived_at.is_(None))
        .order_by(LearningRule.position, LearningRule.created_at))).all()
    return [(rule, packet) for rule, packet in rows if matches(rule, ctx)]


# ── conditions ───────────────────────────────────────────────────────


def normalize_conditions(raw: list[Any]) -> list[dict]:
    """Validate `[{field, values}]` and return it canonical: 422
    `bad_rule_field` for an unknown field, 422 `bad_rule_values` for a
    missing/malformed value list or no conditions at all. Ids are
    lowercase UUID strings, countries upper case, other values trimmed;
    repeats are dropped."""
    if not raw:
        raise _err(422, "bad_rule_values", "A rule needs at least one condition.")
    out = []
    for cond in raw:
        if not isinstance(cond, dict):          # a ConditionIn
            cond = cond.model_dump()
        kind, values = cond.get("field"), cond.get("values")
        if kind not in RULE_FIELDS:
            raise _err(422, "bad_rule_field", f"Unknown rule field: {kind}.")
        values = [str(v).strip() for v in values or []]
        if kind == "everyone":
            if values:
                raise _err(422, "bad_rule_values", "Everyone takes no values.")
            out.append({"field": kind, "values": []})
            continue
        if not [v for v in values if v] or any(not v or len(v) > _MAX_VALUE for v in values):
            raise _err(422, "bad_rule_values", f"Pick at least one value for {kind}.")
        if kind in _UUID_FIELDS:
            try:
                values = [str(uuid.UUID(v)) for v in values]
            except ValueError:
                raise _err(422, "bad_rule_values", f"A {kind} value isn't a valid id.")
        elif kind == "site_country":
            values = [v.upper() for v in values]
        out.append({"field": kind, "values": list(dict.fromkeys(values))})
    return out


# ── CRUD ─────────────────────────────────────────────────────────────


async def _live_packet(db: AsyncSession, packet_id: uuid.UUID) -> LearningPacket:
    packet = await db.get(LearningPacket, packet_id)
    if packet is None or packet.archived_at is not None:
        raise _err(422, "bad_packet", "Pick a packet that exists and isn't archived.")
    return packet


async def list_rules(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(LearningRule, LearningPacket.name, LearningPacket.archived_at)
        .join(LearningPacket, LearningPacket.id == LearningRule.packet_id)
        .order_by(LearningRule.position, LearningRule.created_at))).all()
    return [rule_out(rule, name, archived) for rule, name, archived in rows]


def rule_out(rule: LearningRule, packet_name: str, packet_archived_at: datetime | None) -> dict:
    return {"id": rule.id, "name": rule.name, "packet_id": rule.packet_id,
            "packet_name": packet_name, "packet_archived": packet_archived_at is not None,
            "conditions": rule.conditions, "position": rule.position, "enabled": rule.enabled,
            "created_at": rule.created_at, "updated_at": rule.updated_at}


async def rule_view(db: AsyncSession, rule: LearningRule) -> dict:
    packet = await db.get(LearningPacket, rule.packet_id)
    return rule_out(rule, packet.name, packet.archived_at)


async def create_rule(db: AsyncSession, *, actor_id: uuid.UUID | None, name: str,
                      packet_id: uuid.UUID, conditions: list[Any],
                      enabled: bool = True) -> LearningRule:
    await _live_packet(db, packet_id)
    conditions = normalize_conditions(conditions)
    last = await db.scalar(select(func.max(LearningRule.position)))
    rule = LearningRule(name=name, packet_id=packet_id, conditions=conditions,
                        enabled=enabled, position=(last or 0) + 1, created_by=actor_id)
    db.add(rule)
    await db.flush()
    audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(rule.id),
          action="learning_rule_create",
          changes={"name": name, "packet_id": str(packet_id), "conditions": conditions,
                   "enabled": enabled})
    return rule


async def update_rule(db: AsyncSession, rule: LearningRule, *, actor_id: uuid.UUID | None,
                      changes: dict[str, Any]) -> None:
    """Apply `changes` (name, packet_id, conditions, enabled). Pointing at
    another packet needs a live one; conditions are validated."""
    if changes.get("packet_id", rule.packet_id) != rule.packet_id:
        await _live_packet(db, changes["packet_id"])
    if "conditions" in changes:
        changes["conditions"] = normalize_conditions(changes["conditions"])
    before = {key: getattr(rule, key) for key in changes}
    for key, value in changes.items():
        setattr(rule, key, value)
    delta = diff(before, changes)
    if delta:
        rule.updated_at = _now()
        audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(rule.id),
              action="learning_rule_update", changes=delta)


async def delete_rule(db: AsyncSession, rule: LearningRule, *,
                      actor_id: uuid.UUID | None) -> None:
    """Assignments the rule made keep existing (their rule_id is nulled by
    the database)."""
    audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(rule.id),
          action="learning_rule_delete",
          changes={"name": rule.name, "packet_id": str(rule.packet_id),
                   "conditions": rule.conditions})
    await db.delete(rule)


async def reorder_rules(db: AsyncSession, ids: list[uuid.UUID], *,
                        actor_id: uuid.UUID | None) -> None:
    """Put the rules in `ids` first, in that order; the rest follow in
    their current order. 422 `bad_order` for a repeated or unknown id."""
    if len(set(ids)) != len(ids):
        raise _err(422, "bad_order", "A rule is listed more than once.")
    rules = list(await db.scalars(
        select(LearningRule).order_by(LearningRule.position, LearningRule.created_at)
        .with_for_update()))
    by_id = {r.id: r for r in rules}
    if any(i not in by_id for i in ids):
        raise _err(422, "bad_order", "A rule in the list doesn't exist.")
    ordered = [by_id[i] for i in ids] + [r for r in rules if r.id not in set(ids)]
    before = [str(r.id) for r in rules]
    for position, rule in enumerate(ordered, start=1):
        if rule.position != float(position):
            rule.position = float(position)
    after = [str(r.id) for r in ordered]
    if before != after:
        audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=None,
              action="learning_rule_reorder", changes={"order": {"from": before, "to": after}})
    await db.flush()
