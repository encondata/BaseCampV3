import asyncio
import json
import uuid
from types import SimpleNamespace

import pytest
from conftest import FAKE_BASE_URL

from loadtest.client.portal import PortalClient
from loadtest.profile import RetrySpec
from loadtest.sampler import Sampler

EMAIL = "ops@example.com"
PASSWORD = "portal-pass-1"
EVERY = 10.0


@pytest.fixture
async def setup(fake, clock, metrics):
    move_id = fake.add_move(servers=5, containers=1, trucks=1)
    fake.add_portal_user(EMAIL, PASSWORD)
    portal = PortalClient(base_url=FAKE_BASE_URL, metrics=metrics, clock=clock,
                          retry=RetrySpec(attempts=1, backoff_seconds=(1,)), timeout=10.0,
                          transport=fake.transport())
    assert await clock.run(portal.login(EMAIL, PASSWORD)) == "ok"
    sampler = Sampler(portal=portal, move_id=move_id, metrics=metrics, clock=clock, every=EVERY)
    yield SimpleNamespace(move_id=move_id, portal=portal, sampler=sampler)
    await portal.close()


def add_raw(fake, value: str, device: str = "Load test – QA 1") -> None:
    """One raw scan waiting for the fake's worker, as a kiosk batch stores it."""
    fake.raw_scans.append({
        "id": len(fake.raw_scans) + 10_000, "match_attempted_at": None, "off_move": False,
        "kiosk_asset_id": None, "scanned_value": value, "scan_type": "barcode",
        "status": "qa", "scan_status": "qa", "scanned_at": fake._iso(fake.clock.now()),
        "device_id": device, "operator_id": None, "site_id": None, "initiative_id": None,
        "source": "kiosk", "client_scan_id": str(uuid.uuid4())})


def serials(fake, move_id) -> list[str]:
    return [a["serial_number"] for a in fake.assets.values() if a["initiative_id"] == move_id]


async def run_for(clock, sampler, seconds: float, during=None):
    """Run the sampler for `seconds` virtual seconds, with `during` alongside."""
    task = asyncio.ensure_future(sampler.run())

    async def body():
        if during is not None:
            await during()
        else:
            await clock.sleep(seconds)

    try:
        await clock.run(body())
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_latest_follows_the_waiting_count_and_keeps_the_peak(fake, clock, metrics, setup):
    sns = serials(fake, setup.move_id)

    async def during():
        await clock.sleep(1)                              # after the first reading
        for value in sns[:4]:
            add_raw(fake, value)
        add_raw(fake, "OTHER", device="Dock kiosk 7")    # not this run's device
        await clock.sleep(15)
        assert setup.sampler.latest["waiting"] == 4
        fake.process_scans()
        await clock.sleep(10)

    assert setup.sampler.db_health_state == "not_sampled"
    await run_for(clock, setup.sampler, 0, during)
    assert setup.sampler.db_health_state == "sampled"
    latest = setup.sampler.latest
    assert latest["waiting"] == 0                         # OTHER is not this run's
    assert latest["waiting_peak"] == 4
    assert latest["workers"] == "2/2"
    assert latest["totals"] == {"qa": 4, "loaded_in_system": 1}
    json.dumps(latest)                                    # safe to serialize
    series = metrics.series()
    assert [v for _, v in series["waiting"]] == [0, 4, 0]
    assert [v for _, v in series["workers_running"]] == [2, 2, 2]
    assert series["asset_totals"][0][1] == {"loaded_in_system": 5}
    assert len(series["db_health"]) == 3
    assert series["db_health"][0][1]["connection_groups"][0]["count"] == 10


async def test_one_failed_read_does_not_end_the_loop(fake, clock, metrics, setup):
    fake.fail("GET", r"/scans/raw/page", status=500, times=1)
    fake.fail("GET", r"/initiatives/.*/asset-totals", status=500, times=2)
    await run_for(clock, setup.sampler, 35)
    series = metrics.series()
    assert len(series["waiting"]) == 3                    # 4 ticks, the first failed
    assert len(series["asset_totals"]) == 2
    assert len(series["workers_running"]) == 4
    assert setup.sampler.latest["waiting"] == 0


async def test_health_is_not_asked_again_after_none(fake, clock, metrics, setup):
    fake.portal_users[EMAIL].permissions = {"initiatives:view", "scans:view"}
    await run_for(clock, setup.sampler, 35)
    assert "db_health" not in metrics.series()
    health_calls = [p for _, p in fake.requests if p.startswith("/devtools/health")]
    assert len(health_calls) == 1
    assert setup.sampler.db_health_state == "not_available"


async def test_catch_up_returns_the_virtual_seconds_until_zero(fake, clock, setup):
    for value in serials(fake, setup.move_id):
        add_raw(fake, value)

    async def worker():
        await clock.sleep(35.5)
        fake.process_scans()

    async def both():
        result = await asyncio.gather(setup.sampler.wait_for_catch_up(), worker())
        return result[0]

    # read every second while catching up, not every sample interval: on the real server
    # a 0.4 s catch-up read as a full 10 s interval on every run
    assert await clock.run(both()) == 36.0                # readings at 0, 1, 2, … 36


async def test_catch_up_reads_at_the_sample_interval_when_it_is_shorter(fake, clock, setup):
    setup.sampler.every = 0.5
    add_raw(fake, "NOPE-1")

    async def worker():
        await clock.sleep(2.2)
        fake.raw_scans.clear()

    async def both():
        result = await asyncio.gather(setup.sampler.wait_for_catch_up(), worker())
        return result[0]

    assert await clock.run(both()) == 2.5                 # readings every 0.5 s


async def test_catch_up_is_none_when_scans_stay_unmatched(fake, clock, setup):
    for value in ("NOPE-1", "NOPE-2", "NOPE-3"):
        add_raw(fake, value)
    fake.process_scans()                                  # tried, no match: they stay
    start = clock.now()
    assert await clock.run(setup.sampler.wait_for_catch_up(quiet_samples=6)) is None
    assert clock.now() - start == 60.0                    # 6 sample intervals without shrinking


async def test_catch_up_gives_up_at_the_timeout(fake, clock, setup):
    for i in range(20):
        add_raw(fake, f"NOPE-{i}")

    async def trickle():                                  # always shrinking, never zero
        while True:
            await clock.sleep(EVERY)
            fake.raw_scans.pop(0)

    async def catch_up():
        task = asyncio.ensure_future(trickle())
        try:
            return await setup.sampler.wait_for_catch_up(timeout=45)
        finally:
            task.cancel()

    start = clock.now()
    assert await clock.run(catch_up()) is None
    assert clock.now() - start == 45.0                    # the last reading inside 45 s
