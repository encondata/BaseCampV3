"""Test harness: runs against a dedicated serversherpa_test database on the
local dev Postgres, migrated to head. Tables are truncated between tests."""

import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url

API_DIR = Path(__file__).resolve().parents[1]
TEST_DB = "serversherpa_test"


def _prepare_environment() -> None:
    """Point SS_DATABASE_URL at serversherpa_test (creating it if needed) and
    migrate it to head. Runs once, before serversherpa.config is first used."""
    from serversherpa.config import Settings, get_settings

    base_url = make_url(Settings().database_url.get_secret_value())

    admin = base_url.set(drivername="postgresql")
    with psycopg.connect(admin.render_as_string(hide_password=False),
                         autocommit=True) as conn:
        row = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (TEST_DB,)).fetchone()
        if row is None:
            conn.execute(f'CREATE DATABASE "{TEST_DB}"')

    test_url = base_url.set(database=TEST_DB).render_as_string(hide_password=False)
    os.environ["SS_DATABASE_URL"] = test_url
    get_settings.cache_clear()

    subprocess.run(
        [str(API_DIR / ".venv/bin/alembic"), "upgrade", "head"],
        cwd=API_DIR, env={**os.environ}, check=True, capture_output=True,
    )


_prepare_environment()


@pytest.fixture(autouse=True)
async def clean_db():
    """Truncate mutable tables before each test (roles seed is preserved),
    and dispose the engine after so no pool outlives its event loop."""
    from serversherpa.db.engine import dispose_engine, get_sessionmaker

    async with get_sessionmaker()() as session:
        await session.execute(text(
            "TRUNCATE auth_sessions, person_roles, user_accounts, clients, "
            "partners, people, access_groups, access_group_members, "
            "resource_group_gates, permission_overrides, audit_log, "
            "contact_profiles, sites, site_clients CASCADE"))
        # role matrix is editable seed data — restore defaults & drop customs
        await session.execute(text("DELETE FROM roles WHERE is_system = false"))
        await session.execute(text("DELETE FROM role_permissions"))
        from serversherpa.access.defaults import seed_default_grants
        await seed_default_grants(session)
        # worker_levels is editable seed data — restore canonical titles so
        # the admin-edit test can't pollute later runs
        await session.execute(text("""
            UPDATE worker_levels AS wl
            SET title = v.title, description = '', expected_skills = '[]'::jsonb
            FROM (VALUES
              ('L1','Apprentice'),('L2','Junior Tech'),('L3','Technician'),
              ('L4','Senior Tech'),('L5','Specialist'),('L6','Master')
            ) AS v(level, title)
            WHERE wl.level = v.level
        """))
        # status_values is editable seed data AND createable — drop customs,
        # then restore canonical values so an admin-edit test can't pollute
        # later runs. Values match migration 0012's seeds.
        await session.execute(text("""
            DELETE FROM status_values WHERE (record_type, key) NOT IN (
              ('site','active'),('site','planned'),('site','inactive'),
              ('site','decommissioned'),
              ('worker','active'),('worker','standby'),('worker','blacklist')
            )
        """))
        await session.execute(text("""
            UPDATE status_values AS sv
            SET label = v.label, description = v.description,
                color = v.color, sort_order = v.sort_order, is_active = true
            FROM (VALUES
              ('site','active','Active','In service.','c-green',1),
              ('site','planned','Planned','Not yet in service.','c-aqua',2),
              ('site','inactive','Inactive','Temporarily out of service.','c-slate',3),
              ('site','decommissioned','Decommissioned','Retired; retained for history.','c-red',4),
              ('worker','active','Active','Available for dispatch.','c-green',1),
              ('worker','standby','Standby','Temporarily unavailable.','c-amber',2),
              ('worker','blacklist','Blacklist','Do not dispatch; reason required.','c-red',3)
            ) AS v(record_type, key, label, description, color, sort_order)
            WHERE sv.record_type = v.record_type AND sv.key = v.key
        """))
        await session.execute(text("""
            UPDATE site_types AS st
            SET label = v.label, description = v.description,
                sort_order = v.sort_order, icon = v.icon
            FROM (VALUES
              ('datacenter','Data centre','Colocation or owned data centre space.',1,'server'),
              ('office','Office','Corporate or branch office.',2,'building'),
              ('warehouse','Warehouse','Storage or staging facility.',3,'box'),
              ('colo','Colocation','Shared colocation floor.',4,'server'),
              ('partner_office','Partner office','Facility operated by a partner.',5,'handshake'),
              ('other','Other','Anything that does not fit the other types.',6,'pin')
            ) AS v(key, label, description, sort_order, icon) WHERE st.key = v.key
        """))
        await session.commit()
    yield
    await dispose_engine()


@pytest.fixture
async def client():
    from httpx import ASGITransport, AsyncClient

    from serversherpa.api.app import create_app

    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.fixture
async def db():
    from serversherpa.db.engine import get_sessionmaker

    async with get_sessionmaker()() as session:
        yield session


@pytest.fixture
async def seeded_user(db):
    """A ready-to-log-in staff user: alice@test.example.com / CorrectHorse9!"""
    from datetime import UTC, datetime

    from serversherpa.config import get_settings
    from serversherpa.db.models import Person, PersonRole, UserAccount
    from serversherpa.security.passwords import hash_password

    person = Person(first_name="Alice", last_name="Anderson",
                    email="alice@test.example.com")
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id,
        email="alice@test.example.com",
        password_hash=hash_password(
            "CorrectHorse9!",
            pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC),
    ))
    db.add(PersonRole(person_id=person.id, role="staff"))
    await db.commit()
    return person
