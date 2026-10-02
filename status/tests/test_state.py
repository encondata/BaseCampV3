from datetime import UTC, datetime, timedelta

from serversherpa_status.state import StateTracker

T0 = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


def at(n):
    return T0 + timedelta(minutes=n)


def test_unknown_before_any_check():
    s = StateTracker(["api"], 2).snapshot("api")
    assert (s.state, s.last_checked_at, s.latency_ms) == ("unknown", None, None)


def test_first_success_is_up():
    t = StateTracker(["api"], 2)
    t.record("api", True, 40, at(0))
    assert t.snapshot("api").state == "up"
    assert t.snapshot("api").latency_ms == 40
    assert t.snapshot("api").last_checked_at == at(0)


def test_one_failure_keeps_up_two_flip_down():
    t = StateTracker(["api"], 2)
    t.record("api", True, 40, at(0))
    t.record("api", False, None, at(1))
    assert t.snapshot("api").state == "up"
    t.record("api", False, None, at(2))
    assert t.snapshot("api").state == "down"
    assert t.snapshot("api").last_checked_at == at(2)


def test_single_success_recovers():
    t = StateTracker(["api"], 2)
    for n in range(3):
        t.record("api", False, None, at(n))
    t.record("api", True, 55, at(3))
    assert t.snapshot("api").state == "up"


def test_failure_streak_resets_after_success():
    t = StateTracker(["api"], 2)
    t.record("api", False, None, at(0))
    t.record("api", True, 10, at(1))
    t.record("api", False, None, at(2))
    assert t.snapshot("api").state == "up"


def test_first_failure_from_unknown_stays_unknown():
    t = StateTracker(["api"], 2)
    t.record("api", False, None, at(0))
    assert t.snapshot("api").state == "unknown"
    t.record("api", False, None, at(1))
    assert t.snapshot("api").state == "down"


def test_threshold_one_flips_immediately():
    t = StateTracker(["api"], 1)
    t.record("api", False, None, at(0))
    assert t.snapshot("api").state == "down"


def test_services_are_independent():
    t = StateTracker(["api", "kiosk"], 2)
    t.record("api", True, 1, at(0))
    assert t.snapshot("kiosk").state == "unknown"
