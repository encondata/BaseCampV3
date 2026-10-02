import pytest

from serversherpa_status.config import Service


@pytest.fixture
def api_service() -> Service:
    return Service("api", "API", "http://api.test")


@pytest.fixture
def portal_service() -> Service:
    return Service("portal", "Portal", "http://portal.test")


@pytest.fixture
def kiosk_service() -> Service:
    return Service("kiosk", "Kiosk", "http://kiosk.test")


@pytest.fixture
def wiki_service() -> Service:
    return Service("wiki", "Wiki", "http://wiki.test")
