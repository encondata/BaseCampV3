"""Evaluation context for one processed scan: the scan row plus the
matched entity and (asset matches only) the active-initiative pair.
For asset matches, container is the asset's containing container; for
container matches, it is the matched container.
Dotted keys resolve leniently — a missing entity yields None so
conditions on absent context evaluate per-operator instead of raising.

`rule_id` / `rule_name` name the rule whose actions are running; the
engine sets them before each rule's actions run (None outside the engine,
e.g. a context built by hand), so an action can say which rule it acts for."""

import uuid
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
    rule_id: uuid.UUID | None = None
    rule_name: str | None = None

    def get(self, dotted: str) -> Any:
        entity_key, _, attr = dotted.partition(".")
        entity = getattr(self, entity_key, None)
        if entity is None or not attr:
            return None
        return getattr(entity, attr, None)
