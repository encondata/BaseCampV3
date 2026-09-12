"""labels/generate/values.py: the placeholder catalog + generation_rules
port of V2's field_values/label_generation_code. Pure unit tests — no DB."""

from datetime import UTC, datetime
from decimal import Decimal

from serversherpa.db.models import Initiative, Site
from serversherpa.labels.generate.values import AssetRow, Sites, placeholder_values

CATALOG = [
    "asset_id", "asset_name", "serial_number", "make", "model", "make_model",
    "source_raw", "source_ru", "source_site", "destination_raw", "destination_ru",
    "destination_site", "move_name", "move_date", "container_name", "container_id",
]


def _row(**over) -> AssetRow:
    base = dict(
        asset_id="00000000-0000-0000-0000-0000000000aa", legacy_id=10482, name="core-sw-01",
        serial_number="C7X-00412-A", make="Cisco", model="Nexus 9336C",
        source_rack="NAP7 A12", source_ru=Decimal("14"), source_position=None,
        destination_rack="NAP11 C03", destination_ru=Decimal("22"), destination_position=None,
    )
    base.update(over)
    return AssetRow(**base)


def _initiative(**over) -> Initiative:
    base = dict(name="NAP11 Hall Migration", initiative_type="move",
               scheduled_start=datetime(2026, 9, 15, 18, 0, tzinfo=UTC))
    base.update(over)
    return Initiative(**base)


def _sites(origin_name="NAP7", destination_name="NAP11") -> Sites:
    origin = Site(name=origin_name) if origin_name else None
    destination = Site(name=destination_name) if destination_name else None
    return Sites(origin=origin, destination=destination)


def test_every_catalog_key_present():
    values = placeholder_values(_row(), _initiative(), _sites(), CATALOG)
    assert values == {
        "asset_id": "10482", "asset_name": "core-sw-01", "serial_number": "C7X-00412-A",
        "make": "Cisco", "model": "Nexus 9336C", "make_model": "Cisco Nexus 9336C",
        "source_raw": "NAP7 A12", "source_ru": "U14", "source_site": "NAP7",
        "destination_raw": "NAP11 C03", "destination_ru": "U22", "destination_site": "NAP11",
        "move_name": "NAP11 Hall Migration", "move_date": "09/15/2026",
        "container_name": "", "container_id": "",
    }


def test_source_raw_prefers_position_over_rack():
    values = placeholder_values(
        _row(source_position="NAP7.A12.U14", source_rack="NAP7 A12"),
        _initiative(), _sites(), ["source_raw"])
    assert values["source_raw"] == "NAP7.A12.U14"


def test_destination_raw_prefers_position_over_rack():
    values = placeholder_values(
        _row(destination_position="NAP11.C03.U22", destination_rack="NAP11 C03"),
        _initiative(), _sites(), ["destination_raw"])
    assert values["destination_raw"] == "NAP11.C03.U22"


def test_ru_formatting_integral_fractional_and_none():
    assert placeholder_values(_row(source_ru=Decimal("14")), _initiative(), _sites(),
                              ["source_ru"])["source_ru"] == "U14"
    assert placeholder_values(_row(source_ru=Decimal("14.5")), _initiative(), _sites(),
                              ["source_ru"])["source_ru"] == "U14.5"
    assert placeholder_values(_row(source_ru=None), _initiative(), _sites(),
                              ["source_ru"])["source_ru"] == ""


def test_make_model_combinations():
    assert placeholder_values(_row(make="Cisco", model="Nexus"), _initiative(), _sites(),
                              ["make_model"])["make_model"] == "Cisco Nexus"
    assert placeholder_values(_row(make="Cisco", model=None), _initiative(), _sites(),
                              ["make_model"])["make_model"] == "Cisco"
    assert placeholder_values(_row(make=None, model="Nexus"), _initiative(), _sites(),
                              ["make_model"])["make_model"] == "Nexus"
    assert placeholder_values(_row(make=None, model=None), _initiative(), _sites(),
                              ["make_model"])["make_model"] == ""


def test_move_date_empty_when_unscheduled():
    values = placeholder_values(_row(), _initiative(scheduled_start=None), _sites(),
                                ["move_date"])
    assert values["move_date"] == ""


def test_sites_missing_resolve_empty():
    values = placeholder_values(_row(), _initiative(), Sites(origin=None, destination=None),
                                ["source_site", "destination_site"])
    assert values == {"source_site": "", "destination_site": ""}


def test_missing_asset_data_resolves_empty_v2_parity():
    row = AssetRow(asset_id="x", legacy_id=None, name=None, serial_number=None, make=None,
                   model=None, source_rack=None, source_ru=None, source_position=None,
                   destination_rack=None, destination_ru=None, destination_position=None)
    values = placeholder_values(row, _initiative(), _sites(), CATALOG)
    assert values == {
        "asset_id": "", "asset_name": "", "serial_number": "", "make": "", "model": "",
        "make_model": "", "source_raw": "", "source_ru": "", "source_site": "NAP7",
        "destination_raw": "", "destination_ru": "", "destination_site": "NAP11",
        "move_name": "NAP11 Hall Migration", "move_date": "09/15/2026",
        "container_name": "", "container_id": "",
    }


def test_unrecognized_catalog_key_resolves_empty():
    values = placeholder_values(_row(), _initiative(), _sites(), ["not_a_real_key"])
    assert values == {"not_a_real_key": ""}


def test_generation_rules_splits_position_tokens():
    rules = {"destination": {"1": "nap", "2": "row"}, "source": {"1": "src_nap"}}
    values = placeholder_values(
        _row(destination_position="NAP11.C03", source_position="NAP7.A12"),
        _initiative(), _sites(), ["destination_raw", "source_raw"], generation_rules=rules)
    assert values["nap"] == "NAP11" and values["row"] == "C03"
    assert values["src_nap"] == "NAP7"


def test_generation_rules_position_out_of_range_is_left_unset():
    rules = {"destination": {"5": "too_far"}}
    values = placeholder_values(
        _row(destination_position="NAP11.C03"), _initiative(), _sites(),
        ["destination_raw"], generation_rules=rules)
    assert "too_far" not in values


def test_generation_rules_length_limits_truncate():
    rules = {"length_limits": {"asset_name": 4}}
    values = placeholder_values(
        _row(name="core-switch-long-name"), _initiative(), _sites(),
        ["asset_name"], generation_rules=rules)
    assert values["asset_name"] == "core"


def test_generation_rules_length_limit_on_position_token():
    rules = {"destination": {"1": "nap"}, "length_limits": {"nap": 3}}
    values = placeholder_values(
        _row(destination_position="NAP11.C03"), _initiative(), _sites(),
        ["destination_raw"], generation_rules=rules)
    assert values["nap"] == "NAP"


def test_generation_rules_empty_dict_is_a_no_op():
    values = placeholder_values(_row(), _initiative(), _sites(), CATALOG, generation_rules={})
    assert "nap" not in values
