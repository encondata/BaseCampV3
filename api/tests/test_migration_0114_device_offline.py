"""Migration 0114 (notifications Phase 2, slice 2): `devices.offline_notified_at` and
`notification_events.attempts`.

The shape at head is read on the shared test database. The rollout marking, the backfill of
`attempts` and the rollback run on a throwaway database (`<SS_TEST_DB>_m0114`) so the shared one
stays at head.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 5 and 9)"""

import os
import uuid
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from psycopg.types.json import Jsonb
from sqlalchemy import text
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from serversherpa.db.models import Device, NotificationEvent
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0114"


# ── the shape at head, on the shared database ──────────────────────

async def _column(db, table, column) -> tuple:
    """(udt_name, is_nullable, column_default) as Postgres reports them."""
    return tuple((await db.execute(text(
        "SELECT udt_name, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name = :t AND column_name = :c"), {"t": table, "c": column})).one())


async def test_the_new_columns_at_head(db):
    assert await _column(db, "devices", "offline_notified_at") == ("timestamptz", "YES", None)
    assert await _column(db, "notification_events", "attempts") == ("int4", "NO", "0")


def test_the_models_mirror_the_new_columns():
    notified = Device.__table__.columns["offline_notified_at"]
    assert notified.nullable and notified.type.timezone
    attempts = NotificationEvent.__table__.columns["attempts"]
    assert not attempts.nullable and attempts.server_default.arg.text == "0"


async def test_the_models_round_trip(db):
    device = Device(device_type="kiosk", name="Device A")
    event = NotificationEvent(kind="kind_a", subject_type="device", subject_id=uuid.uuid4())
    db.add_all([device, event])
    await db.commit()
    for row in (device, event):
        await db.refresh(row)

    # a device has not been announced offline, and an event has not failed yet
    assert device.offline_notified_at is None
    assert event.attempts == 0

    noticed = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)
    device.offline_notified_at = noticed
    event.attempts = 2
    await db.commit()
    for row in (device, event):
        await db.refresh(row)
    assert (device.offline_notified_at, event.attempts) == (noticed, 2)

    device.offline_notified_at = None
    await db.commit()
    await db.refresh(device)
    assert device.offline_notified_at is None


# ── the rollout and the rollback, on a throwaway database ──────────

@pytest.fixture
def throwaway_url():
    assert THROWAWAY_DB.startswith("serversherpa_test")
    base = make_url(get_settings().database_url.get_secret_value())
    admin = base.set(drivername="postgresql", database="postgres").render_as_string(
        hide_password=False)
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{THROWAWAY_DB}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{THROWAWAY_DB}"')
    try:
        yield base.set(database=THROWAWAY_DB)
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{THROWAWAY_DB}" WITH (FORCE)')


def _sync(url) -> str:
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def _column_names(conn, table) -> set[str]:
    return {row[0] for row in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s", (table,))}


def _ago(minutes=0, seconds=0) -> timedelta:
    return timedelta(minutes=minutes, seconds=seconds)


STATION = {"sub_type": "laptop", "station_type": "rfid"}

# (name, device type, fields, whether the rollout marks it, what it is). `seen_ago` is how long
# before the migration the device last checked in; none at all has never checked in. The clock
# moves while alembic runs, and a device only grows older: the ones just past 3 minutes stay
# offline, and the router waiting on the 4 minute edge has 59 seconds to spare.
DEVICES = [
    # covered, and offline now
    ("Device A", "kiosk", {**STATION, "seen_ago": _ago(10)}, True,
     "a station seen 10 minutes ago"),
    ("Device B", "fixed_reader", {"seen_ago": _ago(), "raw_info": {"reachable": False}}, True,
     "a reader marked unreachable"),
    ("Device C", "router", {"approval_state": "approved", "seen_ago": _ago(5)}, True,
     "an approved router seen 5 minutes ago"),
    ("Device D", "fixed_reader", {"seen_ago": _ago(10)}, True,
     "a reader seen 10 minutes ago"),
    # the thresholds are per kind: 3 minutes 1 second is offline for a station and a reader
    ("Device E", "kiosk", {**STATION, "seen_ago": _ago(3, 1)}, True,
     "a station seen 3 minutes 1 second ago"),
    ("Device F", "fixed_reader", {"seen_ago": _ago(3, 1)}, True,
     "a reader seen 3 minutes 1 second ago"),
    # covered, and online or never seen
    ("Device G", "kiosk", {**STATION, "seen_ago": _ago(1)}, False,
     "a station seen 1 minute ago"),
    ("Device H", "fixed_reader", {}, False,
     "a reader that has never checked in"),
    ("Device I", "fixed_reader", {"raw_info": {"reachable": False}}, False,
     "a never-seen reader marked unreachable"),
    ("Device J", "fixed_reader", {"seen_ago": _ago(), "raw_info": {"reachable": True}}, False,
     "a reachable reader seen just now"),
    ("Device K", "router", {"approval_state": "approved", "seen_ago": _ago(3, 1)}, False,
     "an approved router seen 3 minutes 1 second ago (a router waits 4)"),
    # not covered, however long they have been quiet
    ("Device L", "router", {"approval_state": "pending", "seen_ago": _ago(10)}, False,
     "a pending router seen 10 minutes ago"),
    ("Device M", "router", {"approval_state": "revoked", "seen_ago": _ago(10)}, False,
     "a revoked router seen 10 minutes ago"),
    ("Device N", "router", {"seen_ago": _ago(10)}, False,
     "a router with no approval state seen 10 minutes ago"),
    ("Device O", "kiosk", {"sub_type": "android", "seen_ago": _ago(10)}, False,
     "an android kiosk seen 10 minutes ago"),
    ("Device P", "kiosk", {"sub_type": "laptop", "station_type": "label", "seen_ago": _ago(10)},
     False, "a Label Station seen 10 minutes ago"),
    ("Device Q", "kiosk",
     {"sub_type": "laptop", "station_type": "timeclock", "seen_ago": _ago(10)},
     False, "a Time Clock station seen 10 minutes ago"),
]
MARKED = {name for name, _type, _fields, marked, _why in DEVICES if marked}
WHY = {name: why for name, _type, _fields, _marked, why in DEVICES}


def _seed_devices(conn) -> None:
    now = conn.execute("SELECT now()").fetchone()[0]    # the database's clock, not ours
    for name, device_type, fields, _marked, _why in DEVICES:
        ago = fields.get("seen_ago")
        conn.execute(
            "INSERT INTO devices (device_type, name, sub_type, station_type, approval_state, "
            "last_seen_at, raw_info) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (device_type, name, fields.get("sub_type"), fields.get("station_type"),
             fields.get("approval_state"), None if ago is None else now - ago,
             Jsonb(fields.get("raw_info", {}))))


def _notified(conn) -> dict[str, datetime]:
    return dict(conn.execute(
        "SELECT name, offline_notified_at FROM devices "
        "WHERE offline_notified_at IS NOT NULL").fetchall())


def test_rollout_marks_devices_already_offline(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0113")
    with psycopg.connect(sync, autocommit=True) as conn:
        _seed_devices(conn)
        # an event announced before this migration
        old_event = conn.execute(
            "INSERT INTO notification_events (kind, subject_type, subject_id) "
            "VALUES ('kind_a', 'initiative', %s) RETURNING id", (uuid.uuid4(),)).fetchone()[0]
        assert "attempts" not in _column_names(conn, "notification_events")
        assert "offline_notified_at" not in _column_names(conn, "devices")
        before = conn.execute("SELECT now()").fetchone()[0]

    _alembic(throwaway_url, "upgrade", "0114")
    with psycopg.connect(sync, autocommit=True) as conn:
        after = conn.execute("SELECT now()").fetchone()[0]
        notified = _notified(conn)
        # every covered device that is offline now is marked as announced, so deploying sends
        # nothing for outages that were already going on; nothing else is
        wrong = {name: WHY[name] for name in set(notified) ^ MARKED}
        assert not wrong, wrong
        assert conn.execute("SELECT count(*) FROM devices").fetchone()[0] == len(DEVICES)
        # all with the migration's own clock: one value for the whole rollout
        assert len(set(notified.values())) == 1
        assert before <= next(iter(notified.values())) <= after

        # an event that was waiting has not failed
        assert conn.execute("SELECT attempts FROM notification_events WHERE id = %s",
                            (old_event,)).fetchone() == (0,)
        # and a new one starts at 0 too, with no way to be none
        assert conn.execute(
            "INSERT INTO notification_events (kind, subject_type, subject_id) "
            "VALUES ('kind_a', 'initiative', %s) RETURNING attempts",
            (uuid.uuid4(),)).fetchone() == (0,)
        with pytest.raises(psycopg.errors.NotNullViolation):
            conn.execute("UPDATE notification_events SET attempts = NULL")


def test_downgrade_removes_both_columns(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0114")
    with psycopg.connect(sync, autocommit=True) as conn:
        _seed_devices(conn)
        conn.execute("INSERT INTO notification_events (kind, subject_type, subject_id, attempts) "
                     "VALUES ('kind_a', 'initiative', %s, 3)", (uuid.uuid4(),))
        assert "attempts" in _column_names(conn, "notification_events")
        assert "offline_notified_at" in _column_names(conn, "devices")

    _alembic(throwaway_url, "downgrade", "0113")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert "attempts" not in _column_names(conn, "notification_events")
        assert "offline_notified_at" not in _column_names(conn, "devices")
        # the rows themselves stay
        assert conn.execute("SELECT count(*) FROM devices").fetchone()[0] == len(DEVICES)
        assert conn.execute("SELECT count(*) FROM notification_events").fetchone()[0] == 1

    # and forward again: the rollout marks what is offline by then, and the event starts over
    _alembic(throwaway_url, "upgrade", "0114")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert set(_notified(conn)) == MARKED
        assert conn.execute("SELECT attempts FROM notification_events").fetchone() == (0,)
