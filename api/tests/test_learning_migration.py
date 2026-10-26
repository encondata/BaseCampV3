"""Migration 0109: the learning portal's tables, the learning_admin role and
its grants, the widened notification category check, and the manager
helper (learning:<action> OR global wiki:delete)."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

TABLES = (
    "learning_documents", "learning_document_versions", "learning_translations",
    "learning_quiz_questions", "learning_packets", "learning_packet_items",
    "learning_rules", "learning_codes", "learning_sessions",
    "learning_assignments", "learning_signoffs", "learning_quiz_attempts",
    "learning_invite_schedules", "learning_email_log", "learning_overrides",
)


async def _person(db, first="Pat"):
    return await db.scalar(text(
        "INSERT INTO people (first_name, last_name) VALUES (:f, 'Tester') "
        "RETURNING id"), {"f": first})


async def _initiative(db):
    return await db.scalar(text(
        "INSERT INTO initiatives (name, initiative_type) VALUES (:n, 'move') RETURNING id"),
        {"n": f"init-{uuid.uuid4()}"})


async def _document(db):
    doc = await db.scalar(text(
        "INSERT INTO learning_documents (title) VALUES ('Safety') RETURNING id"))
    ver = await db.scalar(text(
        "INSERT INTO learning_document_versions "
        "(document_id, version_no, title, content_json, content_html, published_at) "
        "VALUES (:d, 1, 'Safety', '{}'::jsonb, '<p>x</p>', now()) RETURNING id"),
        {"d": doc})
    return doc, ver


async def _assign(db, person, doc, ver, initiative=None, status="assigned"):
    return await db.scalar(text(
        "INSERT INTO learning_assignments "
        "(person_id, initiative_id, document_id, version_id, source, status) "
        "VALUES (:p, :i, :d, :v, 'manual', :s) RETURNING id"),
        {"p": person, "i": initiative, "d": doc, "v": ver, "s": status})


async def test_learning_tables_exist(db):
    found = {r[0] for r in (await db.execute(text(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_name LIKE 'learning\\_%'"))).all()}
    assert set(TABLES) <= found
    cols = {r[0] for r in (await db.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'worker_certifications'"))).all()}
    assert {"source", "learning_initiative_id"} <= cols
    assert await db.scalar(text(
        "SELECT count(*) FROM information_schema.columns "
        "WHERE table_name = 'email_outbox' AND column_name = 'attachments'")) == 1


async def test_document_defaults_and_checks(db):
    doc = await db.scalar(text(
        "INSERT INTO learning_documents (title) VALUES ('d') RETURNING id"))
    row = (await db.execute(text(
        "SELECT resign_rule, sign_style, require_scroll, quiz_enabled, "
        "quiz_fail_action FROM learning_documents WHERE id = :i"), {"i": doc})).one()
    assert tuple(row) == ("expired_or_new_version", "typed_name", True, False, "retry")
    with pytest.raises(IntegrityError):
        await db.execute(text(
            "INSERT INTO learning_documents (title, quiz_pass_percent) VALUES ('x', 101)"))
    await db.rollback()


async def test_assignment_unique_ignores_cancelled(db):
    person = await _person(db)
    init = await _initiative(db)
    doc, ver = await _document(db)
    await _assign(db, person, doc, ver, init)
    with pytest.raises(IntegrityError):
        await _assign(db, person, doc, ver, init, status="opened")
    await db.rollback()

    person = await _person(db, "Quinn")
    init = await _initiative(db)
    doc, ver = await _document(db)
    await _assign(db, person, doc, ver, init, status="cancelled")
    await _assign(db, person, doc, ver, init)
    await db.commit()

    # a null initiative counts as one value, not as "always distinct"
    await _assign(db, person, doc, ver, None)
    with pytest.raises(IntegrityError):
        await _assign(db, person, doc, ver, None)
    await db.rollback()


async def _code(db, person, fingerprint, initiative=None, revoked=False):
    return await db.scalar(text(
        "INSERT INTO learning_codes (person_id, initiative_id, fingerprint, "
        "link_token_hash, revoked_at) VALUES (:p, :i, :f, :t, "
        "CASE WHEN :r THEN now() END) RETURNING id"),
        {"p": person, "i": initiative, "f": fingerprint,
         "t": uuid.uuid4().hex, "r": revoked})


async def test_code_fingerprint_unique_only_when_active(db):
    a, b = await _person(db, "A"), await _person(db, "B")
    await _code(db, a, b"fp-1")
    with pytest.raises(IntegrityError):
        await _code(db, b, b"fp-1")
    await db.rollback()

    a, b = await _person(db, "A"), await _person(db, "B")
    await _code(db, a, b"fp-2", revoked=True)
    await _code(db, b, b"fp-2")  # the revoked one no longer holds the fingerprint
    await db.commit()

    # one active code per person and initiative (null initiative = one value)
    c = await _person(db, "C")
    await _code(db, c, b"fp-3")
    with pytest.raises(IntegrityError):
        await _code(db, c, b"fp-4")
    await db.rollback()


async def test_email_log_unique_is_null_safe(db):
    person = await _person(db)
    sql = text("INSERT INTO learning_email_log (person_id, kind, stage) "
               "VALUES (:p, 'reminder', 'overdue')")
    await db.execute(sql, {"p": person})
    with pytest.raises(IntegrityError):
        await db.execute(sql, {"p": person})
    await db.rollback()


async def test_learning_admin_role_and_grants(db):
    row = (await db.execute(text(
        "SELECT rank, label, scope_anchor, is_system, color FROM roles "
        "WHERE name = 'learning_admin'"))).one()
    assert tuple(row) == (40, "Learning admin", "global", True, "c-violet")

    async def actions(role):
        return {r[0] for r in (await db.execute(text(
            "SELECT action FROM role_permissions WHERE role = :r AND resource = 'learning'"),
            {"r": role})).all()}

    full = {"view", "add", "change", "delete"}
    for role in ("developer", "founder", "super_admin", "admin", "learning_admin"):
        assert await actions(role) == full, role
    assert await actions("staff") == {"view"}
    assert await actions("worker") == set()


async def test_notification_category_learning_allowed(db):
    gid = await db.scalar(text(
        "INSERT INTO notification_groups (name, categories) "
        "VALUES (:n, ARRAY['learning','wiki']) RETURNING id"), {"n": f"g-{uuid.uuid4()}"})
    assert gid is not None
    await db.commit()
    with pytest.raises(DBAPIError):
        await db.execute(text(
            "INSERT INTO notification_groups (name, categories) "
            "VALUES (:n, ARRAY['bogus'])"), {"n": f"g-{uuid.uuid4()}"})
    await db.rollback()


async def _access_for(db, role):
    from serversherpa.access.resolver import resolve_access
    from serversherpa.db.models import PersonRole

    person = await _person(db, role)
    db.add(PersonRole(person_id=person, role=role))
    await db.commit()
    return await resolve_access(db, person)


async def test_is_manager_true_for_wiki_admin_and_learning_admin_false_for_worker(db):
    from serversherpa.learning.access import is_manager

    assert is_manager(await _access_for(db, "admin")) is True  # holds wiki:delete
    assert is_manager(await _access_for(db, "learning_admin")) is True
    assert is_manager(await _access_for(db, "learning_admin"), "change") is True
    assert is_manager(await _access_for(db, "worker")) is False
    staff = await _access_for(db, "staff")
    assert is_manager(staff) is True  # staff holds learning:view...
    assert is_manager(staff, "change") is False  # ...but not wiki:delete


async def test_require_manager_returns_context_or_403(db):
    from fastapi import HTTPException

    from serversherpa.learning.access import require_manager

    guard = require_manager("change").dependency

    class Ctx:
        def __init__(self, access):
            self.access = access

    ok = Ctx(await _access_for(db, "learning_admin"))
    assert await guard(ok) is ok
    with pytest.raises(HTTPException) as exc:
        await guard(Ctx(await _access_for(db, "worker")))
    assert exc.value.status_code == 403
    assert exc.value.detail == {"code": "forbidden"}


def test_wiki_delete_fallback_requires_a_global_anchor():
    from serversherpa.access.resolver import AccessInfo
    from serversherpa.learning.access import is_manager

    perms = {"wiki": {"delete": True}}
    assert is_manager(AccessInfo(perms=perms, is_global=False)) is False
    assert is_manager(AccessInfo(perms=perms, is_global=True)) is True
