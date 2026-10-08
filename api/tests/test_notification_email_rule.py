"""The email send-time rule is pure: no database, fixed aware instants."""

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from serversherpa.notifications.email_rule import allowed_at, email_send_time

NY = ZoneInfo("America/New_York")
ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"]


def make(**over):
    base = {
        "channels": ["inbox", "email"],
        "quiet_start": None,
        "quiet_end": None,
        "timezone": "America/New_York",
        "active_days": ALL_DAYS,
        "dnd_behavior": "defer",
        "urgent_bypass": False,
    }
    base.update(over)
    return base


def ny(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=NY)


# 2026-10-05 is a Monday; 2026-10-09 Friday; 2026-10-10 Saturday.
NIGHT = {"quiet_start": time(22, 0), "quiet_end": time(7, 0)}


def test_empty_list_is_none():
    assert email_send_time([], ny(2026, 10, 5, 12), urgent=False) is None


def test_group_without_email_channel_is_none():
    s = make(channels=["inbox"])
    assert email_send_time([s], ny(2026, 10, 5, 12), urgent=False) is None


def test_no_quiet_hours_all_days_is_now():
    now = ny(2026, 10, 5, 12)
    got = email_send_time([make()], now, urgent=False)
    assert got == now
    assert got.utcoffset() == timedelta(0)


def test_overnight_defer_goes_to_next_morning():
    s = make(**NIGHT)
    got = email_send_time([s], ny(2026, 10, 5, 23, 30), urgent=False)
    assert got == ny(2026, 10, 6, 7, 0)
    assert got.tzinfo is UTC


def test_overnight_skip_is_none():
    s = make(dnd_behavior="skip", **NIGHT)
    assert email_send_time([s], ny(2026, 10, 5, 23, 30), urgent=False) is None


def test_outside_quiet_hours_is_now():
    now = ny(2026, 10, 5, 12)
    assert email_send_time([make(**NIGHT)], now, urgent=False) == now


def test_after_midnight_inside_window_defers_same_day():
    got = email_send_time([make(**NIGHT)], ny(2026, 10, 6, 3, 0), urgent=False)
    assert got == ny(2026, 10, 6, 7, 0)


def test_boundaries():
    s = make(**NIGHT)
    assert (email_send_time([s], ny(2026, 10, 6, 6, 59), urgent=False)
            == ny(2026, 10, 6, 7, 0))
    now = ny(2026, 10, 6, 7, 0)
    assert email_send_time([s], now, urgent=False) == now
    # exactly at quiet_start is quiet
    assert (email_send_time([s], ny(2026, 10, 5, 22, 0), urgent=False)
            == ny(2026, 10, 6, 7, 0))


def test_daytime_window_not_overnight():
    s = make(quiet_start=time(9), quiet_end=time(17))
    assert (email_send_time([s], ny(2026, 10, 5, 10), urgent=False)
            == ny(2026, 10, 5, 17))
    now = ny(2026, 10, 5, 8)
    assert email_send_time([s], now, urgent=False) == now


def test_equal_start_end_means_no_quiet_hours():
    s = make(quiet_start=time(22), quiet_end=time(22))
    now = ny(2026, 10, 5, 22, 0)
    assert email_send_time([s], now, urgent=False) == now


def test_one_sided_quiet_means_no_quiet_hours():
    now = ny(2026, 10, 5, 23)
    assert email_send_time([make(quiet_start=time(22))], now, urgent=False) == now
    assert email_send_time([make(quiet_end=time(7))], now, urgent=False) == now


def test_inactive_day_defers_to_next_active_midnight():
    s = make(active_days=WEEKDAYS)
    got = email_send_time([s], ny(2026, 10, 10, 10), urgent=False)
    assert got == ny(2026, 10, 12, 0, 0)


def test_inactive_day_skip_is_none():
    s = make(active_days=WEEKDAYS, dnd_behavior="skip")
    assert email_send_time([s], ny(2026, 10, 10, 10), urgent=False) is None


def test_inactive_day_plus_quiet_hours():
    s = make(active_days=WEEKDAYS, **NIGHT)
    got = email_send_time([s], ny(2026, 10, 9, 23, 0), urgent=False)
    assert got == ny(2026, 10, 12, 7, 0)


def test_quiet_end_on_inactive_day_carries_on():
    # Friday 23:00 quiet ends Saturday 07:00 (inactive), so Monday 07:00.
    # Active Sat-only would end Saturday; here Sunday is also inactive.
    s = make(active_days=["mon", "tue", "wed", "thu", "fri"], **NIGHT)
    got = email_send_time([s], ny(2026, 10, 10, 2, 0), urgent=False)
    assert got == ny(2026, 10, 12, 7, 0)


def test_urgent_bypass():
    now = ny(2026, 10, 5, 23, 30)
    on = make(urgent_bypass=True, **NIGHT)
    off = make(urgent_bypass=False, **NIGHT)
    assert email_send_time([on], now, urgent=True) == now
    assert email_send_time([off], now, urgent=True) == ny(2026, 10, 6, 7)
    assert email_send_time([on], now, urgent=False) == ny(2026, 10, 6, 7)


def test_urgent_bypass_also_beats_inactive_day_and_skip():
    s = make(active_days=WEEKDAYS, dnd_behavior="skip", urgent_bypass=True)
    now = ny(2026, 10, 10, 10)
    assert email_send_time([s], now, urgent=True) == now


def test_two_groups_earliest_wins():
    now = ny(2026, 10, 5, 23, 30)
    later = make(**NIGHT)
    open_now = make()
    assert email_send_time([later, open_now], now, urgent=False) == now
    earlier = make(quiet_start=time(22), quiet_end=time(6))
    assert (email_send_time([later, earlier], now, urgent=False)
            == ny(2026, 10, 6, 6))


def test_skip_group_ignored_when_another_defers():
    now = ny(2026, 10, 5, 23, 30)
    skip = make(dnd_behavior="skip", **NIGHT)
    defer = make(**NIGHT)
    assert email_send_time([skip, defer], now, urgent=False) == ny(2026, 10, 6, 7)


def test_non_email_group_ignored_among_others():
    now = ny(2026, 10, 5, 23, 30)
    inbox_only = make(channels=["inbox"])
    defer = make(**NIGHT)
    assert email_send_time([inbox_only, defer], now, urgent=False) == ny(2026, 10, 6, 7)


def test_timezone_matters():
    now = datetime(2026, 10, 6, 6, 30, tzinfo=UTC)
    london = make(timezone="Europe/London", **NIGHT)   # 07:30 local: allowed
    la = make(timezone="America/Los_Angeles", **NIGHT)  # 23:30 local: quiet
    assert email_send_time([london], now, urgent=False) == now
    assert (email_send_time([la], now, urgent=False)
            == datetime(2026, 10, 6, 7, 0, tzinfo=ZoneInfo("America/Los_Angeles")))


def test_now_in_other_zone_is_accepted():
    now = datetime(2026, 10, 6, 3, 30, tzinfo=UTC)  # 23:30 NY
    got = email_send_time([make(**NIGHT)], now, urgent=False)
    assert got == datetime(2026, 10, 6, 11, 0, tzinfo=UTC)


def test_naive_now_rejected():
    with pytest.raises(ValueError):
        email_send_time([make()], datetime(2026, 10, 5, 12), urgent=False)  # noqa: DTZ001
    with pytest.raises(ValueError):
        allowed_at(make(), datetime(2026, 10, 5, 12), urgent=False)  # noqa: DTZ001
    with pytest.raises(ValueError):
        email_send_time([], datetime(2026, 10, 5, 12), urgent=False)  # noqa: DTZ001


def test_nothing_allowed_within_eight_days_is_none():
    s = make(active_days=[])
    assert email_send_time([s], ny(2026, 10, 5, 12), urgent=False) is None


def test_dst_spring_forward_window():
    # 2026-03-08 02:00 NY does not exist; quiet 01:00-03:00 ends in the gap.
    s = make(quiet_start=time(1), quiet_end=time(3))
    got = email_send_time([s], ny(2026, 3, 8, 1, 30), urgent=False)
    assert got is not None
    assert got.astimezone(NY).time() >= time(3, 0)
    assert got - ny(2026, 3, 8, 1, 30).astimezone(UTC) <= timedelta(hours=2)


def test_dst_fall_back_second_pass_ends_the_same_day():
    # 2026-11-01 01:00-02:00 NY happens twice. Quiet 00:00-01:30; now is
    # 01:10 in the second pass (EST, fold=1). The quiet end 01:30 EST is
    # 20 minutes away, not a day later.
    s = make(quiet_start=time(0), quiet_end=time(1, 30))
    now = datetime(2026, 11, 1, 1, 10, tzinfo=NY, fold=1)
    assert now.utcoffset() == timedelta(hours=-5)
    got = email_send_time([s], now, urgent=False)
    # (compare in UTC: same-zone aware datetimes compare by wall time)
    assert got == datetime(2026, 11, 1, 6, 30, tzinfo=UTC)
    local = got.astimezone(NY)
    assert (local.date().isoformat(), local.time()) == ("2026-11-01", time(1, 30))


def test_dst_fall_back_first_pass_waits_for_the_first_quiet_end():
    # The first pass (EDT, fold=0) ends quiet at 01:30 EDT, as before.
    s = make(quiet_start=time(0), quiet_end=time(1, 30))
    now = datetime(2026, 11, 1, 1, 10, tzinfo=NY, fold=0)
    got = email_send_time([s], now, urgent=False)
    assert got == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)


def test_dst_spring_forward_quiet_end_in_the_gap_opens_at_the_gap_end():
    # Current, accepted behavior: quiet 01:00-02:30 ends at 02:30, which
    # does not exist on 2026-03-08. Zoneinfo reads that wall time with the
    # pre-transition offset (EST), i.e. 07:30 UTC = 03:30 EDT, so the
    # email goes out at 03:30 EDT: after the gap, never earlier.
    s = make(quiet_start=time(1), quiet_end=time(2, 30))
    got = email_send_time([s], ny(2026, 3, 8, 1, 30), urgent=False)
    assert got == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    assert got.astimezone(NY).time() == time(3, 30)


def test_allowed_at_directly():
    now = ny(2026, 10, 5, 12)
    assert allowed_at(make(), now, urgent=False) == now
