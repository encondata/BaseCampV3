import json

from loadtest import metrics as metrics_mod
from loadtest.metrics import DEFAULT_BACKGROUND, METRICS_NAME, Metrics


def test_percentiles_use_linear_interpolation():
    m = Metrics()
    for ms in range(1, 101):
        m.record("scan", float(ms), True)
    row = m.calls()["scan"]
    assert row["count"] == 100
    assert row["median_ms"] == 50.5
    assert abs(row["p95_ms"] - 95.05) <= 0.1
    assert row["max_ms"] == 100


def test_single_sample_is_every_statistic():
    m = Metrics()
    m.record("pack", 12.34, True)
    row = m.calls()["pack"]
    assert (row["median_ms"], row["p95_ms"], row["max_ms"]) == (12.3, 12.3, 12.3)


def test_counts_retries_and_failures_per_logical_call():
    m = Metrics()
    m.record("pack", 10, True, retries=2)
    m.record("pack", 20, False, retries=4)
    m.record("pack", 30, True)
    row = m.calls()["pack"]
    assert (row["count"], row["retries"], row["failures"]) == (3, 6, 1)


def test_failed_calls_skips_background_calls_but_calls_lists_them():
    m = Metrics()
    m.record("pack", 1, False)
    m.record("heartbeat", 1, False)
    m.record("db-health", 1, False)
    assert m.failed_calls() == 1
    assert m.calls()["heartbeat"]["failures"] == 1
    assert "heartbeat" in DEFAULT_BACKGROUND


def test_a_failed_refresh_is_not_a_failed_call():
    # a failed refresh always leads to a new sign-in; only that sign-in failing is final.
    # On the real server a refresh that met the end of its sign-in failed a whole run.
    m = Metrics()
    m.record("refresh", 1, False)
    m.record("portal-refresh", 1, False)
    assert m.failed_calls() == 0
    assert m.calls()["refresh"]["failures"] == 1


def test_custom_background_set():
    m = Metrics(background=frozenset({"pack"}))
    m.record("pack", 1, False)
    m.record("heartbeat", 1, False)
    assert m.failed_calls() == 1


def test_counters_and_series_are_sorted_plain_json():
    m = Metrics()
    m.count("zeta")
    m.count("alpha", 3)
    m.count("alpha")
    m.sample("backlog", 100.0, 5)
    m.sample("backlog", 160.0, {"a": 1})
    m.record("zz", 1, True)
    m.record("aa", 1, True)
    assert list(m.counters()) == ["alpha", "zeta"]
    assert m.counters()["alpha"] == 4
    assert m.series() == {"backlog": [[100.0, 5], [160.0, {"a": 1}]]}
    assert list(m.calls()) == ["aa", "zz"]
    json.dumps([m.calls(), m.counters(), m.series()])


def test_sample_keeps_a_copy_of_a_dict_value():
    m = Metrics()
    value = {"a": {"n": 1}}
    m.sample("backlog", 1.0, value)
    value["a"]["n"] = 99
    value["b"] = 2
    assert m.series()["backlog"] == [[1.0, {"a": {"n": 1}}]]


def test_untimed_failure_counts_without_a_latency_sample():
    m = Metrics()
    m.record("scans", 40, True)
    m.record("scans", None, False)
    row = m.calls()["scans"]
    assert (row["count"], row["failures"]) == (2, 1)
    assert (row["median_ms"], row["p95_ms"], row["max_ms"]) == (40.0, 40.0, 40.0)
    m.record("enroll", None, False)
    row = m.calls()["enroll"]
    assert (row["count"], row["failures"]) == (1, 1)
    assert (row["median_ms"], row["p95_ms"], row["max_ms"]) == (None, None, None)
    assert m.failed_calls() == 2


# ── the run folder's metrics.jsonl ─────────────────────────────────────


def fill(m: Metrics) -> None:
    m.record("pack", 12.5, True, retries=1)
    m.record("truck-location", None, False)
    m.count("locations_retried", 2)
    m.sample("waiting", 100.0, 7)
    m.sample("db_health", 101.0, {"latency_ms": 1.5, "groups": [{"n": 1}]})
    m.flag("db_health", "sampled")


def same(a: Metrics, b: Metrics) -> None:
    assert (a.calls(), a.counters(), a.series(), a.flags(), a.failed_calls()) == (
        b.calls(), b.counters(), b.series(), b.flags(), b.failed_calls())


def test_a_reopened_log_gives_back_every_statistic(tmp_path):
    path = tmp_path / METRICS_NAME
    first = Metrics()
    first.open_log(path)
    fill(first)
    first.close_log()
    again = Metrics()
    again.open_log(path)
    same(again, first)
    assert again.flags() == {"db_health": "sampled"}
    again.record("pack", 20.0, True)            # later records add to the replayed ones
    again.close_log()
    third = Metrics()
    third.open_log(path)
    assert third.calls()["pack"]["count"] == 2
    third.close_log()


def test_every_record_is_flushed_as_it_is_written(tmp_path):
    """A copy of the folder taken at any instant (a kill -9) holds every record so far."""
    path = tmp_path / METRICS_NAME
    m = Metrics()
    m.open_log(path)
    fill(m)
    lines = path.read_text().splitlines()
    assert len(lines) == 6 and all(json.loads(line)["k"] for line in lines)
    m.close_log()


def test_a_torn_last_line_is_ignored_and_repaired(tmp_path):
    path = tmp_path / METRICS_NAME
    m = Metrics()
    m.open_log(path)
    fill(m)
    m.close_log()
    with open(path, "ab") as fh:
        fh.write(b'{"k":"r","c":"pack","ms":1')
    again = Metrics()
    again.open_log(path)
    same(again, m)
    again.count("scans_retried")                 # not glued onto the torn line
    again.close_log()
    third = Metrics()
    third.open_log(path)
    assert third.counters()["scans_retried"] == 1
    third.close_log()


def test_fsync_is_throttled_and_close_syncs(tmp_path, monkeypatch):
    synced = []
    monkeypatch.setattr(metrics_mod.os, "fsync", lambda fd: synced.append(fd))
    m = Metrics()
    m.open_log(tmp_path / METRICS_NAME)
    for i in range(50):
        m.record("pack", 1.0, True)
    assert len(synced) <= 1
    m.close_log()
    assert len(synced) >= 1
    m.record("pack", 1.0, True)                  # after close: kept in memory only
    assert m.calls()["pack"]["count"] == 51


def test_without_a_log_nothing_is_written(tmp_path):
    m = Metrics()
    fill(m)
    m.close_log()
    assert list(tmp_path.iterdir()) == []
