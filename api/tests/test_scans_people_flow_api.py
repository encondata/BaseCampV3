"""Walk-by rail feed: burst debounce, counts, avatars, gate."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import Person, ProcessedScan, Site

from tests.test_status_values_write import _make


def _scan(person, at, device="dock-reader-1", site_id=None):
    return ProcessedScan(scanned_value=str(person.id), scan_type="rfid",
                         status="labeled", scanned_at=at, device_id=device,
                         site_id=site_id, match_type="person",
                         person_id=person.id, processed_at=at)


async def _people(db):
    a = Person(first_name="Ada", last_name="Lovelace",
               email="ada@test.example.com")
    b = Person(first_name="Grace", last_name="Hopper",
               email="grace@test.example.com")
    db.add(a)
    db.add(b)
    await db.flush()
    return a, b


async def test_burst_debounce_and_order(client, db, seeded_user):
    # Anchor mid-day UTC: offsets up to -60m must stay on TODAY for the
    # person_scans_today assertions (near-midnight runs flaked otherwise).
    now = datetime.now(UTC).replace(hour=12, minute=0, second=0,
                                    microsecond=0)
    a, b = await _people(db)
    site = Site(name="NAP11 - Switch")
    db.add(site)
    await db.flush()
    # Ada burst at dock-reader-1: 3 reads inside 5 min -> ONE event at the EARLIEST
    for mins in (30, 29, 27):
        db.add(_scan(a, now - timedelta(minutes=mins), site_id=site.id))
    # Ada again at the same reader 10 min later (> 5 min after kept) -> new event
    db.add(_scan(a, now - timedelta(minutes=18), site_id=site.id))
    # Ada at a DIFFERENT reader inside 5 min of that -> its own event
    db.add(_scan(a, now - timedelta(minutes=17), device="cage-reader"))
    # Grace once
    db.add(_scan(b, now - timedelta(minutes=5)))
    await db.commit()

    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/scans/people-flow", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    evs = body["events"]
    assert [(e["display_name"], e["device_id"]) for e in evs] == [
        ("Grace Hopper", "dock-reader-1"),
        ("Ada Lovelace", "cage-reader"),
        ("Ada Lovelace", "dock-reader-1"),
        ("Ada Lovelace", "dock-reader-1"),
    ]
    # burst folded to the EARLIEST read (minute 30, not 27)
    assert evs[-1]["scanned_at"].startswith(
        (now - timedelta(minutes=30)).isoformat()[:16])
    assert evs[-1]["site_name"] == "NAP11 - Switch"
    assert evs[0]["avatar_url"] is None  # no avatar_key -> None passthrough
    # counts are PRE-debounce / distinct people
    assert body["person_scans_today"] == 6
    assert body["distinct_people_today"] == 2


async def test_limit_and_since(client, db, seeded_user):
    now = datetime.now(UTC).replace(hour=12, minute=0, second=0,
                                    microsecond=0)
    a, _b = await _people(db)
    for i in range(3):
        db.add(_scan(a, now - timedelta(minutes=30 * i), device=f"r{i}"))
    await db.commit()
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/scans/people-flow?limit=2", headers=hdrs)
    assert len(resp.json()["events"]) == 2
    assert resp.json()["person_scans_today"] == 3  # counts ignore limit
    cutoff = (now - timedelta(minutes=45)).isoformat()
    # params= so httpx URL-encodes the datetime ("+00:00" would otherwise
    # arrive as a space in a hand-built query string)
    resp = await client.get("/scans/people-flow", headers=hdrs,
                            params={"since": cutoff})
    assert len(resp.json()["events"]) == 2  # r0 (now) and r1 (-30m) only


async def test_empty_and_gate(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/scans/people-flow", headers=hdrs)
    assert resp.json() == {"events": [], "distinct_people_today": 0,
                           "person_scans_today": 0}
