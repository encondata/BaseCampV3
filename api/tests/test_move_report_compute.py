"""Pure move-report calculations, pinning the V2 semantics (load/rail/
collision reports) on fixtures — no DB."""

from decimal import Decimal

from serversherpa.reports.move_report.compute import (
    collisions, load_summary, rail_summary, sorted_by_side,
)
from serversherpa.reports.move_report.gather import MoveAsset


def _asset(**kw) -> MoveAsset:
    base = dict(row_id="r", asset_id="a", name="web-01", serial="SN1", make="Dell",
                model="R740", ru_size=2, weight_lbs=Decimal("50"), weight_kg=None,
                length_in=None, width_in=None, height_in=None, rail_type="Sliding",
                priority_wave=None, source_rack=None, source_ru=None,
                source_verified=None, source_position=None, destination_rack=None,
                destination_ru=None, destination_verified=None,
                destination_position=None)
    base.update(kw)
    return MoveAsset(**base)


def test_load_summary_totals_and_kg_fallback():
    assets = [
        _asset(row_id="1", ru_size=2, weight_lbs=Decimal("50")),
        _asset(row_id="2", ru_size=None, weight_lbs=None, weight_kg=Decimal("10")),
        _asset(row_id="3", make="HPE", model="DL380", ru_size=1, weight_lbs=None, weight_kg=None),
    ]
    s = load_summary(assets)
    assert s.total_assets == 3
    assert s.total_ru == 4                              # 2 + default 1 + 1
    assert round(s.total_weight_lbs, 2) == 72.05        # 50 + 10kg→22.05
    assert round(s.total_weight_kg, 2) == 32.68
    assert [(m.make, m.model, m.count, m.total_ru) for m in s.models] == [
        ("Dell", "R740", 2, 3), ("HPE", "DL380", 1, 1)]
    assert s.models[0].dimensions == "—"


def test_load_summary_dimensions_string():
    s = load_summary([_asset(length_in=Decimal("28.5"), width_in=Decimal("17.1"),
                             height_in=Decimal("3.4"))])
    assert s.models[0].dimensions == "28.5 × 17.1 × 3.4 in"


def test_rail_summary_counts_and_na():
    assets = [_asset(row_id="1"), _asset(row_id="2"),
              _asset(row_id="3", make="HPE", model="DL380", rail_type=None)]
    r = rail_summary(assets)
    assert [(x.rail_type, x.count) for x in r.rail_types] == [("Sliding", 2), ("N/A", 1)]
    assert [(m.make, m.model, m.count, m.rail_type) for m in r.models] == [
        ("Dell", "R740", 2, "Sliding"), ("HPE", "DL380", 1, "N/A")]


def test_collisions_overlap_partial_slot_and_none():
    a = _asset(row_id="a", name="a", ru_size=2, destination_rack="R1", destination_ru=10)
    b = _asset(row_id="b", name="b", ru_size=1, destination_rack="R1", destination_ru=11)   # overlaps a's top RU
    c = _asset(row_id="c", name="c", ru_size=1, destination_rack="R1", destination_ru=20.1)
    d = _asset(row_id="d", name="d", ru_size=1, destination_rack="R1", destination_ru=20.1)  # same slot
    e = _asset(row_id="e", name="e", ru_size=1, destination_rack="R2", destination_ru=10)    # other rack
    f = _asset(row_id="f", name="f", ru_size=1, destination_rack=None, destination_ru=10)    # no rack
    g = _asset(row_id="g", name="g", ru_size=4, destination_rack="R1", destination_ru=30)
    h = _asset(row_id="h", name="h", ru_size=1, destination_rack="R1", destination_ru=33)   # partial overlap at g's top
    rep = collisions([a, b, c, d, e, f, g, h])
    assert rep.assets_checked == 7                      # f has no rack
    kinds = {(x.asset_a.name, x.asset_b.name): x.collision_type for x in rep.items}
    assert kinds == {("a", "b"): "ru_overlap", ("c", "d"): "ru_and_slot_conflict",
                     ("g", "h"): "ru_overlap"}
    ab = next(x for x in rep.items if x.asset_a.name == "a")
    assert ab.rack == "R1" and ab.overlapping_rus == [11]
    assert rep.collision_count == 3 and rep.assets_flagged == 6


def test_collisions_slot_conflict_without_overlap_is_impossible_but_zero_slot_ignored():
    # slot 0 (integer RU) is never a "slot conflict" — plain overlap only
    a = _asset(row_id="a", name="a", destination_rack="R1", destination_ru=5)
    b = _asset(row_id="b", name="b", destination_rack="R1", destination_ru=5)
    [x] = collisions([a, b]).items
    assert x.collision_type == "ru_overlap" and x.slot_conflict is None


def test_sorted_by_side_orders_rack_then_ru_nulls_last():
    rows = [_asset(row_id="1", source_rack="B", source_ru=3),
            _asset(row_id="2", source_rack="A", source_ru=10),
            _asset(row_id="3", source_rack="A", source_ru=2),
            _asset(row_id="4", source_rack=None, source_ru=None)]
    assert [r.row_id for r in sorted_by_side(rows, "source")] == ["3", "2", "1", "4"]
