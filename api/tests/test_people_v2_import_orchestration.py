"""Orchestration coverage for `import_workers`: DB inserts, partner
matching, idempotent re-runs, and non-worker filtering. Each test writes
its own tiny synthetic dump to tmp_path (sites importer test pattern)."""

from sqlalchemy import select

from serversherpa.db.models import Partner, Person, WorkerProfile
from serversherpa.people.v2_import import PEOPLE_COLS, import_workers


def _person_values(v2_id: int, first: str, last: str, email: str, *,
                   user_type: str = '{"worker": true}', status: int = 27,
                   partner: str = "NULL",
                   work_type: str = "NULL") -> str:
    by_col = {
        "id": str(v2_id), "first_name": f"'{first}'", "last_name": f"'{last}'",
        "display_name": "''", "email_address": f"'{email}'",
        "phone_number": "'+1 555 0100'", "user_type": f"'{user_type}'",
        "people_status": str(status), "w_resource_partner": partner,
        "w_work_type": work_type,
    }
    return ", ".join(by_col.get(c, "NULL") for c in PEOPLE_COLS)


def _dump_text(*people_rows_sql: str, extra: str = "") -> str:
    cols = ", ".join(PEOPLE_COLS)
    body = "".join(
        f"INSERT INTO people ({cols}) VALUES ({row});\n"
        for row in people_rows_sql)
    return body + extra


async def test_imports_worker_with_profile_and_source_ref(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(_person_values(
        7, "Ada", "Lovelace", "ada@example.com",
        work_type="'{\"hardware\": true}'")))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["imported"] == 1
    person = await db.scalar(select(Person).where(
        Person.source_ref == "backup_20260825_193157:people/7"))
    assert person is not None
    assert person.first_name == "Ada"
    assert person.email == "ada@example.com"
    assert person.source == "import"
    profile = await db.get(WorkerProfile, person.id)
    assert profile is not None
    assert profile.status == "active"
    assert profile.trade == "Hardware"
    assert stats["id_map"] == {7: str(person.id)}


async def test_non_workers_are_skipped(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(1, "Cli", "Ent", "c@example.com",
                       user_type='{"client": true}'),
        _person_values(2, "Off", "Worker", "o@example.com",
                       user_type='{"user": true, "worker": false}'),
    ))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["imported"] == 0
    assert stats["skipped_non_worker"] == 2


async def test_rerun_and_existing_email_skip(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(7, "Ada", "Lovelace", "ada@example.com")))
    first = await import_workers(db, str(dump), limit=10)
    assert first["imported"] == 1
    again = await import_workers(db, str(dump), limit=10)
    assert again["imported"] == 0
    assert again["skipped_existing"] == 1
    # same email under a different v2 id also skips — no duplicate people
    dump.write_text(_dump_text(
        _person_values(8, "Ada", "L", "ADA@example.com")))
    other = await import_workers(db, str(dump), limit=10)
    assert other["imported"] == 0
    assert other["skipped_existing"] == 1


async def test_partner_match_and_partner_miss_note(tmp_path, db):
    db.add(Partner(name="Capitol North American"))
    await db.flush()
    extra = (
        "INSERT INTO partners (id, partner_name, partner_services, "
        "partner_region, parent_partner) VALUES "
        "(5, 'Capitol North American', NULL, NULL, NULL);\n")
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(1, "Match", "Ed", "m@example.com", partner="5"),
        _person_values(2, "Miss", "Ing", "x@example.com", partner="99"),
        extra=extra,
    ))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["imported"] == 2
    matched = await db.scalar(select(Person).where(Person.email == "m@example.com"))
    profile = await db.get(WorkerProfile, matched.id)
    partner = await db.scalar(select(Partner))
    assert profile.partner_id == partner.id
    missed = await db.scalar(select(Person).where(Person.email == "x@example.com"))
    assert "V2 partner #99 not in dump" in (missed.notes or "")


async def test_deleted_status_imports_archived(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(3, "Gone", "Person", "g@example.com", status=31)))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["imported"] == 1
    person = await db.scalar(select(Person).where(Person.email == "g@example.com"))
    assert person.archived_at is not None
    profile = await db.get(WorkerProfile, person.id)
    assert profile.status == "standby"
    assert profile.status_note == "V2 status: Deleted"


async def test_work_associations_land_in_notes(tmp_path, db):
    extra = (
        "INSERT INTO people_work_association (id, person_id, entity_type, "
        "entity_id, work_type, site_worked, rating, created_at, updated_at, "
        "metadata) VALUES (16, 13, 'Project', 3, 'Project Manager', "
        "'NAP11 - Switch', NULL, NULL, NULL, NULL);\n")
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(13, "Hist", "Oric", "h@example.com"), extra=extra))
    await import_workers(db, str(dump), limit=10)
    person = await db.scalar(select(Person).where(Person.email == "h@example.com"))
    assert "V2 work: Project #3 — Project Manager @ NAP11 - Switch" \
        in person.notes


async def test_limit_caps_inserts(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(1, "A", "A", "a@example.com"),
        _person_values(2, "B", "B", "b@example.com"),
    ))
    stats = await import_workers(db, str(dump), limit=1)
    assert stats["imported"] == 1


async def test_limit_truncated_run_reports_no_malformed(tmp_path, db):
    # Regression: malformed used to be computed as (raw_count - parsed_count),
    # which counted rows never scanned past `limit` as malformed. All three
    # rows here are well-formed; only one is ever scanned.
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(1, "A", "A", "a@example.com"),
        _person_values(2, "B", "B", "b@example.com"),
        _person_values(3, "C", "C", "c@example.com"),
    ))
    stats = await import_workers(db, str(dump), limit=1)
    assert stats["imported"] == 1
    assert stats["malformed"] == 0


async def test_malformed_people_row_is_counted(tmp_path, db):
    extra = "INSERT INTO people (id) VALUES (99);\n"
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(1, "A", "A", "a@example.com"), extra=extra))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["malformed"] == 1
    assert stats["imported"] == 1


async def test_partner_in_dump_but_not_in_v3_notes_and_no_partner_id(
        tmp_path, db):
    extra = (
        "INSERT INTO partners (id, partner_name, partner_services, "
        "partner_region, parent_partner) VALUES "
        "(5, 'Nowhere Partners', NULL, NULL, NULL);\n")
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(1, "Orphan", "Ed", "orphan@example.com", partner="5"),
        extra=extra,
    ))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["imported"] == 1
    person = await db.scalar(
        select(Person).where(Person.email == "orphan@example.com"))
    assert "V2 partner not in V3: Nowhere Partners" in (person.notes or "")
    profile = await db.get(WorkerProfile, person.id)
    assert profile.partner_id is None
