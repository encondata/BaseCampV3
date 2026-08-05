"""Resolve audit (entity_type, entity_id) pairs to display names + a small
summary for hover details. Batch per type — one query each per page of
audit rows, never per row. Unknown types and non-UUID ids resolve to None
(deleted records too — the log outlives what it describes)."""

import uuid
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Client, Partner, Person, Site

Ref = tuple[str, str]
Resolved = dict[Ref, dict]

# entity types that share a person id
_PERSON_TYPES = ("worker", "person", "user_account")


def _uuid_or_none(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return None


async def resolve_entity_refs(db: AsyncSession, refs: set[Ref]) -> Resolved:
    by_type: dict[str, set[uuid.UUID]] = defaultdict(set)
    for entity_type, entity_id in refs:
        parsed = _uuid_or_none(entity_id)
        if parsed is not None:
            by_type[entity_type].add(parsed)

    out: Resolved = {}

    person_ids = set().union(*(by_type.get(t, set()) for t in _PERSON_TYPES))
    if person_ids:
        people = (await db.scalars(
            select(Person).where(Person.id.in_(person_ids)))).all()
        for p in people:
            summary = {"Email": p.email or "—"}
            for t in _PERSON_TYPES:
                if p.id in by_type.get(t, set()):
                    out[(t, str(p.id))] = {"name": p.display_name,
                                           "summary": summary}

    if by_type.get("site"):
        for s in await db.scalars(
                select(Site).where(Site.id.in_(by_type["site"]))):
            place = ", ".join(part for part in (s.city, s.region) if part)
            out[("site", str(s.id))] = {
                "name": s.name,
                "summary": {"Location": place or "—", "Status": s.status},
            }

    for entity_type, model in (("client", Client), ("partner", Partner)):
        ids = by_type.get(entity_type)
        if not ids:
            continue
        for org in await db.scalars(select(model).where(model.id.in_(ids))):
            summary = {}
            code = getattr(org, "code", None)
            if code:
                summary["Code"] = code
            out[(entity_type, str(org.id))] = {"name": org.name,
                                               "summary": summary}

    return out
