"""Dashboard time aggregates: open count, pending count, zero-filled days."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import Person, TimeEntry

from tests.test_status_values_write import _make


async def _person(db, first="Tess", last="Clock"):
    p = Person(first_name=first, last_name=last,
               email=f"{first}.{last}@test.example.com".lower())
    db.add(p)
    await db.flush()
    return p


async def test_summary_counts_and_days(client, db, seeded_user):
    # Anchor at 12:00 UTC so a "3 days ago" shift never crosses midnight
    # into the wrong calendar day regardless of when the suite runs.
    base = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
    p = await _person(db)
    # open entry (clocked in) — contributes 0 minutes
    db.add(TimeEntry(person_id=p.id, clock_in_at=base - timedelta(hours=3)))
    # closed entry today: 120 min span, 30 min break -> 90 worked, pending
    db.add(TimeEntry(person_id=p.id, clock_in_at=base - timedelta(hours=6),
                     clock_out_at=base - timedelta(hours=4),
                     break_minutes=30, status="pending"))
    # closed entry 3 days ago: 60 min, approved
    db.add(TimeEntry(person_id=p.id,
                     clock_in_at=base - timedelta(days=3, hours=2),
                     clock_out_at=base - timedelta(days=3, hours=1),
                     status="approved"))
    # entry outside the window: excluded from days
    db.add(TimeEntry(person_id=p.id,
                     clock_in_at=base - timedelta(days=40, hours=2),
                     clock_out_at=base - timedelta(days=40, hours=1)))
    await db.commit()

    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/time/stats/summary", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["clocked_in"] == 1
    assert body["pending_entries"] == 1
    assert body["minutes_today"] == 90
    assert len(body["days"]) == 14
    assert body["days"][-1]["day"] == base.date().isoformat()
    assert body["days"][-1]["minutes"] == 90
    day3 = (base - timedelta(days=3)).date().isoformat()
    assert next(d for d in body["days"] if d["day"] == day3)["minutes"] == 60
    # zero-filled elsewhere
    assert sum(d["minutes"] for d in body["days"]) == 150


async def test_summary_days_param_and_empty(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/time/stats/summary?days=7", headers=hdrs)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["days"]) == 7
    assert body["clocked_in"] == 0 and body["minutes_today"] == 0
    assert all(d["minutes"] == 0 for d in body["days"])
