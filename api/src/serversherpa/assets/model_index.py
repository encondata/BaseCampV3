"""The make/model catalog index shared by the move-roster importer
(imports/move_assets.py) and the bulk asset update (assets/bulk_update.py).

Matching is two-tier. `literal` is keyed on the catalog display name
("make model") and on each alias exactly as written, lowercased only; a
display name always wins over an alias spelled the same. A row that names a
catalog entry verbatim ALWAYS matches it. Only the looser normalized tier
(`normalize_model_key`) can be ambiguous: two catalog rows can normalize to
the same key ("Shelf 1U" / "Shelf 2U", "Dell R740 (Chassis)" / "Dell R740
Chassis"). Guessing one would be non-deterministic, so a key hit by two or
more models is dropped from `normalized` and kept in `ambiguous` with the
models it could mean. The ORDER BYs only make the scans reproducible."""

import re
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AssetModel, AssetModelAlias

_HEIGHT_TOKEN = re.compile(r"\s+\d+u$", re.IGNORECASE)


def normalize_model_key(text: str) -> str:
    """The lookup key for matching an imported make/model string against
    the catalog. Every word is kept — "(Chassis)" and "(Node)" tell two
    real rows apart — and only the noise that manufactures accidental
    duplicates goes: underscores become spaces, parentheses are dropped,
    a trailing height token such as "4U" is removed, whitespace collapses,
    case folds. Lookup only; stored make and model are never rewritten."""
    s = text.replace("_", " ").replace("(", " ").replace(")", " ")
    s = " ".join(s.split())
    s = _HEIGHT_TOKEN.sub("", s)
    return s.lower()


def display_name(m: AssetModel) -> str:
    return f"{m.make} {m.model}".strip()


@dataclass
class ModelIndex:
    literal: dict[str, AssetModel]           # exact "make model" or alias, lowercased
    normalized: dict[str, AssetModel]        # normalize_model_key(...); ambiguous keys dropped
    ambiguous: dict[str, list[AssetModel]]   # normalized keys hit by 2+ models
    models: dict[uuid.UUID, AssetModel] = field(default_factory=dict)   # every catalog row


async def build_model_index(db: AsyncSession) -> ModelIndex:
    literal: dict[str, AssetModel] = {}
    hits: dict[str, dict[uuid.UUID, AssetModel]] = {}
    models: dict[uuid.UUID, AssetModel] = {}
    for m in await db.scalars(select(AssetModel).order_by(
            AssetModel.make, AssetModel.model, AssetModel.id)):
        models[m.id] = m
        display = display_name(m)
        literal[display.lower()] = m
        hits.setdefault(normalize_model_key(display), {}).setdefault(m.id, m)
    alias_rows = (await db.execute(
        select(AssetModelAlias.alias, AssetModel)
        .join(AssetModel, AssetModel.id == AssetModelAlias.model_id)
        .order_by(AssetModelAlias.alias, AssetModel.id))).all()
    for alias, m in alias_rows:
        literal.setdefault(alias.lower(), m)           # exact wins over alias
        hits.setdefault(normalize_model_key(alias), {}).setdefault(m.id, m)
    normalized = {k: next(iter(v.values())) for k, v in hits.items() if len(v) == 1}
    ambiguous = {k: list(v.values()) for k, v in hits.items() if len(v) > 1}
    return ModelIndex(literal=literal, normalized=normalized, ambiguous=ambiguous,
                      models=models)


def find_model(index: ModelIndex, make: str,
               model: str) -> tuple[AssetModel | None, list[AssetModel]]:
    """(match, candidates): a verbatim display name or alias first, then the
    normalized key; no match → (None, the models an ambiguous key could
    mean, or [])."""
    text = f"{(make or '').strip()} {(model or '').strip()}".strip()
    hit = index.literal.get(text.lower())
    if hit is not None:
        return hit, []
    key = normalize_model_key(text)
    hit = index.normalized.get(key)
    if hit is not None:
        return hit, []
    return None, list(index.ambiguous.get(key, []))
