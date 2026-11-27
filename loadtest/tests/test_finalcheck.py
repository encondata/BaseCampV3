import random
from dataclasses import replace
from types import SimpleNamespace

import pytest
from conftest import FAKE_BASE_URL
from pipeline_helpers import fast
from run_helpers import state_for_move

from loadtest.actions import Actions
from loadtest.client.portal import AssetScan, PortalClient
from loadtest.events import Events
from loadtest.finalcheck import FinalReport, Finding, final_check
from loadtest.fleet import Fleet
from loadtest.pipeline import Pipeline

MOVE_PASSWORD = "move-pass-1"
EMAIL = "ops@example.com"
PORTAL_PASSWORD = "portal-pass-1"
SERVERS = 45
SERVER_SCANS = SERVERS * 10          # ten server stages with a checkpoint
CONTAINER_SCANS = 3 * 2              # three crates, each loaded and unloaded
STOPPED = "Run was stopped before it finished."


@pytest.fixture
async def move(fake, clock, metrics):
    """Factory: `await move()` runs a whole 45-server move on the fake (fast profile),
    lets 5 virtual seconds pass and processes every scan. `move(limit=s)` stops the
    pipeline after `s` virtual seconds instead. Returns an object with the profile,
    state, portal, move id and the rule checkpoints the fake has."""
    made: list = []

    async def make(*, limit: float | None = None, process: bool = True):
        profile = fast()
        move_id = fake.add_move(servers=SERVERS, containers=3, trucks=1, password=MOVE_PASSWORD)
        fake.add_portal_user(EMAIL, PORTAL_PASSWORD)
        portal = PortalClient(base_url=FAKE_BASE_URL, metrics=metrics, clock=clock,
                              retry=profile.retry, timeout=10.0, transport=fake.transport())
        made.append(portal)
        assert await clock.run(portal.login(EMAIL, PORTAL_PASSWORD)) == "ok"
        info = await clock.run(portal.move(move_id))
        events = Events(None)
        fleet = Fleet(profile=profile, base_url=FAKE_BASE_URL, move=info, metrics=metrics,
                      clock=clock, events=events, transport=fake.transport())
        made.append(fleet)
        made.append(events)
        await clock.run(fleet.start(MOVE_PASSWORD))
        state = state_for_move(fake, move_id, profile, clock)
        actions = Actions(profile=profile, state=state, fleet=fleet, portal=portal,
                          events=events, metrics=metrics, clock=clock)
        pipeline = Pipeline(profile, state, actions.perform, clock, random.Random(0))
        if limit is None:
            await clock.run(pipeline.run())
        else:
            with pytest.raises(TimeoutError):
                await clock.run(pipeline.run(), limit=limit)
        await clock.run(clock.sleep(5))
        if process:
            fake.process_scans()
        rules = await clock.run(portal.rule_checkpoints())
        return SimpleNamespace(profile=profile, state=state, portal=portal, move_id=move_id,
                               rules=rules)

    yield make
    for thing in made:
        if isinstance(thing, Fleet):
            await thing.stop()
        elif isinstance(thing, Events):
            thing.close()
        else:
            await thing.close()


async def check(clock, metrics, m, *, rules=None, stopped_early=False,
                profile=None) -> FinalReport:
    return await clock.run(final_check(
        portal=m.portal, state=m.state, profile=profile or m.profile, metrics=metrics,
        rule_checkpoints=m.rules if rules is None else rules, stopped_early=stopped_early))


def texts(report: FinalReport, level: str | None = None) -> list[str]:
    return [f.text for f in report.findings if level is None or f.level == level]


def server_by_serial(m, serial: str) -> str:
    return next(s.id for s in m.state.servers.values() if s.serial == serial)


def first_serials(m, n: int) -> list[str]:
    return sorted(s.serial for s in m.state.servers.values())[:n]


async def test_clean_run_passes(fake, clock, metrics, move):
    m = await move()
    report = await check(clock, metrics, m)
    assert report.verdict == "Pass", report.findings
    assert report.findings == []
    assert report.scans_sent == report.scans_processed == SERVER_SCANS
    assert report.scans_twice == 0 and report.scans_missing == 0
    assert report.container_scans_sent == CONTAINER_SCANS
    assert report.container_scans_checked is False
    assert set(report.delay_ms) == {"median", "p95", "max"}
    assert report.delay_ms["median"] >= 0
    assert report.delay_ms["max"] >= report.delay_ms["p95"] >= report.delay_ms["median"]
    assert report.delay_ms["max"] >= 5000          # 5 virtual seconds before processing


async def test_missing_last_rule_skips_the_status_check_with_a_warning(fake, clock, metrics,
                                                                        move):
    m = await move()
    fake.assets[server_by_serial(m, first_serials(m, 1)[0])]["asset_status"] = "qa"
    fake.status_rules[:] = [r for r in fake.status_rules
                            if r["trigger_status"] not in ("on_truck", "received", "complete")]
    rules = await clock.run(m.portal.rule_checkpoints())
    assert "complete" not in rules and "qa" in rules
    report = await check(clock, metrics, m, rules=rules)
    assert report.verdict == "Pass with warnings"
    assert report.findings == [Finding(
        "warn", "Move status not checked: no enabled rule for the Complete checkpoint.")]


async def test_dropped_scan_fails_naming_checkpoint_and_serial(fake, clock, metrics, move):
    m = await move()
    serial = first_serials(m, 1)[0]
    sid = server_by_serial(m, serial)
    row = next(p for p in fake.processed_scans
               if p["asset_id"] == sid and p["status"] == "labeled")
    fake.processed_scans.remove(row)
    report = await check(clock, metrics, m)
    assert report.verdict == "Fail"
    assert report.scans_missing == 1
    assert report.scans_processed == SERVER_SCANS - 1
    assert texts(report) == [
        (f"1 scan was never processed by the BaseCamp server: Label station (labeled) for "
         f"SN {serial}.")]


async def test_many_dropped_scans_list_three_serials_and_the_rest(fake, clock, metrics, move):
    m = await move()
    serials = first_serials(m, 5)
    gone = {server_by_serial(m, s) for s in serials}
    fake.processed_scans[:] = [p for p in fake.processed_scans
                               if not (p["asset_id"] in gone and p["status"] == "qa")]
    report = await check(clock, metrics, m)
    assert report.scans_missing == 5
    assert texts(report) == [
        (f"5 scans were never processed by the BaseCamp server: QA (qa) for SN {serials[0]}, "
         f"SN {serials[1]}, SN {serials[2]} and 2 more.")]


async def test_duplicated_scan_is_a_warning(fake, clock, metrics, move):
    m = await move()
    row = next(p for p in fake.processed_scans if p["status"] == "rfid_3_staging")
    fake.processed_scans.append({**row, "id": len(fake.processed_scans) + 1})
    report = await check(clock, metrics, m)
    assert report.verdict == "Pass with warnings"
    assert report.scans_twice == 1
    assert report.scans_processed == SERVER_SCANS
    assert report.findings == [Finding("warn", "1 scan was processed twice after a retry.")]


async def test_rows_from_other_devices_or_earlier_runs_are_ignored(fake, clock, metrics, move):
    m = await move()
    row = next(p for p in fake.processed_scans if p["status"] == "qa")
    fake.processed_scans.append({**row, "id": 10_001, "device_id": "Dock kiosk 7"})
    fake.processed_scans.append({**row, "id": 10_002,
                                 "scanned_at": fake._iso(m.state.started_at - 3600)})
    report = await check(clock, metrics, m)
    assert report.verdict == "Pass", report.findings


async def test_server_left_at_qa_fails(fake, clock, metrics, move):
    m = await move()
    serial = first_serials(m, 1)[0]
    fake.assets[server_by_serial(m, serial)]["asset_status"] = "qa"
    report = await check(clock, metrics, m)
    assert report.verdict == "Fail"
    assert texts(report, "fail") == [
        f"1 server did not reach the move status complete: SN {serial} (qa)."]


async def test_container_left_with_an_asset_fails(fake, clock, metrics, move):
    m = await move()
    cid = next(iter(m.state.containers))
    fake.container_of[next(iter(m.state.servers))] = cid
    report = await check(clock, metrics, m)
    assert report.verdict == "Fail"
    name = m.state.containers[cid].name
    assert texts(report) == [f"1 container is not empty: {name}."]


async def test_container_still_on_a_truck_and_truck_not_arrived_fail(fake, clock, metrics, move):
    m = await move()
    cids = list(m.state.containers)
    tid = next(iter(m.state.trucks))
    for cid in cids:
        fake.truck_of[cid] = tid
    fake.trucks[tid]["status"] = "in_transit"
    report = await check(clock, metrics, m)
    names = sorted(m.state.containers[c].name for c in cids)
    assert report.verdict == "Fail"
    assert texts(report) == [
        f"3 containers are still on a truck: {names[0]}, {names[1]} and {names[2]}.",
        f"1 truck is not at the destination: {m.state.trucks[tid].name} (in_transit)."]


async def test_wrong_tag_fails(fake, clock, metrics, move):
    m = await move()
    serial = first_serials(m, 1)[0]
    fake.assets[server_by_serial(m, serial)]["rfid_tag"] = "0" * 24
    report = await check(clock, metrics, m)
    assert texts(report, "fail") == [
        f"1 server does not have the tag the run gave it: SN {serial}."]


async def test_step_that_did_not_land_is_its_own_finding(fake, clock, metrics, move):
    m = await move()
    serials = first_serials(m, 2)
    for serial in serials:
        m.state.servers[server_by_serial(m, serial)].done["label"] = False
    report = await check(clock, metrics, m)
    assert report.verdict == "Fail"
    assert report.scans_sent == SERVER_SCANS - 2
    assert report.scans_twice == 0                  # their scan showed up anyway
    assert texts(report) == [
        f"The Label station step failed for 2 servers: SN {serials[0]} and SN {serials[1]}."]


async def test_failed_truck_and_trip_steps_come_from_the_state(fake, clock, metrics, move):
    """The verdict for truck and trip steps is read from the journaled state, never from
    the call counts alone (those start over when a run is continued)."""
    m = await move()
    crates = sorted(m.state.containers.values(), key=lambda c: c.name)
    truck = next(iter(m.state.trucks.values()))
    crates[0].load_failed = True
    crates[1].unload_failed = crates[2].unload_failed = True
    truck.depart_failed = truck.arrive_failed = True
    truck.failed_locations = {3, 7, 9}
    report = await check(clock, metrics, m)
    assert report.verdict == "Fail"
    assert texts(report) == [
        f"Loading failed for 1 container: {crates[0].name}.",
        f"Unloading failed for 2 containers: {crates[1].name} and {crates[2].name}.",
        f"Departure failed for 1 truck: {truck.name}.",
        f"3 truck location updates failed for {truck.name}.",
        f"Arrival failed for 1 truck: {truck.name}.",
    ]


async def test_failed_location_updates_on_several_trucks_are_one_finding(fake, clock, metrics,
                                                                         move):
    m = await move()
    truck = next(iter(m.state.trucks.values()))
    truck.failed_locations = {1}
    m.state.trucks["t-extra"] = replace(truck, id="t-extra", name="Truck 9",
                                        failed_locations={4, 5})
    report = await check(clock, metrics, m)
    assert f"3 truck location updates failed for 2 trucks: {truck.name} (1) and Truck 9 (2)." \
        in texts(report, "fail")


async def test_failed_calls_and_truck_updates_are_reported(fake, clock, metrics, move):
    m = await move()
    metrics.record("enroll", 12.0, False)
    metrics.record("heartbeat", 3.0, False)         # background: does not count
    metrics.count("locations_retried", 2)
    m.state.trucks[next(iter(m.state.trucks))].updates_skipped = 4
    report = await check(clock, metrics, m)
    assert report.verdict == "Fail"
    assert report.findings == [
        Finding("fail", "1 call failed for good (see the call table)."),
        Finding("warn", "Truck location updates: 4 skipped while the runner was down, "
                        "2 retried (each may have left a duplicate point).")]


async def test_stopped_early_expects_only_finished_stages(fake, clock, metrics, move):
    m = await move(limit=40)
    done = [s.done for s in m.state.servers.values()]
    assert any("complete" not in d for d in done)    # stopped part-way
    assert any(d for d in done)
    report = await check(clock, metrics, m, stopped_early=True)
    assert report.verdict == "Fail"
    assert report.findings == [Finding("fail", STOPPED)]
    assert report.scans_sent == sum(len(d) for d in done) == report.scans_processed


async def test_failed_reads_are_findings_not_crashes(fake, clock, metrics, move, monkeypatch):
    m = await move()

    async def broken(move_id):
        raise KeyError("asset")

    monkeypatch.setattr(m.portal, "roster", broken)
    fake.fail("GET", r"/trucks", status=500, times=1000)
    sid = next(iter(m.state.servers))
    fake.fail("GET", rf"/scans/asset/{sid}", status=500, times=1000)
    report = await check(clock, metrics, m)
    assert report.verdict == "Fail"
    serial = m.state.servers[sid].serial
    assert texts(report) == [
        (f"Could not read the scan history of 1 server (SN {serial}), so its scans were not "
         "checked."),
        "Could not read the move's roster, so the tag and move status checks were not done.",
        "Could not read the containers, so the container check was not done.",
        "Could not read the trucks, so the truck check was not done."]
    assert report.scans_sent == SERVER_SCANS - 10
    assert report.scans_processed == SERVER_SCANS - 10


async def test_a_malformed_history_row_is_an_unread_history(fake, clock, metrics, move,
                                                             monkeypatch):
    m = await move()
    sid = next(iter(m.state.servers))
    real = m.portal.asset_scans

    async def odd(asset_id):
        rows = await real(asset_id)
        if asset_id != sid:
            return rows
        naive = rows[0].scanned_at.replace(tzinfo=None)    # cannot be subtracted
        return [AssetScan(rows[0].status, naive, rows[0].processed_at, rows[0].device_id)]

    monkeypatch.setattr(m.portal, "asset_scans", odd)
    report = await check(clock, metrics, m)
    assert texts(report) == [
        (f"Could not read the scan history of 1 server (SN {m.state.servers[sid].serial}), "
         "so its scans were not checked.")]
    assert report.scans_sent == SERVER_SCANS - 10


async def test_stopped_early_scan_not_processed_yet_is_worded_as_such(fake, clock, metrics, move):
    m = await move(limit=40)
    serial = min(s.serial for s in m.state.servers.values() if s.done.get("enroll"))
    sid = server_by_serial(m, serial)
    fake.processed_scans[:] = [p for p in fake.processed_scans
                               if not (p["asset_id"] == sid and p["status"] == "pre_stage")]
    report = await check(clock, metrics, m, stopped_early=True)
    assert report.verdict == "Fail"
    assert report.scans_missing == 1
    assert texts(report) == [
        STOPPED,
        (f"1 scan had not been processed yet when the run was stopped: RFID enroll "
         f"(pre_stage) for SN {serial}.")]


async def test_containers_and_trucks_gone_from_the_move_fail(fake, clock, metrics, move):
    m = await move()
    cid = max(m.state.containers, key=lambda c: m.state.containers[c].name)
    fake.containers[cid]["archived_at"] = fake._iso(clock.now())
    tid = next(iter(m.state.trucks))
    fake.trucks[tid]["initiative_id"] = "another-move"
    report = await check(clock, metrics, m)
    assert report.verdict == "Fail"
    assert texts(report) == [
        (f"1 container the run used is no longer on the move (or was archived): "
         f"{m.state.containers[cid].name}."),
        f"1 truck the run used is no longer on the move: {m.state.trucks[tid].name}."]


async def test_servers_that_never_reached_a_stage_fail(fake, clock, metrics, move):
    m = await move()
    serials = first_serials(m, 2)
    for serial in serials:
        done = m.state.servers[server_by_serial(m, serial)].done
        for key in ("unpack", "staging", "into_cage", "qa", "complete"):
            del done[key]
    report = await check(clock, metrics, m)
    assert report.verdict == "Fail"
    assert report.scans_sent == SERVER_SCANS - 10
    assert report.scans_twice == 0                  # rows for stages not expected
    assert texts(report) == [
        f"2 servers never reached Unpack containers: SN {serials[0]} and SN {serials[1]}."]


async def test_two_stages_sharing_a_checkpoint_count_once_each(fake, clock, metrics, move):
    m = await move()
    stages = tuple(replace(s, checkpoint="qa") if s.key == "staging" else s
                   for s in m.profile.stages)
    shared = replace(m.profile, stages=stages)
    report = await check(clock, metrics, m, profile=shared)
    assert report.scans_sent == SERVER_SCANS
    assert report.scans_missing == SERVERS           # one qa row each, two expected
    assert report.scans_processed == SERVER_SCANS - SERVERS
    assert texts(report) == [
        (f"{SERVERS} scans were never processed by the BaseCamp server: RFID 3 – Staging or "
         f"QA (qa) for SN {first_serials(m, 3)[0]}, SN {first_serials(m, 3)[1]}, "
         f"SN {first_serials(m, 3)[2]} and {SERVERS - 3} more.")]
    for p in [p for p in fake.processed_scans if p["status"] == "qa"]:
        fake.processed_scans.append({**p, "id": p["id"] + 100_000})
    report = await check(clock, metrics, m, profile=shared)
    assert report.verdict == "Pass", report.findings
    assert (report.scans_missing, report.scans_twice) == (0, 0)


async def test_extra_findings_count_toward_the_verdict(fake, clock, metrics, move):
    m = await move()
    extra = [Finding("warn", "The wait for the server to catch up was ended early.")]
    report = await clock.run(final_check(
        portal=m.portal, state=m.state, profile=m.profile, metrics=metrics,
        rule_checkpoints=m.rules, stopped_early=False, extra_findings=extra))
    assert report.verdict == "Pass with warnings"
    assert report.findings == extra


async def test_a_server_clock_behind_the_runner_is_allowed_for(fake, clock, metrics, move):
    """Enroll, pack and unpack rows carry the server's clock, the other scans this
    machine's; processed_at is always the server's. With the measured difference the
    history filter keeps every row and no scan delay is negative."""
    from conftest import Skewed
    fake.clock = Skewed(clock, 120)
    m = await move()
    unmeasured = await check(clock, metrics, m)
    assert unmeasured.verdict == "Fail" and unmeasured.scans_missing > 0
    m.state.clock_offset = -120.0
    report = await check(clock, metrics, m)
    assert report.verdict == "Pass", report.findings
    assert report.scans_processed == SERVER_SCANS
    assert 0 < report.delay_ms["median"] <= report.delay_ms["max"]
    assert report.delay_ms["median"] < unmeasured.delay_ms["median"] + 120_000


async def test_scan_delay_is_never_negative(fake, clock, metrics, move):
    """A measured difference a little larger than the real one must not show a negative
    delay: each corrected delay stops at zero."""
    from conftest import Skewed
    fake.clock = Skewed(clock, 30)
    m = await move()
    m.state.clock_offset = -40.0
    report = await check(clock, metrics, m)
    assert report.delay_ms["median"] >= 0 and report.delay_ms["p95"] >= 0


async def test_problems_the_tool_counted_are_findings(fake, clock, metrics, move):
    m = await move()
    metrics.count("action_errors", 2)
    metrics.count("heartbeat_errors")
    metrics.count("scans_not_sent", 10)
    report = await clock.run(final_check(
        portal=m.portal, state=m.state, profile=m.profile, metrics=metrics,
        rule_checkpoints=m.rules, stopped_early=False, feed_write_errors=3))
    assert report.verdict == "Fail"
    assert report.findings == [
        Finding("fail", "2 steps got an answer this tool does not understand."),
        Finding("fail", "10 scans were not sent because a station had no key."),
        Finding("warn", "1 heartbeat got an answer this tool does not understand."),
        Finding("warn", "3 feed lines could not be written to events.log."),
    ]


async def test_rejected_scans_are_named_only_when_no_failed_step_says_so(fake, clock,
                                                                        metrics, move):
    m = await move()
    metrics.count("scans_rejected")
    report = await check(clock, metrics, m)
    assert texts(report) == ["1 scan was rejected by the server in an accepted batch."]
    assert report.verdict == "Pass with warnings"
    sid = server_by_serial(m, first_serials(m, 1)[0])
    m.state.servers[sid].done["label"] = False       # the step its rejected scan was in
    report = await check(clock, metrics, m)
    assert not any("rejected" in t for t in texts(report))
