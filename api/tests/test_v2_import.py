"""Pure parsing/mapping helpers of the V2 legacy-dump importer."""

from serversherpa.assets.v2_import import (
    build_model_kwargs, map_category, map_mount, map_status, parse_dims,
    parse_ru, parse_weight,
)


def test_parse_weight_variants():
    assert parse_weight("95 lbs") == 95.0
    assert parse_weight("92lb") == 92.0
    assert parse_weight("40") == 40.0
    assert parse_weight("20 kg") == 44.09
    assert parse_weight("heavy") is None
    assert parse_weight(None) is None
    assert parse_weight("") is None


def test_parse_ru_variants():
    assert parse_ru("2U") == 2
    assert parse_ru("2") == 2
    assert parse_ru("3.3U") == 3
    assert parse_ru(None) is None
    assert parse_ru("tower") is None


def test_parse_dims_variants():
    assert parse_dims("3.43x17.61x32.32") == (3.43, 17.61, 32.32)
    assert parse_dims('17.08" x 3.4" x 35.3"') == (17.08, 3.4, 35.3)
    assert parse_dims("17 x 3") is None
    assert parse_dims(None) is None


def test_map_status_pipeline_collapse():
    assert map_status("Racked") == "active"
    assert map_status("On Truck") == "in_transit"
    assert map_status("Staged") == "in_storage"
    assert map_status("e-waste") == "decommissioned"
    assert map_status("Location Collision") == "unknown"
    assert map_status(None) == "unknown"


def test_map_category_and_mount():
    assert map_category("Server") == "server"
    assert map_category("weird") == "other"
    assert map_category(None) is None
    assert map_mount("rail") == "rails"
    assert map_mount("tower") == "custom"
    assert map_mount(None) is None


def test_build_model_kwargs_parses_and_computes_metric():
    row = ["42", "Dell", "R750XA", "95 lbs", "2U",
           '17.08" x 3.4" x 35.3"', "rails", "B19/B17", "", "Server"]
    kwargs = build_model_kwargs(row)
    assert kwargs["make"] == "Dell" and kwargs["model"] == "R750XA"
    assert kwargs["weight_lbs"] == 95.0 and kwargs["weight_kg"] == 43.09
    assert kwargs["length_in"] == 17.08 and kwargs["length_cm"] == 43.38
    assert kwargs["ru_size"] == 2
    assert kwargs["category"] == "server"
    assert kwargs["legacy_id"] == 42
    assert kwargs["knowledge"] == ""


def test_build_model_kwargs_preserves_unparseable():
    row = ["7", "HP", "ML30 Gen10", "thirty pounds", "3.3U",
           "smallish", "tower", None, "Tips here", "Server"]
    kwargs = build_model_kwargs(row)
    assert kwargs["weight_lbs"] is None
    assert "length_in" not in kwargs
    assert kwargs["mount_type"] == "custom"
    assert kwargs["knowledge"].startswith("Tips here")
    assert "weight: thirty pounds" in kwargs["knowledge"]
    assert "dimensions: smallish" in kwargs["knowledge"]
    assert "mount: tower" in kwargs["knowledge"]
