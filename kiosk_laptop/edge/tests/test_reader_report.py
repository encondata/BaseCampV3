import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from edge import laptop_setup
from edge.db import iso
from edge.rfid import reader_report
from edge.rfid.reader_report import ReaderReporter, build_snapshot, current_snapshot, parse_uptime
from tests.conftest import make_session
from tests.test_rfid_pairing import SERIAL, pair, use_reader, write_host

NOW = datetime(2026, 10, 16, 23, 0, 5, tzinfo=UTC)


def test_parse_uptime():
    assert parse_uptime("357:6:17") == 1285577
    assert parse_uptime("0:0:5") == 5
    for bad in ("", "x", None, "1:2", "1:2:x", "26 days 01:11:17", 5):
        assert parse_uptime(bad) is None


async def paired_station(app, client, station="rfid", **reader_kw):
    reader = use_reader(app, **reader_kw)
    write_host(app)
    assert (await pair(client, app, laptop_ip="10.0.0.5")).status_code == 200
    laptop_setup.save(app.state.store, {"initiative_id": "i-1", "initiative_name": "Move"},
                      station)
    return reader


def add_read(app, serial, received_at):
    app.state.store.run(
        "INSERT INTO raw_tag_reads (received_at, reader_serial, epc, raw_json) "
        "VALUES (?, ?, 'E2', '{}')", (iso(received_at), serial))


async def test_snapshot_fields(app, client):
    reader = await paired_station(app, client)
    reader.reading = True
    snap = await build_snapshot(app.state, now=NOW)
    assert snap == {
        "serial": SERIAL, "make": "Zebra", "model": "FX9600", "name": "FX9600647D23",
        "mac": "C4:7D:CC:64:7D:23", "ip": "10.10.48.119", "firmware": "2.7.19.0",
        "uptime_seconds": 1285577, "antennas_connected": 2, "antennas_total": 4,
        "reading": True, "tags_24h": 0, "reachable": True, "taken_at": snap["taken_at"]}


async def test_tags_24h_counts_only_this_reader_and_window(app, client):
    await paired_station(app, client)
    add_read(app, SERIAL, NOW - timedelta(hours=1))
    add_read(app, SERIAL, NOW - timedelta(hours=25))
    add_read(app, "other", NOW - timedelta(hours=1))
    assert (await build_snapshot(app.state, now=NOW))["tags_24h"] == 1


async def test_snapshot_without_network_call(app, client):
    reader = await paired_station(app, client)
    reader.network_fails = True
    snap = await build_snapshot(app.state, now=NOW)
    assert not {"mac", "ip", "name"} & snap.keys()
    assert snap["model"] == "FX9600" and snap["reading"] is False and snap["reachable"] is True


async def test_bad_values_are_omitted(app, client):
    reader = await paired_station(app, client)
    reader.network.update(macAddress="nope", ipAddress="10.1.1", hostName="x" * 65)
    snap = await build_snapshot(app.state, now=NOW)
    assert not {"mac", "ip", "name"} & snap.keys()


async def test_unreachable_first_snapshot(app, client):
    reader = await paired_station(app, client)
    reader.mode = "unreachable"
    snap = await build_snapshot(app.state, now=NOW)
    assert snap == {"serial": SERIAL, "make": "Zebra", "reachable": False, "tags_24h": 0,
                    "taken_at": snap["taken_at"]}


async def test_unreachable_keeps_last_values(app, client):
    reader = await paired_station(app, client)
    app.state.reader_snapshot = await build_snapshot(app.state, now=NOW)
    add_read(app, SERIAL, NOW - timedelta(hours=1))
    reader.mode = "unreachable"
    snap = await build_snapshot(app.state, now=NOW)
    assert snap["reachable"] is False and snap["mac"] == "C4:7D:CC:64:7D:23"
    assert snap["model"] == "FX9600" and snap["tags_24h"] == 1


async def test_no_snapshot_without_pairing_or_label_station(app, client):
    assert await build_snapshot(app.state, now=NOW) is None
    await paired_station(app, client, station="label")
    assert await build_snapshot(app.state, now=NOW) is None


async def test_snapshot_takes_pair_lock(app, client):
    await paired_station(app, client)
    task_done = False

    async def run():
        nonlocal task_done
        await build_snapshot(app.state, now=NOW)
        task_done = True

    async with app.state.pair_lock:
        task = asyncio.create_task(run())
        await asyncio.sleep(0.05)
        assert not task_done
    await task
    assert task_done


def test_current_snapshot_only_when_fresh(app):
    laptop_setup.save(app.state.store, {"initiative_id": "i-1"}, "rfid")
    app.state.reader_snapshot = {"serial": "s", "taken_at": iso(NOW - timedelta(minutes=2))}
    assert current_snapshot(app.state, now=NOW)["serial"] == "s"
    app.state.reader_snapshot = {"serial": "s", "taken_at": iso(NOW - timedelta(minutes=4))}
    assert current_snapshot(app.state, now=NOW) is None
    app.state.reader_snapshot = None
    assert current_snapshot(app.state, now=NOW) is None


async def test_reporter_loop_survives_errors(app, client, monkeypatch):
    await paired_station(app, client)
    calls = 0
    real = reader_report.build_snapshot

    async def flaky(state, **kw):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("boom")
        return await real(state, **kw)

    monkeypatch.setattr(reader_report, "build_snapshot", flaky)
    monkeypatch.setattr(reader_report, "INTERVAL_S", 0.01)
    reporter = ReaderReporter(app.state)
    reporter.start()
    try:
        for _ in range(100):
            if getattr(app.state, "reader_snapshot", None):
                break
            await asyncio.sleep(0.02)
    finally:
        await reporter.stop()
    assert calls >= 2 and app.state.reader_snapshot["serial"] == SERIAL


async def test_hung_reader_is_bounded_and_frees_the_lock(app, client, monkeypatch):
    import httpx

    reader = await paired_station(app, client)
    app.state.reader_snapshot = await build_snapshot(app.state, now=NOW)

    class Hang(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            await asyncio.sleep(30)

    monkeypatch.setattr(reader_report, "REPORT_LOCK_BUDGET_S", 0.2)
    app.state.reader_transport = Hang()
    snap = await asyncio.wait_for(build_snapshot(app.state, now=NOW), 3)
    assert snap["reachable"] is False and snap["mac"] == "C4:7D:CC:64:7D:23"
    assert not app.state.pair_lock.locked()


async def test_vanished_pairing_row_degrades_to_unreachable(app, client, monkeypatch):
    await paired_station(app, client)

    async def gone(*a, **kw):
        from edge.deps import err
        raise err(409, "reader_required")

    monkeypatch.setattr(reader_report.pairing, "open_current", gone)
    assert (await build_snapshot(app.state, now=NOW))["reachable"] is False
