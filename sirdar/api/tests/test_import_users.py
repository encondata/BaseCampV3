from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuthSession, ImportRun, Role, TotpBackupCode, User, UserRole
from sirdar_api.services import auth
from sirdar_api.services.import_users import (
    ImportNotConfigured, ImportSourceError, import_users,
)

from .factories import PASSWORD, make_user
from .source_helpers import add_portal_person, add_role, set_security


def _std_roles(conn):
    add_role(conn, "developer", 100)
    add_role(conn, "admin", 60, label="Administrator")
    add_role(conn, "staff", 40)
    add_role(conn, "client_owner", 70, scope="client")


async def _roles_of(db, pid) -> set[str]:
    return set(await db.scalars(select(UserRole.role).where(UserRole.person_id == pid)))


async def test_imports_only_eligible_people(db, source):
    _std_roles(source)
    admin = add_portal_person(source, email="admin@test.example.com", roles=("admin", "staff"))
    add_portal_person(source, email="staff@test.example.com", roles=("staff",))
    add_portal_person(source, email="owner@test.example.com", roles=("client_owner",))
    add_portal_person(source, email="nopw@test.example.com", password=None)
    add_portal_person(source, email="off@test.example.com", disabled_at=datetime.now(UTC))
    add_portal_person(source, email="gone@test.example.com", archived=True)
    revoked = add_portal_person(source, email="rev@test.example.com", roles=())
    source.execute("INSERT INTO person_roles (person_id, role, revoked_at) "
                   "VALUES (%s, 'admin', now())", (revoked,))

    run = await import_users(db, actor_id=None, trigger="cli")
    assert run.status == "ok" and run.added == 1
    users = list(await db.scalars(select(User)))
    assert [u.email for u in users] == ["admin@test.example.com"]
    assert users[0].person_id == admin and users[0].source == "portal"
    assert await _roles_of(db, admin) == {"admin"}       # only eligible roles are mirrored


async def test_imported_user_can_sign_in_with_portal_password(db, source):
    _std_roles(source)
    add_portal_person(source, email="admin@test.example.com", password="PortalPass1!")
    await import_users(db, actor_id=None, trigger="cli")
    result = await auth.login(db, email="admin@test.example.com", password="PortalPass1!")
    assert result.user.email == "admin@test.example.com"


async def test_rerun_is_idempotent_and_updates(db, source):
    _std_roles(source)
    pid = add_portal_person(source, email="admin@test.example.com", first="Pat")
    await import_users(db, actor_id=None, trigger="cli")
    run2 = await import_users(db, actor_id=None, trigger="cli")
    assert (run2.added, run2.updated, run2.unchanged) == (0, 0, 1)
    source.execute("UPDATE people SET first_name = 'Patricia' WHERE id = %s", (pid,))
    run3 = await import_users(db, actor_id=None, trigger="cli")
    assert run3.updated == 1
    row = next(r for r in run3.rows if r["action"] == "updated")
    assert "first_name" in row["changes"]


async def test_demoted_user_is_disabled_and_sessions_revoked(db, source):
    _std_roles(source)
    pid = add_portal_person(source, email="admin@test.example.com", password=PASSWORD)
    await import_users(db, actor_id=None, trigger="cli")
    await auth.login(db, email="admin@test.example.com", password=PASSWORD)
    source.execute("UPDATE person_roles SET revoked_at = now() WHERE person_id = %s", (pid,))
    run = await import_users(db, actor_id=None, trigger="cli")
    assert run.disabled == 1
    user = await db.get(User, pid)
    await db.refresh(user)
    assert user.disabled_at is not None and user.disabled_reason == "not_eligible"
    live = list(await db.scalars(select(AuthSession).where(AuthSession.revoked_at.is_(None))))
    assert live == []
    # re-promoted: re-enabled
    source.execute("INSERT INTO person_roles (person_id, role) VALUES (%s, 'admin')", (pid,))
    run = await import_users(db, actor_id=None, trigger="cli")
    await db.refresh(user)
    assert user.disabled_at is None and run.updated == 1


async def test_local_users_untouched_and_email_collision_skipped(db, source):
    _std_roles(source)
    local = await make_user(db, email="admin@test.example.com", source="local",
                            roles=("developer",))
    add_portal_person(source, email="admin@test.example.com")
    run = await import_users(db, actor_id=None, trigger="cli")
    assert run.skipped == 1 and run.rows[0]["reason"] == "email_collision_local"
    await db.refresh(local)
    assert local.source == "local" and local.disabled_at is None


async def test_totp_policy_and_backup_codes_copied(db, source):
    _std_roles(source)
    set_security(source, {"two_factor_enabled": True})
    source.execute("UPDATE roles SET totp_required = true WHERE name = 'staff'")
    pid = add_portal_person(source, email="admin@test.example.com", roles=("admin", "staff"),
                            totp_secret_enc=b"seed-blob", totp_confirmed_at=datetime.now(UTC),
                            totp_last_counter=5)
    source.execute("INSERT INTO totp_backup_codes (person_id, code_hash) VALUES (%s, 'h1'), "
                   "(%s, 'h2')", (pid, pid))
    await import_users(db, actor_id=None, trigger="cli")
    user = await db.get(User, pid)
    assert user.totp_enabled and user.totp_required      # required via the staff role
    assert user.totp_secret_enc == b"seed-blob" and user.totp_last_counter == 5
    codes = list(await db.scalars(select(TotpBackupCode.code_hash)
                                  .where(TotpBackupCode.person_id == pid)))
    assert sorted(codes) == ["h1", "h2"]
    # a code used in Sirdar stays used; a higher Sirdar counter is kept
    code = await db.scalar(select(TotpBackupCode).where(TotpBackupCode.code_hash == "h1"))
    code.used_at = datetime.now(UTC)
    user.totp_last_counter = 99
    await db.commit()
    await import_users(db, actor_id=None, trigger="cli")
    await db.refresh(user)
    assert user.totp_last_counter == 99
    used = await db.scalar(select(TotpBackupCode.used_at).where(TotpBackupCode.code_hash == "h1"))
    assert used is not None


async def test_new_eligible_portal_role_is_added_without_permissions(db, source):
    _std_roles(source)
    add_role(source, "ops_chief", 70, label="Ops chief")
    add_portal_person(source, email="ops@test.example.com", roles=("ops_chief",))
    await import_users(db, actor_id=None, trigger="cli")
    role = await db.get(Role, "ops_chief")
    assert role is not None and role.rank == 70 and role.label == "Ops chief"


async def test_unreachable_source_records_failed_run_and_changes_nothing(db):
    with pytest.raises(ImportSourceError) as exc:
        await import_users(db, actor_id=None, trigger="web",
                           source_url="postgresql+asyncpg://nobody:x@127.0.0.1:1/nope")
    run = await db.get(ImportRun, exc.value.run_id)
    assert run.status == "failed" and run.error
    assert "nobody:x" not in run.error and "postgresql" not in run.error
    assert list(await db.scalars(select(User))) == []


async def test_apply_failure_rolls_back_and_records_failed_run(db, source, monkeypatch):
    from sirdar_api.db.models import AuditLog
    from sirdar_api.services import import_users as mod
    _std_roles(source)
    add_portal_person(source, email="admin@test.example.com")
    real_apply = mod._apply

    async def broken_apply(db_, snap, now):
        await real_apply(db_, snap, now)          # writes happen, then the run blows up
        await db_.flush()
        raise RuntimeError("boom")

    monkeypatch.setattr(mod, "_apply", broken_apply)
    with pytest.raises(RuntimeError):
        await import_users(db, actor_id=None, trigger="cli")
    run = await db.scalar(select(ImportRun))
    assert run.status == "failed" and "boom" in run.error and run.finished_at is not None
    assert list(await db.scalars(select(User))) == []
    actions = list(await db.scalars(select(AuditLog.action)))
    assert "users.import_failed" in actions


async def test_not_configured(db, monkeypatch):
    from sirdar_api.config import Settings, get_settings
    monkeypatch.delenv("SIRDAR_SOURCE_DATABASE_URL")
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    get_settings.cache_clear()
    try:
        with pytest.raises(ImportNotConfigured):
            await import_users(db, actor_id=None, trigger="cli")
    finally:
        get_settings.cache_clear()


def _by_pid(run) -> dict:
    out: dict = {}
    for r in run.rows:
        out.setdefault(r["person_id"], []).append(r)
    return out


async def test_email_swap_between_portal_admins(db, source):
    _std_roles(source)
    a = add_portal_person(source, email="a@test.example.com")
    b = add_portal_person(source, email="b@test.example.com")
    await import_users(db, actor_id=None, trigger="cli")
    source.execute("UPDATE user_accounts SET email = 'tmp@test.example.com' WHERE person_id = %s",
                   (a,))
    source.execute("UPDATE user_accounts SET email = 'a@test.example.com' WHERE person_id = %s",
                   (b,))
    source.execute("UPDATE user_accounts SET email = 'b@test.example.com' WHERE person_id = %s",
                   (a,))
    run = await import_users(db, actor_id=None, trigger="cli")
    assert (run.updated, run.disabled, run.skipped) == (2, 0, 0)
    ua, ub = await db.get(User, a), await db.get(User, b)
    await db.refresh(ua)
    await db.refresh(ub)
    assert ua.email == "b@test.example.com" and ub.email == "a@test.example.com"
    assert ua.disabled_at is None and ub.disabled_at is None
    assert all("email" in r["changes"] for r in run.rows)


async def test_email_freed_from_demoted_portal_user(db, source):
    _std_roles(source)
    a = add_portal_person(source, email="x@test.example.com")
    await import_users(db, actor_id=None, trigger="cli")
    source.execute("UPDATE person_roles SET revoked_at = now() WHERE person_id = %s", (a,))
    source.execute("UPDATE user_accounts SET email = 'old-x@test.example.com' "
                   "WHERE person_id = %s", (a,))
    c = add_portal_person(source, email="x@test.example.com")
    run = await import_users(db, actor_id=None, trigger="cli")
    rows = _by_pid(run)
    assert all(len(v) == 1 for v in rows.values()) and len(rows) == 2
    ra, rc = rows[str(a)][0], rows[str(c)][0]
    assert ra["action"] == "disabled" and ra["reason"] == "not_eligible"
    assert "email_released" in ra["changes"]
    assert rc["action"] == "added"
    ua = await db.get(User, a)
    await db.refresh(ua)
    assert ua.email == f"released+{a}@sirdar.invalid" and ua.disabled_at is not None
    assert (await db.get(User, c)).email == "x@test.example.com"
    # the next run leaves the already-disabled holder alone: no second row
    run2 = await import_users(db, actor_id=None, trigger="cli")
    assert str(a) not in _by_pid(run2) and run2.disabled == 0


async def test_email_freed_from_already_disabled_portal_user(db, source):
    _std_roles(source)
    a = add_portal_person(source, email="x@test.example.com")
    await import_users(db, actor_id=None, trigger="cli")
    source.execute("UPDATE person_roles SET revoked_at = now() WHERE person_id = %s", (a,))
    await import_users(db, actor_id=None, trigger="cli")          # a disabled, keeps x@
    source.execute("UPDATE user_accounts SET email = 'old-x@test.example.com' "
                   "WHERE person_id = %s", (a,))
    c = add_portal_person(source, email="x@test.example.com")
    run = await import_users(db, actor_id=None, trigger="cli")
    rows = _by_pid(run)
    assert list(rows) == [str(c)] and rows[str(c)][0]["action"] == "added"
    ua = await db.get(User, a)
    await db.refresh(ua)
    assert ua.email == f"released+{a}@sirdar.invalid"


async def test_skipped_person_not_also_disabled(db, source):
    _std_roles(source)
    a = add_portal_person(source, email="a@test.example.com")
    await import_users(db, actor_id=None, trigger="cli")
    await make_user(db, email="local@test.example.com", source="local", roles=("developer",))
    source.execute("UPDATE user_accounts SET email = 'local@test.example.com' "
                   "WHERE person_id = %s", (a,))
    run = await import_users(db, actor_id=None, trigger="cli")
    rows = _by_pid(run)
    assert len(rows[str(a)]) == 1
    assert rows[str(a)][0]["action"] == "skipped"
    assert rows[str(a)][0]["reason"] == "email_collision_local"
    assert run.disabled == 0
    ua = await db.get(User, a)
    await db.refresh(ua)
    assert ua.disabled_at is None and ua.email == "a@test.example.com"


async def test_import_copies_contact_fields_and_reports_changes(db, source):
    _std_roles(source)
    pid = add_portal_person(source, email="admin@test.example.com", person={
        "email": "pat.contact@example.com", "phone": "555-0100", "city": "Austin",
        "region": "TX", "postal_code": "78701", "address_line1": "1 Main St",
        "country": "CA"})
    await import_users(db, actor_id=None, trigger="cli")
    user = await db.get(User, pid)
    assert (user.contact_email, user.phone, user.city, user.country) == (
        "pat.contact@example.com", "555-0100", "Austin", "CA")
    assert user.address_line1 == "1 Main St" and user.postal_code == "78701"

    source.execute("UPDATE people SET phone = '555-0199' WHERE id = %s", (pid,))
    again = await import_users(db, actor_id=None, trigger="cli")
    assert again.updated == 1
    row = next(r for r in again.rows if r["person_id"] == str(pid))
    assert "phone" in row["changes"]
    await db.refresh(user)
    assert user.phone == "555-0199"
