import pytest

from serversherpa_devices.packages.versions import ios_build_sort


def test_ios_build_sort_orders_1_10_after_1_9():
    assert ios_build_sort("1.10") > ios_build_sort("1.9")
    assert ios_build_sort("2") > ios_build_sort("1.65535.65535.65535")
    assert ios_build_sort("1.0.1") > ios_build_sort("1")
    assert ios_build_sort("1") == ios_build_sort("1.0.0.0") == 1 << 48
    assert ios_build_sort("1.2.3.4") == (1 << 48) | (2 << 32) | (3 << 16) | 4
    assert ios_build_sort("0") == 0


@pytest.mark.parametrize("build", [
    "", "abc", "1.0b3", "1..2", "1.", ".1", "+1", " 1", "1 ", "-1", "1.2.3.4.5", "65536", "²",
])
def test_ios_build_sort_rejects_non_numeric(build):
    with pytest.raises(ValueError):
        ios_build_sort(build)
