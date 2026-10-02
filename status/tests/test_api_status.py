from datetime import UTC, datetime, timedelta

import pytest

from serversherpa_status.api_status import (
    ApiStatus,
    Background,
    LatestApiStatus,
    parse_api_status,
)

T0 = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)


def test_parses_a_full_payload():
    got = parse_api_status({
        "read_only": True,
        "read_only_message": "  Cutover  ",
        "banner": "Hi",
        "background": {"state": "down", "running": 1, "total": 3},
    })
    assert got == ApiStatus(True, "Cutover", "Hi", Background("down", 1, 3))


def test_empty_payload_is_all_unknown():
    assert parse_api_status({}) == ApiStatus(False, None, None, None)


def test_only_a_real_true_counts_as_maintenance():
    assert parse_api_status({"read_only": "yes"}).maintenance is False


def test_blank_messages_become_none():
    got = parse_api_status({"read_only": True, "read_only_message": "   ", "banner": ""})
    assert got.maintenance_message is None
    assert got.announcement is None


def test_long_messages_are_capped():
    got = parse_api_status({"banner": "x" * 600})
    assert len(got.announcement) == 500


@pytest.mark.parametrize("bad", [
    {"running": 1, "total": 2},
    {"state": "exploded", "running": 1, "total": 2},
    {"state": "running", "running": -1, "total": 2},
    {"state": "running", "running": 1, "total": "9"},
    [],
])
def test_bad_background_is_rejected(bad):
    assert parse_api_status({"background": bad}).background is None


def test_latest_holder():
    latest = LatestApiStatus()
    assert latest.get(T0, 60) is None
    value = ApiStatus(True, "M", None, None)
    latest.set(value, T0)
    assert latest.get(T0 + timedelta(seconds=30), 60) is value
    assert latest.get(T0 + timedelta(seconds=61), 60) is None
    latest.set(None, T0)
    assert latest.get(T0, 60) is None
