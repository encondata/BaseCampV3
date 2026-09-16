"""Cascade delete: the schema walk that decides what else dies with a
reconcile target, and the endpoints that preview and run it."""

import uuid
from datetime import UTC, datetime

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, AuditLog, AuthSession,
    Person, PersonRole, TimeEntry, UserAccount, WorkerProfile,
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
    db.add(TimeEntry(person_id=person.id, clock_in_at=datetime.now(UTC)))
    await db.flush()
    first_session = AuthSession(
        person_id=person.id, family_id=uuid.uuid4(), token_hash="a",
        expires_at=datetime.now(UTC))
    db.add(first_session)
    await db.flush()
    db.add(AuthSession(
        person_id=person.id, family_id=uuid.uuid4(), token_hash="b",
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
    # the self-reference inside auth_sessions is cleared, not purged
    replaced = _step(plan, "auth_sessions", "replaced_by")
    assert replaced is not None and replaced.action == "clear"
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
