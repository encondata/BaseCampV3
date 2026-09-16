"""Cascade delete: the schema walk that decides what else dies with a
reconcile target, and the endpoints that preview and run it."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, AuditLog, AuthSession,
    PendingDelete, Person, PersonRole, TimeEntry, UserAccount, WorkerProfile,
)
from serversherpa.devtools.cascade import plan_cascade
from serversherpa.security.passwords import hash_password
from tests.test_devtools import login, set_role


async def _developer(db, client, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    return await login(client)


async def _person_with_everything(db, *, first="Doomed", last="Person"):
    """A person carrying one row in each shape the walk must handle: a
    required dependent (user_accounts), a transitive dependent that FKs the
    dependent rather than the person (auth_sessions), a self-reference
    inside that table (replaced_by), plain required dependents, and a
    business record (time_entries)."""
    person = Person(first_name=first, last_name=last)
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email=f"{first.lower()}@test.example.com",
        password_hash=hash_password(
            "CorrectHorse9!",
            pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=person.id, role="staff"))
    db.add(WorkerProfile(person_id=person.id, status="active"))
    group = AccessGroup(name=f"Group {first}")
    db.add(group)
    await db.flush()
    db.add(AccessGroupMember(group_id=group.id, person_id=person.id))
    # approved_by=person.id (alongside person_id=person.id) makes this one
    # row both purged (via person_id) and cleared (via approved_by) —
    # the regression case for clear-before-purge ordering.
    db.add(TimeEntry(person_id=person.id, approved_by=person.id,
                     clock_in_at=datetime.now(UTC)))
    await db.flush()
    first_session = AuthSession(
        person_id=person.id, family_id=uuid.uuid4(), token_hash=f"{first}-a",
        expires_at=datetime.now(UTC))
    db.add(first_session)
    await db.flush()
    db.add(AuthSession(
        person_id=person.id, family_id=uuid.uuid4(), token_hash=f"{first}-b",
        expires_at=datetime.now(UTC), replaced_by=first_session.id,
        rotated_at=datetime.now(UTC)))
    db.add(AuditLog(actor_person_id=person.id, entity_type="person",
                    entity_id=str(person.id), action="person.create", changes={}))
    await db.commit()
    return person


def _step(plan, table, column=None):
    for s in plan.steps:
        if s.table == table and (column is None or s.column == column):
            return s
    return None


async def test_plan_classifies_every_reference_shape(db, seeded_user):
    person = await _person_with_everything(db)

    plan = await plan_cascade(db, Person, person.id,
                              entity_type="person", label="Doomed Person")

    assert plan.blocked == []
    # required dependents are purged
    for table in ("user_accounts", "person_roles", "worker_profiles",
                  "access_group_members", "time_entries"):
        step = _step(plan, table)
        assert step is not None, f"{table} missing from plan"
        assert step.action == "purge", f"{table} should purge, got {step.action}"
    # auth_sessions FKs user_accounts.person_id, not people.id — depth 1
    sessions = _step(plan, "auth_sessions", "person_id")
    assert sessions is not None and sessions.action == "purge"
    assert sessions.depth == 1
    assert sessions.count == 2
    # the self-reference inside auth_sessions needs no step at all: both
    # rows are purged by the same DELETE statement, so the plain NO ACTION
    # foreign key on replaced_by is satisfied without ever nulling it
    assert _step(plan, "auth_sessions", "replaced_by") is None
    # nullable provenance columns are cleared
    assert _step(plan, "audit_log").action == "clear"
    assert plan.total_rows_deleted >= 7


async def test_plan_reports_database_handled_foreign_keys(db, seeded_user):
    """notification_group_members.person_id declares ON DELETE CASCADE, so
    the database removes it — the plan must say so instead of purging it."""
    from serversherpa.db.models import NotificationGroup, NotificationGroupMember

    person = Person(first_name="Notified", last_name="Person")
    db.add(person)
    group = NotificationGroup(
        name="Ops", description="", channels=["email"],
        timezone="America/New_York", active_days=["mon"],
        dnd_behavior="defer", urgent_bypass=False, enabled=True)
    db.add_all([person, group])
    await db.flush()
    db.add(NotificationGroupMember(group_id=group.id, person_id=person.id))
    await db.commit()

    plan = await plan_cascade(db, Person, person.id,
                              entity_type="person", label="Notified Person")

    step = _step(plan, "notification_group_members", "person_id")
    assert step is not None
    assert step.action == "db_cascade"
    assert step.count == 1


async def test_plan_never_purges_the_audit_log(db, seeded_user):
    person = Person(first_name="Audited", last_name="Person")
    db.add(person)
    await db.flush()
    db.add(AuditLog(actor_person_id=person.id, entity_type="person",
                    entity_id=str(person.id), action="person.update", changes={}))
    await db.commit()

    plan = await plan_cascade(db, Person, person.id,
                              entity_type="person", label="Audited Person")

    step = _step(plan, "audit_log")
    assert step.action == "clear"
    assert all(s.action != "purge" or s.table != "audit_log" for s in plan.steps)


async def test_plan_refuses_to_take_another_deletable_record_with_it(db, seeded_user):
    """Nothing in today's schema requires one reconcile-able entity to point
    at another, so this pins the guard directly: name a table the walk will
    reach as protected and it must refuse rather than purge."""
    person = await _person_with_everything(db, first="Protected")

    plan = await plan_cascade(
        db, Person, person.id, entity_type="person", label="Protected Person",
        protected_tables=frozenset({"user_accounts"}))

    assert any("user_accounts" in reason for reason in plan.blocked)
    assert _step(plan, "user_accounts") is None


async def test_plan_blocks_when_depth_is_exhausted(db, seeded_user):
    person = await _person_with_everything(db, first="Shallow")

    plan = await plan_cascade(db, Person, person.id, entity_type="person",
                              label="Shallow Person", max_depth=0)

    assert plan.blocked != []
    assert any("depth" in reason.lower() for reason in plan.blocked)


async def test_execute_removes_exactly_the_planned_rows(db, seeded_user):
    from sqlalchemy import delete as sa_delete

    from serversherpa.devtools.cascade import execute_cascade

    doomed = await _person_with_everything(db, first="Doomed")
    keeper = await _person_with_everything(db, first="Keeper")

    result = await execute_cascade(db, Person, doomed.id)
    # ORM-level delete (not Person.__table__): this synchronizes the
    # session so the identity map's cached `doomed` doesn't shadow the
    # deletion for the db.get() below.
    await db.execute(sa_delete(Person).where(Person.id == doomed.id))
    await db.commit()

    assert result["deleted_rows"]["user_accounts"] == 1
    assert result["deleted_rows"]["auth_sessions"] == 2
    assert result["deleted_rows"]["time_entries"] == 1
    # time_entries.approved_by=person.id on the person's own time entry (see
    # _person_with_everything) is both cleared and, on the same row,
    # purged via person_id — this only comes out right if clears run
    # before purges, which is exactly what this pins down.
    assert result["cleared_references"]["time_entries.approved_by"] == 1
    assert result["cleared_references"]["audit_log.actor_person_id"] == 1
    assert await db.get(Person, doomed.id) is None
    for model, col in ((UserAccount, UserAccount.person_id),
                       (PersonRole, PersonRole.person_id),
                       (WorkerProfile, WorkerProfile.person_id),
                       (AccessGroupMember, AccessGroupMember.person_id),
                       (TimeEntry, TimeEntry.person_id),
                       (AuthSession, AuthSession.person_id)):
        assert (await db.scalars(select(model).where(col == doomed.id))).first() is None
    # the untouched neighbour keeps every one of its rows
    for model, col in ((UserAccount, UserAccount.person_id),
                       (PersonRole, PersonRole.person_id),
                       (TimeEntry, TimeEntry.person_id)):
        assert (await db.scalars(select(model).where(col == keeper.id))).first() is not None
    assert (await db.scalars(
        select(AuthSession).where(AuthSession.person_id == keeper.id))).all()


async def test_execute_refuses_a_blocked_plan(db, seeded_user):
    from serversherpa.devtools.cascade import CascadeBlocked, execute_cascade

    person = await _person_with_everything(db, first="Blocked")

    try:
        await execute_cascade(db, Person, person.id, max_depth=0)
    except CascadeBlocked as exc:
        assert exc.reasons != []
    else:
        raise AssertionError("expected CascadeBlocked")

    # execute_cascade refuses before issuing a single statement, so there
    # is nothing to roll back — the person and account are untouched as-is.
    assert await db.get(Person, person.id) is not None
    assert (await db.scalars(
        select(UserAccount).where(UserAccount.person_id == person.id))).first() is not None


async def _marker(db, person, label):
    marker = PendingDelete(entity_type="person", entity_id=person.id,
                           entity_label=label)
    db.add(marker)
    await db.commit()
    return marker


async def test_preview_lists_the_plan(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    person = await _person_with_everything(db, first="Preview")
    marker = await _marker(db, person, "Preview Person")

    resp = await client.get(
        f"/devtools/pending-deletes/{marker.id}/cascade-preview", headers=hdrs)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["label"] == "Preview Person"
    assert body["blocked"] == []
    assert body["total_rows_deleted"] >= 7
    by_table = {(s["table"], s["column"]): s for s in body["steps"]}
    assert by_table[("user_accounts", "person_id")]["action"] == "purge"
    assert by_table[("auth_sessions", "person_id")]["depth"] == 1
    assert by_table[("audit_log", "actor_person_id")]["action"] == "clear"
    # purges sort ahead of clears so the destructive rows read first
    assert body["steps"][0]["action"] == "purge"


async def test_preview_404s_for_an_unknown_marker(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get(
        f"/devtools/pending-deletes/{uuid.uuid4()}/cascade-preview", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "marker_not_found"


async def test_cascade_delete_destroys_everything_and_audits(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    person = await _person_with_everything(db, first="Gone")
    marker = await _marker(db, person, "Gone Person")
    person_id, marker_id = person.id, marker.id

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/cascade-delete", headers=hdrs,
        json={"confirm_label": "Gone Person"})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"deleted": 1, "failed": []}
    # the delete ran in the API's own session; ours still holds the
    # pre-delete identity map (expire_on_commit=False), same as every
    # other post-reconcile db.get() check in test_pending_deletes_api.py.
    # The ids are read above, before expiring, so accessing them below
    # doesn't itself trigger a synchronous refresh of an expired instance.
    db.expire_all()
    assert await db.get(Person, person_id) is None
    assert await db.get(PendingDelete, marker_id) is None
    assert (await db.scalars(
        select(AuthSession).where(AuthSession.person_id == person_id))).first() is None

    log = await db.scalar(
        select(AuditLog).where(AuditLog.action == "cascade_delete"))
    assert log is not None
    assert log.entity_id == str(person_id)
    assert log.changes["label"] == "Gone Person"
    assert log.changes["deleted_rows"]["user_accounts"] == 1


async def test_cascade_delete_requires_the_exact_label(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    person = await _person_with_everything(db, first="Safe")
    marker = await _marker(db, person, "Safe Person")
    person_id, marker_id = person.id, marker.id

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/cascade-delete", headers=hdrs,
        json={"confirm_label": "safe person"})

    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "label_mismatch"
    assert await db.get(Person, person_id) is not None

    # surrounding whitespace is forgiven
    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/cascade-delete", headers=hdrs,
        json={"confirm_label": "  Safe Person  "})
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert await db.get(Person, person_id) is None


async def test_cascade_delete_refuses_a_marker_without_a_label(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    person = await _person_with_everything(db, first="Nameless")
    marker = await _marker(db, person, "")

    resp = await client.post(
        f"/devtools/pending-deletes/{marker.id}/cascade-delete", headers=hdrs,
        json={"confirm_label": ""})

    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "label_unavailable"
    assert await db.get(Person, person.id) is not None


async def test_references_report_marks_database_handled_foreign_keys(
        client, db, seeded_user):
    """The failure list used to present an ON DELETE CASCADE reference as a
    blocker; it never was."""
    from serversherpa.db.models import NotificationGroup, NotificationGroupMember

    hdrs = await _developer(db, client, seeded_user)
    person = Person(first_name="Reported", last_name="Person")
    group = NotificationGroup(
        name="Ops2", description="", channels=["email"],
        timezone="America/New_York", active_days=["mon"],
        dnd_behavior="defer", urgent_bypass=False, enabled=True)
    db.add_all([person, group])
    await db.flush()
    db.add(NotificationGroupMember(group_id=group.id, person_id=person.id))
    db.add(PersonRole(person_id=person.id, role="staff"))
    marker = await _marker(db, person, "Reported Person")

    resp = await client.post(
        f"/devtools/pending-deletes/{marker.id}/reconcile", headers=hdrs)

    failure = resp.json()["failed"][0]
    refs = {(r["table"], r["column"]): r for r in failure["references"]}
    assert refs[("notification_group_members", "person_id")]["db_handled"] is True
    assert refs[("person_roles", "person_id")]["db_handled"] is False


async def test_cascade_delete_404s_for_an_unknown_marker(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post(
        f"/devtools/pending-deletes/{uuid.uuid4()}/cascade-delete", headers=hdrs,
        json={"confirm_label": "whatever"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "marker_not_found"


async def test_cascade_delete_409s_when_the_plan_is_blocked(client, db, seeded_user):
    """processed_scans.person_id is nullable but check-guarded by
    processed_scans_match_target_chk (a scan matched to a person can't have
    its person_id nulled without tripping the CHECK), so collect_levels
    refuses it outright — a real block, nothing mocked."""
    from datetime import UTC, datetime

    from serversherpa.db.models import ProcessedScan

    hdrs = await _developer(db, client, seeded_user)
    person = Person(first_name="Blocked", last_name="Person")
    db.add(person)
    await db.flush()
    db.add(ProcessedScan(
        scanned_value="x", scan_type="rfid", scanned_at=datetime.now(UTC),
        match_type="person", person_id=person.id, processed_at=datetime.now(UTC)))
    marker = await _marker(db, person, "Blocked Person")
    person_id, marker_id = person.id, marker.id

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/cascade-delete", headers=hdrs,
        json={"confirm_label": "Blocked Person"})

    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "cascade_blocked"
    assert detail["reasons"]
    assert any("processed_scans" in reason for reason in detail["reasons"])

    db.expire_all()
    assert await db.get(Person, person_id) is not None
    assert await db.get(PendingDelete, marker_id) is not None
    assert await db.scalar(
        select(AuditLog).where(AuditLog.action == "cascade_delete")) is None


async def test_cascade_delete_rolls_back_the_audit_row_on_fk_violation(
        client, db, seeded_user, monkeypatch):
    """A seam, not a fake exception: execute_cascade is monkeypatched to a
    no-op, so the target's own required person_roles dependent is left
    behind and Postgres raises a real fk_violation deleting the person row.
    The empty audit-row check is the point of this test — it proves the
    audit row the try block would otherwise write is rolled back with
    everything else in the failed savepoint, not left dangling."""
    from serversherpa.api.routes import devtools as devtools_routes

    async def _noop_cascade(db, model, entity_id, **kwargs):
        return {"deleted_rows": {}, "cleared_references": {}}

    monkeypatch.setattr(devtools_routes, "execute_cascade", _noop_cascade)

    hdrs = await _developer(db, client, seeded_user)
    person = Person(first_name="Poisoned", last_name="Person")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="staff"))
    marker = await _marker(db, person, "Poisoned Person")
    person_id, marker_id = person.id, marker.id

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/cascade-delete", headers=hdrs,
        json={"confirm_label": "Poisoned Person"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == 0
    assert len(body["failed"]) == 1
    failure = body["failed"][0]
    assert failure["reason"] == "fk_violation"
    refs = {(r["table"], r["column"]) for r in failure["references"]}
    assert ("person_roles", "person_id") in refs

    db.expire_all()
    assert await db.get(Person, person_id) is not None
    assert await db.get(PendingDelete, marker_id) is not None
    assert await db.scalar(
        select(AuditLog).where(AuditLog.action == "cascade_delete")) is None
