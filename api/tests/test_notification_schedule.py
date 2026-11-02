"""A person's schedule decides when email reaches them. It is pure: no
database, fixed aware instants. The zone is America/Chicago, so the DST
dates below are real: clocks fall back on 2026-11-01 (07:00 UTC) and spring
forward on 2027-03-14 (08:00 UTC)."""

import logging
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from serversherpa.notifications.schedule import (
    DAYS,
    HoldDecision,
    Schedule,
    back_online_after,
    hold_decision,
    schedule_from_prefs,
    state_at,
    summary_at,
)

CHI = ZoneInfo("America/Chicago")
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"]
NIGHT = {"quiet_start": "21:00", "quiet_end": "06:00"}


def chi(y, m, d, hh=0, mm=0, *, fold=0):
    return datetime(y, m, d, hh, mm, tzinfo=CHI, fold=fold)


def make(**over):
    """A Chicago schedule that works every day with no quiet hours, unless
    the overrides say otherwise."""
    raw = {"timezone": "America/Chicago", "days": list(DAYS)}
    raw.update(over)
    return schedule_from_prefs(raw)


# 2026-10-21 is a Wednesday, 10-23 a Friday, 10-24 a Saturday, 10-25 a
# Sunday, 10-26 a Monday and 10-27 a Tuesday.


def test_days_run_monday_to_sunday():
    assert DAYS == ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def test_open_by_default():
    s = schedule_from_prefs(None)
    sat_3am = chi(2026, 10, 24, 3)
    assert state_at(s, sat_3am) == "open"
    assert hold_decision(s, sat_3am) == HoldDecision(False, None, None, False)


@pytest.mark.parametrize(
    "raw",
    [
        None,
        {},
        {"timezone": None, "days": None, "quiet_start": None, "quiet_end": None},
    ],
)
def test_nothing_set_is_the_reference_zone_all_days_no_quiet_hours(raw):
    s = schedule_from_prefs(raw)
    assert s.zone.key == "America/New_York"
    assert s.days == frozenset(DAYS)
    assert (s.quiet_start, s.quiet_end) == (None, None)


def test_overnight_quiet_hours():
    s = make(**NIGHT)
    assert state_at(s, chi(2026, 10, 21, 22)) == "quiet_hours"
    assert state_at(s, chi(2026, 10, 21, 5, 59)) == "quiet_hours"
    assert state_at(s, chi(2026, 10, 21, 6)) == "open"
    assert state_at(s, chi(2026, 10, 21, 20, 59)) == "open"
    assert state_at(s, chi(2026, 10, 21, 21)) == "quiet_hours"


def test_daytime_quiet_hours():
    s = make(quiet_start="09:00", quiet_end="17:00")
    assert state_at(s, chi(2026, 10, 21, 8, 59)) == "open"
    assert state_at(s, chi(2026, 10, 21, 9)) == "quiet_hours"
    assert state_at(s, chi(2026, 10, 21, 16, 59)) == "quiet_hours"
    assert state_at(s, chi(2026, 10, 21, 17)) == "open"
    assert back_online_after(s, chi(2026, 10, 21, 10)) == chi(2026, 10, 21, 17)


def test_day_off_wins():
    s = make(days=WEEKDAYS, **NIGHT)
    assert state_at(s, chi(2026, 10, 24, 10)) == "inactive_day"
    assert state_at(s, chi(2026, 10, 24, 23)) == "inactive_day"
    # inside Friday night's window, but it is Saturday now
    assert state_at(s, chi(2026, 10, 24, 3)) == "inactive_day"
    # and Monday's small hours are quiet hours, not a day off
    assert state_at(s, chi(2026, 10, 26, 3)) == "quiet_hours"


def test_the_schedule_zone_decides_the_local_clock():
    s = schedule_from_prefs({"timezone": "Europe/London", **NIGHT})
    # 04:00 UTC is 05:00 BST (still quiet); 05:00 UTC is 06:00 BST (open)
    assert state_at(s, datetime(2026, 10, 21, 4, 0, tzinfo=UTC)) == "quiet_hours"
    assert state_at(s, datetime(2026, 10, 21, 5, 0, tzinfo=UTC)) == "open"


def test_an_instant_in_another_zone_is_read_on_the_schedules_clock():
    s = make(**NIGHT)
    at = datetime(2026, 10, 22, 3, 30, tzinfo=UTC)  # 22:30 CDT on Wednesday
    assert state_at(s, at) == "quiet_hours"
    assert back_online_after(s, at) == datetime(2026, 10, 22, 11, 0, tzinfo=UTC)


def test_back_online_is_now_when_already_open():
    s = make(**NIGHT)
    now = chi(2026, 10, 21, 12)
    got = back_online_after(s, now)
    assert got == now
    assert got.tzinfo is UTC


def test_back_online_after_quiet_hours_and_days_off():
    s = make(days=WEEKDAYS, **NIGHT)
    assert back_online_after(s, chi(2026, 10, 23, 22)) == chi(2026, 10, 26, 6)
    # with no quiet hours it is 12:00 AM of the next day they work
    s = make(days=WEEKDAYS)
    assert back_online_after(s, chi(2026, 10, 24, 10)) == chi(2026, 10, 26, 0)


def test_summary_is_an_hour_before_back_online():
    s = make(**NIGHT)
    got = summary_at(s, chi(2026, 10, 21, 22))
    assert got == chi(2026, 10, 22, 5)
    assert got.tzinfo is UTC


def test_weekend_hold_summary_monday():
    s = make(days=WEEKDAYS, **NIGHT)
    d = hold_decision(s, chi(2026, 10, 23, 22))
    assert d.hold is True
    assert d.reason == "quiet_hours"
    assert d.summary_at == chi(2026, 10, 26, 5)
    assert d.summary_at.tzinfo is UTC
    assert d.after_summary is False


def test_days_off_without_quiet_hours():
    s = make(days=WEEKDAYS)
    d = hold_decision(s, chi(2026, 10, 24, 10))
    assert (d.hold, d.reason, d.after_summary) == (True, "inactive_day", False)
    assert d.summary_at == chi(2026, 10, 25, 23)


def test_daytime_quiet_hours_with_days_off():
    s = make(days=WEEKDAYS, quiet_start="01:00", quiet_end="06:00")
    sat = hold_decision(s, chi(2026, 10, 24, 10))
    assert (sat.hold, sat.reason) == (True, "inactive_day")
    assert sat.summary_at == chi(2026, 10, 25, 23)
    tue = hold_decision(s, chi(2026, 10, 27, 2))
    assert (tue.hold, tue.reason) == (True, "quiet_hours")
    assert tue.summary_at == chi(2026, 10, 27, 5)


def test_quiet_hours_starting_at_midnight_cover_midnight():
    # Monday opens already inside the window, so back online is 06:00.
    s = make(days=WEEKDAYS, quiet_start="00:00", quiet_end="06:00")
    d = hold_decision(s, chi(2026, 10, 24, 10))
    assert (d.hold, d.reason) == (True, "inactive_day")
    assert d.summary_at == chi(2026, 10, 26, 5)


def test_quiet_end_just_after_midnight_puts_the_summary_the_evening_before():
    s = make(days=WEEKDAYS, quiet_start="00:00", quiet_end="00:30")
    held = hold_decision(s, chi(2026, 10, 24, 10))
    assert held.hold is True
    assert held.summary_at == chi(2026, 10, 25, 23, 30)
    # past that summary but before back online at 00:30: send right away
    late = hold_decision(s, chi(2026, 10, 25, 23, 45))
    assert late == HoldDecision(False, "inactive_day", None, True)
    # the same on a day they work: Tuesday 00:10 is past Monday's 23:30
    tue = hold_decision(make(quiet_start="00:00", quiet_end="00:30"), chi(2026, 10, 27, 0, 10))
    assert tue == HoldDecision(False, "quiet_hours", None, True)


def test_last_hour_sends_now():
    s = make(**NIGHT)
    d = hold_decision(s, chi(2026, 10, 27, 5, 30))
    assert d.hold is False
    assert d.after_summary is True
    assert d.reason == "quiet_hours"
    assert d.summary_at is None


def test_the_summary_time_itself_is_already_too_late_to_hold():
    s = make(**NIGHT)
    before = hold_decision(s, chi(2026, 10, 27, 4, 59))
    assert (before.hold, before.after_summary) == (True, False)
    assert before.summary_at == chi(2026, 10, 27, 5)
    at = hold_decision(s, chi(2026, 10, 27, 5, 0))
    assert (at.hold, at.after_summary) == (False, True)


def test_open_is_never_held():
    s = make(days=WEEKDAYS, **NIGHT)
    assert hold_decision(s, chi(2026, 10, 26, 12)) == HoldDecision(False, None, None, False)


def test_one_working_day_waits_for_next_week():
    # Monday 22:00 to next Monday 06:00 is 6 days 8 hours and crosses the fall
    # back, which is inside the 8-day search horizon.
    s = make(days=["mon"], **NIGHT)
    now = chi(2026, 10, 26, 22)
    assert back_online_after(s, now) == chi(2026, 11, 2, 6)
    assert summary_at(s, now) == chi(2026, 11, 2, 5)


def test_nothing_open_within_the_horizon_is_never():
    # schedule_from_prefs never builds this (no days means all days), but a
    # hand-built schedule must still answer instead of looping.
    s = Schedule(CHI, frozenset(), None, None)
    now = chi(2026, 10, 21, 12)
    assert state_at(s, now) == "inactive_day"
    assert back_online_after(s, now) is None
    assert summary_at(s, now) is None
    assert hold_decision(s, now) == HoldDecision(False, None, None, False)


# ── DST: the local wall clock decides, not a fixed 24-hour day ──


def test_fall_back_keeps_local_wall_clock():
    s = make(**NIGHT)
    d = hold_decision(s, chi(2026, 10, 31, 22))  # CDT
    assert d.hold is True
    assert d.summary_at == datetime(2026, 11, 1, 11, 0, tzinfo=UTC)
    local = d.summary_at.astimezone(CHI)
    assert (local.hour, local.minute) == (5, 0)
    assert local.utcoffset() == timedelta(hours=-6)  # CST


def test_spring_forward_keeps_local_wall_clock():
    s = make(**NIGHT)
    d = hold_decision(s, chi(2027, 3, 13, 22))  # CST
    assert d.hold is True
    assert d.summary_at == datetime(2027, 3, 14, 10, 0, tzinfo=UTC)
    local = d.summary_at.astimezone(CHI)
    assert (local.hour, local.minute) == (5, 0)
    assert local.utcoffset() == timedelta(hours=-5)  # CDT


def test_fall_back_second_pass_ends_the_same_morning():
    # 01:00-02:00 happens twice on 2026-11-01. Quiet 00:00-01:30; now is 01:10
    # in the second pass (CST, fold=1). The quiet end, 01:30 CST, is 20
    # minutes away, not a day later.
    s = make(quiet_start="00:00", quiet_end="01:30")
    now = chi(2026, 11, 1, 1, 10, fold=1)
    assert now.utcoffset() == timedelta(hours=-6)
    # (compare in UTC: same-zone aware datetimes compare by wall time)
    assert back_online_after(s, now) == datetime(2026, 11, 1, 7, 30, tzinfo=UTC)


def test_fall_back_first_pass_ends_at_the_first_quiet_end():
    s = make(quiet_start="00:00", quiet_end="01:30")
    now = chi(2026, 11, 1, 1, 10, fold=0)
    assert now.utcoffset() == timedelta(hours=-5)
    assert back_online_after(s, now) == datetime(2026, 11, 1, 6, 30, tzinfo=UTC)


def test_spring_forward_quiet_end_in_the_gap_opens_after_the_gap():
    # 02:00-03:00 does not exist on 2027-03-14 (the gap ends at 08:00 UTC).
    # Quiet 01:00-02:30 ends inside it. zoneinfo reads 02:30 with the CST
    # offset, 08:30 UTC or 03:30 CDT, so back online is 03:30 CDT: after the
    # gap, never earlier. That is the rule the old group email rule had too.
    s = make(quiet_start="01:00", quiet_end="02:30")
    got = back_online_after(s, chi(2027, 3, 14, 1, 30))
    assert got == datetime(2027, 3, 14, 8, 30, tzinfo=UTC)
    assert got >= datetime(2027, 3, 14, 8, 0, tzinfo=UTC)
    assert state_at(s, got) == "open"


# ── reading the stored preference ──


def test_bad_zone_falls_back(caplog):
    with caplog.at_level(logging.WARNING, logger="serversherpa.notifications.schedule"):
        s = schedule_from_prefs({"timezone": "Not/AZone"})
    assert s.zone.key == "America/New_York"
    # the fallback is not silent: it changes when a person's email goes out
    assert "Not/AZone" in caplog.text


@pytest.mark.parametrize("name", ["../etc/passwd", "zone.tab", "America"])
def test_zone_names_zoneinfo_refuses_fall_back_too(name):
    # ZoneInfo raises a different error for each of these (ValueError for a
    # path outside the zone database or a file that is not a zone, and a
    # not-found error for a directory).
    assert schedule_from_prefs({"timezone": name}).zone.key == "America/New_York"


def test_a_good_zone_is_used():
    assert schedule_from_prefs({"timezone": "Europe/London"}).zone.key == "Europe/London"


@pytest.mark.parametrize("days", [[], ["someday"], None])
def test_empty_or_unknown_days_mean_all_days(days):
    assert schedule_from_prefs({"days": days}).days == frozenset(DAYS)


def test_known_days_are_kept():
    assert schedule_from_prefs({"days": ["sat", "mon"]}).days == frozenset({"mon", "sat"})
    # an unknown name is dropped; the rest still count
    assert schedule_from_prefs({"days": ["mon", "someday"]}).days == frozenset({"mon"})


def test_quiet_times_take_seconds():
    s = schedule_from_prefs({"quiet_start": "21:00:00", "quiet_end": "06:00"})
    assert (s.quiet_start, s.quiet_end) == (time(21, 0), time(6, 0))


def test_half_quiet_pair_is_ignored():
    for raw in ({"quiet_start": "21:00"}, {"quiet_end": "06:00"}):
        s = schedule_from_prefs(raw)
        assert (s.quiet_start, s.quiet_end) == (None, None)
    s = schedule_from_prefs({"timezone": "America/Chicago", "quiet_start": "21:00"})
    assert state_at(s, chi(2026, 10, 21, 23)) == "open"


def test_equal_quiet_times_are_ignored():
    s = schedule_from_prefs({"quiet_start": "21:00", "quiet_end": "21:00"})
    assert (s.quiet_start, s.quiet_end) == (None, None)
    # a schedule built by hand gets the same answer: never always-quiet
    hand = Schedule(CHI, frozenset(DAYS), time(21, 0), time(21, 0))
    assert state_at(hand, chi(2026, 10, 21, 22)) == "open"


@pytest.mark.parametrize("bad", ["late", "25:00", ""])
def test_unreadable_quiet_times_are_ignored(bad):
    s = schedule_from_prefs({"quiet_start": bad, "quiet_end": "06:00"})
    assert (s.quiet_start, s.quiet_end) == (None, None)


def test_naive_datetime_rejected():
    s = make(**NIGHT)
    naive = datetime(2026, 10, 21, 22)  # noqa: DTZ001
    for call in (state_at, back_online_after, summary_at, hold_decision):
        with pytest.raises(ValueError):
            call(s, naive)
