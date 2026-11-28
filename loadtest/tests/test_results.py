import json
from dataclasses import replace

import pytest
from pipeline_helpers import make_state, real_time
from test_finalcheck import CONTAINER_SCANS, SERVER_SCANS, check, move  # noqa: F401

from loadtest.finalcheck import FinalReport, Finding
from loadtest.metrics import Metrics
from loadtest.results import build_results, write_results

STARTED = 1_800_000_000.0
ENDED = STARTED + 3725.5


def report(**overrides) -> FinalReport:
    base = FinalReport(verdict="Pass with warnings",
                       findings=[Finding("warn", "1 scan was processed twice after a retry.")],
                       scans_sent=10, scans_processed=10, scans_twice=1, scans_missing=0,
                       container_scans_sent=2, container_scans_checked=False,
                       delay_ms={"median": 120.0, "p95": 900.5, "max": 1500.0})
    return replace(base, **overrides)


def metrics_with_samples() -> Metrics:
    m = Metrics()
    m.record("scan-batch", 40.0, True, retries=1)
    m.count("locations_retried")
    for at, n in ((STARTED, 0), (STARTED + 10, 37), (STARTED + 20, 12)):
        m.sample("waiting", at, n)
    return m


def build(state=None, **kw):
    profile = real_time()
    state = state or make_state(10, 1, 1, profile, started_at=STARTED)
    args = {"state": state, "profile": profile, "metrics": metrics_with_samples(),
            "report": report(), "catch_up_seconds": 42.0, "ended_at": ENDED,
            "reason": "completed"}
    args.update(kw)
    return build_results(**args)


def test_build_results_has_every_section():
    state = make_state(10, 1, 1, real_time(), started_at=STARTED)
    state.interruptions = [(STARTED + 60, STARTED + 120), (STARTED + 600, None)]
    out = build(state)
    assert set(out) == {"run", "verdict", "findings", "calls", "counters", "scans",
                        "scan_delay_ms", "backlog", "series", "db_health", "redactions",
                        "clock_offset_seconds", "feed_write_errors", "throughput"}
    assert out["feed_write_errors"] == 0
    assert out["clock_offset_seconds"] is None          # not measured
    run = out["run"]
    assert run["server_url"] == "http://localhost:8000"
    assert (run["move_id"], run["move_name"]) == ("move-1", "Load test move")
    assert (run["servers"], run["containers"], run["trucks"]) == (10, 1, 1)
    assert run["profile"] == "real-time" and run["profile_raw"] == real_time().raw
    assert run["started_at"] == "2027-01-15T08:00:00+00:00"
    assert run["ended_at"] == "2027-01-15T09:02:05.500000+00:00"
    assert run["reason"] == "completed"
    assert run["interruptions"] == [
        {"stopped_at": "2027-01-15T08:01:00+00:00", "resumed_at": "2027-01-15T08:02:00+00:00"},
        {"stopped_at": "2027-01-15T08:10:00+00:00", "resumed_at": None}]
    assert out["verdict"] == "Pass with warnings"
    assert out["findings"] == [{"level": "warn",
                                "text": "1 scan was processed twice after a retry."}]
    assert out["calls"]["scan-batch"]["retries"] == 1
    assert out["counters"] == {"locations_retried": 1}
    assert out["scans"] == {"sent": 10, "processed": 10, "processed_twice": 1,
                            "never_processed": 0, "container_scans_sent": 2,
                            "container_scans_checked": False}
    assert out["scan_delay_ms"] == {"median": 120.0, "p95": 900.5, "max": 1500.0}
    assert out["backlog"] == {"peak": 37, "catch_up_seconds": 42.0}
    assert out["series"]["waiting"][1] == [STARTED + 10, 37]
    assert out["db_health"] == "not_sampled" and out["redactions"] == 0
    assert build(db_health="not_available")["db_health"] == "not_available"


def test_results_hold_the_runs_throughput():
    metrics = Metrics()
    metrics.sample("throughput", 0, {"calls": 0, "scans": 0, "waiting": 0})
    metrics.sample("throughput", 10, {"calls": 100, "scans": 50, "waiting": 10})
    out = build(metrics=metrics)
    assert out["throughput"] == {"calls": {"average": 10.0, "peak": 10.0},
                                 "scans_sent": {"average": 5.0, "peak": 5.0},
                                 "scans_processed": {"average": 4.0, "peak": 4.0}}


def test_no_report_is_a_fail_with_the_reason():
    out = build(report=None, catch_up_seconds=None, reason="error: the server went away.")
    assert out["verdict"] == "Fail"
    assert out["findings"] == [{"level": "fail", "text": "The run ended before the final "
                                "check could run: error: the server went away."}]
    assert out["backlog"] == {"peak": 37, "catch_up_seconds": None}
    assert out["scans"]["sent"] is None


def test_secrets_are_removed_from_free_text_only():
    leak = report(findings=[Finding("fail", "login refused for move-pass-1 (move-pass-1)"),
                            Finding("warn", "nothing secret here")])
    out = build(report=leak, reason="stopped: move-pass-1 refused", secrets={"move-pass-1"})
    assert out["findings"][0]["text"] == "login refused for [removed] ([removed])"
    assert out["findings"][1]["text"] == "nothing secret here"
    assert out["run"]["reason"] == "stopped: [removed] refused"
    assert out["redactions"] == 3
    assert "move-pass-1" not in json.dumps(out)


def test_one_leaked_secret_counts_one_redaction():
    leak = report(findings=[Finding("fail", "refused move-pass-1")])
    out = build(report=leak, secrets={"move-pass-1"})
    assert out["findings"][0]["text"] == "refused [removed]"
    assert out["redactions"] == 1


def test_short_secrets_and_structured_values_are_left_alone():
    state = make_state(10, 1, 1, real_time(), started_at=STARTED)
    clean = build(state)
    for secrets in ({"2027"}, {"move-pass-1"}, {"2027-01-15T08", "08:00:00"}, {""}, set()):
        out = build(state, secrets=secrets)
        assert out["run"]["started_at"] == "2027-01-15T08:00:00+00:00"   # never altered
        assert out["series"] == clean["series"] and out["run"] == clean["run"]
    # a long secret that matches only structured values: nothing removed, nothing refused
    out = build(state, secrets={"2027-01-15T08"})
    assert out["redactions"] == 0 and out["findings"] == clean["findings"]


def test_write_results_is_pretty_sorted_json(tmp_path):
    out = build()
    path = write_results(tmp_path, out)
    assert path == tmp_path / "results.json"
    text = path.read_text(encoding="utf-8")
    assert json.loads(text) == out
    assert text.startswith('{\n  "backlog": {')
    assert [p.name for p in tmp_path.iterdir()] == ["results.json"]   # no temp file left
    out["verdict"] = "Fail"
    write_results(tmp_path, out)
    assert json.loads(path.read_text(encoding="utf-8"))["verdict"] == "Fail"
    with pytest.raises(ValueError):
        write_results(tmp_path, {**out, "bad": float("nan")})
    assert json.loads(path.read_text(encoding="utf-8"))["verdict"] == "Fail"


async def test_results_from_a_clean_run(fake, clock, metrics, move, tmp_path):  # noqa: F811
    m = await move()
    final = await check(clock, metrics, m)
    for secrets in ({"2027"}, {"move-pass-1"}, {"move-pass-1", "portal-pass-1"}):
        out = build_results(state=m.state, profile=m.profile, metrics=metrics, report=final,
                            catch_up_seconds=0.0, ended_at=clock.now(), reason="completed",
                            secrets=secrets)
        assert out["redactions"] == 0
        assert out["run"]["started_at"].startswith("2027-01-15T08:00:00")
        assert out["run"]["move_id"] == m.move_id
    assert out["verdict"] == "Pass"
    assert out["scans"]["sent"] == out["scans"]["processed"] == SERVER_SCANS
    assert out["scans"]["container_scans_sent"] == CONTAINER_SCANS
    write_results(tmp_path, out)
