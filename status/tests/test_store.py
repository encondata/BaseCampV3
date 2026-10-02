from datetime import UTC, date, datetime, timedelta

import pytest

from serversherpa_status.store import DayBar, Store, uptime_percent

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "nested" / "status.db"))
    yield s
    s.close()


def test_creates_parent_dir_and_records(store, tmp_path):
    store.record("api", NOW, True, 42, "")
    assert (tmp_path / "nested" / "status.db").exists()
    rows = store.recent("api", 5)
    assert len(rows) == 1
    assert (rows[0].at, rows[0].ok, rows[0].latency_ms) == (NOW, True, 42)


def test_recent_is_oldest_first_and_limited(store):
    for n in range(5):
        store.record("api", NOW + timedelta(minutes=n), n % 2 == 0, n, "")
    rows = store.recent("api", 2)
    assert [r.at for r in rows] == [NOW + timedelta(minutes=3), NOW + timedelta(minutes=4)]
    assert [r.ok for r in rows] == [False, True]


def test_recent_is_per_service(store):
    store.record("api", NOW, True, 1, "")
    assert store.recent("kiosk", 5) == []


def test_daily_rollup_counts(store):
    store.record("api", NOW, True, 1, "")
    store.record("api", NOW + timedelta(minutes=1), False, None, "timeout")
    store.record("api", NOW + timedelta(minutes=2), True, 1, "")
    bars = store.daily("api", NOW.date(), 90)
    assert len(bars) == 90
    assert bars[-1] == DayBar("2026-09-23", 2, 3)
    assert bars[0] == DayBar("2026-06-26", None, None)


def test_daily_uses_utc_day(store):
    from datetime import timezone
    est = timezone(timedelta(hours=-5))
    # 22:00 EST on the 22nd is 03:00 UTC on the 23rd
    store.record("api", datetime(2026, 9, 22, 22, 0, tzinfo=est), True, 1, "")
    assert store.daily("api", date(2026, 9, 23), 2)[-1] == DayBar("2026-09-23", 1, 1)


def test_naive_datetime_rejected(store):
    with pytest.raises(ValueError):
        store.record("api", datetime(2026, 9, 23, 12, 0), True, 1, "")


def test_prune_drops_old_raw_and_old_days(store):
    store.record("api", NOW - timedelta(days=8), True, 1, "")
    store.record("api", NOW - timedelta(days=6), True, 1, "")
    store.record("api", NOW - timedelta(days=95), True, 1, "")
    store.prune(NOW)
    assert [r.at for r in store.recent("api", 10)] == [NOW - timedelta(days=6)]
    # the 8-day-old day survives in the rollup (inside 90 days); the 95-day-old one is gone
    bars = {b.day: b for b in store.daily("api", NOW.date(), 90) if b.total}
    assert set(bars) == {"2026-09-15", "2026-09-17"}
    import sqlite3
    conn = sqlite3.connect(store.path)
    assert conn.execute("SELECT COUNT(*) FROM daily").fetchone()[0] == 2
    conn.close()


def test_prune_keeps_exactly_90_days(store):
    store.record("api", NOW - timedelta(days=89), True, 1, "")
    store.record("api", NOW - timedelta(days=90), True, 1, "")
    store.prune(NOW)
    days = [b.day for b in store.daily("api", NOW.date(), 90) if b.total]
    assert days == ["2026-06-26"]


def test_survives_reopen(tmp_path):
    path = str(tmp_path / "s.db")
    s = Store(path)
    s.record("api", NOW, True, 1, "")
    s.close()
    s2 = Store(path)
    assert len(s2.recent("api", 5)) == 1
    s2.close()


def test_uptime_percent():
    assert uptime_percent([DayBar("a", None, None)]) is None
    assert uptime_percent([]) is None
    assert uptime_percent([DayBar("a", 3, 4), DayBar("b", None, None), DayBar("c", 4, 4)]) == 87.5
    assert uptime_percent([DayBar("a", 2, 3)]) == 66.6667
