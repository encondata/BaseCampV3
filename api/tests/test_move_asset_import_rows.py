"""Pure row-parsing helpers ported from V2's upload path."""

import re

from serversherpa.imports.move_assets import (
    PRIORITY_MAX, generate_serial, parse_row,
    resolve_make_model_for_creation,
)


def _canonical(**over):
    from serversherpa.imports.parsing import CANONICAL
    row = {c: "" for c in CANONICAL}
    row.update(over)
    return row


def test_resolve_make_model_split_and_dedup():
    # both halves present: unchanged (minus duplicated make prefix)
    assert resolve_make_model_for_creation("Dell", "R640") == ("Dell", "R640")
    assert resolve_make_model_for_creation("Dell", "Dell R640") == ("Dell", "R640")
    assert resolve_make_model_for_creation("Dell", "Dell Dell R640") == ("Dell", "R640")
    # only model: split on first space
    assert resolve_make_model_for_creation("", "Dell R640") == ("Dell", "R640")
    assert resolve_make_model_for_creation("", "R640") == ("R640", "R640")
    # only make: split on first space
    assert resolve_make_model_for_creation("Dell R640", "") == ("Dell", "R640")
    # model exactly equal to make is left alone
    assert resolve_make_model_for_creation("Dell", "Dell") == ("Dell", "Dell")


def test_generate_serial_format():
    serial = generate_serial(" Web-01 ")
    assert re.fullmatch(r"web-01\.\d{13}", serial)


def test_missing_serial_is_an_error():
    out = parse_row(2, _canonical(), {}, generate_serials=False)
    assert out["status"] == "error"
    assert out["message"] == "Missing required field: Serial Number"
    out = parse_row(2, _canonical(), {}, generate_serials=True)
    assert out["status"] == "error"
    assert "Asset Name is also blank" in out["message"]


def test_serial_generation_path():
    out = parse_row(2, _canonical(asset_name="Web-01"), {},
                    generate_serials=True)
    assert out["status"] == "ok"
    assert out["serial_generated"] is True
    assert re.fullmatch(r"web-01\.\d{13}", out["serial_number"])


def test_typed_fields_and_lowering():
    raw = {"Serial Number": "SN-9", "Weird": "kept"}
    out = parse_row(3, _canonical(
        serial_number="SN-9", asset_make="Dell", asset_model="R740",
        source_ru="12", destination_ru="junk", priority="P" * 40,
        data_1="sw1", mgmt_2="m2", vendor_involvement="x",
        source_position=" Front ", destination_position="",
    ), raw, generate_serials=False)
    assert out["status"] == "ok"
    assert out["serial_number"] == "sn-9"
    assert out["asset_name"] == "sn-9"          # falls back to serial
    assert out["make_model_str"] == "Dell R740"
    assert out["source_ru"] == 12.0
    assert out["destination_ru"] is None        # unparseable -> None
    assert out["priority_wave"] == "P" * PRIORITY_MAX
    assert any("truncated" in n for n in out["notes"])
    assert out["cable_info"] == {"data_1": "sw1", "mgmt_2": "m2"}
    assert out["vendor_involved"] is True
    assert out["raw_ft"] == raw
    assert out["source_position"] == "Front"    # trimmed, NOT lowercased
    assert out["destination_position"] is None  # blank -> None


def test_make_model_str_single_half():
    assert parse_row(2, _canonical(serial_number="s", asset_model="R740"),
                     {}, generate_serials=False)["make_model_str"] == "R740"
    assert parse_row(2, _canonical(serial_number="s", asset_make="Dell"),
                     {}, generate_serials=False)["make_model_str"] == "Dell"
    assert parse_row(2, _canonical(serial_number="s"),
                     {}, generate_serials=False)["make_model_str"] is None


def test_pods_parse_stripped_and_blank_is_none():
    out = parse_row(2, _canonical(serial_number="SN-1", source_pod=" 14 ",
                                  destination_pod=""), {},
                    generate_serials=False)
    assert out["source_pod"] == "14"
    assert out["destination_pod"] is None
