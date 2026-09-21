"""Step 2 of the Move Report: the V2 load / rail / collision calculations
as pure functions over MoveAsset lists."""

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal

from serversherpa.racks.placement import Placed, evaluate, place
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
    """Nodes live inside a chassis and have no rails of their own, so a
    model flagged `node` is left out of the rail counts entirely. The load
    summary still counts them: they move as separate items."""
    railed = [a for a in assets if a.form_factor != "node"]
    groups: dict[tuple[str, str], list[MoveAsset]] = defaultdict(list)
    for a in railed:
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
    return RailSummary(total_assets=len(railed), rail_types=rail_types, models=models)


@dataclass(frozen=True)
class Placement:
    asset: MoveAsset
    base: int
    slot: int

    @property
    def name(self) -> str:
        return self.asset.label

    @property
    def ru_text(self) -> str:
        return f"{self.base}.{self.slot}" if self.slot else str(self.base)


@dataclass(frozen=True)
class Collision:
    rack: str
    collision_type: str            # ru_overlap | slot_conflict
    overlapping_rus: list[int]
    slot_conflict: int | None
    asset_a: Placement
    asset_b: Placement


@dataclass(frozen=True)
class OrphanRow:
    rack: str
    asset: Placement
    reason: str                    # no_chassis | form_factor_mismatch


@dataclass(frozen=True)
class CollisionReport:
    items: list[Collision] = field(default_factory=list)
    orphans: list[OrphanRow] = field(default_factory=list)
    assets_checked: int = 0

    @property
    def collision_count(self) -> int:
        return len(self.items)

    @property
    def assets_flagged(self) -> int:
        return len({p.asset.row_id for c in self.items for p in (c.asset_a, c.asset_b)})


def collisions(assets: list[MoveAsset]) -> CollisionReport:
    """Destination-side only (V2 semantics). The rule itself lives in
    serversherpa.racks.placement and is shared with the importer and the
    re-check endpoint; this only maps MoveAsset rows in and out."""
    placed: dict[str, tuple[MoveAsset, Placed]] = {}
    for a in assets:
        if a.destination_rack and a.destination_ru is not None:
            placed[a.row_id] = (a, place(key=a.row_id, label=a.label, rack=a.destination_rack,
                                         ru=a.destination_ru, height=_ru(a),
                                         form_factor=a.form_factor))
    result = evaluate([p for _, p in placed.values()])

    def wrap(p: Placed) -> Placement:
        return Placement(asset=placed[p.key][0], base=p.base, slot=p.slot)

    items = [Collision(rack=c.rack, collision_type=c.kind,
                       overlapping_rus=list(c.overlapping_rus), slot_conflict=c.slot,
                       asset_a=wrap(c.a), asset_b=wrap(c.b)) for c in result.conflicts]
    orphans = [OrphanRow(rack=o.rack, asset=wrap(o.row), reason=o.reason)
               for o in result.orphans]
    return CollisionReport(items=items, orphans=orphans, assets_checked=result.checked)


def sorted_by_side(assets: list[MoveAsset], side: str) -> list[MoveAsset]:
    """Asset list ordering for the by-source / by-destination tables: rack,
    then RU, with unracked rows last (then by label)."""
    rack = (lambda a: a.source_rack) if side == "source" else (lambda a: a.destination_rack)
    ru = (lambda a: a.source_ru) if side == "source" else (lambda a: a.destination_ru)
    return sorted(assets, key=lambda a: (rack(a) is None, rack(a) or "",
                                         ru(a) is None, ru(a) or 0.0, a.label))
