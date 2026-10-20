"""timeclock.today_summary and timeclock.site_zone — the "You've been
working for 7h 24m today" line on the kiosk Time Clock's Clock Out
screen. Pure service tests with a pinned `now`, so local midnight is
never a moving target."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from serversherpa.db.models import Person, Site, TimeEntry
from serversherpa.services import timeclock

NY = ZoneInfo("America/New_York")
LA = ZoneInfo("America/Los_Angeles")


def _local(tz: ZoneInfo, day: int, hour: int, minute: int = 0) -> datetime:
    """A wall-clock time on 2026-10-`day` in `tz`, as an aware datetime."""
    return datetime(2026, 10, day, hour, minute, tzinfo=tz)


async def _person(db, first="Tara"):
    person = Person(first_name=first, last_name="Today")
    db.add(person)
    await db.flush()
    return person


async def _entry(db, person, clock_in_at, clock_out_at=None, break_minutes=0):
    entry = TimeEntry(person_id=person.id, clock_in_at=clock_in_at,
                      clock_out_at=clock_out_at, break_minutes=break_minutes,
                      status="open" if clock_out_at is None else "pending")
    db.add(entry)
    await db.flush()
    return entry


async def test_today_counts_open_entry_to_now(db):
    person = await _person(db)
    await _entry(db, person, _local(NY, 20, 8, 2))

    total, spans = await timeclock.today_summary(
        db, person.id, tz=NY, now=_local(NY, 20, 15, 26))
    assert total == 444            # 7h 24m
    assert len(spans) == 1
    assert spans[0].clock_in_at == _local(NY, 20, 8, 2)
    assert spans[0].clock_out_at is None
    assert spans[0].minutes == 444


async def test_today_clips_shift_from_yesterday(db):
    person = await _person(db)
    # break belongs to a shift that started yesterday: not subtracted today
    await _entry(db, person, _local(NY, 19, 22), _local(NY, 20, 2),
                 break_minutes=30)

    total, spans = await timeclock.today_summary(
        db, person.id, tz=NY, now=_local(NY, 20, 10))
    assert total == 120
    assert [s.minutes for s in spans] == [120]


async def test_today_subtracts_break_for_shift_started_today(db):
    person = await _person(db)
    await _entry(db, person, _local(NY, 20, 8), _local(NY, 20, 12),
                 break_minutes=30)

    total, spans = await timeclock.today_summary(
        db, person.id, tz=NY, now=_local(NY, 20, 15))
    assert total == 210
    assert [s.minutes for s in spans] == [210]


async def test_today_orders_spans_and_ignores_other_days_and_people(db):
    person = await _person(db)
    other = await _person(db, first="Otto")
    await _entry(db, person, _local(NY, 20, 13), _local(NY, 20, 14))
    await _entry(db, person, _local(NY, 20, 8), _local(NY, 20, 12))
    await _entry(db, person, _local(NY, 18, 8), _local(NY, 18, 12))   # two days ago
    await _entry(db, person, _local(NY, 20, 16), _local(NY, 20, 17))  # after now
    await _entry(db, other, _local(NY, 20, 8), _local(NY, 20, 12))

    total, spans = await timeclock.today_summary(
        db, person.id, tz=NY, now=_local(NY, 20, 15))
    assert total == 300
    assert [s.clock_in_at for s in spans] == [_local(NY, 20, 8), _local(NY, 20, 13)]
    assert [s.minutes for s in spans] == [240, 60]


async def test_today_floors_a_span_at_zero(db):
    person = await _person(db)
    await _entry(db, person, _local(NY, 20, 8), _local(NY, 20, 8, 20),
                 break_minutes=45)

    total, spans = await timeclock.today_summary(
        db, person.id, tz=NY, now=_local(NY, 20, 15))
    assert total == 0
    assert [s.minutes for s in spans] == [0]


async def test_today_uses_site_zone(db):
    person = await _person(db)
    # 03:30-05:30 UTC on Oct 21: 23:30-01:30 in New York, 20:30-22:30 the
    # evening before in Los Angeles
    start = datetime(2026, 10, 21, 3, 30, tzinfo=UTC)
    await _entry(db, person, start, start + timedelta(hours=2))
    now = datetime(2026, 10, 21, 6, 0, tzinfo=UTC)

    ny_total, _ = await timeclock.today_summary(db, person.id, tz=NY, now=now)
    la_total, _ = await timeclock.today_summary(db, person.id, tz=LA, now=now)
    assert ny_total == 90          # only the part after New York's midnight
    assert la_total == 120         # the whole shift is still "today" in LA


async def test_site_zone_falls_back_to_utc(db):
    bogus = Site(name="Bogus Zone Hall", timezone="Not/AZone")
    blank = Site(name="No Zone Hall")
    good = Site(name="Pacific Hall", timezone="America/Los_Angeles")
    db.add_all([bogus, blank, good])
    await db.flush()

    assert (await timeclock.site_zone(db, None)).key == "UTC"
    assert (await timeclock.site_zone(db, bogus.id)).key == "UTC"
    assert (await timeclock.site_zone(db, blank.id)).key == "UTC"
    assert (await timeclock.site_zone(db, good.id)).key == "America/Los_Angeles"


async def test_today_counts_a_25_hour_dst_day(db):
    """2026-11-01 in New York is 25 hours long (2:00 EDT falls back to
    1:00 EST). A shift from 23:00 the night before to 23:30 that night
    counts 24h 30m today — and the same answer comes back whether `now`
    is passed in UTC or in the site's own zone (same-zone aware
    subtraction is wall-clock, which would lose the extra hour)."""
    person = await _person(db)
    start = datetime(2026, 11, 1, 3, 0, tzinfo=UTC)      # Oct 31 23:00 EDT
    await _entry(db, person, start)
    now = datetime(2026, 11, 2, 4, 30, tzinfo=UTC)       # Nov 1 23:30 EST

    total, spans = await timeclock.today_summary(db, person.id, tz=NY, now=now)
    assert total == 1470
    total_local, _ = await timeclock.today_summary(
        db, person.id, tz=NY, now=now.astimezone(NY))
    assert total_local == 1470
    assert [s.minutes for s in spans] == [1470]
