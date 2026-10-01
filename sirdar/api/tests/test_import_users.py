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
    assert list(await db.scalars(select(User))) == []


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
