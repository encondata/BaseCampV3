"""Timesheet report data layer: flags, day rows, rollups (pure) and
`gather` (DB) — local-day placement, filters, statuses, size limit."""

import uuid
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from serversherpa.db.models import Initiative, Person, Site, TimeEntry
from serversherpa.reports.timesheet import gather as g
from serversherpa.reports.timesheet.gather import (
    EntryRow,
    TimesheetFilters,
    TimesheetTooLarge,
    day_rows,
    flags_for,
    gather,
    rollups,
)

NY = ZoneInfo("America/New_York")
NOW = datetime(2026, 10, 6, 20, 0, tzinfo=UTC)
P1, P2 = uuid.uuid4(), uuid.uuid4()
J1 = uuid.uuid4()


def row(*, person=P1, name="Ann", day=date(2026, 10, 1), start_h=8, end_h=16.0,
        status="approved", source="punch", adjusted=False, job=J1,
        job_name="Alpha", worked=None, break_minutes=0, open_=False) -> EntryRow:
    start = datetime(day.year, day.month, day.day, tzinfo=NY) + timedelta(hours=start_h)
    out = None if open_ else start + timedelta(hours=end_h - start_h)
    if worked is None:
        worked = 0 if open_ else int((out - start).total_seconds() // 60)
    return EntryRow(
        id=uuid.uuid4(), person_id=person, person_name=name, initiative_id=job,
        job_name=job_name if job else None, site_name=None, tz_name="America/New_York",
        local_day=day, clock_in=start, clock_out=out, break_minutes=break_minutes,
        worked_minutes=worked, status="open" if open_ else status,
        status_label=status, source=source, approved_by_name=None,
        adjusted=adjusted, adjust_reason=None, notes=None)


def flagged(*rows: EntryRow, now=NOW) -> list[EntryRow]:
    flags_for(list(rows), now)
    return list(rows)


# ---------------------------------------------------------------- flags (pure)

def test_constants():
    assert g.MAX_ENTRIES == 20_000
    assert g.CLOSED_COUNTED == ("approved", "pending")
    assert TimesheetTooLarge.code == "too_many_entries"


def test_plain_entry_has_no_flags():
    (e,) = flagged(row())
    assert e.flags == []


def test_adjusted_and_manual():
    (e,) = flagged(row(adjusted=True, source="manual"))
    assert e.flags == ["Adjusted", "Manual entry"]


def test_over_10_boundary():
    a, b = flagged(row(worked=599), row(worked=600, day=date(2026, 10, 2)))
    assert a.flags == []
    assert b.flags == ["Over 10 h"]


def test_over_16_replaces_over_10():
    a, b = flagged(row(worked=959), row(worked=960, day=date(2026, 10, 2)))
    assert a.flags == ["Over 10 h"]
    assert b.flags == ["Over 16 h"]


def test_overlap_flags_both_entries_of_the_pair():
    a, b = flagged(row(start_h=8, end_h=12), row(start_h=11, end_h=14))
    assert a.flags == ["Overlap"]
    assert b.flags == ["Overlap"]


def test_overlap_across_midnight_flags_the_earlier_day_too():
    # 22:00 -> 02:00 next day, then a punch starting 01:00 on the next day.
    first = row(day=date(2026, 10, 1), start_h=22, end_h=26)
    second = row(day=date(2026, 10, 2), start_h=1, end_h=3)
    flagged(first, second)
    assert first.flags == ["Overlap"] and second.flags == ["Overlap"]
    d1, d2 = day_rows([first, second])
    assert (d1.day, d1.flags) == (date(2026, 10, 1), ["Overlap"])
    assert (d2.day, d2.flags) == (date(2026, 10, 2), ["Overlap"])


def test_touching_entries_do_not_overlap():
    a, b = flagged(row(start_h=8, end_h=12), row(start_h=12, end_h=14))
    assert a.flags == [] and b.flags == []


def test_overlap_is_per_person():
    a, b = flagged(row(start_h=8, end_h=12),
                   row(person=P2, name="Bob", start_h=9, end_h=10))
    assert a.flags == [] and b.flags == []


def test_overlap_against_longest_earlier_entry():
    a, b, c = flagged(row(start_h=8, end_h=18), row(start_h=9, end_h=10),
                      row(start_h=11, end_h=12))
    assert a.flags == ["Over 10 h", "Overlap"]
    assert b.flags == ["Overlap"]
    assert c.flags == ["Overlap"]


def test_overlap_pairs_with_the_latest_ending_entry():
    # b sits inside a (both flagged); c starts after a ends, so it is clean.
    a, b, c = flagged(row(start_h=8, end_h=12), row(start_h=9, end_h=10),
                      row(start_h=13, end_h=14))
    assert a.flags == ["Overlap"] and b.flags == ["Overlap"]
    assert c.flags == []


def test_open_entry_ends_now_for_overlap():
    # open entry started 08:00 NY on the day of NOW; a later closed entry
    # starting before "now" overlaps it.
    day = date(2026, 10, 6)
    op, later = flagged(row(day=day, start_h=8, open_=True),
                        row(day=day, start_h=12, end_h=13))
    assert op.flags == ["Overlap", "Still clocked in"]
    assert later.flags == ["Overlap"]


def test_open_entry_after_a_closed_one_is_not_overlap():
    day = date(2026, 10, 6)
    closed, op = flagged(row(day=day, start_h=8, end_h=9),
                         row(day=day, start_h=10, open_=True))
    assert closed.flags == []
    assert op.flags == ["Still clocked in"]


def test_flag_order():
    a, b = flagged(
        row(start_h=0, end_h=17, adjusted=True, source="manual"),
        row(start_h=2, end_h=3))
    assert a.flags == ["Adjusted", "Manual entry", "Over 16 h", "Overlap"]
    assert b.flags == ["Overlap"]
    full = row(start_h=1, end_h=13, adjusted=True, source="manual", open_=True)
    full.worked_minutes = 700
    (e,) = flagged(full)
    assert e.flags == ["Adjusted", "Manual entry", "Over 10 h", "Still clocked in"]


# ------------------------------------------------------------- day rows (pure)

def test_day_row_shared_status_and_labels():
    rows = flagged(row(start_h=8, end_h=12, status="approved"),
                   row(start_h=13, end_h=17, status="approved"))
    (d,) = day_rows(rows)
    assert d.entries == 2
    assert d.status_label == "Approved"
    assert d.worked_minutes == 480
    assert d.first_in == rows[0].clock_in
    assert d.last_out == rows[1].clock_out


@pytest.mark.parametrize("status,label", [
    ("pending", "Pending"), ("rejected", "Rejected")])
def test_day_row_status_labels(status, label):
    (d,) = day_rows(flagged(row(status=status)))
    assert d.status_label == label


def test_day_row_open_is_on_the_clock_with_no_last_out():
    (d,) = day_rows(flagged(row(open_=True)))
    assert d.status_label == "On the clock"
    assert d.last_out is None


def test_day_row_last_out_follows_open_status():
    # An "open" status row is the open test, whatever its clock_out says.
    e = row(start_h=8, end_h=9)
    e.status = "open"
    (d,) = day_rows(flagged(e))
    assert d.last_out is None


def test_day_row_mixed_status_and_open_blanks_last_out():
    rows = flagged(row(start_h=8, end_h=9, status="approved"),
                   row(start_h=10, open_=True))
    (d,) = day_rows(rows)
    assert d.status_label == "Mixed"
    assert d.last_out is None


def test_day_row_flag_union_in_spec_order():
    rows = flagged(row(start_h=8, end_h=9, source="manual"),
                   row(start_h=8, end_h=9, adjusted=True))
    (d,) = day_rows(rows)
    assert d.flags == ["Adjusted", "Manual entry", "Overlap"]


def test_day_rows_split_by_person_and_day_and_sort():
    rows = flagged(
        row(person=P2, name="Ann 10", day=date(2026, 10, 1)),
        row(person=P1, name="Ann 2", day=date(2026, 10, 1)),
        row(person=P1, name="Ann 2", day=date(2026, 10, 2)),
        row(person=P2, name="Ann 10", day=date(2026, 9, 30)))
    got = [(d.day, d.person_name) for d in day_rows(rows)]
    assert got == [(date(2026, 9, 30), "Ann 10"), (date(2026, 10, 1), "Ann 2"),
                   (date(2026, 10, 1), "Ann 10"), (date(2026, 10, 2), "Ann 2")]


# --------------------------------------------------------------- rollups (pure)

def test_rollups_minutes_exclude_rejected_and_open_but_count_entries():
    rows = flagged(
        row(status="approved", start_h=8, end_h=10),    # 120
        row(status="pending", start_h=11, end_h=12),    # 60
        row(status="rejected", start_h=13, end_h=15),   # not counted
        row(open_=True, start_h=16))
    by_person, by_job, approved, pending = rollups(rows)
    assert (approved, pending) == (120, 60)
    (p,) = by_person
    assert (p.entries, p.days, p.approved_minutes, p.pending_minutes) == (4, 1, 120, 60)
    assert p.total_minutes == 180
    assert p.flagged == 1  # the open one
    (j,) = by_job
    assert (j.entries, j.people, j.approved_minutes, j.pending_minutes) == (4, 1, 120, 60)
    assert j.total_minutes == 180


def test_rollups_no_job_bucket_and_people_count():
    rows = flagged(
        row(person=P1, name="Ann", job=J1, job_name="Alpha"),
        row(person=P2, name="Bob", job=J1, job_name="Alpha"),
        row(person=P2, name="Bob", job=None, day=date(2026, 10, 2)))
    by_person, by_job, _, _ = rollups(rows)
    assert [j.job_name for j in by_job] == ["Alpha", "No job"]
    alpha, nojob = by_job
    assert (alpha.people, alpha.entries) == (2, 2)
    assert (nojob.people, nojob.entries, nojob.initiative_id) == (1, 1, None)
    bob = by_person[1]
    assert (bob.days, bob.entries) == (2, 2)


def test_rollups_person_sort_is_natural():
    rows = flagged(row(person=P1, name="Ann 10"), row(person=P2, name="Ann 2"))
    by_person, *_ = rollups(rows)
    assert [p.person_name for p in by_person] == ["Ann 2", "Ann 10"]


def test_rollups_empty():
    assert rollups([]) == ([], [], 0, 0)


# ------------------------------------------------------------------ gather (DB)

async def _person(db, first="Ann", last="Smith", **kw) -> Person:
    p = Person(first_name=first, last_name=last, **kw)
    db.add(p)
    await db.flush()
    return p


async def _site(db, name="HQ", tz=None) -> Site:
    s = Site(name=name, timezone=tz)
    db.add(s)
    await db.flush()
    return s


async def _job(db, name="Alpha") -> Initiative:
    i = Initiative(name=name, initiative_type="project")
    db.add(i)
    await db.flush()
    return i


def _entry(person, start, hours=8, **kw) -> TimeEntry:
    kw.setdefault("status", "approved")
    return TimeEntry(person_id=person.id, clock_in_at=start,
                     clock_out_at=start + timedelta(hours=hours), **kw)


def _filters(**kw) -> TimesheetFilters:
    base = {"from_day": date(2026, 10, 1), "to_day": date(2026, 10, 31),
            "person_id": None, "initiative_id": None, "site_id": None,
            "statuses": ("approved", "pending")}
    base.update(kw)
    return TimesheetFilters(**base)


async def test_gather_places_entries_on_the_local_day(db):
    p = await _person(db)
    # 01:30 UTC on Oct 2 is 21:30 EDT on Oct 1.
    db.add(_entry(p, datetime(2026, 10, 2, 1, 30, tzinfo=UTC), hours=2))
    await db.commit()
    data = await gather(db, _filters(), now=NOW)
    (e,) = data.entries
    assert e.local_day == date(2026, 10, 1)
    assert e.tz_name == "America/New_York"
    assert e.clock_in.hour == 21 and e.clock_in.utcoffset() == timedelta(hours=-4)
    assert data.default_tz == "America/New_York"


async def test_gather_site_timezone_overrides_default(db):
    p = await _person(db)
    la = await _site(db, "West", "America/Los_Angeles")
    # 06:30 UTC Oct 2 = 23:30 PDT Oct 1 = 02:30 EDT Oct 2.
    db.add(_entry(p, datetime(2026, 10, 2, 6, 30, tzinfo=UTC), hours=1, site_id=la.id))
    db.add(_entry(p, datetime(2026, 10, 2, 6, 30, tzinfo=UTC) + timedelta(hours=3), hours=1))
    await db.commit()
    data = await gather(db, _filters(), now=NOW)
    by_site = {e.site_name: e for e in data.entries}
    assert by_site["West"].tz_name == "America/Los_Angeles"
    assert by_site["West"].local_day == date(2026, 10, 1)
    assert by_site[None].tz_name == "America/New_York"
    assert by_site[None].local_day == date(2026, 10, 2)


async def test_gather_range_is_inclusive_on_local_dates(db):
    p = await _person(db)
    # Local Sep 30 23:00 EDT (out), Oct 1 00:30 EDT (in), Oct 31 23:30 EDT (in),
    # Nov 1 00:30 EDT (out).
    for start in (datetime(2026, 10, 1, 3, 0, tzinfo=UTC),    # Sep 30 23:00 EDT
                  datetime(2026, 10, 1, 4, 30, tzinfo=UTC),   # Oct 1 00:30 EDT
                  datetime(2026, 11, 1, 3, 30, tzinfo=UTC),   # Oct 31 23:30 EDT
                  datetime(2026, 11, 1, 4, 30, tzinfo=UTC)):  # Nov 1 00:30 EDT
        db.add(_entry(p, start, hours=1))
    await db.commit()
    data = await gather(db, _filters(), now=NOW)
    assert [e.local_day for e in data.entries] == [date(2026, 10, 1), date(2026, 10, 31)]


async def test_gather_filters(db):
    ann = await _person(db)
    bob = await _person(db, "Bob", "Jones")
    a, b = await _job(db, "Alpha"), await _job(db, "Beta")
    s1, s2 = await _site(db, "One"), await _site(db, "Two")
    t = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)
    db.add_all([
        _entry(ann, t, initiative_id=a.id, site_id=s1.id),
        _entry(bob, t, initiative_id=b.id, site_id=s2.id),
        _entry(bob, t + timedelta(days=1), initiative_id=a.id, site_id=s1.id)])
    await db.commit()

    assert len((await gather(db, _filters(), now=NOW)).entries) == 3

    d = await gather(db, _filters(person_id=bob.id), now=NOW)
    assert {e.person_name for e in d.entries} == {"Bob Jones"}
    assert d.person_label == "Bob Jones"
    assert (d.job_label, d.site_label) == ("All jobs", "All sites")

    d = await gather(db, _filters(initiative_id=a.id), now=NOW)
    assert len(d.entries) == 2 and d.job_label == "Alpha"

    d = await gather(db, _filters(site_id=s2.id), now=NOW)
    assert len(d.entries) == 1 and d.site_label == "Two"

    d = await gather(db, _filters(), now=NOW)
    assert d.person_label == "Everyone"


async def test_gather_statuses_and_totals(db):
    p = await _person(db)
    base = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)
    boss = await _person(db, "Boss", "Man")
    db.add(_entry(p, base, hours=4, status="approved", approved_by=boss.id))
    db.add(_entry(p, base + timedelta(days=1), hours=2, status="pending"))
    db.add(_entry(p, base + timedelta(days=2), hours=3, status="rejected"))
    db.add(TimeEntry(person_id=p.id, clock_in_at=base + timedelta(days=3),
                     status="open"))
    await db.commit()

    d = await gather(db, _filters(), now=NOW + timedelta(days=30))
    assert [e.status for e in d.entries] == ["approved", "pending"]
    assert (d.approved_minutes, d.pending_minutes) == (240, 120)
    assert d.entries[0].approved_by_name == "Boss Man"
    assert d.entries[0].status_label == "Approved"

    d = await gather(db, _filters(statuses=("approved", "pending", "rejected", "open")),
                     now=NOW + timedelta(days=30))
    assert len(d.entries) == 4
    assert (d.approved_minutes, d.pending_minutes) == (240, 120)
    assert d.people == 1 and d.day_count == 4
    assert d.flagged_entries == 1  # the open one
    open_row = d.entries[-1]
    assert open_row.flags == ["Still clocked in"] and open_row.clock_out is None
    assert open_row.worked_minutes == 0

    d = await gather(db, _filters(statuses=("rejected",)), now=NOW)
    assert [e.status for e in d.entries] == ["rejected"]
    assert (d.approved_minutes, d.pending_minutes) == (0, 0)


async def test_gather_day_count_is_distinct_dates(db):
    ann = await _person(db)
    bob = await _person(db, "Bob", "Jones")
    t = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)
    db.add_all([_entry(ann, t), _entry(bob, t),
                _entry(bob, t + timedelta(days=1))])
    await db.commit()
    d = await gather(db, _filters(), now=NOW)
    assert len(d.days) == 3          # person-days
    assert d.day_count == 2          # distinct dates
    by = {p.person_name: p.days for p in d.by_person}
    assert by == {"Ann Smith": 1, "Bob Jones": 2}


async def test_gather_invalid_site_timezone_falls_back_and_warns(db, caplog):
    p = await _person(db)
    bad = await _site(db, "Bad", "Mars/Olympus")
    t = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)
    db.add_all([_entry(p, t, site_id=bad.id),
                _entry(p, t + timedelta(days=1), site_id=bad.id)])
    await db.commit()
    with caplog.at_level("WARNING", logger=g.__name__):
        d = await gather(db, _filters(), now=NOW)
    assert {e.tz_name for e in d.entries} == {"America/New_York"}
    warnings = [r for r in caplog.records if "Mars/Olympus" in r.getMessage()]
    assert len(warnings) == 1


async def test_gather_auckland_site_includes_local_from_day(db):
    p = await _person(db)
    nz = await _site(db, "NZ", "Pacific/Auckland")
    # 2026-10-01 00:30 NZDT (UTC+13) = 2026-09-30 11:30Z.
    db.add(_entry(p, datetime(2026, 9, 30, 11, 30, tzinfo=UTC), hours=1,
                  site_id=nz.id))
    await db.commit()
    d = await gather(db, _filters(), now=NOW)
    (e,) = d.entries
    assert e.local_day == date(2026, 10, 1)
    assert e.tz_name == "Pacific/Auckland"
    assert (e.clock_in.hour, e.clock_in.minute) == (0, 30)
    assert e.clock_in.tzname() == "NZDT"


async def test_gather_new_york_fall_back(db):
    p = await _person(db)
    # DST ended 2026-11-01 06:00Z; 06:30Z is 01:30 EST (second 01:30 that night).
    db.add(_entry(p, datetime(2026, 11, 1, 6, 30, tzinfo=UTC), hours=1))
    db.add(_entry(p, datetime(2026, 11, 1, 5, 30, tzinfo=UTC), hours=0.25))
    await db.commit()
    d = await gather(db, _filters(from_day=date(2026, 11, 1),
                                  to_day=date(2026, 11, 1)), now=NOW)
    edt, est = d.entries
    assert (edt.clock_in.tzname(), edt.clock_in.hour) == ("EDT", 1)
    assert (est.clock_in.tzname(), est.clock_in.hour) == ("EST", 1)
    assert est.local_day == date(2026, 11, 1) and est.tz_name == "America/New_York"


async def test_gather_sorts_and_includes_archived_people(db):
    a10 = await _person(db, "Ann", "10", archived_at=datetime(2026, 1, 1, tzinfo=UTC))
    a2 = await _person(db, "Ann", "2")
    t = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)
    db.add_all([_entry(a10, t), _entry(a2, t),
                _entry(a2, t - timedelta(days=1))])
    await db.commit()
    d = await gather(db, _filters(), now=NOW)
    assert [(e.local_day.day, e.person_name) for e in d.entries] == [
        (9, "Ann 2"), (10, "Ann 2"), (10, "Ann 10")]
    assert [p.person_name for p in d.by_person] == ["Ann 2", "Ann 10"]
    assert len(d.days) == 3


async def test_gather_job_and_notes_fields(db):
    p = await _person(db)
    job = await _job(db, "Alpha")
    site = await _site(db, "HQ")
    t = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)
    db.add(_entry(p, t, initiative_id=job.id, site_id=site.id, notes="n",
                  adjusted=True, adjust_reason="forgot", source="manual",
                  break_minutes=30))
    db.add(_entry(p, t + timedelta(days=1)))
    await db.commit()
    d = await gather(db, _filters(), now=NOW)
    e, none_job = d.entries
    assert (e.job_name, e.site_name, e.notes, e.adjust_reason) == ("Alpha", "HQ", "n", "forgot")
    assert e.worked_minutes == 450 and e.break_minutes == 30
    assert e.flags == ["Adjusted", "Manual entry"]
    assert (none_job.job_name, none_job.site_name, none_job.notes) == (None, None, None)
    assert [j.job_name for j in d.by_job] == ["Alpha", "No job"]


async def test_gather_too_large(db):
    p = await _person(db)
    t = datetime(2026, 10, 10, 14, 0, tzinfo=UTC)
    db.add_all([_entry(p, t + timedelta(days=i), hours=1) for i in range(3)])
    await db.commit()
    with pytest.raises(TimesheetTooLarge) as exc:
        await gather(db, _filters(), now=NOW, limit=2)
    assert exc.value.code == "too_many_entries"
    assert len((await gather(db, _filters(), now=NOW, limit=3)).entries) == 3


async def test_gather_empty(db):
    d = await gather(db, _filters(), now=NOW)
    assert d.entries == [] and d.days == []
    assert (d.people, d.day_count, d.flagged_entries) == (0, 0, 0)
