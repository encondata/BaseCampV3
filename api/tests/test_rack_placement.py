"""The rack placement rule (spec: docs/superpowers/specs/2026-09-21-rack-
node-slots-design.md, "The placement rule"). Pure, no DB. Every row of
the rule table has a case here; the example initiative's rack is the
last one."""

from serversherpa.racks.placement import evaluate, place


def _p(key, ru, height=1, rack="R1", form_factor=None):
    return place(key=key, label=key, rack=rack, ru=ru, height=height,
                 form_factor=form_factor)


def _kinds(result):
    return sorted((c.a.key, c.b.key, c.kind) for c in result.conflicts)


def _orphans(result):
    return sorted((o.row.key, o.reason) for o in result.orphans)


def test_place_splits_base_and_slot_and_defaults_height():
    p = _p("a", 33.4, height=None)
    assert (p.base, p.slot, p.height) == (33, 4, 1)
    assert p.is_slot and p.span == frozenset()
    q = _p("b", 10, height=4)
    assert (q.base, q.slot, q.height) == (10, 0, 4)
    assert not q.is_slot and q.span == frozenset({10, 11, 12, 13})


def test_place_accepts_decimal_and_rounds_slot():
    from decimal import Decimal
    assert _p("a", Decimal("5.3")).slot == 3
    assert _p("a", 5.30000001).slot == 3


def test_two_spans_sharing_an_ru_overlap():
    r = evaluate([_p("a", 10, 2), _p("b", 11), _p("c", 30)])
    assert _kinds(r) == [("a", "b", "ru_overlap")]
    assert r.conflicts[0].overlapping_rus == [11]
    assert r.colliding_keys == {"a", "b"} and r.checked == 3


def test_slot_zero_is_never_a_slot_conflict():
    r = evaluate([_p("a", 5), _p("b", 5)])
    assert _kinds(r) == [("a", "b", "ru_overlap")]
    assert r.conflicts[0].slot is None


def test_nodes_inside_a_chassis_are_contained_not_colliding():
    rows = [_p("chassis", 33, 4)] + [_p(f"n{i}", 33 + i / 10) for i in (1, 2, 3, 4)]
    r = evaluate(rows)
    assert r.conflicts == [] and r.orphans == []
    assert r.colliding_keys == set() and r.orphan_keys == set()


def test_containment_holds_even_when_chassis_height_is_unknown():
    r = evaluate([_p("chassis", 33, None), _p("n1", 33.1), _p("n2", 33.2)])
    assert r.conflicts == [] and r.orphans == []


def test_two_nodes_in_the_same_slot_are_a_slot_conflict():
    r = evaluate([_p("chassis", 20), _p("x", 20.1), _p("y", 20.1)])
    assert _kinds(r) == [("x", "y", "slot_conflict")]
    c = r.conflicts[0]
    assert c.slot == 1 and c.overlapping_rus == [20]
    assert r.orphans == []


def test_node_with_nothing_at_its_base_is_an_orphan_not_a_collision():
    r = evaluate([_p("n", 20.1), _p("other", 30)])
    assert r.conflicts == []
    assert _orphans(r) == [("n", "no_chassis")]
    assert r.orphan_keys == {"n"}


def test_node_whose_base_is_covered_from_below_collides_and_is_orphaned():
    # a 2U server at 32 reaches into 33; the node at 33.1 claims a chassis
    # that is not there, so it collides with the server AND has no chassis
    r = evaluate([_p("srv", 32, 2), _p("n", 33.1)])
    assert _kinds(r) == [("n", "srv", "ru_overlap")]
    assert r.conflicts[0].overlapping_rus == [33]
    assert _orphans(r) == [("n", "no_chassis")]


def test_node_contained_by_chassis_but_also_covered_from_below():
    r = evaluate([_p("srv", 32, 2), _p("chassis", 33, 4), _p("n", 33.1)])
    assert _kinds(r) == [("chassis", "srv", "ru_overlap"), ("n", "srv", "ru_overlap")]
    assert r.orphans == []


def test_racks_are_independent_and_rows_without_placement_are_not_here():
    r = evaluate([_p("a", 10, rack="R1"), _p("b", 10, rack="R2")])
    assert r.conflicts == [] and r.checked == 2


def test_half_ru_reads_as_slot_five_and_orphans_without_a_base_device():
    r = evaluate([_p("san", 3.5)])
    assert _orphans(r) == [("san", "no_chassis")]


def test_form_factor_mismatches():
    r = evaluate([
        _p("chassis", 10, 4, form_factor="chassis"),
        _p("ok_node", 10.1, form_factor="node"),
        _p("bad_node", 10.2, form_factor="standalone"),   # standalone at a slot
        _p("loose", 20, form_factor="node"),               # node at an integer RU
    ])
    assert r.conflicts == []
    assert _orphans(r) == [("bad_node", "form_factor_mismatch"),
                           ("loose", "form_factor_mismatch")]


def test_form_factor_never_changes_spans():
    # a chassis-flagged 4U row still spans four RUs; a node-flagged row at an
    # integer RU still spans one and can still overlap
    r = evaluate([_p("chassis", 10, 4, form_factor="chassis"),
                  _p("loose", 12, form_factor="node")])
    assert _kinds(r) == [("chassis", "loose", "ru_overlap")]


def test_example_rack_from_the_las_vegas_cluster_move():
    rows = []
    for base, nodes in ((1, 4), (5, 4), (9, 4), (13, 4), (17, 4),
                        (21, 4), (25, 2), (29, 2), (33, 4)):
        rows.append(_p(f"chassis{base}", base, None))
        rows += [_p(f"node{base}.{i}", base + i / 10) for i in range(1, nodes + 1)]
    rows += [_p("switch45", 45), _p("brush47", 47), _p("sw48", 48),
             _p("sw49", 49), _p("sw51", 51)]
    r = evaluate(rows)
    assert r.checked == 46
    assert r.conflicts == [] and r.orphans == []
