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
# Override when parallel sessions/worktrees would otherwise fight over one
# test DB (they truncate between tests AND may sit on different migration
# heads — both collide): SS_TEST_DB=serversherpa_test_<branch> pytest …
TEST_DB = os.environ.get("SS_TEST_DB", "serversherpa_test")


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

# ── blast-radius guard ──────────────────────────────────────────────
# The suite TRUNCATEs data tables before every test. On 2026-08-28 a run
# escaped its sandbox and truncated the live dev database. These checks
# make that structurally impossible: the target database NAME must say
# it is a test database, both at configure time and again on the very
# connection that is about to truncate.
if not TEST_DB.startswith("serversherpa_test"):
    raise RuntimeError(
        f"refusing to run tests against database {TEST_DB!r} — "
        "SS_TEST_DB must start with 'serversherpa_test'")


@pytest.fixture(autouse=True)
async def clean_db():
    """Truncate mutable tables before each test (roles seed is preserved),
    and dispose the engine after so no pool outlives its event loop."""
    from serversherpa.db.engine import dispose_engine, get_sessionmaker

    async with get_sessionmaker()() as session:
        connected_db = await session.scalar(text("SELECT current_database()"))
        if not str(connected_db).startswith("serversherpa_test"):
            raise RuntimeError(
                f"refusing to TRUNCATE: connected to {connected_db!r}, "
                "not a serversherpa_test* database")
        await session.execute(text(
            "TRUNCATE auth_sessions, person_roles, user_accounts, clients, "
            "partners, people, access_groups, access_group_members, "
            "resource_group_gates, permission_overrides, audit_log, "
            "notification_groups, notification_group_members, "
            "contact_profiles, sites, site_clients, notes, assets, "
            "asset_model_aliases, asset_models, container_assets, "
            "log_entries, processes, "
            "initiative_links, initiative_people, initiatives, import_jobs, "
            "containers, pending_deletes CASCADE"))
        # role matrix is editable seed data — restore defaults & drop customs
        await session.execute(text("DELETE FROM roles WHERE is_system = false"))
        await session.execute(text("DELETE FROM role_permissions"))
        from serversherpa.access.defaults import seed_default_grants
        await seed_default_grants(session)
        # worker_levels is editable seed data AND createable — drop customs,
        # then restore canonical values so an admin-edit test can't pollute
        # later runs. rank is restored too: a create commits a rank shift
        # (UPDATE ... rank + 1), so without this L1-L6 stay permanently
        # shifted for every later test in the session.
        await session.execute(text(
            "DELETE FROM worker_levels WHERE level NOT IN "
            "('L1','L2','L3','L4','L5','L6')"))
        # The rank restore needs no SET CONSTRAINTS: worker_levels_rank_key is
        # DEFERRABLE (0013), so uniqueness is checked at statement end, and
        # this single UPDATE ends in a unique state even though it passes
        # through transient collisions row by row.
        await session.execute(text("""
            UPDATE worker_levels AS wl
            SET title = v.title, description = '', expected_skills = '[]'::jsonb,
                color = v.color, rank = v.rank
            FROM (VALUES
              ('L1','Apprentice','#8a93a6',1),('L2','Junior Tech','#4dd0ff',2),
              ('L3','Technician','#35e0c8',3),('L4','Senior Tech','#3ddc84',4),
              ('L5','Specialist','#a78bfa',5),('L6','Master','#ffb84d',6)
            ) AS v(level, title, color, rank)
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
                color = v.color, sort_order = v.sort_order, is_active = true,
                progress_weight = NULL
            FROM (VALUES
              ('site','active','Active','In service.','#178a4c',1),
              ('site','planned','Planned','Not yet in service.','#0f7c86',2),
              ('site','inactive','Inactive','Temporarily out of service.','#51606f',3),
              ('site','decommissioned','Decommissioned','Retired; retained for history.','#c03540',4),
              ('worker','active','Active','Available for dispatch.','#178a4c',1),
              ('worker','standby','Standby','Temporarily unavailable.','#a36207',2),
              ('worker','blacklist','Blacklist','Do not dispatch; reason required.','#c03540',3)
            ) AS v(record_type, key, label, description, color, sort_order)
            WHERE sv.record_type = v.record_type AND sv.key = v.key
        """))
        # site_types is editable seed data AND createable — drop customs, then
        # restore canonical values so an admin-edit test can't pollute later runs
        await session.execute(text(
            "DELETE FROM site_types WHERE key NOT IN ('datacenter','office',"
            "'warehouse','colo','partner_office','other')"))
        await session.execute(text("""
            UPDATE site_types AS st
            SET label = v.label, description = v.description,
                sort_order = v.sort_order, icon = v.icon, color = v.color
            FROM (VALUES
              ('datacenter','Data centre','Colocation or owned data centre space.',1,'server','#1668a7'),
              ('office','Office','Corporate or branch office.',2,'building','#6d4fc4'),
              ('warehouse','Warehouse','Storage or staging facility.',3,'box','#a36207'),
              ('colo','Colocation','Shared colocation floor.',4,'server','#0f7c86'),
              ('partner_office','Partner office','Facility operated by a partner.',5,'handshake','#178a4c'),
              ('other','Other','Anything that does not fit the other types.',6,'pin','#51606f')
            ) AS v(key, label, description, sort_order, icon, color) WHERE st.key = v.key
        """))
        # asset vocabulary — restore canonical seeds (0014 as merged by
        # 0022: lifecycle keys + the former move_asset_status workflow
        # keys at sort_order 0, weights VERBATIM from the weighted-
        # progress design doc; in_transit is the merged collision row —
        # move's look and weight, asset's key/sort/description)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type = 'asset'"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order, progress_weight)
            VALUES
              ('asset','active','Active','Racked and in service.','#178a4c',1,NULL),
              ('asset','in_transit','In Transit','Between locations.','#f52727',2,50),
              ('asset','in_storage','In storage','Warehoused, not in service.','#51606f',3,NULL),
              ('asset','decommissioned','Decommissioned','Retired; retained for history.','#c03540',4,NULL),
              ('asset','unknown','Unknown','Not yet verified.','#a36207',5,NULL),
              ('asset','loaded_in_system','Loaded In System','','#808080',0,0),
              ('asset','pre_stage','Pre-Stage','','#caa0a0',0,8),
              ('asset','racked','Racked','','#273ff5',0,15),
              ('asset','labeled','Labeled','','#f5be27',0,23),
              ('asset','pack_logistics','Pack / Logistics','','#31f527',0,31),
              ('asset','in_container','In Container','','#31f527',0,38),
              ('asset','on_truck','On Truck','','#31f527',0,46),
              ('asset','received','Received','','#31f527',0,54),
              ('asset','un_pack','Un-Pack','','#31f527',0,62),
              ('asset','staged','Staged','','#27f5ad',0,69),
              ('asset','re_racked','Re-Racked','','#31f527',0,77),
              ('asset','cabling','Cabling','','#31f527',0,85),
              ('asset','qa','QA','','#31f527',0,92),
              ('asset','complete','Complete','','#8e27f5',0,100),
              ('asset','rfid_1_cage_exit','RFID 1 - Cage Exit','','#31f527',0,35),
              ('asset','rfid_2_loading_dock','RFID 2 - Loading Dock','','#29d3f5',0,40),
              ('asset','rfid_3_staging','RFID 3 - Staging','','#f58b29',0,65),
              ('asset','rfid_4_into_cage','RFID 4 - Into Cage','','#f5297a',0,72),
              ('asset','rfid_10_dock_to_truck','RFID 10 - Dock to Truck (Auto Container Pack)','','#1890ff',0,44),
              ('asset','e_waste','e-waste','','#ee27f5',0,100),
              ('asset','pending_client_handover','Pending Client Handover','','#00ff00',0,95),
              ('asset','historical','Historical','','#27f5f2',0,NULL),
              ('asset','location_collision','Location Collision','','#ff0000',0,NULL)
        """))
        # container vocabulary — restore canonical seeds (0015)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type IN "
            "('container', 'container_type')"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order)
            VALUES
              ('container','available','Available','Empty or accepting assets.','#178a4c',1),
              ('container','packed','Packed','Loaded and sealed.','#6d4fc4',2),
              ('container','in_transit','In transit','Between locations.','#0f7c86',3),
              ('container','historical','Historical','Retired; retained for history.','#51606f',4),
              ('container_type','pelican_case','Pelican case','Hard transport case.','#1668a7',1),
              ('container_type','shipping_container','Shipping container','Full-size freight container.','#a36207',2),
              ('container_type','cart','Cart','Rolling cart or trolley.','#0f7c86',3)
        """))
        # initiative vocabularies — restore canonical seeds (0016)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type IN "
            "('initiative', 'initiative_type', 'initiative_sub_type', "
            "'initiative_work_type', 'shipping_type')"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order)
            VALUES
              ('initiative','planned','Planned','Not yet scheduled.','#51606f',1),
              ('initiative','scheduled','Scheduled','Date set; not started.','#0f7c86',2),
              ('initiative','in_progress','In progress','Work underway.','#1668a7',3),
              ('initiative','on_hold','On hold','Paused.','#a36207',4),
              ('initiative','completed','Completed','Done; retained for history.','#178a4c',5),
              ('initiative','cancelled','Cancelled','Will not happen.','#c03540',6),
              ('initiative_type','project','Project','Long-running engagement.','#1668a7',1),
              ('initiative_type','event','Event','Date-bound occasion.','#6d4fc4',2),
              ('initiative_type','move','Move','Physical relocation of assets.','#a36207',3),
              ('initiative_sub_type','deployment','Deployment','New equipment install.','#178a4c',1),
              ('initiative_sub_type','decommission','Decommission','Teardown / removal.','#c03540',2),
              ('initiative_sub_type','migration','Migration','Data-centre migration.','#0f7c86',3),
              ('initiative_sub_type','maintenance','Maintenance','Scheduled maintenance.','#a36207',4),
              ('initiative_sub_type','conference','Conference','Conference or trade show.','#6d4fc4',5),
              ('initiative_sub_type','office_move','Office move','Office relocation.','#1668a7',6),
              ('initiative_work_type','lead','Lead','On-site lead.','#1668a7',1),
              ('initiative_work_type','tech','Tech','Hands-on technician.','#178a4c',2),
              ('initiative_work_type','cabling','Cabling','Structured cabling.','#0f7c86',3),
              ('initiative_work_type','logistics','Logistics','Transport & handling.','#a36207',4),
              ('initiative_work_type','other','Other','Anything else.','#51606f',5),
              ('shipping_type','truck','Truck','Road freight.','#1668a7',1),
              ('shipping_type','air','Air','Air freight.','#0f7c86',2),
              ('shipping_type','rail','Rail','Rail freight.','#a36207',3),
              ('shipping_type','ferry','Ferry','Sea / ferry.','#6d4fc4',4)
        """))
        # partner type vocabulary — restore canonical seeds (0017)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type = 'partner_type'"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order)
            VALUES
              ('partner_type','staffing','Staffing','Contract labour.','#1668a7',1),
              ('partner_type','logistics','Logistics','Transport & freight.','#a36207',2),
              ('partner_type','tech','Tech','Hands-on technical services.','#178a4c',3),
              ('partner_type','cable','Cable','Structured cabling.','#0f7c86',4),
              ('partner_type','subcontractor','Subcontractor','General subcontracting.','#6d4fc4',5),
              ('partner_type','consultant','Consultant','Advisory services.','#51606f',6),
              ('partner_type','other','Other','Anything else.','#c03540',7)
        """))
        # scan vocabulary — restore canonical seeds (0025)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type IN "
            "('scan', 'processed_scan')"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order)
            VALUES
              ('scan','rfid','RFID','Read from an RFID tag.','#1668a7',1),
              ('scan','barcode','Barcode','Read from a barcode or QR label.','#6d4fc4',2),
              ('scan','manual','Manual','Keyed in by hand.','#a36207',3),
              ('processed_scan','asset','Asset','Matched to an asset.','#178a4c',1),
              ('processed_scan','container','Container','Matched to a container.','#0f7c86',2),
              ('processed_scan','person','Person','Matched to a person badge.','#6d4fc4',3)
        """))
        # time entry vocabulary — restore canonical seeds (0028)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type = 'time_entry'"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order)
            VALUES
              ('time_entry','open','On the clock','','#258bcd',1),
              ('time_entry','pending','Pending review','','#a36207',2),
              ('time_entry','approved','Approved','','#178a4c',3),
              ('time_entry','rejected','Rejected','','#c03540',4)
        """))
        # device type vocabulary — restore canonical seeds (0037)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type = 'device_type'"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order)
            VALUES
              ('device_type','router','Router','GL.iNet site router.','#1668a7',1),
              ('device_type','fixed_reader','Fixed Reader','Zebra FX9600 fixed RFID reader.','#178a4c',2),
              ('device_type','handheld_reader','Handheld Reader','Android / iOS / Zebra handheld scanner.','#6d4fc4',3),
              ('device_type','kiosk','Kiosk','Web or iPad kiosk station.','#a36207',4)
        """))
        await session.execute(text("DELETE FROM asset_categories"))
        await session.execute(text("""
            INSERT INTO asset_categories (key, label, description, sort_order, color)
            VALUES
              ('server','Server','Compute hardware.',1,'#1668a7'),
              ('storage','Storage','Disk shelves, arrays, tape.',2,'#6d4fc4'),
              ('network','Network','Switches, routers, firewalls.',3,'#0f7c86'),
              ('power','Power','PDUs, UPSes.',4,'#a36207'),
              ('other','Other','Anything that does not fit the other categories.',5,'#51606f')
        """))
        # system_config is editable seed data — restore 0024 defaults
        await session.execute(text("DELETE FROM system_config"))
        await session.execute(text("""
            INSERT INTO system_config (section, data) VALUES
              ('logging', '{"mode": "local",
                "local_max_rows_per_process": 20000,
                "local_max_age_days": 14, "remote_buffer_rows": 10000,
                "min_level": "INFO",
                "syslog": {"host": "", "port": 514, "protocol": "udp"}}'::jsonb),
              ('logging_cursor', '{"last_forwarded_id": 0}'::jsonb)
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
