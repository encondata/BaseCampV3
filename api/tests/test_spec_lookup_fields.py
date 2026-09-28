from decimal import Decimal

from serversherpa.db.models import AssetModel
from serversherpa.spec_lookup.fields import (
    column_payload, current_value, enabled_fields, is_blank, wanted_fields,
)

CFG = {"fields_specs": True, "fields_mounting": False, "fields_knowledge": False}


def _m(**kw):
    base = dict(make="HPE", model="DL320", knowledge="")
    base.update(kw)
    return AssetModel(**base)


def test_enabled_fields_follow_groups():
    assert enabled_fields(CFG) == ["ru_size", "weight", "length", "width", "height"]
    assert enabled_fields({**CFG, "fields_specs": False, "fields_knowledge": True}) == ["knowledge"]
    assert enabled_fields({**CFG, "fields_mounting": True})[-2:] == ["mount_type", "rail_type"]


def test_blank_rules():
    m = _m(ru_size=1, weight_lbs=Decimal("30.50"), weight_kg=Decimal("13.83"))
    assert not is_blank(m, "ru_size") and not is_blank(m, "weight")
    assert is_blank(m, "length") and is_blank(m, "knowledge")
    assert not is_blank(_m(knowledge="tip"), "knowledge")


def test_wanted_is_enabled_and_blank():
    m = _m(ru_size=1)
    assert wanted_fields(m, CFG) == ["weight", "length", "width", "height"]


def test_current_value_in_unit():
    m = _m(weight_lbs=Decimal("30.50"), weight_kg=Decimal("13.83"), ru_size=2)
    assert current_value(m, "weight", "lbs") == "30.5"
    assert current_value(m, "weight", "kg") == "13.83"
    assert current_value(m, "ru_size", None) == "2"
    assert current_value(m, "length", "in") is None
    assert current_value(_m(), "knowledge", None) is None


def test_column_payload():
    assert column_payload("ru_size", "2", None) == {"ru_size": 2}
    assert column_payload("weight", "13.6", "kg") == {"weight_kg": 13.6}
    assert column_payload("height", "1.7", "in") == {"height_in": 1.7}
    assert column_payload("height", None, "in") == {"height_in": None}
    assert column_payload("mount_type", "rails", None) == {"mount_type": "rails"}
    assert column_payload("knowledge", "1U server.", None) == {"knowledge": "1U server."}
    assert column_payload("knowledge", None, None) == {"knowledge": ""}
