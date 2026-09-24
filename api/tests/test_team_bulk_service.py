"""Bulk assign people to a job (no HTTP): parse, resolve, preview, commit."""
from sqlalchemy import func, select

from serversherpa.db.models import (
    AuditLog, Initiative, InitiativePerson, Person, PersonRole, Site,
)
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people import team_bulk as tb


async def mk_job(db, name="Move A", archived=False):
    job = Initiative(name=name, initiative_type="move",
                     archived_at=func.now() if archived else None)
    db.add(job)
    await db.commit()
    return job


async def mk_worker(db, first, last, preferred=None, email=None, role="worker",
                    archived=False, revoked=False):
    p = Person(first_name=first, last_name=last, preferred_name=preferred, email=email,
               archived_at=func.now() if archived else None)
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role=role,
                      revoked_at=func.now() if revoked else None))
    await db.commit()
    return p


async def mk_site(db, name, archived=False):
    s = Site(name=name, archived_at=func.now() if archived else None)
    db.add(s)
    await db.commit()
    return s


async def assign(db, job, person, site=None, role=None):
    db.add(InitiativePerson(initiative_id=job.id, person_id=person.id,
                            site_worked_id=site.id if site else None, work_type=role))
    await db.commit()


async def preview(db, job, rows, **kw):
    return await tb.preview_rows(db, job.id, tb.number_json_rows(rows), **kw)


async def commit(db, actor, job, rows, *, overrides=None, skip=(), approved=(),
                 source="team.csv"):
    return await tb.commit_rows(db, actor.id, job.id, tb.number_json_rows(rows),
                                overrides=overrides or {}, skip=set(skip),
                                approved_updates=set(approved), source_label=source)


def by_row(result):
    return {r["row"]: r for r in result["rows"]}


# ── shape / parsing ─────────────────────────────────────────────────

def test_columns_and_template_round_trip():
    assert tb.COLUMNS == ["worker", "site", "role"]
    from_csv = tb.parse_upload("t.csv", tb.build_template_csv().encode())
    assert [r for _, r in from_csv] == [r for _, r in tb.number_json_rows(tb.SAMPLE_ROWS)]
    assert [n for n, _ in from_csv] == [2, 3]


def test_number_posted_rows_keeps_spreadsheet_numbers():
    rows = [{"worker": "A B"}, {"worker": "C D"}]
    assert [n for n, _ in tb.number_posted_rows(rows, [5, 9])] == [5, 9]
    assert [n for n, _ in tb.number_posted_rows(rows, None)] == [1, 2]
    for bad in ([5], [5, 5], ["5", 9], "x"):
        try:
            tb.number_posted_rows(rows, bad)
        except BulkImportError as exc:
            assert exc.code == "invalid_row_numbers"
        else:
            raise AssertionError(bad)


def test_parse_overrides_and_row_lists():
    assert tb.parse_overrides({"3": {"worker": "abc", "role": "lead"}}) == {
        3: {"worker": "abc", "role": "lead"}}
    assert tb.parse_overrides(None) == {}
    for bad in ([], {"x": {}}, {"3": {"nope": "a"}}, {"3": {"worker": 7}}):
        try:
            tb.parse_overrides(bad)
        except BulkImportError as exc:
            assert exc.code == "invalid_overrides"
        else:
            raise AssertionError(bad)
    assert tb.parse_row_list([2, 3], "invalid_skip") == {2, 3}
    assert tb.parse_row_list(None, "invalid_skip") == set()


# ── preview ─────────────────────────────────────────────────────────

async def test_add_update_unchanged(db, seeded_user):
    job = await mk_job(db)
    east, west = await mk_site(db, "DC East"), await mk_site(db, "DC West")
    ana = await mk_worker(db, "Ana", "Lopez")
    ben = await mk_worker(db, "Ben", "Ng")
    cy = await mk_worker(db, "Cy", "Park")
    await assign(db, job, ben, east, "tech")
    await assign(db, job, cy, east, "tech")
    res = await preview(db, job, [
        {"worker": "ana lopez", "site": "DC West", "role": "Lead"},
        {"worker": "Ben  Ng", "site": "DC West", "role": ""},
        {"worker": "Cy Park", "site": "", "role": "TECH"},
    ])
    rows = by_row(res)
    assert rows[1]["action"] == "add" and rows[1]["person_id"] == str(ana.id)
    assert rows[1]["site_id"] == str(west.id) and rows[1]["role_key"] == "lead"
    assert rows[2]["action"] == "update"
    assert rows[2]["diff"] == {"site": {"old": "DC East", "new": "DC West"}}
    assert rows[3]["action"] == "unchanged"
    assert res["can_commit"] is True
    assert res["counts"] == {"add": 1, "update": 1, "unchanged": 1, "attention": 0,
                             "error": 0, "skipped": 0}


async def test_preferred_name_matches(db, seeded_user):
    job = await mk_job(db)
    await mk_worker(db, "Robert", "Stone", preferred="Bob")
    row = (await preview(db, job, [{"worker": "Bob Stone"}]))["rows"][0]
    assert row["action"] == "add"


async def test_unknown_and_ambiguous_need_attention(db, seeded_user):
    job = await mk_job(db)
    j1 = await mk_worker(db, "Jimmy", "Henderson", email="j1@x.test")
    j2 = await mk_worker(db, "Jimmy", "Henderson", email="j2@x.test")
    await mk_site(db, "Dup Site")
    await mk_site(db, "Dup Site")
    res = await preview(db, job, [
        {"worker": "Jimmy Henderson", "site": "Dup Site", "role": "wizard"},
        {"worker": "Nobody Here"},
    ])
    rows = by_row(res)
    assert rows[1]["action"] == "attention"
    kinds = {(i["field"], i["kind"]) for i in rows[1]["issues"]}
    assert kinds == {("worker", "ambiguous"), ("site", "ambiguous"), ("role", "unknown")}
    worker_issue = next(i for i in rows[1]["issues"] if i["field"] == "worker")
    assert {c["id"] for c in worker_issue["candidates"]} == {str(j1.id), str(j2.id)}
    assert {c["detail"] for c in worker_issue["candidates"]} == {"j1@x.test", "j2@x.test"}
    assert rows[2]["action"] == "attention"
    assert rows[2]["issues"] == [{"field": "worker", "kind": "unknown", "value": "Nobody Here",
                                  "candidates": []}]
    assert res["can_commit"] is False


async def test_archived_or_non_worker_people_do_not_match(db, seeded_user):
    job = await mk_job(db)
    await mk_worker(db, "Old", "Timer", archived=True)
    await mk_worker(db, "Ex", "Worker", revoked=True)
    await mk_worker(db, "Only", "Staff", role="staff")
    await mk_site(db, "Closed DC", archived=True)
    res = await preview(db, job, [{"worker": "Old Timer"}, {"worker": "Ex Worker"},
                                  {"worker": "Only Staff"},
                                  {"worker": "Old Timer", "site": "Closed DC"}])
    assert all(r["action"] == "attention" for r in res["rows"])


async def test_overrides_resolve_rows(db, seeded_user):
    job = await mk_job(db)
    j1 = await mk_worker(db, "Jimmy", "Henderson")
    await mk_worker(db, "Jimmy", "Henderson")
    site = await mk_site(db, "DC East")
    res = await preview(db, job, [{"worker": "Jimmy Henderson", "site": "DC Est", "role": "ld"}],
                        overrides={1: {"worker": str(j1.id), "site": str(site.id), "role": "lead"}})
    row = res["rows"][0]
    assert row["action"] == "add" and row["person_id"] == str(j1.id)
    assert row["site_id"] == str(site.id) and row["role_key"] == "lead"


async def test_bad_override_is_an_error(db, seeded_user):
    job = await mk_job(db)
    await mk_worker(db, "Ana", "Lopez")
    res = await preview(db, job, [{"worker": "Ana Lopez"}],
                        overrides={1: {"site": "00000000-0000-0000-0000-000000000000"}})
    assert res["rows"][0]["action"] == "error"
    assert "no longer exists" in res["rows"][0]["errors"][0]


async def test_duplicate_worker_in_file_including_via_override(db, seeded_user):
    job = await mk_job(db)
    ana = await mk_worker(db, "Ana", "Lopez")
    await mk_worker(db, "Ben", "Ng")
    res = await preview(db, job, [{"worker": "Ana Lopez"}, {"worker": "Ben Ng"},
                                  {"worker": "Typo Name"}],
                        overrides={3: {"worker": str(ana.id)}})
    rows = by_row(res)
    assert rows[1]["action"] == "error" and rows[3]["action"] == "error"
    assert "more than one row" in rows[1]["errors"][0]
    assert rows[2]["action"] == "add"


async def test_blank_worker_is_an_error_and_skip_wins(db, seeded_user):
    job = await mk_job(db)
    res = await preview(db, job, [{"site": "X"}, {"worker": "Nobody"}], skip={2})
    rows = by_row(res)
    assert rows[1]["action"] == "error" and rows[1]["errors"] == ["worker is required"]
    assert rows[2]["action"] == "skipped"


async def test_export_round_trips_as_unchanged(db, seeded_user):
    job = await mk_job(db)
    east = await mk_site(db, "DC East")
    ana = await mk_worker(db, "Ana", "Lopez")
    ben = await mk_worker(db, "Ben", "Ng")
    await assign(db, job, ana, east, "lead")
    await assign(db, job, ben)
    exported = await tb.export_rows(db, job.id)
    assert exported == [{"worker": "Ana Lopez", "site": "DC East", "role": "Lead"},
                        {"worker": "Ben Ng", "site": "", "role": ""}]
    res = await preview(db, job, exported)
    assert [r["action"] for r in res["rows"]] == ["unchanged", "unchanged"]


# ── commit ──────────────────────────────────────────────────────────

async def test_commit_adds_and_approved_updates_only(db, seeded_user):
    job = await mk_job(db)
    east, west = await mk_site(db, "DC East"), await mk_site(db, "DC West")
    ana = await mk_worker(db, "Ana", "Lopez")
    ben = await mk_worker(db, "Ben", "Ng")
    cy = await mk_worker(db, "Cy", "Park")
    await assign(db, job, ben, east, "tech")
    await assign(db, job, cy, east, "tech")
    rows = [{"worker": "Ana Lopez", "site": "DC West", "role": "lead"},
            {"worker": "Ben Ng", "site": "DC West"},
            {"worker": "Cy Park", "role": "lead"}]
    out = await commit(db, seeded_user, job, rows, approved={2})
    assert (out["created"], out["updated"], out["skipped"], out["unchanged"]) == (1, 1, 1, 0)
    assert [r["action"] for r in out["rows"]] == ["created", "updated", "skipped"]
    assert out["rows"][0]["name"] == "Ana Lopez"
    team = {tp.person_id: tp for tp in await db.scalars(
        select(InitiativePerson).where(InitiativePerson.initiative_id == job.id))}
    await db.refresh(team[ben.id])
    await db.refresh(team[cy.id])
    assert team[ana.id].site_worked_id == west.id and team[ana.id].work_type == "lead"
    assert team[ben.id].site_worked_id == west.id and team[ben.id].work_type == "tech"
    assert team[cy.id].work_type == "tech"      # not approved → untouched
    actions = [a.action for a in await db.scalars(
        select(AuditLog).where(AuditLog.entity_id == str(job.id)))]
    assert sorted(actions) == ["bulk_import", "person_add", "person_update"]


async def test_commit_refuses_unresolved_and_writes_nothing(db, seeded_user):
    job = await mk_job(db)
    await mk_worker(db, "Ana", "Lopez")
    try:
        await commit(db, seeded_user, job, [{"worker": "Ana Lopez"}, {"worker": "Nobody"}])
    except BulkImportError as exc:
        assert exc.code == "rows_invalid"
        assert {r["action"] for r in exc.extra["rows"]} == {"add", "attention"}
    else:
        raise AssertionError("expected rows_invalid")
    count = await db.scalar(select(func.count()).select_from(InitiativePerson))
    assert count == 0


async def test_commit_with_override_and_skip(db, seeded_user):
    job = await mk_job(db)
    ana = await mk_worker(db, "Ana", "Lopez")
    out = await commit(db, seeded_user, job,
                       [{"worker": "Anna Lopes"}, {"worker": "Nobody"}],
                       overrides={1: {"worker": str(ana.id)}}, skip={2})
    assert (out["created"], out["skipped"]) == (1, 1)
    assert await db.scalar(select(func.count()).select_from(InitiativePerson)) == 1
