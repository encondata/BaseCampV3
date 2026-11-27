import json

from loadtest.metrics import DEFAULT_BACKGROUND, Metrics


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
