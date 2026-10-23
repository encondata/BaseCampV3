"""Biometric sign-in schema (migration 0107): every session records how it
signed in (`auth_sessions.login_method`, set server-side by start_session
and carried through refresh rotation), one live biometric key per
(person, device), and the personal-device columns on `devices`.

Design: docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md
§Data."""

import os
from datetime import UTC, datetime

import psycopg
import pytest
from sqlalchemy import select
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from serversherpa.config import get_settings
from serversherpa.db.models import AuthSession, BiometricKey, Device, Initiative
from tests.test_kiosk_pairing_api import _create, _poll
from tests.test_migration_0099_kiosk_config import _alembic
from tests.test_sites_api import login
from tests.test_status_values_write import PW, _make

MOVE_PW = "Crew-2026!"
THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0107"


async def _session_for(db, refresh_cookie: str) -> AuthSession:
    from serversherpa.services.auth import hash_refresh_token

    return await db.scalar(select(AuthSession).where(
        AuthSession.token_hash == hash_refresh_token(refresh_cookie)))


async def test_password_login_records_method(client, db, seeded_user):
    await _make(db, client, "worker", "bio-w@test.example.com")
    resp = await client.post("/auth/login", json={
        "email": "bio-w@test.example.com", "password": PW, "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    row = await _session_for(db, resp.cookies["ss_refresh"])
    assert row.client == "kiosk"
    assert row.login_method == "password"


async def test_refresh_keeps_method(client, db, seeded_user):
    await _make(db, client, "worker", "bio-r@test.example.com")
    resp = await client.post("/auth/login", json={
        "email": "bio-r@test.example.com", "password": PW, "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    first = await _session_for(db, resp.cookies["ss_refresh"])
    first_id, family_id = first.id, first.family_id
    rotated = await client.post("/auth/refresh?client=kiosk")
    assert rotated.status_code == 200, rotated.text
    db.expire_all()
    successor = await _session_for(db, rotated.cookies["ss_refresh"])
    assert successor.id != first_id
    assert successor.family_id == family_id
    assert successor.login_method == "password"


async def test_pair_and_move_record_their_methods(client, db, seeded_user):
    # link with phone: the claimed pairing mints a "link" session
    d = await _create(client)
    hdrs = await login(client)        # the phone's own password session
    assert (await client.post(f"/kiosk/pair/{d['code']}/approve",
                              headers=hdrs)).status_code == 204
    polled = await _poll(client, d)
    assert polled.status_code == 200, polled.text
    pair_row = await _session_for(db, polled.cookies["ss_refresh"])
    assert pair_row.login_method == "link"

    # move password: a "move" session
    admin = await _make(db, client, "admin", "bio-admin@test.example.com")
    init = Initiative(name="Bio Move", initiative_type="move", status="planned")
    db.add(init)
    await db.commit()
    set_pw = await client.patch(f"/initiatives/{init.id}", headers=admin,
                                json={"kiosk_password": MOVE_PW})
    assert set_pw.status_code == 200, set_pw.text
    moved = await client.post("/kiosk/move-login", json={"password": MOVE_PW})
    assert moved.status_code == 200, moved.text
    move_row = await _session_for(db, moved.cookies["ss_refresh"])
    assert move_row.initiative_id == init.id
    assert move_row.login_method == "move"

    # the phone's portal sign-in and the admin's are password sign-ins
    others = (await db.scalars(select(AuthSession).where(
        AuthSession.client == "portal"))).all()
    assert others and {s.login_method for s in others} == {"password"}


async def test_one_live_key_per_person_device(db, seeded_user):
    device = Device(device_type="kiosk", name="Pixel 8", serial="android-bio-1",
                    sub_type="android", personal_person_id=seeded_user.id,
                    personal_set_at=datetime.now(UTC), personal_set_by=seeded_user.id)
    db.add(device)
    await db.commit()
    await db.refresh(device)
    assert device.personal_person_id == seeded_user.id
    device_id, person_id = device.id, seeded_user.id

    def key(**over):
        return BiometricKey(person_id=person_id, device_id=device_id,
                            **{"public_key": b"\x30\x59fake-der", "key_alg": "ES256",
                               "security_level": "tee",
                               "password_sign_in_at": datetime.now(UTC), **over})

    first = key()
    db.add(first)
    await db.commit()
    await db.refresh(first)
    assert first.key_alg == "ES256"
    assert first.created_at is not None and first.last_nonce is None
    first_id = first.id

    db.add(key())
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    first = await db.get(BiometricKey, first_id)
    first.revoked_at = datetime.now(UTC)
    first.revoke_reason = "forgotten"
    await db.commit()
    db.add(key(security_level="strongbox"))
    await db.commit()
    keys = (await db.scalars(select(BiometricKey).where(
        BiometricKey.device_id == device_id))).all()
    assert len(keys) == 2
    assert sum(1 for k in keys if k.revoked_at is None) == 1


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


def _columns(conn, table):
    return {name for (name,) in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
        (table,))}


def test_migration_round_trip(throwaway_url):
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert conn.execute("SELECT to_regclass('biometric_keys')").fetchone()[0] \
            == "biometric_keys"
        assert "login_method" in _columns(conn, "auth_sessions")
        assert {"personal_person_id", "personal_set_at", "personal_set_by"} \
            <= _columns(conn, "devices")
        assert _columns(conn, "biometric_keys") == {
            "id", "person_id", "device_id", "public_key", "key_alg", "security_level",
            "created_at", "password_sign_in_at", "last_used_at", "last_nonce",
            "revoked_at", "revoke_reason"}

    _alembic(throwaway_url, "downgrade", "0106")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert conn.execute("SELECT to_regclass('biometric_keys')").fetchone()[0] is None
        assert "login_method" not in _columns(conn, "auth_sessions")
        assert not ({"personal_person_id", "personal_set_at", "personal_set_by"}
                    & _columns(conn, "devices"))

    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert conn.execute("SELECT to_regclass('biometric_keys')").fetchone()[0] \
            == "biometric_keys"
        assert "login_method" in _columns(conn, "auth_sessions")
