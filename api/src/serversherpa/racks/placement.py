"""The rack placement rule, shared by the move-assets importer, the Move
Report and the re-check endpoint so the three cannot drift.

A roster row at an integer RU occupies a span (base .. base + height - 1)
in slot 0. A row at a fractional RU `N.x` is a node in slot x of RU N: it
occupies that one cell and contributes no span. Two spans that share an
RU are an `ru_overlap`. Two nodes at the same base and slot are a
`slot_conflict`. A node whose base RU is the START of a span is contained
by it. A node whose base RU is covered by a span that starts elsewhere
collides with that span (it claims a chassis that is not there). A node
with no span starting at its base is an orphan. Slot 0 is never a slot
conflict.

The model form factor only adds orphan reasons: a `standalone` row at a
slot, or a `node` row at an integer RU, is a `form_factor_mismatch`. It
never changes what a row occupies.

Design: docs/superpowers/specs/2026-09-21-rack-node-slots-design.md
"""

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from itertools import combinations
from math import floor

RU_OVERLAP = "ru_overlap"
SLOT_CONFLICT = "slot_conflict"
NO_CHASSIS = "no_chassis"
FORM_FACTOR_MISMATCH = "form_factor_mismatch"


@dataclass(frozen=True)
class Placed:
    key: str
    label: str
    rack: str
    base: int
    slot: int
    height: int
    form_factor: str | None = None

    @property
    def is_slot(self) -> bool:
        return self.slot > 0

    @property
    def span(self) -> frozenset[int]:
        if self.is_slot:
            return frozenset()
        return frozenset(range(self.base, self.base + self.height))


def place(key: str, label: str, rack: str, ru: float | Decimal, height: int | None,
          form_factor: str | None = None) -> Placed:
    raw = float(ru)
    base = floor(raw)
    # Half-UP, not Python's banker's rounding: RU 3.25 is slot 3, matching
    # the portal's `Math.round` in lib/initiatives.ts's `ruSlot`. `round()`
    # would give 2 here and silently disagree with the drawing.
    slot = floor((raw - base) * 10 + 0.5)
    return Placed(key=key, label=label, rack=rack, base=base, slot=slot,
                  height=max(1, int(height or 1)), form_factor=form_factor)


@dataclass(frozen=True)
class Conflict:
    rack: str
    kind: str                  # RU_OVERLAP | SLOT_CONFLICT
    a: Placed
    b: Placed
    overlapping_rus: list[int]
    slot: int | None           # set for SLOT_CONFLICT


@dataclass(frozen=True)
class Orphan:
    rack: str
    row: Placed
    reason: str                # NO_CHASSIS | FORM_FACTOR_MISMATCH


@dataclass(frozen=True)
class PlacementResult:
    conflicts: list[Conflict] = field(default_factory=list)
    orphans: list[Orphan] = field(default_factory=list)
    checked: int = 0
    #: Always populated, whether or not `evaluate` collected the conflicts
    #: themselves — see `evaluate(collect=False)`.
    colliding: frozenset[str] = frozenset()

    @property
    def colliding_keys(self) -> frozenset[str]:
        return self.colliding

    @property
    def orphan_keys(self) -> set[str]:
        return {o.row.key for o in self.orphans}


def _pair(rack: str, pa: Placed, pb: Placed) -> Conflict | None:
    if not pa.is_slot and not pb.is_slot:
        overlap = pa.span & pb.span
        if overlap:
            # Positional order, like the other two branches: `evaluate`
            # already sorted the rack by (base, slot, label, key), so `pa`
            # is the lower device. Reordering by key would randomize the
            # Move Report's "Asset A / Asset B" columns (keys are UUIDs).
            return Conflict(rack, RU_OVERLAP, pa, pb, sorted(overlap), None)
        return None
    if pa.is_slot and pb.is_slot:
        if pa.base == pb.base and pa.slot == pb.slot:
            return Conflict(rack, SLOT_CONFLICT, pa, pb, [pa.base], pa.slot)
        return None
    node, span_row = (pa, pb) if pa.is_slot else (pb, pa)
    if node.base in span_row.span and span_row.base != node.base:
        return Conflict(rack, RU_OVERLAP, pa, pb, [node.base], None)
    return None


def evaluate(rows: list[Placed], *, collect: bool = True) -> PlacementResult:
    """Run the rule over every row, grouped by rack.

    `collect=False` keeps only the colliding KEYS and leaves `conflicts`
    empty. Callers that just restate statuses (recheck_placement) never
    read the pairs, and a degenerate roster — a thousand rows all at RU 1
    — would otherwise materialize ~500k Conflict objects in the import
    worker. `colliding` / `colliding_keys` and the orphans are identical
    either way.
    """
    racks: dict[str, list[Placed]] = defaultdict(list)
    for r in rows:
        racks[r.rack].append(r)
    conflicts: list[Conflict] = []
    orphans: list[Orphan] = []
    colliding: set[str] = set()
    for rack in sorted(racks):
        placed = sorted(racks[rack], key=lambda p: (p.base, p.slot, p.label, p.key))
        starts = {p.base for p in placed if not p.is_slot}
        for pa, pb in combinations(placed, 2):
            c = _pair(rack, pa, pb)
            if c is not None:
                colliding.add(c.a.key)
                colliding.add(c.b.key)
                if collect:
                    conflicts.append(c)
        for p in placed:
            if p.is_slot:
                if p.base not in starts:
                    orphans.append(Orphan(rack, p, NO_CHASSIS))
                elif p.form_factor == "standalone":
                    orphans.append(Orphan(rack, p, FORM_FACTOR_MISMATCH))
            elif p.form_factor == "node":
                orphans.append(Orphan(rack, p, FORM_FACTOR_MISMATCH))
    return PlacementResult(conflicts=conflicts, orphans=orphans, checked=len(rows),
                           colliding=frozenset(colliding))
