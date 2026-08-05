"""apply_unit_pairs — the one place unit conversion happens."""

from serversherpa.assets.units import apply_unit_pairs


def test_lbs_fills_kg():
    data = apply_unit_pairs({"weight_lbs": 50.0})
    assert data["weight_kg"] == 22.68          # 50 * 0.453592 = 22.6796


def test_kg_fills_lbs():
    data = apply_unit_pairs({"weight_kg": 10.0})
    assert data["weight_lbs"] == 22.05         # 10 / 0.453592 = 22.0462


def test_both_present_stored_as_sent():
    data = apply_unit_pairs({"weight_lbs": 50.0, "weight_kg": 23.0})
    assert data == {"weight_lbs": 50.0, "weight_kg": 23.0}


def test_dimensions_pair_componentwise():
    data = apply_unit_pairs({"length_in": 32.0, "width_in": 1.5, "height_in": 18.5})
    assert data["length_cm"] == 81.28
    assert data["width_cm"] == 3.81
    assert data["height_cm"] == 46.99


def test_cm_to_inches():
    data = apply_unit_pairs({"length_cm": 100.0})
    assert data["length_in"] == 39.37


def test_none_clears_partner():
    data = apply_unit_pairs({"weight_lbs": None})
    assert data["weight_kg"] is None


def test_untouched_fields_pass_through():
    data = apply_unit_pairs({"make": "Dell", "ru_size": 2})
    assert data == {"make": "Dell", "ru_size": 2}
