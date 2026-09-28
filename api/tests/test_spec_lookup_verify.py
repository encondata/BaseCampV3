import pytest

from serversherpa.spec_lookup.verify import (
    height_fits_ru, normalize_url, numbers_in, verify_finding, weight_is_heavy,
)

SEEN = {normalize_url("https://www.hpe.com/psnow/doc/a50004307enw")}
URL = "https://www.hpe.com/psnow/doc/a50004307enw/"


def v(field, value, unit, quote, url=URL):
    return verify_finding(field, value, unit, quote, url, SEEN)


def test_numbers_in():
    assert numbers_in("Weight: 1,234.5 lb") == [1234.5]
    assert numbers_in("43.46 x 70.7 x 4.29 cm") == [43.46, 70.7, 4.29]
    assert numbers_in("17,5 kg") == [17.5]
    assert numbers_in("2U") == [2.0]


def test_numbers_in_skips_unparseable():
    assert numbers_in("iLO 192.168.1.1, weight 13.6 kg") == [13.6]


def test_url_normalization():
    assert normalize_url("https://WWW.hpe.com/a/?x=1#frag") == "https://www.hpe.com/a?x=1"


def test_accepts_value_present_in_quote():
    got = v("weight", "13.6", "kg", "Maximum weight 13.6 kg (30 lb)")
    assert got is not None and got.value == "13.6" and got.unit == "kg"
    assert v("ru_size", "1", None, "1U rack height").value == "1"


def test_rejects_value_missing_from_quote():
    assert v("weight", "14", "kg", "Maximum weight 13.6 kg") is None


def test_rejects_unseen_url():
    assert v("ru_size", "1", None, "1U", url="https://example.com/made-up") is None


def test_bounds():
    assert v("ru_size", "0", None, "0U") is None
    assert v("ru_size", "61", None, "61U") is None
    assert v("weight", "4000", "lbs", "4000 lbs") is None
    assert v("height", "200", "in", "200 in") is None
    assert v("height", "4.29", "cm", "4.29 cm") is not None


def test_units_must_fit_the_field():
    assert v("weight", "13.6", "cm", "13.6 cm") is None
    assert v("ru_size", "1", "in", "1U") is None


def test_mount_and_rail_and_knowledge():
    assert v("mount_type", "rails", None, "ships with sliding rails").value == "rails"
    assert v("mount_type", "magnets", None, "magnets") is None
    assert v("rail_type", "Easy install sliding rails", None, "Easy install sliding rails") is not None
    assert v("rail_type", "x" * 101, None, "x") is None
    assert v("knowledge", "1U, 2-socket server.", None, "The DL320 is a 1U server") is not None
    assert v("knowledge", "y" * 1001, None, "y") is None


def test_empty_quote_rejected():
    assert v("ru_size", "1", None, "   ") is None


def test_verify_finding_with_ip_address_in_quote():
    assert v("weight", "13.6", "kg", "Default gateway 192.168.1.1, weight 13.6 kg") is not None


def test_non_string_inputs_rejected():
    assert v("ru_size", "1", None, "1U", url=None) is None
    assert v("ru_size", "1", None, "1U", url=123) is None
    assert v("ru_size", 1, None, "1U") is None
    assert v("ru_size", "1", None, ["1U"]) is None


@pytest.mark.parametrize("height,unit,ru,expected", [
    (4.28, "cm", 1, True),          # 1.69 in, true height of the 1U DL320
    (42.8, "cm", 1, False),         # the live-test bug: width mistaken for height
    (-0.25, "in", 1, True),         # lower bound of 1U window: (1-1)*1.75-0.25
    (2.0, "in", 1, True),           # upper bound of 1U window: 1*1.75+0.25
    (2.01, "in", 1, False),         # just past the upper bound
    (-0.26, "in", 1, False),        # just past the lower bound
    (3.44, "in", 2, True),
    (8.75, "cm", 2, True),
])
def test_height_fits_ru(height, unit, ru, expected):
    assert height_fits_ru(height, unit, ru) is expected


@pytest.mark.parametrize("weight,unit,ru,expected", [
    (29.6, "kg", 1, True),
    (16, "kg", 1, False),
    (33, "kg", 2, False),
    (65.3, "lbs", 1, True),         # 29.6 kg
    (25, "kg", None, False),        # ru unknown -> never flagged heavy
])
def test_weight_is_heavy(weight, unit, ru, expected):
    assert weight_is_heavy(weight, unit, ru) is expected
