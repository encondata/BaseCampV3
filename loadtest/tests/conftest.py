"""Shared test fixtures (later tasks add to this)."""

import pytest
from fakeserver import FakeBaseCamp

from loadtest.client.kiosk import KioskDevice
from loadtest.clock import FakeClock
from loadtest.metrics import Metrics
from loadtest.profile import RetrySpec

FAKE_BASE_URL = "http://fake.test"
_SERIAL_PREFIX = {"handheld": "ENROLL", "rfid_station": "RFID", "label_station": "LABEL"}
_NAME = {"handheld": "Enroll", "rfid_station": "RFID", "label_station": "Label"}


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def metrics():
    return Metrics()


@pytest.fixture
def retry():
    return RetrySpec(attempts=3, backoff_seconds=(1, 2))


@pytest.fixture
def fake(clock):
    return FakeBaseCamp(clock)


@pytest.fixture
async def device(fake, clock, metrics, retry):
    """Factory: device(kind="handheld", n=1) -> a KioskDevice on the fake; all closed after."""
    made: list[KioskDevice] = []

    def make(kind="handheld", n=1, **overrides):
        kwargs = {"base_url": FAKE_BASE_URL, "serial": f"LOADTEST-{_SERIAL_PREFIX[kind]}-{n}",
                  "name": f"Load test – {_NAME[kind]} {n}", "kind": kind, "metrics": metrics,
                  "clock": clock, "retry": retry, "timeout": 10.0, "transport": fake.transport()}
        kwargs.update(overrides)
        d = KioskDevice(**kwargs)
        made.append(d)
        return d

    yield make
    for d in made:
        await d.close()
