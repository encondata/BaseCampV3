import pytest

from serversherpa_devices.packages.versions import ios_build_sort


def test_ios_build_sort_orders_1_10_after_1_9():
    assert ios_build_sort("1.10") > ios_build_sort("1.9")
    assert ios_build_sort("2") > ios_build_sort("1.999999999.999999999.999999999")
    assert ios_build_sort("1.0.1") > ios_build_sort("1")
    assert ios_build_sort("1") == ios_build_sort("1.0.0.0") == 10**27
    assert ios_build_sort("1.2.3.4") == 10**27 + 2 * 10**18 + 3 * 10**9 + 4
    assert ios_build_sort("0") == 0


def test_ios_build_sort_accepts_date_style_builds():
    assert ios_build_sort("20261117") < ios_build_sort("20261118")
    assert ios_build_sort("2026111701") < ios_build_sort("2026111702")   # YYYYMMDDNN
    assert ios_build_sort("2026111701") == 2026111701 * 10**27
    assert ios_build_sort("2026111701") > ios_build_sort("20261118")
    top = ios_build_sort("99999999999.999999999.999999999.999999999")
    assert top == 10**38 - 1   # the largest key still fits numeric(38,0)


def test_ios_build_sort_rejects_part_over_9_digits():
    for build in ("1.1000000000", "1.2.1000000000", "1.2.3.99999999999"):
        with pytest.raises(ValueError):
            ios_build_sort(build)
    assert ios_build_sort("1.999999999") == 10**27 + 999999999 * 10**18


def test_ios_build_sort_first_part_allows_11_digits():
    assert ios_build_sort("99999999999") == 99999999999 * 10**27
    with pytest.raises(ValueError):   # 12 digits
        ios_build_sort("100000000000")


@pytest.mark.parametrize("build", [
    "", "abc", "1.0b3", "1..2", "1.", ".1", "+1", " 1", "1 ", "-1", "1.2.3.4.5", "²",
])
def test_ios_build_sort_rejects_non_numeric(build):
    with pytest.raises(ValueError):
        ios_build_sort(build)
