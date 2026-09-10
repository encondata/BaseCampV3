import pytest

from serversherpa.trucks.location import LocationError, parse_location


def test_parses_v2_text_and_objects():
    assert parse_location("39.0437, -77.4875") == (39.0437, -77.4875)
    assert parse_location(" 32.7767 , -96.7970 ") == (32.7767, -96.797)
    assert parse_location({"lat": 1, "lng": 2}) == (1.0, 2.0)


@pytest.mark.parametrize("bad", ["", "abc", "91, 0", "0, 181", "1", {"lat": 1}, "1,2,3"])
def test_rejects_garbage(bad):
    with pytest.raises(LocationError):
        parse_location(bad)
