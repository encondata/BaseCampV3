from loadtest.throughput import current, intervals, scans_taken, summary


def pt(at, calls, scans, waiting):
    return [at, {"calls": calls, "scans": scans, "waiting": waiting}]


def test_scans_taken_is_sent_less_rejected():
    assert scans_taken({"scans_sent": 10, "scans_rejected": 3}) == 7
    assert scans_taken({}) == 0


def test_processed_is_sent_less_the_waiting_growth():
    points = [pt(0, 0, 0, 0), pt(10, 100, 300, 200)]
    assert current(points, 10) == {"calls": 10.0, "scans_sent": 30.0, "scans_processed": 10.0}


def test_current_uses_the_newest_reading_a_window_back():
    # catch-up readings come every second; the rate still spans a whole window
    points = [pt(0, 0, 0, 0), pt(10, 10, 0, 100)] + [pt(10 + i, 10 + i, 0, 100 - 5 * i)
                                                    for i in range(1, 11)]
    assert current(points, 10) == {"calls": 1.0, "scans_sent": 0.0, "scans_processed": 5.0}


def test_current_is_none_until_a_window_has_passed_or_after_a_pause():
    assert current([], 10) is None
    assert current([pt(0, 0, 0, 0), pt(5, 5, 5, 0)], 10) is None
    assert current([pt(0, 0, 0, 0), pt(100, 5, 5, 0)], 10) is None   # stopped, continued


def test_rates_never_go_below_zero():
    # the waiting count can drop by more than was sent (a reading that lagged)
    points = [pt(0, 0, 0, 0), pt(10, 10, 10, 200), pt(20, 20, 10, 0)]
    spans = intervals(points, 10)
    assert spans[0]["scans_processed"] == 0.0
    assert spans[1]["scans_processed"] == 20.0


def test_summary_averages_by_time_and_leaves_pauses_out():
    points = [pt(0, 0, 0, 0), pt(10, 100, 100, 0), pt(20, 300, 300, 0),
              pt(1000, 300, 300, 0),                  # a pause: stopped, then continued
              pt(1010, 400, 400, 0)]
    out = summary(points, 10)
    assert out["calls"] == {"average": 13.3, "peak": 20.0}
    assert out["scans_sent"] == {"average": 13.3, "peak": 20.0}
    assert out["scans_processed"] == {"average": 13.3, "peak": 20.0}


def test_summary_of_nothing_is_none():
    assert summary([], 10)["calls"] == {"average": None, "peak": None}
    assert summary([pt(0, 0, 0, 0)], 10)["scans_processed"] == {"average": None, "peak": None}


def test_a_malformed_reading_is_skipped():
    points = [pt(0, 0, 0, 0), [10, {"calls": 1}], pt(20, 20, 20, 0)]
    assert summary(points, 10)["calls"]["average"] is not None
