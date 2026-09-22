"""Catalog review: which models an admin should look at.

Imported rows carry the importer's "FORCED:" note. Likely duplicates are
models whose normalized name, or any alias, collides with another model's;
union-find joins A~B and B~C into one group. Pure functions over ORM rows
so the route stays a thin query layer."""

import uuid

from serversherpa.db.models import AssetModel
from serversherpa.imports.move_assets import normalize_model_key

FORCED_PREFIX = "forced:"


def is_imported(m: AssetModel) -> bool:
    return (m.knowledge or "").lstrip().lower().startswith(FORCED_PREFIX)


def model_keys(m: AssetModel, aliases: list[str]) -> set[str]:
    keys = {normalize_model_key(f"{m.make} {m.model}")}
    keys |= {normalize_model_key(a) for a in aliases}
    return {k for k in keys if k}


def duplicate_groups(
    models: list[AssetModel], aliases_by_model: dict[uuid.UUID, list[str]],
    counts: dict[uuid.UUID, tuple[int, int]],
) -> list[tuple[str, list[AssetModel]]]:
    """Groups of two or more models sharing a normalized key. Each group is
    (key, members) with members ordered by asset count desc then name and
    groups by their first member's name."""
    parent: dict[uuid.UUID, uuid.UUID] = {m.id: m.id for m in models}

    def find(x: uuid.UUID) -> uuid.UUID:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: uuid.UUID, b: uuid.UUID) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    owner_by_key: dict[str, uuid.UUID] = {}
    key_of_group: dict[uuid.UUID, str] = {}
    for m in models:
        for key in model_keys(m, aliases_by_model.get(m.id, [])):
            if key in owner_by_key:
                union(owner_by_key[key], m.id)
                key_of_group[find(m.id)] = key
            else:
                owner_by_key[key] = m.id

    members: dict[uuid.UUID, list[AssetModel]] = {}
    for m in models:
        members.setdefault(find(m.id), []).append(m)

    def name(m: AssetModel) -> str:
        return f"{m.make} {m.model}".lower()

    groups = []
    for root, ms in members.items():
        if len(ms) < 2:
            continue
        ms.sort(key=lambda m: (-counts.get(m.id, (0, 0))[0], name(m)))
        # the key the first two members actually share, for display
        shared = set.intersection(*(model_keys(m, aliases_by_model.get(m.id, [])) for m in ms[:2]))
        key = next(iter(sorted(shared)), key_of_group.get(find(root), ""))
        groups.append((key, ms))
    groups.sort(key=lambda g: name(g[1][0]))
    return groups
