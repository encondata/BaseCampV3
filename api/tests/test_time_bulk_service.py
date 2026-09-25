"""Add time punches in bulk (no HTTP): matching, time zones, row errors,
overlaps, duplicates, the preview listing and the template."""
import io
import uuid
from datetime import UTC, datetime

import openpyxl
import pytest
from sqlalchemy import func

from serversherpa.db.models import Initiative, Person, PersonRole, Site, TimeEntry
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people import time_bulk as tb

NOW = datetime(2026, 9, 25, 12, 0, tzinfo=UTC)


async def worker(db, first, last, *, email=None, phone=None, preferred=None,
                 role="worker", archived=False):
    p = Person(first_name=first, last_name=last, email=email, phone=phone,
               preferred_name=preferred, archived_at=func.now() if archived else None)
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return p


async def site(db, name, *, code=None, tz=None, archived=False):
    s = Site(name=name, code=code, timezone=tz, archived_at=func.now() if archived else None)
    db.add(s)
    await db.commit()
    return s


async def job(db, name, *, site_=None, archived=False):
    j = Initiative(name=name, initiative_type="move", site_id=site_.id if site_ else None,
                   archived_at=func.now() if archived else None)
    db.add(j)
    await db.commit()
    return j


def shift(worker="Ana Lopez", clock_in="2026-09-24 07:00", clock_out="2026-09-24 15:30",
          **cells):
    return {"worker": worker, "clock_in": clock_in, "clock_out": clock_out, **cells}


async def preview(db, rows, now=NOW, **kw):
    return await tb.preview_rows(db, tb.number_json_rows(rows), now=now, **kw)


def by_row(result):
    return {r["row"]: r for r in result["rows"]}


# ── shape ───────────────────────────────────────────────────────────

def test_columns_limits_and_template_round_trip():
    assert tb.COLUMNS == ["worker", "clock_in", "clock_out", "break_minutes", "job", "site",
                          "notes"]
    assert (tb.MAX_ROWS, tb.MAX_BYTES) == (5000, 5 * 1024 * 1024)
    parsed = tb.parse_upload("t.csv", tb.build_template_csv().encode())
    assert [n for n, _ in parsed] == [2, 3]
    assert [r for _, r in parsed] == tb.SAMPLE_ROWS
    assert len(tb.number_json_rows([{"worker": "x"}] * 5000)) == 5000
    with pytest.raises(BulkImportError) as info:
        tb.number_json_rows([{"worker": "x"}] * 5001)
    assert (info.value.code, info.value.extra) == ("too_many_rows", {"limit": 5000})


async def test_template_xlsx_lists_workers_jobs_and_sites(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    await job(db, "Move A")
    await site(db, "DC East")
    wb = openpyxl.load_workbook(io.BytesIO(await tb.build_template_xlsx(db)))
    assert wb.sheetnames == ["Time", "Reference"]
    assert [c.value for c in wb["Time"][1]] == tb.COLUMNS
    ref = {c.value for c in wb["Reference"]["A"] if c.value}
    assert {"Workers", "Jobs", "Sites", "Ana Lopez", "Move A", "DC East"} <= ref


# ── matching ────────────────────────────────────────────────────────

async def test_worker_matches_by_email_then_phone_then_name(db, seeded_user):
    ana = await worker(db, "Ana", "Lopez", email="ana@x.test", phone="555-123-4567",
                       preferred="Annie")
    rows = by_row(await preview(db, [
        shift(worker="ANA@X.TEST"),
        shift(worker="(555) 123-4567", clock_in="2026-09-23 07:00", clock_out="2026-09-23 15:00"),
        shift(worker="ana  lopez", clock_in="2026-09-22 07:00", clock_out="2026-09-22 15:00"),
        shift(worker="Annie Lopez", clock_in="2026-09-21 07:00", clock_out="2026-09-21 15:00"),
    ]))
    assert [(rows[n]["person_id"], rows[n]["matched_by"]) for n in (1, 2, 3, 4)] == [
        (str(ana.id), "email"), (str(ana.id), "phone"), (str(ana.id), "name"),
        (str(ana.id), "name")]
    assert rows[1]["name"] == rows[1]["person_name"] == "Ana Lopez"
    assert all(rows[n]["action"] == "add" for n in (1, 2, 3, 4))


async def test_unknown_and_ambiguous_values_need_attention(db, seeded_user):
    j1 = await worker(db, "Jo", "Park", email="j1@x.test")
    j2 = await worker(db, "Jo", "Park", email="j2@x.test")
    m1 = await job(db, "Dallas Move")
    m2 = await job(db, "Dallas Move")
    res = await preview(db, [
        shift(worker="Jo Park", job="dallas move", site="Nowhere DC"),
        shift(worker="nobody@x.test"),
    ])
    rows = by_row(res)
    assert rows[1]["action"] == "attention"
    assert {(i["field"], i["kind"]) for i in rows[1]["issues"]} == {
        ("worker", "ambiguous"), ("job", "ambiguous"), ("site", "unknown")}
    worker_issue = next(i for i in rows[1]["issues"] if i["field"] == "worker")
    assert {(c["id"], c["detail"]) for c in worker_issue["candidates"]} == {
        (str(j1.id), "j1@x.test"), (str(j2.id), "j2@x.test")}
    job_issue = next(i for i in rows[1]["issues"] if i["field"] == "job")
    assert {c["id"] for c in job_issue["candidates"]} == {str(m1.id), str(m2.id)}
    assert rows[2]["issues"] == [{"field": "worker", "kind": "unknown",
                                  "value": "nobody@x.test", "candidates": []}]
    assert rows[2]["name"] == "nobody@x.test"
    assert res["can_commit"] is False


async def test_archived_and_non_worker_records_do_not_match(db, seeded_user):
    await worker(db, "Old", "Timer", archived=True)
    await worker(db, "Sam", "Staff", role="staff")
    await job(db, "Closed Move", archived=True)
    await site(db, "Closed DC", archived=True)
    rows = by_row(await preview(db, [
        shift(worker="Old Timer"),
        shift(worker="Sam Staff", job="Closed Move", site="Closed DC"),
    ]))
    assert [(i["field"], i["kind"]) for i in rows[1]["issues"]] == [("worker", "unknown")]
    assert {(i["field"], i["kind"]) for i in rows[2]["issues"]} == {
        ("worker", "unknown"), ("job", "unknown"), ("site", "unknown")}


async def test_site_matches_by_name_or_code(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    west = await site(db, "Example DC West", code="DCW")
    rows = by_row(await preview(db, [
        shift(site="dcw"),
        shift(site="example dc west", clock_in="2026-09-23 07:00", clock_out="2026-09-23 15:00"),
    ]))
    assert rows[1]["site_id"] == rows[2]["site_id"] == str(west.id)
    assert rows[1]["site_name"] == "Example DC West"


async def test_picks_resolve_rows_and_skips_skip_them(db, seeded_user):
    j1 = await worker(db, "Jo", "Park")
    await worker(db, "Jo", "Park")
    move = await job(db, "Move A")
    west = await site(db, "DC West", tz="America/Los_Angeles")
    rows = by_row(await preview(
        db,
        [shift(worker="Jo Park", job="Mystery", site="Somewhere"), shift(worker="Nobody"),
         shift(worker="Jo Park")],
        overrides={1: {"worker": str(j1.id), "job": str(move.id), "site": str(west.id)},
                   3: {"worker": str(uuid.uuid4())}},
        skip={2}))
    assert rows[1]["action"] == "add" and rows[1]["matched_by"] == "your pick"
    assert (rows[1]["person_id"], rows[1]["job_id"], rows[1]["site_id"]) == (
        str(j1.id), str(move.id), str(west.id))
    assert rows[1]["zone"] == "America/Los_Angeles"          # the picked site's zone
    assert rows[2]["action"] == "skipped"
    assert rows[3]["action"] == "error"
    assert rows[3]["errors"] == ["The chosen worker no longer exists. Pick again."]


# ── times ───────────────────────────────────────────────────────────

async def test_zone_is_the_site_then_the_jobs_site_then_the_default(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    await site(db, "DC West", tz="America/Los_Angeles")
    chi = await site(db, "DC Central", tz="America/Chicago")
    await site(db, "DC Nowhere", tz="Mars/Base")
    await job(db, "Chicago Move", site_=chi)
    rows = by_row(await preview(db, [
        shift(site="DC West"),
        shift(job="Chicago Move", clock_in="2026-09-23 07:00", clock_out="2026-09-23 15:00"),
        shift(clock_in="2026-09-22 07:00", clock_out="2026-09-22 15:00"),
        shift(site="DC Nowhere", clock_in="2026-09-21 07:00", clock_out="2026-09-21 15:00"),
        shift(site="DC West", clock_in="2026-09-20T07:00:00-06:00",
              clock_out="2026-09-20T15:00:00-06:00"),
    ]))
    assert [rows[n]["action"] for n in range(1, 6)] == ["add"] * 5
    assert rows[1]["clock_in_at"] == "2026-09-24T14:00:00+00:00"
    assert rows[1]["zone"] == "America/Los_Angeles"
    assert rows[1]["shift"] == "Sep 24, 7:00 AM – 3:30 PM PDT"
    assert rows[1]["minutes"] == 510
    assert rows[2]["clock_in_at"] == "2026-09-23T12:00:00+00:00"
    assert rows[2]["zone"] == "America/Chicago"
    assert rows[3]["clock_in_at"] == "2026-09-22T11:00:00+00:00"
    assert rows[3]["zone"] == "America/New_York"
    assert rows[4]["clock_in_at"] == "2026-09-21T11:00:00+00:00"     # bad zone → default
    assert rows[5]["clock_in_at"] == "2026-09-20T13:00:00+00:00"     # offset as written


async def test_excel_serials_and_us_dates_read_alike(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    [row] = (await preview(db, [shift(clock_in="46289.291666666664",
                                      clock_out="9/24/2026 3:30 PM",
                                      break_minutes="30")]))["rows"]
    assert row["clock_in_at"] == "2026-09-24T11:00:00+00:00"
    assert row["clock_out_at"] == "2026-09-24T19:30:00+00:00"
    assert (row["break_minutes"], row["minutes"]) == (30, 480)


async def test_dst_fall_back_reads_the_first_occurrence(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    [row] = (await preview(db, [shift(clock_in="2026-11-01 01:30", clock_out="2026-11-01 09:00")],
                           now=datetime(2026, 11, 2, tzinfo=UTC)))["rows"]
    assert row["clock_in_at"] == "2026-11-01T05:30:00+00:00"
    assert row["shift"] == "Nov 1, 1:30 AM EDT – 9:00 AM EST"
    assert row["minutes"] == 510


@pytest.mark.parametrize(("cells", "message"), [
    ({"worker": ""}, "Worker is required."),
    ({"clock_in": ""}, "Clock-in is required."),
    ({"clock_out": ""}, "Clock-out is required."),
    ({"clock_in": "someday"}, "Clock-in 'someday' is not a date and time this import can read."),
    ({"clock_out": "9/24/2026"},
     "Clock-out '9/24/2026' is not a date and time this import can read."),
    ({"clock_out": "2026-09-24 07:00"}, "Clock-out must be after clock-in."),
    ({"clock_out": "2026-09-25 07:01"}, "The shift is longer than 24 hours."),
    ({"clock_in": "2026-09-25 13:00", "clock_out": "2026-09-25 18:00"},
     "Clock-in is in the future."),
    ({"break_minutes": "abc"}, "The break must be a whole number of minutes, 0 or more."),
    ({"break_minutes": "-5"}, "The break must be a whole number of minutes, 0 or more."),
    ({"break_minutes": "510"}, "The break is as long as the shift or longer."),
])
async def test_row_errors_are_sentences(db, seeded_user, cells, message):
    await worker(db, "Ana", "Lopez")
    [row] = (await preview(db, [shift(**cells)]))["rows"]
    assert row["action"] == "error"
    assert message in row["errors"]


# ── overlaps and duplicates ─────────────────────────────────────────

def utc(day, hour, minute=0, second=0):
    return datetime(2026, 9, day, hour, minute, second, tzinfo=UTC)


async def test_overlaps_with_existing_time(db, seeded_user):
    ana = await worker(db, "Ana", "Lopez")
    cy = await worker(db, "Cy", "Park")
    dee = await worker(db, "Dee", "Moss")
    ben = await worker(db, "Ben", "Ng")
    db.add_all([
        # 6:00–8:00 AM EDT on Sep 24
        TimeEntry(person_id=ana.id, clock_in_at=utc(24, 10), clock_out_at=utc(24, 12),
                  status="approved"),
        TimeEntry(person_id=cy.id, clock_in_at=utc(24, 11), clock_out_at=utc(24, 19),
                  status="rejected"),
        # still open since Sep 23, 10:00 PM EDT
        TimeEntry(person_id=dee.id, clock_in_at=utc(24, 2), status="open"),
        # ends at 7:00 AM EDT, exactly when the imported shift starts
        TimeEntry(person_id=ben.id, clock_in_at=utc(24, 7), clock_out_at=utc(24, 11),
                  status="pending"),
    ])
    await db.commit()
    rows = by_row(await preview(db, [shift(worker=w) for w in (
        "Ana Lopez", "Cy Park", "Dee Moss", "Ben Ng")]))
    assert rows[1]["action"] == "error"
    assert rows[1]["errors"] == [
        "Overlaps Ana Lopez's existing entry on Sep 24, 6:00 AM – 8:00 AM EDT."]
    assert rows[2]["action"] == "add"                  # rejected time is ignored
    assert rows[3]["errors"] == [
        "Overlaps Dee Moss's open entry that started Sep 23, 10:00 PM EDT."]
    assert rows[4]["action"] == "add"                  # touching is not overlapping


async def test_an_exact_repeat_is_already_there(db, seeded_user):
    ana = await worker(db, "Ana", "Lopez")
    ben = await worker(db, "Ben", "Ng")
    db.add_all([
        TimeEntry(person_id=ana.id, clock_in_at=utc(24, 11, 0, 40),
                  clock_out_at=utc(24, 19, 30, 5), status="approved"),
        TimeEntry(person_id=ben.id, clock_in_at=utc(24, 11), clock_out_at=utc(24, 19, 30),
                  status="rejected"),
    ])
    await db.commit()
    res = await preview(db, [shift(), shift(worker="Ben Ng")])
    assert [r["action"] for r in res["rows"]] == ["duplicate", "duplicate"]
    assert res["rows"][0]["detail"] == "Already there."
    assert res["counts"]["duplicate"] == 2
    assert res["can_commit"] is False                 # nothing is left to add


async def test_overlaps_within_the_file(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    await worker(db, "Ben", "Ng")
    rows = by_row(await preview(db, [
        shift(),
        shift(clock_in="2026-09-24 15:00", clock_out="2026-09-24 20:00"),
        shift(worker="Ben Ng"),
        shift(clock_in="2026-09-24 15:30", clock_out="2026-09-24 18:00"),
    ], skip={4}))
    assert rows[1]["errors"] == ["Overlaps row 2 in this file."]
    assert rows[2]["errors"] == ["Overlaps row 1 in this file."]
    assert rows[3]["action"] == "add"
    assert rows[4]["action"] == "skipped"


async def test_counts_order_and_can_commit(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    res = await preview(db, [
        shift(), shift(worker="Nobody"), shift(worker=""),
        shift(clock_in="2026-09-23 07:00", clock_out="2026-09-23 15:00"),
    ], skip={4})
    assert [r["row"] for r in res["rows"]] == [2, 3, 1, 4]
    assert res["counts"] == {"attention": 1, "error": 1, "add": 1, "duplicate": 0,
                             "skipped": 1}
    assert res["can_commit"] is False
    ok = await preview(db, [shift(), shift(worker="Nobody")], skip={2})
    assert ok["can_commit"] is True
