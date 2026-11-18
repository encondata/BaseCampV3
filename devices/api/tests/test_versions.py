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
    assert ios_build_sort("202611170") == 202611170 * 10**27   # nine digits: the most a part holds
    assert ios_build_sort("202611170") > ios_build_sort("20261118")
    with pytest.raises(ValueError):   # ten digits (YYYYMMDDNN) is over a part's limit
        ios_build_sort("2026111701")
    top = ios_build_sort("999999999.999999999.999999999.999999999")
    assert top == 10**36 - 1 and len(str(top)) <= 38   # fits numeric(38,0)


def test_ios_build_sort_rejects_part_over_9_digits():
    for build in ("1000000000", "1.1000000000", "1.2.3.99999999999"):
        with pytest.raises(ValueError):
            ios_build_sort(build)
    assert ios_build_sort("1.999999999") == 10**27 + 999999999 * 10**18


@pytest.mark.parametrize("build", [
    "", "abc", "1.0b3", "1..2", "1.", ".1", "+1", " 1", "1 ", "-1", "1.2.3.4.5", "²",
])
def test_ios_build_sort_rejects_non_numeric(build):
    with pytest.raises(ValueError):
        ios_build_sort(build)
