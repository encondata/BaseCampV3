"""MacroPoint grouping, truck matching and the forward-only status rule
(pure functions; no database)."""

import uuid
from datetime import UTC, datetime, timedelta

from serversherpa.db.models import Truck
from serversherpa.trucks.macropoint.apply import (
    group_messages,
    match_group,
    status_target,
)
from serversherpa.trucks.macropoint.parse import ParsedMessage, source_ref_for

T0 = datetime(2024, 10, 15, 14, tzinfo=UTC)


def msg(id_number="Load A", token=None, minutes=0, kind="location", event=None,
        event_kind=None, stop=None, source="a.eml"):
    at = T0 + timedelta(minutes=minutes)
    ref = source_ref_for(kind, id_number, at, lat=1.0, lng=2.0, event=event)
    if kind == "location":
        return ParsedMessage("location", source, "Landstar - ATL", id_number, token, at, ref,
                             lat=1.0, lng=2.0)
    return ParsedMessage("trip_event", source, "Landstar - ATL", id_number, token, at, ref,
                         event=event, event_kind=event_kind, stop=stop)


def truck(name="T", status="active", **tracking):
    return Truck(id=uuid.uuid4(), name=name, status=status, tracking_type=tracking)


def test_group_by_token_and_merge_tokenless_by_id():
    a1 = msg("JAMIE & PATRICK", token="tok1", minutes=5)
    a2 = msg("jamie  &  patrick", token=None, minutes=1)     # pasted: joins tok1
    b = msg("Other Load", token=None)
    [g1, g2] = group_messages([a1, a2, b])
    assert g1.key == "order:tok1" and g1.id_number == "JAMIE & PATRICK"
    assert g1.messages == [a2, a1]                          # oldest first
    assert g2.key == "id:other load" and g2.order_token is None


def test_tokenless_with_two_token_owners_stays_separate():
    t1 = msg("Reused", token="tok1")
    t2 = msg("Reused", token="tok2", minutes=1)
    loose = msg("Reused", minutes=2)
    keys = [g.key for g in group_messages([t1, t2, loose])]
    assert sorted(keys) == ["id:reused", "order:tok1", "order:tok2"]


def test_groups_sorted_naturally_by_id():
    keys = [g.id_number for g in group_messages([msg("Team 10"), msg("Team 9")])]
    assert keys == ["Team 9", "Team 10"]


def test_match_by_order_token_beats_tracker_id():
    by_order = truck("A", macropoint_order="tok1")
    by_id = truck("B", tracker_id="Load A")
    [g] = group_messages([msg("Load A", token="tok1")])
    m = match_group(g, [by_id, by_order])
    assert (m.truck_id, m.by, m.ambiguous_ids) == (by_order.id, "order", [])


def test_match_by_tracker_id_normalized():
    t = truck(tracker_id="  load   a ")
    [g] = group_messages([msg("LOAD A")])
    assert match_group(g, [t]).by == "tracker_id"


def test_ambiguous_and_unmatched():
    t1, t2 = truck("A", tracker_id="Load A"), truck("B", tracker_id="load a")
    [g] = group_messages([msg("Load A")])
    m = match_group(g, [t1, t2])
    assert m.truck_id is None and set(m.ambiguous_ids) == {t1.id, t2.id}
    m = match_group(g, [truck(tracker_id="Something else")])
    assert (m.truck_id, m.by, m.ambiguous_ids) == (None, None, [])


def test_status_target_forward_only():
    dep_pick = msg(kind="trip_event", event="Departed at Pickup", event_kind="departed", stop="pickup")
    arr_drop = msg(kind="trip_event", event="Arrived at Drop-Off", event_kind="arrived", stop="drop_off")
    arr_pick = msg(kind="trip_event", event="Arrived at Pickup", event_kind="arrived", stop="pickup")
    named = msg(kind="trip_event", event="Arrived at BROADCOM", event_kind="arrived", stop="BROADCOM")
    assert status_target("created", dep_pick) == "in_transit"
    assert status_target("active", dep_pick) == "in_transit"
    assert status_target("in_transit", dep_pick) is None
    assert status_target("at_destination", dep_pick) is None
    assert status_target("in_transit", arr_drop) == "at_destination"
    assert status_target("created", arr_drop) == "at_destination"
    assert status_target("at_destination", arr_drop) is None
    assert status_target("active", arr_pick) is None
    assert status_target("in_transit", named) is None
    assert status_target("created", msg()) is None           # locations never change status
