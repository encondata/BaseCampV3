"""Zebra Android handhelds are derived from what the app already reports,
not chosen by hand — a manual sub_type is overwritten on the next re-pair."""

import pytest
from serversherpa.api.routes.kiosk import kiosk_sub_type


@pytest.mark.parametrize("raw_info", [
    {"manufacturer": "Zebra Technologies", "datawedge": "false"},
    {"manufacturer": "zebra technologies"},          # case-insensitive
    {"manufacturer": "Google", "datawedge": "true"},  # DataWedge fallback
])
def test_android_on_zebra_hardware_becomes_zebra(raw_info):
    assert kiosk_sub_type("android", raw_info) == "zebra"


@pytest.mark.parametrize("raw_info", [
    {"manufacturer": "Google", "datawedge": "false"},
    {"manufacturer": "Samsung"},
    {},
])
def test_ordinary_android_stays_android(raw_info):
    assert kiosk_sub_type("android", raw_info) == "android"


@pytest.mark.parametrize("mode", ["web", "laptop", "pi", "ios"])
def test_other_modes_are_never_reclassified(mode):
    """Only android is refined. A laptop reporting a Zebra manufacturer
    string is still a laptop."""
    assert kiosk_sub_type(mode, {"manufacturer": "Zebra Technologies"}) == mode


def test_missing_or_malformed_raw_info_does_not_raise():
    assert kiosk_sub_type("android", {}) == "android"
    assert kiosk_sub_type("android", {"manufacturer": None}) == "android"
    assert kiosk_sub_type("android", {"datawedge": True}) == "zebra"   # bool, not str
