"""Add time punches in bulk — the /time/bulk routes: gates, template,
preview, the all-or-nothing commit, and the overlap re-check at commit."""
import io
from datetime import UTC, datetime

import openpyxl
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import AuditLog, Person, PersonRole, TimeEntry
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people import time_bulk

from .test_assets_api import login, make_login
from .test_time_bulk_service import worker

BASE = "/time/bulk"
HEADER = "worker,clock_in,clock_out,break_minutes,job,site,notes"


@pytest.fixture
async def admin(db):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return person


@pytest.fixture
async def admin_hdrs(db, client, admin):
    return await make_login(db, client, admin, "ada@test.example.com")


def csv_file(*lines: str) -> dict:
    body = "\n".join([HEADER, *lines]) + "\n"
    return {"file": ("time.csv", body.encode(), "text/csv")}


def two_days() -> dict:
    return {"rows": [
        {"worker": "Ana Lopez", "clock_in": "6/1/2026 7:00 AM", "clock_out": "6/1/2026 3:30 PM"},
        {"worker": "Ana Lopez", "clock_in": "6/2/2026 7:00 AM", "clock_out": "6/2/2026 3:30 PM"},
    ]}


async def imported(db) -> list[TimeEntry]:
    return list(await db.scalars(select(TimeEntry).where(TimeEntry.source == "import")))


async def test_rank_and_time_add_are_both_required(client, db, seeded_user, admin_hdrs):
    staff = await login(client)

    async def statuses(hdrs):
        return [
            (await client.get(f"{BASE}/template?format=csv", headers=hdrs)).status_code,
            (await client.post(f"{BASE}/preview", headers=hdrs,
                               json={"rows": [{"worker": "X"}]})).status_code,
            (await client.post(f"{BASE}/commit", headers=hdrs,
                               json={"rows": [{"worker": "X"}]})).status_code,
        ]

    assert await statuses(staff) == [403, 403, 403]
    # time:add alone is not enough — bulk import needs admin rank
    await db.execute(text("INSERT INTO role_permissions (role, resource, action) "
                          "VALUES ('staff', 'time', 'add')"))
    await db.commit()
    assert await statuses(staff) == [403, 403, 403]
    # and admin rank without time:add is not enough either
    await db.execute(text("DELETE FROM role_permissions "
                          "WHERE role = 'admin' AND resource = 'time' AND action = 'add'"))
    await db.commit()
    assert await statuses(admin_hdrs) == [403, 403, 403]


async def test_template_formats(client, db, seeded_user, admin_hdrs):
    await worker(db, "Ana", "Lopez")
    resp = await client.get(f"{BASE}/template?format=csv", headers=admin_hdrs)
    assert resp.status_code == 200
    assert resp.headers["content-disposition"] == 'attachment; filename="time-template.csv"'
    assert resp.text.splitlines()[0] == HEADER
    xlsx = await client.get(f"{BASE}/template?format=xlsx", headers=admin_hdrs)
    assert xlsx.headers["content-disposition"] == 'attachment; filename="time-template.xlsx"'
    wb = openpyxl.load_workbook(io.BytesIO(xlsx.content))
    assert wb.sheetnames == ["Time", "Reference"]
    assert "Ana Lopez" in [c.value for c in wb["Reference"]["A"]]
    assert (await client.get(f"{BASE}/template?format=pdf", headers=admin_hdrs)).status_code == 422


async def test_file_preview_then_json_commit_adds_pending_import_entries(
        client, db, seeded_user, admin, admin_hdrs):
    ana = await worker(db, "Ana", "Lopez")
    resp = await client.post(f"{BASE}/preview", headers=admin_hdrs, files=csv_file(
        "Ana Lopez,6/1/2026 7:00 AM,6/1/2026 3:30 PM,30,,,first day",
        "Nobody Here,6/1/2026 7:00 AM,6/1/2026 3:30 PM,,,,"))
    assert resp.status_code == 200, resp.text
    rows = sorted(resp.json()["rows"], key=lambda r: r["row"])
    assert [(r["row"], r["action"]) for r in rows] == [(2, "add"), (3, "attention")]
    body = {"rows": [r["cells"] for r in rows], "row_numbers": [2, 3], "skip": [3],
            "overrides": {}}
    again = await client.post(f"{BASE}/preview", headers=admin_hdrs, json=body)
    assert again.json()["can_commit"] is True

    done = await client.post(f"{BASE}/commit", headers=admin_hdrs,
                             json={**body, "source": "time.csv"})
    assert done.status_code == 200, done.text
    out = done.json()
    assert out["summary"] == {"added": 1, "skipped": 1}
    [entry] = await imported(db)
    assert [(r["row"], r["action"], r["entry_id"]) for r in out["rows"]] == [
        (2, "created", str(entry.id)), (3, "skipped", None)]
    assert out["rows"][0]["detail"] == "Jun 1, 7:00 AM – 3:30 PM EDT"
    assert (entry.person_id, entry.status, entry.source) == (ana.id, "pending", "import")
    assert (entry.break_minutes, entry.notes, entry.adjusted) == (30, "first day", False)
    assert entry.created_by == admin.id
    assert entry.clock_in_at == datetime(2026, 6, 1, 11, 0, tzinfo=UTC)
    audits = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "time_entry")))
    assert sorted(a.action for a in audits) == ["bulk_import", "import"]
    per_entry = next(a for a in audits if a.action == "import")
    assert per_entry.entity_id == str(entry.id)
    assert per_entry.changes == {"status": {"from": None, "to": "pending"}}
    summary = next(a for a in audits if a.action == "bulk_import")
    assert summary.entity_id is None
    assert summary.changes == {"added": 1, "skipped": 1, "source": "time.csv"}


async def test_commit_is_all_or_nothing(client, db, seeded_user, admin_hdrs):
    await worker(db, "Ana", "Lopez")
    body = two_days()
    body["rows"][1]["clock_out"] = "6/2/2026 7:00 AM"
    resp = await client.post(f"{BASE}/commit", headers=admin_hdrs, json=body)
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "rows_invalid"
    assert [(r["row"], r["errors"]) for r in detail["rows"]] == [
        (2, ["Clock-out must be after clock-in."])]
    assert await imported(db) == []
    assert list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "time_entry"))) == []


async def test_commit_rechecks_overlaps_and_refuses_the_run(client, db, seeded_user, admin_hdrs):
    ana = await worker(db, "Ana", "Lopez")
    body = two_days()
    assert (await client.post(f"{BASE}/preview", headers=admin_hdrs,
                              json=body)).json()["can_commit"] is True
    # a kiosk punch lands between the preview and the commit
    db.add(TimeEntry(person_id=ana.id, clock_in_at=datetime(2026, 6, 2, 12, 0, tzinfo=UTC),
                     clock_out_at=datetime(2026, 6, 2, 14, 0, tzinfo=UTC),
                     status="pending", source="kiosk"))
    await db.commit()
    resp = await client.post(f"{BASE}/commit", headers=admin_hdrs, json=body)
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "rows_invalid"
    assert [r["row"] for r in detail["rows"]] == [2]
    assert detail["rows"][0]["errors"] == [
        "Overlaps Ana Lopez's existing entry on Jun 2, 8:00 AM – 10:00 AM EDT."]
    assert await imported(db) == []
    assert list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "time_entry"))) == []


async def test_an_exact_repeat_is_skipped_as_already_there(client, db, seeded_user, admin_hdrs):
    ana = await worker(db, "Ana", "Lopez")
    db.add(TimeEntry(person_id=ana.id, clock_in_at=datetime(2026, 6, 1, 11, 0, tzinfo=UTC),
                     clock_out_at=datetime(2026, 6, 1, 19, 30, tzinfo=UTC), status="approved"))
    await db.commit()
    resp = await client.post(f"{BASE}/commit", headers=admin_hdrs, json=two_days())
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["summary"] == {"added": 1, "skipped": 1}
    assert (out["rows"][0]["row"], out["rows"][0]["action"], out["rows"][0]["detail"]) == (
        1, "skipped", "Already there.")
    assert len(await imported(db)) == 1


async def test_bad_bodies_are_422(client, db, seeded_user, admin_hdrs):
    for body, code in (
        ({"rows": [{"worker": "X"}], "row_numbers": [1, 2]}, "invalid_row_numbers"),
        ({"rows": [{"worker": "X"}], "overrides": {"1": {"role": "x"}}}, "invalid_overrides"),
        ({"rows": [{"worker": "X"}], "skip": "all"}, "invalid_skip"),
        ({"rows": [{"shift": "X"}]}, "unknown_columns"),
    ):
        resp = await client.post(f"{BASE}/preview", headers=admin_hdrs, json=body)
        assert resp.status_code == 422 and resp.json()["detail"]["code"] == code, body
    resp = await client.post(f"{BASE}/commit", headers=admin_hdrs, files=csv_file(
        "Ana Lopez,6/1/2026 7:00 AM,6/1/2026 3:30 PM,,,,"))
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_json"


# ── the table lock (service level) ──────────────────────────────────

async def lock_holders() -> list[str]:
    """SHARE ROW EXCLUSIVE locks granted on time_entries, seen from another
    connection."""
    async with get_sessionmaker()() as other:
        return list(await other.scalars(text(
            "SELECT mode FROM pg_locks WHERE relation = 'time_entries'::regclass "
            "AND granted AND mode = 'ShareRowExclusiveLock'")))


async def insert_blocked(person_id) -> bool:
    """Whether a kiosk-style INSERT from another connection has to wait for
    a lock (it gives up after 200 ms). Rolled back either way."""
    async with get_sessionmaker()() as other:
        await other.execute(text("SET LOCAL lock_timeout = '200ms'"))
        other.add(TimeEntry(person_id=person_id,
                            clock_in_at=datetime(2026, 5, 1, 12, 0, tzinfo=UTC),
                            clock_out_at=datetime(2026, 5, 1, 13, 0, tzinfo=UTC),
                            status="pending", source="kiosk"))
        try:
            await other.flush()
        except DBAPIError as exc:
            await other.rollback()
            assert "lock timeout" in str(exc), exc
            return True
        await other.rollback()
        return False


@pytest.fixture
def lock_spy(monkeypatch):
    """Wraps preview_rows so that, while commit_rows is mid-run (after its
    re-check, before its commit), we record who holds the lock and whether
    a concurrent writer is blocked."""
    seen: dict = {}
    real = time_bulk.preview_rows

    async def spy(db, numbered, **kw):
        out = await real(db, numbered, **kw)
        seen["held"] = await lock_holders()
        seen["blocked"] = await insert_blocked(seen["person_id"])
        return out

    monkeypatch.setattr(time_bulk, "preview_rows", spy)
    return seen


async def test_the_commit_blocks_writers_until_it_commits(db, admin, lock_spy):
    ana = await worker(db, "Ana", "Lopez")
    lock_spy["person_id"] = ana.id
    out = await time_bulk.commit_rows(
        db, admin.id, time_bulk.number_json_rows(two_days()["rows"]),
        overrides={}, skip=set(), source_label="t")
    assert out["summary"] == {"added": 2, "skipped": 0}
    assert (lock_spy["held"], lock_spy["blocked"]) == (["ShareRowExclusiveLock"], True)
    # released by the commit
    assert await lock_holders() == []
    assert await insert_blocked(ana.id) is False


async def test_a_refused_commit_releases_the_lock_and_writes_nothing(db, admin, lock_spy):
    ana_id = (await worker(db, "Ana", "Lopez")).id   # the rollback expires the objects
    lock_spy["person_id"] = ana_id
    rows = two_days()["rows"]
    rows[1]["clock_out"] = "6/2/2026 7:00 AM"
    with pytest.raises(BulkImportError) as refused:
        await time_bulk.commit_rows(db, admin.id, time_bulk.number_json_rows(rows),
                                    overrides={}, skip=set(), source_label="t")
    assert refused.value.code == "rows_invalid"
    assert [r["row"] for r in refused.value.extra["rows"]] == [2]
    assert (lock_spy["held"], lock_spy["blocked"]) == (["ShareRowExclusiveLock"], True)
    # released by the rollback
    assert await lock_holders() == []
    assert await insert_blocked(ana_id) is False
    assert list(await db.scalars(select(TimeEntry))) == []
    assert list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "time_entry"))) == []
