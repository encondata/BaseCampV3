"""Workers bulk import pipeline (no HTTP): keys, template, export, preview,
commit. Actor for preview/commit is an admin (rank 60) unless a test says
otherwise."""
import io
import uuid

import openpyxl
import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, Partner, Person, PersonRole, UserAccount, WorkerProfile,
)
from serversherpa.people import bulk_import as bi

ADMIN_RANK = 60


@pytest.fixture
async def admin(db):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return person


async def preview(db, admin, rows):
    return await bi.preview_rows(db, bi.number_json_rows(rows),
                                 actor_id=admin.id, actor_rank=ADMIN_RANK)


async def commit(db, admin, rows, approved=(), source="test.csv"):
    return await bi.commit_rows(db, bi.number_json_rows(rows), actor_id=admin.id,
                                actor_rank=ADMIN_RANK,
                                approved_updates=set(approved), source_label=source)


async def mk_worker(db, first="Robert", last="Smith", *, preferred=None,
                    email=None, phone=None, rfid=None, role=True, profile=None,
                    archived=False, account=False):
    from datetime import UTC, datetime
    person = Person(first_name=first, last_name=last, preferred_name=preferred,
                    email=email, phone=phone, rfid_tag=rfid,
                    archived_at=datetime.now(UTC) if archived else None)
    db.add(person)
    await db.flush()
    if role:
        db.add(PersonRole(person_id=person.id, role="worker"))
    if profile is not None:
        db.add(WorkerProfile(person_id=person.id, **profile))
    if account:
        db.add(UserAccount(person_id=person.id, email=email or f"{first}@test.example.com",
                           password_hash="x"))
    await db.commit()
    return person


# ── shape / keys / template ─────────────────────────────────────────

def test_columns_match_canonical_shape():
    assert bi.COLUMNS == [
        "first_name", "last_name", "preferred_name", "email", "phone",
        "job_title", "employee_number", "rfid_tag", "address_line1",
        "address_line2", "city", "region", "postal_code", "country",
        "partner", "trade", "level", "status", "status_note", "notes"]


def test_normalize_phone():
    assert bi.normalize_phone("(555) 123-4567") == "5551234567"
    assert bi.normalize_phone("1-555-123-4567") == "5551234567"
    assert bi.normalize_phone("+44 20 7946 0958") == "442079460958"   # not a US 1
    assert bi.normalize_phone("12345") == ""                            # too short
    assert bi.normalize_phone("") == ""


def test_name_keys_cover_first_and_preferred():
    assert bi.name_keys("Robert", "Smith", "Bob") == {"robert smith", "bob smith"}
    assert bi.name_keys("  Robert ", "SMITH", "") == {"robert smith"}
    assert bi.name_keys("", "Smith", "Bob") == {"bob smith"}
    assert bi.name_keys("", "", "") == set()


def test_csv_and_json_normalize_identically():
    from_csv = bi.parse_upload("t.csv", bi.build_template_csv().encode())
    from_json = bi.number_json_rows(bi.SAMPLE_ROWS)
    assert [r for _, r in from_csv] == [r for _, r in from_json]
    assert [n for n, _ in from_csv] == [2, 3]


def test_xlsx_template_round_trips_with_reference_blocks():
    blob = bi.build_template_xlsx(["L1", "L2"], ["active", "standby"], ["Haul It"])
    wb = openpyxl.load_workbook(io.BytesIO(blob))
    assert wb.sheetnames == ["Workers", "Reference"]
    ref = [row[0].value for row in wb["Reference"].iter_rows()]
    assert ref == ["Valid levels", "L1", "L2", None,
                   "Valid statuses", "active", "standby", None,
                   "Partner names", "Haul It"]
    rows = bi.parse_upload("t.xlsx", blob)
    assert [r for _, r in rows] == [r for _, r in bi.number_json_rows(bi.SAMPLE_ROWS)]


# ── export ──────────────────────────────────────────────────────────

async def test_export_rows_shape_and_round_trip(db, admin):
    pt = Partner(name="Haul It")
    db.add(pt)
    await db.flush()
    await mk_worker(db, "Zed", "Zulu", email="zed@test.example.com", phone="555-000-1111",
                    profile={"partner_id": pt.id, "trade": "Cable", "level": "L2",
                             "status": "standby"})
    await mk_worker(db, "Amy", "Alpha")                         # no profile
    await mk_worker(db, "Not", "Worker", role=False)            # no worker role
    await mk_worker(db, "Old", "Gone", archived=True)
    rows = await bi.export_rows(db)
    assert [r["last_name"] for r in rows] == ["Alpha", "Zulu"]
    assert set(rows[0]) == set(bi.COLUMNS)
    assert rows[0]["status"] == "active"                # profile-less default
    assert rows[1]["partner"] == "Haul It" and rows[1]["level"] == "L2"
    assert rows[1]["phone"] == "555-000-1111"

    csv_text = bi.build_rows_csv(rows)
    out = await preview(db, admin, [r for _, r in bi.parse_upload("e.csv", csv_text.encode())])
    assert [r["action"] for r in out["rows"]] == ["unchanged", "unchanged"]


async def test_reference_lists(db, admin):
    db.add(Partner(name="Bee Co"))
    db.add(Partner(name="Ant Co"))
    await db.commit()
    levels, statuses, partners = await bi.reference_lists(db)
    assert levels == ["L1", "L2", "L3", "L4", "L5", "L6"]
    assert statuses == ["active", "standby", "blacklist"]
    assert partners == ["Ant Co", "Bee Co"]
