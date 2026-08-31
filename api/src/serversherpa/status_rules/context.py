"""Evaluation context for one processed scan: the scan row plus the
matched entity and (asset matches only) the active-initiative pair.
Dotted keys resolve leniently — a missing entity yields None so
conditions on absent context evaluate per-operator instead of raising."""

from dataclasses import dataclass
from typing import Any


@dataclass
class Context:
    scan: Any
    asset: Any = None
    container: Any = None
    person: Any = None
    initiative_asset: Any = None
    initiative: Any = None

    def get(self, dotted: str) -> Any:
        entity_key, _, attr = dotted.partition(".")
        entity = getattr(self, entity_key, None)
        if entity is None or not attr:
            return None
        return getattr(entity, attr, None)
