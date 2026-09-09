"""Step 2 of the Move Report: the V2 load / rail / collision calculations
as pure functions over MoveAsset lists."""

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from itertools import combinations
from math import floor

from serversherpa.reports.move_report.gather import MoveAsset

LBS_PER_KG = 2.20462


def _ru(a: MoveAsset) -> int:
    return a.ru_size if a.ru_size and a.ru_size > 0 else 1


def _weight_lbs(a: MoveAsset) -> float:
    if a.weight_lbs is not None:
        return float(a.weight_lbs)
    if a.weight_kg is not None:
        return float(a.weight_kg) * LBS_PER_KG
    return 0.0


def _dims(a: MoveAsset) -> str:
    if a.length_in is None or a.width_in is None or a.height_in is None:
        return "—"
    fmt = lambda d: f"{Decimal(d).normalize():f}"      # noqa: E731
    return f"{fmt(a.length_in)} × {fmt(a.width_in)} × {fmt(a.height_in)} in"


def _model_key(a: MoveAsset) -> tuple[str, str]:
    return (a.make or "", a.model or "")


@dataclass(frozen=True)
class ModelLoad:
    make: str | None
    model: str | None
    count: int
    ru_size: int
    total_ru: int
    weight_per_unit_lbs: float
    total_weight_lbs: float
    total_weight_kg: float
    dimensions: str


@dataclass(frozen=True)
class LoadSummary:
    total_assets: int
    total_ru: int
    total_weight_lbs: float
    total_weight_kg: float
    models: list[ModelLoad]


def load_summary(assets: list[MoveAsset]) -> LoadSummary:
    groups: dict[tuple[str, str], list[MoveAsset]] = defaultdict(list)
    for a in assets:
        groups[_model_key(a)].append(a)
    models = []
    for key in sorted(groups):
        rows = groups[key]
        first = rows[0]
        lbs = sum(_weight_lbs(r) for r in rows)
        models.append(ModelLoad(
            make=first.make, model=first.model, count=len(rows), ru_size=_ru(first),
            total_ru=sum(_ru(r) for r in rows), weight_per_unit_lbs=_weight_lbs(first),
            total_weight_lbs=lbs, total_weight_kg=lbs / LBS_PER_KG, dimensions=_dims(first)))
    total_lbs = sum(_weight_lbs(a) for a in assets)
    return LoadSummary(total_assets=len(assets), total_ru=sum(_ru(a) for a in assets),
                       total_weight_lbs=total_lbs, total_weight_kg=total_lbs / LBS_PER_KG,
                       models=models)


@dataclass(frozen=True)
class RailTypeCount:
    rail_type: str
    count: int


@dataclass(frozen=True)
class ModelRail:
    make: str | None
    model: str | None
    count: int
    rail_type: str
    ru_size: int


@dataclass(frozen=True)
class RailSummary:
    total_assets: int
    rail_types: list[RailTypeCount]
    models: list[ModelRail]


def rail_summary(assets: list[MoveAsset]) -> RailSummary:
    groups: dict[tuple[str, str], list[MoveAsset]] = defaultdict(list)
    for a in assets:
        groups[_model_key(a)].append(a)
    counts: dict[str, int] = defaultdict(int)
    models = []
    for key in sorted(groups):
        rows = groups[key]
        rail = rows[0].rail_type or "N/A"
        counts[rail] += len(rows)
        models.append(ModelRail(make=rows[0].make, model=rows[0].model, count=len(rows),
                                rail_type=rail, ru_size=_ru(rows[0])))
    rail_types = sorted((RailTypeCount(k, v) for k, v in counts.items()),
                        key=lambda x: (-x.count, x.rail_type))
    return RailSummary(total_assets=len(assets), rail_types=rail_types, models=models)


@dataclass(frozen=True)
class Placement:
    asset: MoveAsset
    base: int
    slot: int
    occupied: frozenset[int]

    @property
    def name(self) -> str:
        return self.asset.label


@dataclass(frozen=True)
class Collision:
    rack: str
    collision_type: str            # ru_overlap | slot_conflict | ru_and_slot_conflict
    overlapping_rus: list[int]
    slot_conflict: int | None
    asset_a: Placement
    asset_b: Placement


@dataclass(frozen=True)
class CollisionReport:
    items: list[Collision] = field(default_factory=list)
    assets_checked: int = 0

    @property
    def collision_count(self) -> int:
        return len(self.items)

    @property
    def assets_flagged(self) -> int:
        return len({p.asset.row_id for c in self.items for p in (c.asset_a, c.asset_b)})


def _placement(a: MoveAsset) -> Placement:
    raw = float(a.destination_ru)                      # caller guarantees not None
    base = floor(raw)
    slot = round((raw - base) * 10)
    return Placement(asset=a, base=base, slot=slot,
                     occupied=frozenset(range(base, base + _ru(a))))


def collisions(assets: list[MoveAsset]) -> CollisionReport:
    """Destination-side only (V2 semantics): pairwise within a rack, RU
    overlap and/or same-base same-non-zero-slot."""
    racks: dict[str, list[Placement]] = defaultdict(list)
    checked = 0
    for a in assets:
        if a.destination_rack and a.destination_ru is not None:
            racks[a.destination_rack].append(_placement(a))
            checked += 1
    items: list[Collision] = []
    for rack in sorted(racks):
        placed = sorted(racks[rack], key=lambda p: (p.base, p.slot, p.name))
        for pa, pb in combinations(placed, 2):
            overlap = pa.occupied & pb.occupied
            slot_hit = pa.base == pb.base and pa.slot == pb.slot and pa.slot > 0
            if not overlap and not slot_hit:
                continue
            kind = ("ru_and_slot_conflict" if overlap and slot_hit
                    else "slot_conflict" if slot_hit else "ru_overlap")
            items.append(Collision(
                rack=rack, collision_type=kind,
                overlapping_rus=sorted(overlap) if overlap else [pa.base],
                slot_conflict=pa.slot if slot_hit else None, asset_a=pa, asset_b=pb))
    return CollisionReport(items=items, assets_checked=checked)


def sorted_by_side(assets: list[MoveAsset], side: str) -> list[MoveAsset]:
    """Asset list ordering for the by-source / by-destination tables: rack,
    then RU, with unracked rows last (then by label)."""
    rack = (lambda a: a.source_rack) if side == "source" else (lambda a: a.destination_rack)
    ru = (lambda a: a.source_ru) if side == "source" else (lambda a: a.destination_ru)
    return sorted(assets, key=lambda a: (rack(a) is None, rack(a) or "",
                                         ru(a) is None, ru(a) or 0.0, a.label))
