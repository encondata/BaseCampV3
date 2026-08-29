"""Encrypted DB backups: crypto envelope round-trip + the four devtools
endpoints (list/create/download/delete), storage and pg_dump mocked so the
suite never touches real MinIO or spawns a real pg_dump."""

import shutil
import subprocess
import uuid

import pytest

from serversherpa.db.models import DbBackup, Person, PersonRole
from serversherpa.services.db_backup import (
    PgDumpFailed, PgDumpUnavailable, _dump_argv, decrypt_openssl,
    encrypt_openssl,
)
from tests.test_assets_api import login, make_login

FAKE_DUMP = b"-- fake dump\n"
PASSWORD = "CorrectHorse9!"
DB_PASSWORD = "s3cr3t-db-p$ss!"  # deliberately shell-hostile chars (no "@": that's the URL userinfo/host separator, not something this test is about)


# ── crypto round-trip (pure, no app/db needed) ──────────────────────


def test_round_trip():
    blob = encrypt_openssl(FAKE_DUMP, PASSWORD)
    assert decrypt_openssl(blob, PASSWORD) == FAKE_DUMP


def test_envelope_starts_with_salted_header():
    blob = encrypt_openssl(FAKE_DUMP, PASSWORD)
    assert blob.startswith(b"Salted__")
    assert len(blob) >= 16  # header(8) + salt(8) at minimum


def test_wrong_password_raises():
    blob = encrypt_openssl(FAKE_DUMP, PASSWORD)
    with pytest.raises(ValueError, match="bad_password_or_corrupt"):
        decrypt_openssl(blob, "totally-wrong-password")


def test_corrupt_blob_raises():
    with pytest.raises(ValueError, match="bad_password_or_corrupt"):
        decrypt_openssl(b"not an envelope at all", PASSWORD)


def test_each_encryption_uses_a_fresh_salt():
    a = encrypt_openssl(FAKE_DUMP, PASSWORD)
    b = encrypt_openssl(FAKE_DUMP, PASSWORD)
    assert a != b  # random salt -> different ciphertext for identical input


@pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl not installed")
def test_openssl_can_decrypt_our_envelope(tmp_path):
    blob = encrypt_openssl(FAKE_DUMP, PASSWORD)
    enc_path = tmp_path / "backup.sql.enc"
    enc_path.write_bytes(blob)
    out_path = tmp_path / "backup.sql"

    result = subprocess.run(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-md", "sha256",
         "-in", str(enc_path), "-out", str(out_path), "-pass", f"pass:{PASSWORD}"],
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr.decode()
    assert out_path.read_bytes() == FAKE_DUMP


# ── pg_dump argv/env (the password must never reach argv) ──────────


def test_dump_argv_keeps_password_out_of_argv_and_only_in_env(monkeypatch):
    """Regression test for the real conninfo-building path: argv is visible
    to every other process on the host via `ps`, so the DB password may
    appear ONLY in the returned env's PGPASSWORD, never in any argv
    element. (`url.set(password=None)` is a no-op in SQLAlchemy — None
    there means "leave unchanged" — so a naive implementation leaves the
    real password sitting in the conninfo string; this test would catch
    that regression.)"""
    monkeypatch.setattr(
        "serversherpa.services.db_backup._resolve_pg_dump",
        lambda: "/usr/bin/pg_dump")

    database_url = (
        f"postgresql+asyncpg://dbuser:{DB_PASSWORD}@dbhost:6543/serversherpa")
    argv, env = _dump_argv(database_url)

    assert argv[0] == "/usr/bin/pg_dump"
    assert "--no-owner" in argv
    assert "--no-privileges" in argv
    for arg in argv:
        assert DB_PASSWORD not in arg, f"password leaked into argv: {arg!r}"

    assert env["PGPASSWORD"] == DB_PASSWORD
    # the conninfo argument (right after "-d") still carries user/host/db
    conninfo = argv[argv.index("-d") + 1]
    assert "dbuser" in conninfo
    assert "dbhost" in conninfo
    assert "6543" in conninfo
    assert "serversherpa" in conninfo


# ── endpoint tests (storage + pg_dump mocked) ───────────────────────


class _FakeStorage:
    """In-memory stand-in for services.storage, keyed like the real thing."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}

    async def put_object(self, key, data, content_type):
        self.objects[key] = data

    async def delete_object(self, key):
        self.objects.pop(key, None)

    def presign_get(self, key, *, download_filename=None):
        if not key:
            return None
        suffix = f"&filename={download_filename}" if download_filename else ""
        return f"https://fake-storage.example/{key}?sig=fake{suffix}"


@pytest.fixture
def fake_storage(monkeypatch):
    fake = _FakeStorage()
    monkeypatch.setattr("serversherpa.api.routes.devtools.put_object", fake.put_object)
    monkeypatch.setattr("serversherpa.api.routes.devtools.delete_object", fake.delete_object)
    monkeypatch.setattr("serversherpa.api.routes.devtools.presign_get", fake.presign_get)
    return fake


@pytest.fixture
def fake_pg_dump(monkeypatch):
    async def _fake(database_url):
        return FAKE_DUMP

    monkeypatch.setattr("serversherpa.api.routes.devtools.run_pg_dump", _fake)


async def _developer(db, client_api, seeded_user):
    from tests.test_devtools import login as devtools_login, set_role

    await set_role(db, seeded_user.id, "developer")
    return await devtools_login(client_api)


async def test_create_wrong_password_is_403(client, db, seeded_user, fake_storage,
                                             fake_pg_dump):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/backups", headers=hdrs,
                             json={"password": "nope-not-it"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "invalid_password"
    assert fake_storage.objects == {}


async def test_create_lists_downloads_and_decrypts(client, db, seeded_user,
                                                    fake_storage, fake_pg_dump):
    hdrs = await _developer(db, client, seeded_user)

    resp = await client.post("/devtools/backups", headers=hdrs,
                             json={"password": PASSWORD})
    assert resp.status_code == 200, resp.text
    created = resp.json()
    assert created["filename"].startswith("serversherpa_backup_")
    assert created["filename"].endswith(".sql.enc")
    assert created["created_by_name"] == "Alice Anderson"
    assert created["download_url"]
    assert created["size_bytes"] > 0

    # the stored blob is the OpenSSL envelope, decryptable with the
    # password the caller supplied -- never logged, never stored plain
    [stored] = fake_storage.objects.values()
    assert stored.startswith(b"Salted__")
    assert decrypt_openssl(stored, PASSWORD) == FAKE_DUMP

    listing = (await client.get("/devtools/backups", headers=hdrs)).json()
    assert len(listing) == 1
    assert listing[0]["id"] == created["id"]
    assert listing[0]["created_by_name"] == "Alice Anderson"
    # list rows don't carry a live download link
    assert listing[0]["download_url"] is None

    dl = await client.get(f"/devtools/backups/{created['id']}/download", headers=hdrs)
    assert dl.status_code == 200
    assert dl.json()["url"]

    delete_resp = await client.delete(f"/devtools/backups/{created['id']}", headers=hdrs)
    assert delete_resp.status_code == 204
    assert fake_storage.objects == {}
    assert await db.get(DbBackup, uuid.UUID(created["id"])) is None


async def test_download_missing_backup_is_404(client, db, seeded_user, fake_storage):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get(
        f"/devtools/backups/{uuid.uuid4()}/download", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_found"


async def test_delete_missing_backup_is_404(client, db, seeded_user, fake_storage):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.delete(f"/devtools/backups/{uuid.uuid4()}", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_found"


async def test_pg_dump_unavailable_is_500(client, db, seeded_user, fake_storage,
                                          monkeypatch):
    async def _boom(database_url):
        raise PgDumpUnavailable()

    monkeypatch.setattr("serversherpa.api.routes.devtools.run_pg_dump", _boom)
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/backups", headers=hdrs,
                             json={"password": PASSWORD})
    assert resp.status_code == 500
    assert resp.json()["detail"]["code"] == "pg_dump_unavailable"


async def test_pg_dump_failure_is_500(client, db, seeded_user, fake_storage,
                                      monkeypatch):
    async def _boom(database_url):
        raise PgDumpFailed(b"connection refused")

    monkeypatch.setattr("serversherpa.api.routes.devtools.run_pg_dump", _boom)
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/backups", headers=hdrs,
                             json={"password": PASSWORD})
    assert resp.status_code == 500
    assert resp.json()["detail"]["code"] == "pg_dump_failed"


async def test_audit_never_contains_the_password(client, db, seeded_user,
                                                  fake_storage, fake_pg_dump):
    from serversherpa.db.models import AuditLog
    from sqlalchemy import select

    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/backups", headers=hdrs,
                             json={"password": PASSWORD})
    assert resp.status_code == 200

    rows = (await db.scalars(
        select(AuditLog).where(AuditLog.action == "backup.create"))).all()
    assert len(rows) == 1
    assert PASSWORD not in str(rows[0].changes)


async def test_devtools_gate_staff_and_worker_are_403(client, db, seeded_user,
                                                       fake_storage, fake_pg_dump):
    """devtools is developer-only (see access/defaults.py) -- staff and
    worker hold no devtools grant at all, unlike the founder/admin/
    super_admin roles that get every OTHER resource by default."""
    staff = Person(first_name="St", last_name="Aff")
    worker = Person(first_name="Wk", last_name="Er")
    db.add_all([staff, worker])
    await db.flush()
    db.add_all([
        PersonRole(person_id=staff.id, role="staff"),
        PersonRole(person_id=worker.id, role="worker"),
    ])
    await db.commit()

    for person, email in ((staff, "staff-backup@test.example.com"),
                          (worker, "worker-backup@test.example.com")):
        hdrs = await make_login(db, client, person, email)
        assert (await client.get("/devtools/backups", headers=hdrs)).status_code == 403
        resp = await client.post("/devtools/backups", headers=hdrs,
                                 json={"password": PASSWORD})
        assert resp.status_code == 403


async def test_create_plain_backup_needs_no_password(client, db, seeded_user,
                                                     fake_storage, fake_pg_dump):
    hdrs = await _developer(db, client, seeded_user)

    resp = await client.post("/devtools/backups", headers=hdrs,
                             json={"encrypt": False})
    assert resp.status_code == 200, resp.text
    created = resp.json()
    assert created["encrypted"] is False
    assert created["filename"].endswith(".sql")
    assert not created["filename"].endswith(".sql.enc")

    # stored blob IS the dump, byte for byte — no envelope
    [(key, blob)] = fake_storage.objects.items()
    assert key.endswith(".sql")
    assert blob == FAKE_DUMP

    # and the list reports the mode
    rows = (await client.get("/devtools/backups", headers=hdrs)).json()
    assert rows[0]["encrypted"] is False


async def test_create_encrypted_without_password_is_422(client, db, seeded_user,
                                                        fake_storage, fake_pg_dump):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/backups", headers=hdrs, json={})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "password_required"
    assert fake_storage.objects == {}
