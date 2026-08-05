import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Person
from serversherpa.services.audit import audit, diff, snapshot


def test_diff_reports_only_changes_and_redacts():
    before = {"first_name": "Al", "phone": None, "password_hash": "aaa"}
    after = {"first_name": "Alice", "phone": None, "password_hash": "bbb"}
    d = diff(before, after)
    assert d == {"first_name": {"from": "Al", "to": "Alice"},
                 "password_hash": {"from": "[redacted]", "to": "[redacted]"}}


def test_snapshot_json_safe():
    import uuid as _uuid
    from datetime import UTC, datetime

    class Obj:
        name = "x"
        when = datetime(2026, 7, 14, tzinfo=UTC)
        ref = _uuid.UUID(int=1)
    s = snapshot(Obj(), ["name", "when", "ref"])
    assert s["name"] == "x"
    assert isinstance(s["when"], str) and isinstance(s["ref"], str)


async def test_audit_row_in_same_transaction(db):
    p = Person(first_name="A", last_name="B")
    db.add(p)
    await db.flush()
    audit(db, actor_id=p.id, entity_type="person", entity_id=str(p.id),
          action="create", changes={"first_name": {"from": None, "to": "A"}})
    await db.commit()
    row = await db.scalar(select(AuditLog))
    assert row.entity_type == "person" and row.action == "create"
    assert row.changes["first_name"]["to"] == "A"


async def test_audit_rolls_back_with_mutation(db):
    p = Person(first_name="A", last_name="B")
    db.add(p)
    await db.flush()
    audit(db, actor_id=p.id, entity_type="person", entity_id=str(p.id),
          action="update")
    await db.rollback()
    assert await db.scalar(select(AuditLog)) is None
