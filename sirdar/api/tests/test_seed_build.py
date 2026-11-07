"""Building a subset snapshot from a recipe (Task 7)."""

import asyncio
import os
import re
import subprocess
import tarfile
import uuid
from pathlib import Path

import asyncpg
import psycopg
import pytest
from sqlalchemy import select
from sqlalchemy.engine import make_url

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Snapshot
from sirdar_api.deploy import bundle, snapshots
from sirdar_api.seed import build, reset, scratch
from sirdar_api.seed import files as seed_files

from .api_helpers import auth_headers
from .bundle_helpers import write_objects_tar
from .conftest import BASE_URL, TEST_DB, _psycopg_url, pg_bin_dir_for_tests
from .deploy_factories import secrets_key, snapshots_dir  # noqa: F401
from .test_seed_scratch import KEYS

SOURCE = f"{TEST_DB}_buildsrc"
BUILD = "/api/seed/recipes/{rid}/build"
SNAPSHOTS = "/api/deploy/snapshots"

# Mirrors the reset list's tables and columns (seed/reset.py), plus the
# shapes the load has to get right: an optional self-link, an optional
# link, a required self-link (loaded in any order), an unmentioned table
# with a sequence, and files on rows.
SCHEMA = [
    # the extensions ServerSherpa uses: their functions sit in public and are allowed
    "CREATE EXTENSION citext",
    "CREATE EXTENSION pg_trgm",
    "CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)",
    "INSERT INTO alembic_version VALUES ('0089')",
    "CREATE TABLE roles (id int PRIMARY KEY, name text NOT NULL)",
    "INSERT INTO roles VALUES (1, 'admin'), (2, 'staff')",
    ("CREATE TABLE people (id int PRIMARY KEY, name text NOT NULL, avatar_key text, "
     "manager_id int REFERENCES people)"),
    ("INSERT INTO people VALUES (1, 'Ann', 'avatars/ann.png', NULL), "
     "(2, 'Bob', 'avatars/bob.png', 1), (3, 'Cy', NULL, 2)"),
    ("CREATE TABLE user_accounts (person_id int PRIMARY KEY REFERENCES people, "
     "email text NOT NULL, password_hash text, "
     "must_change_password boolean NOT NULL DEFAULT false, password_updated_at timestamptz, "
     "totp_secret_enc bytea, totp_confirmed_at timestamptz, totp_last_counter bigint, "
     "failed_login_count int NOT NULL DEFAULT 0, locked_until timestamptz, "
     "role_id int NOT NULL REFERENCES roles)"),
    ("INSERT INTO user_accounts VALUES "
     "(1, 'ann@x.test', 'hash-ann', false, now(), '\\x0102'::bytea, now(), 5, 2, now(), 1), "
     "(2, 'bob@x.test', 'hash-bob', false, now(), NULL, NULL, NULL, 0, NULL, 2)"),
    ("CREATE TABLE password_history (id int PRIMARY KEY, "
     "person_id int NOT NULL REFERENCES user_accounts, password_hash text NOT NULL)"),
    "INSERT INTO password_history VALUES (1, 1, 'old-ann'), (2, 2, 'old-bob')",
    ("CREATE TABLE totp_backup_codes (id int PRIMARY KEY, "
     "person_id int NOT NULL REFERENCES user_accounts, code_hash text NOT NULL)"),
    "INSERT INTO totp_backup_codes VALUES (1, 1, 'code-1')",
    ("CREATE TABLE trusted_devices (id int PRIMARY KEY, "
     "person_id int NOT NULL REFERENCES user_accounts, token text, file_key text)"),
    "INSERT INTO trusted_devices VALUES (1, 1, 'trust-1', 'devices/d1.bin')",
    ("CREATE TABLE auth_sessions (id int PRIMARY KEY, "
     "person_id int NOT NULL REFERENCES user_accounts, token text)"),
    "INSERT INTO auth_sessions VALUES (1, 2, 'sess-1')",
    ("CREATE TABLE password_reset_tokens (id int PRIMARY KEY, "
     "person_id int NOT NULL REFERENCES user_accounts, token text)"),
    "INSERT INTO password_reset_tokens VALUES (1, 1, 'reset-1')",
    ("CREATE TABLE biometric_keys (id int PRIMARY KEY, "
     "person_id int NOT NULL REFERENCES user_accounts, pubkey text)"),
    "INSERT INTO biometric_keys VALUES (1, 2, 'bio-1')",
    # an enum array: binary COPY would carry the source's element type OID
    "CREATE TYPE mood AS ENUM ('ok', 'meh')",
    ("CREATE TABLE sites (id int PRIMARY KEY, name text NOT NULL, "
     "created_by int REFERENCES people, tags mood[])"),
    "INSERT INTO sites VALUES (1, 'North', 3, ARRAY['ok', 'meh']::mood[]), (2, 'South', NULL, NULL)",
    ("CREATE TABLE docs (id int PRIMARY KEY, site_id int NOT NULL REFERENCES sites, "
     "storage_key text)"),
    "INSERT INTO docs VALUES (7, 1, 'docs/plan.pdf'), (8, 2, 'docs/other.pdf')",
    "CREATE TABLE audit_log (id serial PRIMARY KEY, note citext)",
    "INSERT INTO audit_log (note) VALUES ('a'), ('b'), ('c')",
    ("CREATE TABLE wiki_pages (id int PRIMARY KEY, "
     "parent_id int NOT NULL REFERENCES wiki_pages DEFERRABLE INITIALLY DEFERRED, title text)"),
    "INSERT INTO wiki_pages VALUES (1, 1, 'Home'), (2, 1, 'Guides'), (3, 2, 'Racking')",
]

OBJECTS = {
    "avatars/ann.png": (b"A" * 11, "image/png"),
    "avatars/bob.png": (b"B" * 12, "image/png"),
    "docs/plan.pdf": (b"P" * 14, "application/pdf"),
    "docs/other.pdf": (b"O" * 15, None),
    "loose/readme.txt": (b"R" * 17, "text/plain"),
    "devices/d1.bin": (b"D" * 18, None),
}

# An untrusted dump's own mischief: an ordinary trigger that keeps the old
# row (replica mode skips it, as it does an ordinary rule, but its function
# is the schema's own, so the schema is refused); an ALWAYS rule that
# rewrites the UPDATE to nothing; a REPLICA trigger that copies each hash
# into another table as it goes; a CHECK constraint whose function does the
# same during the load. All refused before any row is loaded.
TRIGGER = [
    ("CREATE FUNCTION keep_old() RETURNS trigger LANGUAGE plpgsql AS "
     "$$ BEGIN RETURN OLD; END $$"),
    ("CREATE TRIGGER keep_old BEFORE UPDATE ON user_accounts "
     "FOR EACH ROW EXECUTE FUNCTION keep_old()"),
]
RULE = ["CREATE RULE keep_rows AS ON UPDATE TO user_accounts DO INSTEAD NOTHING",
        "ALTER TABLE user_accounts ENABLE ALWAYS RULE keep_rows"]
LEAK = [
    "CREATE TABLE leaked (id serial PRIMARY KEY, hash text)",
    ("CREATE FUNCTION leak() RETURNS trigger LANGUAGE plpgsql AS "
     "$$ BEGIN INSERT INTO leaked (hash) VALUES (OLD.password_hash); RETURN NEW; END $$"),
    ("CREATE TRIGGER leak AFTER UPDATE ON user_accounts "
     "FOR EACH ROW EXECUTE FUNCTION leak()"),
    "ALTER TABLE user_accounts ENABLE REPLICA TRIGGER leak",
]
CHECK = [
    # no primary key: the CHECK fires again while pg_restore loads user_accounts
    "CREATE TABLE leaked (hash text)",
    ("CREATE FUNCTION stash(h text) RETURNS boolean LANGUAGE plpgsql AS "
     "$$ BEGIN INSERT INTO public.leaked (hash) VALUES (h); RETURN true; END $$"),
    "ALTER TABLE user_accounts ADD CONSTRAINT stash CHECK (stash(password_hash))",
]

SUPERUSER = make_url(BASE_URL).username


def _dump() -> bytes:
    bin_dir = pg_bin_dir_for_tests()
    if bin_dir is None:
        pytest.skip("no pg_dump matching the test Postgres's major version")
    url = make_url(BASE_URL)
    done = subprocess.run(
        [str(Path(bin_dir) / "pg_dump"), "-Fc", "--host", url.host, "--port", str(url.port),
         "--username", url.username, "--no-password", SOURCE],
        env={**os.environ, "PGPASSWORD": url.password or ""}, check=True, capture_output=True)
    return done.stdout


@pytest.fixture(scope="module")
def dumps() -> dict[str, bytes]:
    """pg_dump -Fc of the fixture schema: whole; with the ordinary trigger;
    with the ALWAYS rule; with the REPLICA leak trigger; with the leaking
    CHECK; without biometric_keys; and also without
    user_accounts.totp_last_counter."""
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{SOURCE}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{SOURCE}"')

    def run(statements: list[str]) -> None:
        with psycopg.connect(_psycopg_url(SOURCE), autocommit=True) as conn:
            for sql in statements:
                conn.execute(sql)

    try:
        run(SCHEMA)
        out = {"full": _dump()}
        run(TRIGGER)
        out["trigger"] = _dump()
        run(["DROP TRIGGER keep_old ON user_accounts", "DROP FUNCTION keep_old", *RULE])
        out["rule"] = _dump()
        run(["DROP RULE keep_rows ON user_accounts", *LEAK])
        out["leak"] = _dump()
        run(["DROP TRIGGER leak ON user_accounts", "DROP FUNCTION leak", "DROP TABLE leaked",
             *CHECK])
        out["check"] = _dump()
        run(["ALTER TABLE user_accounts DROP CONSTRAINT stash", "DROP FUNCTION stash",
             "DROP TABLE leaked", "DROP TABLE biometric_keys"])
        out["no_table"] = _dump()
        with psycopg.connect(_psycopg_url(SOURCE), autocommit=True) as conn:
            conn.execute("ALTER TABLE user_accounts DROP COLUMN totp_last_counter")
        out["no_column"] = _dump()
        return out
    finally:
        with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{SOURCE}" WITH (FORCE)')


def _store(tmp_path, dump: bytes, objects: dict = OBJECTS) -> Snapshot:
    """A stored source bundle holding `dump` and `objects`, and its row."""
    parts = tmp_path / f"parts-{uuid.uuid4().hex}"
    parts.mkdir()
    (parts / "db.dump").write_bytes(dump)
    write_objects_tar(parts / "objects.tar", objects)
    (parts / "keys").write_bytes(snapshots.encrypt_keys(get_settings(), KEYS))
    src = parts / "bundle.tar.gz"
    bundle.pack(src, source="uat", revision="0089", bucket="serversherpa",
                db_dump=parts / "db.dump", objects_tar=parts / "objects.tar",
                keys_file=parts / "keys")
    snapshot_id = uuid.uuid4()
    snapshots.ensure_dirs(get_settings())
    stored = snapshots.store_bundle(get_settings(), src, snapshot_id)
    return Snapshot(id=snapshot_id, name=f"uat-{snapshot_id.hex[:6]}", origin="upload",
                    source="uat", status="ready", bundle_file=stored.bundle_file,
                    alembic_revision="0089", size_bytes=stored.size_bytes,
                    checksum=stored.checksum, object_count=len(objects))


@pytest.fixture
async def source(db, scratch_url, snapshots_dir, tmp_path, dumps) -> Snapshot:  # noqa: F811
    snap = _store(tmp_path, dumps["full"])
    db.add(snap)
    await db.commit()
    return snap


@pytest.fixture
async def headers(client, db) -> dict:
    return await auth_headers(client, db)


async def _recipe(client, h, tables: dict, files: dict | None = None,
                  name: str | None = None) -> str:
    name = name or f"Recipe {uuid.uuid4().hex[:6]}"
    resp = await client.post("/api/seed/recipes", json={"name": name}, headers=h)
    assert resp.status_code == 201, resp.text
    rid = resp.json()["id"]
    resp = await client.put(f"/api/seed/recipes/{rid}", headers=h,
                            json={"tables": tables, "files": files or {}})
    assert resp.status_code == 200, resp.text
    return rid


async def _start(client, h, rid: str, source: Snapshot, *, reset_passwords: bool = False):
    return await client.post(BUILD.format(rid=rid), headers=h,
                             json={"snapshot_id": str(source.id),
                                   "reset_passwords": reset_passwords})


async def _built(client, db, h, rid: str, source: Snapshot, *,
                 reset_passwords: bool = False) -> Snapshot:
    """Start a build, wait for it, and return the finished row."""
    resp = await _start(client, h, rid, source, reset_passwords=reset_passwords)
    assert resp.status_code == 201, resp.text
    assert resp.json()["status"] == "pending"
    snapshot_id = uuid.UUID(resp.json()["id"])
    await build.wait(snapshot_id)
    snap = await db.get(Snapshot, snapshot_id, populate_existing=True)
    assert snap is not None
    return snap


async def _restored(snap: Snapshot) -> asyncpg.Connection:
    """The built snapshot restored through the ordinary scratch path."""
    name = await scratch.ensure_restored(get_settings(), snap)
    return await scratch.connect(get_settings(), name)


async def _rows(conn, table: str, *cols: str) -> list[tuple]:
    select = ", ".join(cols) if cols else "*"
    found = await conn.fetch(f"SELECT {select} FROM {table} ORDER BY 1")
    return [tuple(r.values()) for r in found]


async def _counts(conn, *tables: str) -> dict[str, int]:
    return {t: await conn.fetchval(f"SELECT count(*) FROM {t}") for t in tables}


def _objects(path: Path) -> dict[str, tuple[bytes, str | None]]:
    """objects.tar's members of a stored bundle: key -> (bytes, content type)."""
    out: dict[str, tuple[bytes, str | None]] = {}

    def on_data(name, size, reader):
        if name != bundle.OBJECTS:
            return
        with tarfile.open(fileobj=reader, mode="r|") as tar:
            for member in tar:
                data = tar.extractfile(member).read()
                out[member.name] = (data, member.pax_headers.get(bundle.CONTENT_TYPE_HEADER))

    bundle._scan(path, on_data=on_data)
    return out


def _databases() -> set[str]:
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        return {r[0] for r in conn.execute("SELECT datname FROM pg_database").fetchall()}


def _roles() -> set[str]:
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        return {r[0] for r in conn.execute("SELECT rolname FROM pg_roles").fetchall()}


def _scratch_gone(source: Snapshot, built: Snapshot) -> None:
    """Both of the build's scratch databases, and their roles, are gone."""
    names = {scratch.db_name(source.id, "build"), scratch.db_name(built.id, "subset")}
    assert not names & _databases()
    assert not names & _roles()


BASIC = {"roles": {"mode": "all"},
         "people": {"mode": "rows", "pks": [{"id": "2"}]},
         "sites": {"mode": "rows", "pks": [{"id": "1"}]},
         "docs": {"mode": "rows", "pks": [{"id": "7"}]},
         "wiki_pages": {"mode": "rows", "pks": [{"id": "2"}]}}

RESET = {"roles": {"mode": "all"},
         "people": {"mode": "rows", "pks": [{"id": "1"}, {"id": "2"}]},
         "user_accounts": {"mode": "all"},
         "password_history": {"mode": "all"},
         "totp_backup_codes": {"mode": "all"},
         "trusted_devices": {"mode": "all"},
         "auth_sessions": {"mode": "all"},
         "password_reset_tokens": {"mode": "all"},
         "biometric_keys": {"mode": "all"}}


# ---- the reset list ------------------------------------------------------------------

def test_reset_list_is_the_agreed_one():
    assert reset.USER_TABLE == "user_accounts"
    assert reset.USER_COLUMNS == {
        "password_hash": None, "must_change_password": True, "password_updated_at": None,
        "totp_secret_enc": None, "totp_confirmed_at": None, "totp_last_counter": None,
        "failed_login_count": 0, "locked_until": None}
    assert reset.EMPTY_TABLES == ("password_history", "totp_backup_codes", "trusted_devices",
                                  "auth_sessions", "password_reset_tokens", "biometric_keys")


# ---- the subset ------------------------------------------------------------------------

async def test_subset_holds_exactly_the_kept_rows(client, db, headers, source):
    rid = await _recipe(client, headers, BASIC)
    built = await _built(client, db, headers, rid, source)
    assert (built.status, built.notes) == ("ready", "")
    conn = await _restored(built)
    try:
        assert await _rows(conn, "alembic_version") == [("0089",)]
        assert await _rows(conn, "roles") == [(1, "admin"), (2, "staff")]       # all: whole
        assert await _rows(conn, "people", "id", "name", "manager_id") == [(2, "Bob", None)]
        assert await _rows(conn, "sites", "id", "created_by") == [(1, None)]    # optional orphan
        assert await conn.fetchval("SELECT tags::text[] FROM sites") == ["ok", "meh"]
        assert await _rows(conn, "docs", "id", "site_id") == [(7, 1)]
        # the closure added page 1 (the parent); loaded in any order
        assert await _rows(conn, "wiki_pages", "id", "parent_id") == [(1, 1), (2, 1)]
        assert await _counts(conn, "user_accounts", "password_history", "audit_log",
                             "auth_sessions") == {"user_accounts": 0, "password_history": 0,
                                                  "audit_log": 0, "auth_sessions": 0}
        # every foreign key holds (a NOT VALID re-check would fail otherwise)
        for table, column in (("people", "manager_id"), ("sites", "created_by"),
                              ("docs", "site_id"), ("wiki_pages", "parent_id")):
            await conn.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {table}_{column}_fkey")
        # sequences keep the source's position: new rows never collide
        assert await conn.fetchval("SELECT last_value FROM audit_log_id_seq") == 3
        # the extensions came along: their public functions aren't the schema's own
        assert await conn.fetchval("SELECT count(*) FROM pg_extension "
                                   "WHERE extname IN ('citext', 'pg_trgm')") == 2
    finally:
        await conn.close()
    _scratch_gone(source, built)


async def test_the_stored_snapshot_row_and_bundle(client, db, headers, source):
    rid = await _recipe(client, headers, BASIC, name="Demo basic")
    built = await _built(client, db, headers, rid, source)
    assert built.name == f"Demo basic from {source.name}"
    assert (built.origin, built.status, built.source, built.reset_passwords) == (
        "recipe", "ready", "uat", False)
    assert built.recipe_id == uuid.UUID(rid) and built.source_snapshot_id == source.id
    assert built.alembic_revision == "0089"
    assert built.object_count == 2 and built.object_bytes == 12 + 14
    assert built.bundle_file == f"{built.id}.tar.gz" and built.checksum
    path = snapshots.bundle_path(get_settings(), built)
    assert built.size_bytes == path.stat().st_size
    manifest, keys_name, keys_data = bundle.read_head(path)
    assert keys_name == bundle.KEYS_ENC
    assert snapshots.decrypt_keys(get_settings(), keys_data) == KEYS   # the source's keys
    assert manifest["recipe"] == {"id": rid, "name": "Demo basic"}
    assert manifest["source_snapshot"] == {"id": str(source.id), "name": source.name}
    assert manifest["reset_passwords"] is False
    assert manifest["rows"] == {"alembic_version": 1, "roles": 2, "people": 1, "sites": 1,
                                "docs": 1, "wiki_pages": 2}
    assert manifest["files"] == 2 and manifest["object_count"] == 2
    assert manifest["source"] == "uat" and manifest["bucket"] == "serversherpa"
    # the API's view
    out = (await client.get(f"{SNAPSHOTS}", headers=headers)).json()["snapshots"]
    mine = next(s for s in out if s["id"] == str(built.id))
    assert mine["recipe"] == {"id": rid, "name": "Demo basic"}
    assert mine["source_snapshot"] == {"id": str(source.id), "name": source.name}
    assert mine["reset_passwords"] is False and mine["origin"] == "recipe"
    theirs = next(s for s in out if s["id"] == str(source.id))
    assert (theirs["recipe"], theirs["source_snapshot"], theirs["reset_passwords"]) == (
        None, None, False)
    assert await db.scalar(select(AuditLog.changes).where(AuditLog.action == "seed.build")) == {
        "recipe": "Demo basic", "snapshot": source.name, "name": built.name,
        "reset_passwords": False}


async def test_objects_tar_holds_only_the_kept_files(client, db, headers, source):
    rid = await _recipe(client, headers, BASIC,
                        files={"docs/plan.pdf": False, "loose/readme.txt": True})
    built = await _built(client, db, headers, rid, source)
    assert built.status == "ready", built.notes
    got = _objects(snapshots.bundle_path(get_settings(), built))
    # Bob's avatar follows his row; the plan is unticked; the readme is ticked
    assert got == {"avatars/bob.png": (b"B" * 12, "image/png"),
                   "loose/readme.txt": (b"R" * 17, "text/plain")}
    rid = await _recipe(client, headers, {"docs": {"mode": "all"}})
    built = await _built(client, db, headers, rid, source)
    got = _objects(snapshots.bundle_path(get_settings(), built))
    assert got == {"docs/plan.pdf": (b"P" * 14, "application/pdf"),
                   "docs/other.pdf": (b"O" * 15, None)}          # no content type stays none


async def test_a_name_that_is_taken_gets_a_suffix(client, db, headers, source):
    rid = await _recipe(client, headers, {"roles": {"mode": "all"}}, name="Tiny")
    first = await _built(client, db, headers, rid, source)
    second = await _built(client, db, headers, rid, source)
    third = await _built(client, db, headers, rid, source)
    assert first.name == f"Tiny from {source.name}"
    assert second.name == f"Tiny from {source.name}-2"
    assert third.name == f"Tiny from {source.name}-3"
    assert {s.status for s in (first, second, third)} == {"ready"}


async def test_a_cut_name_never_ends_in_a_space_or_dash(client, db, headers, source):
    rid = await _recipe(client, headers, {"roles": {"mode": "all"}}, name="N" * 63)
    first = await _built(client, db, headers, rid, source)      # char 64 would be the space
    second = await _built(client, db, headers, rid, source)
    assert first.name == "N" * 63
    assert second.name == "N" * 62 + "-2"
    rid = await _recipe(client, headers, {"roles": {"mode": "all"}}, name="M" * 61)
    await _built(client, db, headers, rid, source)
    second = await _built(client, db, headers, rid, source)     # char 62 would be the space
    assert second.name == "M" * 61 + "-2"
    rid = await _recipe(client, headers, {"roles": {"mode": "all"}}, name="D" * 63 + "-x")
    built = await _built(client, db, headers, rid, source)      # char 64 would be the dash
    assert built.name == "D" * 63
    # an uncut name keeps its ending; a cut name of dashes falls back to the trimmed whole
    rid = await _recipe(client, headers, {"roles": {"mode": "all"}}, name="Dash-")
    built = await _built(client, db, headers, rid, source)
    assert built.name == f"Dash- from {source.name}"
    rid = await _recipe(client, headers, {"roles": {"mode": "all"}}, name="-" * 70)
    built = await _built(client, db, headers, rid, source)
    assert built.name == f"from {source.name}"
    assert snapshots._cut("-" * 70, 64) == "recipe"


async def test_recipe_names_are_cleaned_and_printable(client, db, headers):
    resp = await client.post("/api/seed/recipes", json={"name": "  Demo \t  basic\n"},
                             headers=headers)
    assert resp.status_code == 201 and resp.json()["name"] == "Demo basic"
    rid = resp.json()["id"]
    for bad in ("Demo\x01", "Demo\x7f basic", "\u200b"):
        resp = await client.post("/api/seed/recipes", json={"name": bad}, headers=headers)
        assert (resp.status_code, resp.json()["detail"]) == (422, {"code": "recipe_name_invalid"}), bad
        resp = await client.put(f"/api/seed/recipes/{rid}", json={"name": bad}, headers=headers)
        assert resp.status_code == 422, bad
    resp = await client.put(f"/api/seed/recipes/{rid}", json={"name": " Renamed   twice "},
                            headers=headers)
    assert resp.status_code == 200 and resp.json()["name"] == "Renamed twice"


async def test_a_long_name_stays_within_the_limit(client, db, headers, source):
    long = "L" * 70
    rid = await _recipe(client, headers, {"roles": {"mode": "all"}}, name=long)
    first = await _built(client, db, headers, rid, source)
    second = await _built(client, db, headers, rid, source)
    assert first.name == f"{long} from {source.name}"[:64]
    assert second.name == f"{long} from {source.name}"[:62] + "-2"


# ---- password reset --------------------------------------------------------------------

async def test_reset_empties_the_listed_tables_and_nulls_the_columns(client, db, headers,
                                                                      source):
    rid = await _recipe(client, headers, RESET)
    built = await _built(client, db, headers, rid, source, reset_passwords=True)
    assert (built.status, built.reset_passwords) == ("ready", True)
    conn = await _restored(built)
    try:
        rows = await conn.fetch(
            "SELECT person_id, email, role_id, password_hash, must_change_password, "
            "password_updated_at, totp_secret_enc, totp_confirmed_at, totp_last_counter, "
            "failed_login_count, locked_until FROM user_accounts ORDER BY person_id")
        assert [tuple(r.values()) for r in rows] == [
            (1, "ann@x.test", 1, None, True, None, None, None, None, 0, None),
            (2, "bob@x.test", 2, None, True, None, None, None, None, 0, None)]
        assert await _counts(conn, *reset.EMPTY_TABLES) == {t: 0 for t in reset.EMPTY_TABLES}
        assert await _counts(conn, "people", "roles") == {"people": 2, "roles": 2}
    finally:
        await conn.close()
    manifest = bundle.read_head(snapshots.bundle_path(get_settings(), built))[0]
    assert manifest["reset_passwords"] is True
    assert manifest["rows"]["user_accounts"] == 2 and "password_history" not in manifest["rows"]
    # the emptied tables' files don't follow them (trusted_devices.file_key)
    assert set(_objects(snapshots.bundle_path(get_settings(), built))) == {
        "avatars/ann.png", "avatars/bob.png"}


async def test_without_reset_the_secrets_stay(client, db, headers, source):
    rid = await _recipe(client, headers, RESET)
    built = await _built(client, db, headers, rid, source)
    assert built.status == "ready", built.notes
    conn = await _restored(built)
    try:
        rows = await conn.fetch("SELECT person_id, password_hash, must_change_password, "
                                "totp_secret_enc, totp_last_counter, failed_login_count "
                                "FROM user_accounts ORDER BY person_id")
        assert [tuple(r.values()) for r in rows] == [
            (1, "hash-ann", False, b"\x01\x02", 5, 2), (2, "hash-bob", False, None, None, 0)]
        assert await _counts(conn, *reset.EMPTY_TABLES) == {
            "password_history": 2, "totp_backup_codes": 1, "trusted_devices": 1,
            "auth_sessions": 1, "password_reset_tokens": 1, "biometric_keys": 1}
    finally:
        await conn.close()
    assert set(_objects(snapshots.bundle_path(get_settings(), built))) == {
        "avatars/ann.png", "avatars/bob.png", "devices/d1.bin"}


async def test_an_ordinary_trigger_is_inert_but_its_function_is_refused(
        client, db, headers, scratch_url, snapshots_dir, tmp_path, dumps,  # noqa: F811
        monkeypatch):
    rid = await _recipe(client, headers, RESET)
    with_trigger = _store(tmp_path, dumps["trigger"])
    db.add(with_trigger)
    await db.commit()
    # every trigger calls a function, and a function of the schema's own is refused
    built = await _built(client, db, headers, rid, with_trigger, reset_passwords=True)
    assert (built.status, built.notes) == (
        "failed", "unsafe_schema: 0 always/replica triggers or rules, 1 functions")
    _scratch_gone(with_trigger, built)

    # with the check out of the way: a BEFORE UPDATE trigger returning OLD would
    # keep every secret, and replica mode skips it
    async def no_check(dst):
        return None

    monkeypatch.setattr(build, "_check_schema", no_check)
    built = await _built(client, db, headers, rid, with_trigger, reset_passwords=True)
    assert built.status == "ready", built.notes
    conn = await _restored(built)
    try:
        assert await conn.fetchval(
            "SELECT count(*) FROM user_accounts WHERE password_hash IS NOT NULL "
            "OR totp_secret_enc IS NOT NULL OR NOT must_change_password") == 0
        assert await _counts(conn, *reset.EMPTY_TABLES) == {t: 0 for t in reset.EMPTY_TABLES}
    finally:
        await conn.close()


async def test_always_or_replica_triggers_and_rules_refuse_the_schema(
        client, db, headers, scratch_url, snapshots_dir, tmp_path, dumps):  # noqa: F811
    rid = await _recipe(client, headers, RESET)
    with_rule = _store(tmp_path, dumps["rule"])
    with_leak = _store(tmp_path, dumps["leak"])
    with_check = _store(tmp_path, dumps["check"])
    db.add_all([with_rule, with_leak, with_check])
    await db.commit()
    # a REPLICA trigger (and its function) copying hashes elsewhere: refused with and
    # without the reset
    for reset_passwords in (True, False):
        built = await _built(client, db, headers, rid, with_leak, reset_passwords=reset_passwords)
        assert (built.status, built.notes) == (
            "failed", "unsafe_schema: 1 always/replica triggers or rules, 1 functions"), \
            reset_passwords
        assert built.bundle_file is None
        _scratch_gone(with_leak, built)
    # an ALWAYS rule likewise
    built = await _built(client, db, headers, rid, with_rule, reset_passwords=True)
    assert (built.status, built.notes) == (
        "failed", "unsafe_schema: 1 always/replica triggers or rules, 0 functions")
    _scratch_gone(with_rule, built)
    # a CHECK constraint whose function stashes the hash during the load
    for reset_passwords in (True, False):
        built = await _built(client, db, headers, rid, with_check,
                             reset_passwords=reset_passwords)
        assert (built.status, built.notes) == (
            "failed", "unsafe_schema: 0 always/replica triggers or rules, 1 functions"), \
            reset_passwords
        _scratch_gone(with_check, built)


async def test_rows_the_loader_did_not_put_there_fail_the_build(client, db, headers, source,
                                                                monkeypatch):
    """Defense in depth: were anything to add rows during the load (here, a
    stand-in for the schema check being bypassed), the count check refuses."""
    real_load = build._load

    async def load_and_stray(src, dst, kept):
        counts = await real_load(src, dst, kept)
        await dst.execute("INSERT INTO roles VALUES (99, 'stray')")
        return counts

    monkeypatch.setattr(build, "_load", load_and_stray)
    rid = await _recipe(client, headers, BASIC)
    built = await _built(client, db, headers, rid, source)
    assert (built.status, built.notes) == ("failed", "unexpected_rows: roles")
    assert built.bundle_file is None
    _scratch_gone(source, built)

    async def load_and_fill(src, dst, kept):
        counts = await real_load(src, dst, kept)
        await dst.execute("INSERT INTO audit_log (note) VALUES ('stray')")   # a table not loaded
        return counts

    monkeypatch.setattr(build, "_load", load_and_fill)
    built = await _built(client, db, headers, rid, source)
    assert (built.status, built.notes) == ("failed", "unexpected_rows: audit_log")


async def test_the_reset_is_read_back(client, db, headers, scratch_url, snapshots_dir,  # noqa: F811
                                      tmp_path, dumps, monkeypatch):
    """The second layer: were the schema check ever to miss an ALWAYS rule
    rewriting the UPDATE to nothing, the read-back refuses to ship."""
    async def no_check(dst):
        return None

    monkeypatch.setattr(build, "_check_schema", no_check)
    rid = await _recipe(client, headers, RESET)
    with_rule = _store(tmp_path, dumps["rule"])
    db.add(with_rule)
    await db.commit()
    built = await _built(client, db, headers, rid, with_rule, reset_passwords=True)
    assert (built.status, built.notes) == ("failed", "reset_failed")
    assert built.bundle_file is None
    _scratch_gone(with_rule, built)
    # without the reset the rule never fires on anything: the build goes through
    built = await _built(client, db, headers, rid, with_rule)
    assert built.status == "ready", built.notes


# ---- failures ----------------------------------------------------------------------------

async def test_a_required_orphan_fails_with_its_name(client, db, headers, source, monkeypatch):
    real = seed_files.kept_rows

    async def without_sites(conn, tables):
        kept = await real(conn, tables)
        kept.pop("sites", None)                  # docs 7 needs site 1: forced away
        return kept

    monkeypatch.setattr(seed_files, "kept_rows", without_sites)
    rid = await _recipe(client, headers, BASIC)
    built = await _built(client, db, headers, rid, source)
    assert (built.status, built.notes) == ("failed", "missing_parent: docs 7 needs sites")
    assert built.bundle_file is None and built.checksum is None
    _scratch_gone(source, built)
    assert not list(snapshots.root(get_settings()).glob(f"{built.id}*"))


async def test_a_failure_keeps_the_code_only_and_drops_the_scratch_databases(
        client, db, headers, source, monkeypatch):
    seen: dict = {}
    real = scratch.connect

    async def connect(settings, name):
        conn = await real(settings, name)
        if name.startswith(f"{scratch.PREFIX}_subset_"):
            seen["subset"] = name
            await conn.close()
            raise asyncpg.PostgresError("ERROR: row 'Bob' detail that must never leak")
        return conn

    monkeypatch.setattr(scratch, "connect", connect)
    rid = await _recipe(client, headers, BASIC)
    built = await _built(client, db, headers, rid, source)
    assert built.status == "failed"
    assert built.notes == "scratch_unavailable"
    assert "Bob" not in built.notes
    assert seen["subset"] not in _databases()
    _scratch_gone(source, built)


async def test_a_source_snapshot_in_a_build_cannot_be_deleted(client, db, headers, source,
                                                              monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()
    real = scratch.connect

    async def slow_connect(settings, name):
        if name.startswith(f"{scratch.PREFIX}_subset_"):
            started.set()
            await release.wait()
        return await real(settings, name)

    monkeypatch.setattr(scratch, "connect", slow_connect)
    rid = await _recipe(client, headers, BASIC)
    resp = await _start(client, headers, rid, source)
    assert resp.status_code == 201, resp.text
    built_id = uuid.UUID(resp.json()["id"])
    await started.wait()
    try:
        # the source is in use while the build is pending; so is the pending row
        for snapshot_id in (source.id, built_id):
            resp = await client.delete(f"{SNAPSHOTS}/{snapshot_id}", headers=headers)
            assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "snapshot_in_use")
    finally:
        release.set()
    await build.wait(built_id)
    assert (await db.get(Snapshot, built_id, populate_existing=True)).status == "ready"
    resp = await client.delete(f"{SNAPSHOTS}/{source.id}", headers=headers)
    assert resp.status_code == 204


async def test_cancelling_the_build_drops_the_scratch_databases(client, db, headers, source,
                                                                 monkeypatch):
    started = asyncio.Event()
    real = scratch.connect

    async def hang(settings, name):
        if name.startswith(f"{scratch.PREFIX}_subset_"):
            started.set()
            await asyncio.sleep(3600)
        return await real(settings, name)

    monkeypatch.setattr(scratch, "connect", hang)
    rid = await _recipe(client, headers, BASIC)
    resp = await _start(client, headers, rid, source)
    built_id = uuid.UUID(resp.json()["id"])
    await started.wait()
    assert scratch.db_name(source.id, "build") in _databases()
    await build.shutdown()
    snap = await db.get(Snapshot, built_id, populate_existing=True)
    assert (snap.status, snap.notes) == ("failed", "cancelled")
    _scratch_gone(source, snap)


# ---- the load never runs as the superuser ------------------------------------------------

class _Spy:
    """A connection that records (user, sql) for every statement."""

    def __init__(self, conn, user: str, database: str, log: list):
        self._conn, self._user, self._database, self._log = conn, user, database, log

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def _note(self, sql: str) -> None:
        self._log.append((self._user, self._database, sql))

    async def execute(self, sql, *args, **kw):
        self._note(sql)
        return await self._conn.execute(sql, *args, **kw)

    async def fetch(self, sql, *args, **kw):
        self._note(sql)
        return await self._conn.fetch(sql, *args, **kw)

    async def fetchval(self, sql, *args, **kw):
        self._note(sql)
        return await self._conn.fetchval(sql, *args, **kw)

    async def fetchrow(self, sql, *args, **kw):
        self._note(sql)
        return await self._conn.fetchrow(sql, *args, **kw)

    async def copy_from_query(self, sql, *args, **kw):
        self._note(f"COPY_OUT {sql}")
        return await self._conn.copy_from_query(sql, *args, **kw)

    async def copy_to_table(self, table, **kw):
        self._note(f"COPY_IN {table}")
        return await self._conn.copy_to_table(table, **kw)


# Anything that reads or writes rows, or turns constraints off (the GRANT of
# the parameter is the superuser's job and doesn't match).
DATA_SQL = re.compile(r"\b(COPY|COPY_IN|COPY_OUT|UPDATE|DELETE|TRUNCATE|INSERT|setval)\b"
                      r"|SET\s+(LOCAL\s+)?session_replication_role", re.IGNORECASE)


async def test_the_load_runs_only_as_the_scratch_roles(client, db, headers, source, monkeypatch):
    log: list = []
    real = asyncpg.connect

    async def connect(*args, **kw):
        conn = await real(*args, **kw)
        database = kw.get("database", "")
        if database in (TEST_DB, f"{TEST_DB}_source"):
            return conn                          # Sirdar's own database: not under test
        return _Spy(conn, kw.get("user", ""), database, log)

    monkeypatch.setattr(asyncpg, "connect", connect)
    rid = await _recipe(client, headers, RESET)
    built = await _built(client, db, headers, rid, source, reset_passwords=True)
    assert built.status == "ready", built.notes
    as_super = [(d, s) for u, d, s in log if u == SUPERUSER]
    assert as_super, "the superuser creates and drops the databases"
    for database, sql in as_super:
        assert not database.startswith(f"{scratch.PREFIX}_"), (database, sql)
        assert not DATA_SQL.search(sql), sql
    copies = [(u, d) for u, d, s in log if s.startswith("COPY_IN ")]
    assert copies and all(u == d and d.startswith(f"{scratch.PREFIX}_subset_") for u, d in copies)
    assert any("session_replication_role" in s and u == d for u, d, s in log)


# ---- the endpoint ------------------------------------------------------------------------

async def test_build_needs_deploy_add(client, db, source):
    viewer = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    rid_resp = await client.get("/api/seed/recipes", headers=viewer)
    assert rid_resp.status_code == 200
    boss = await auth_headers(client, db)
    rid = await _recipe(client, boss, {"roles": {"mode": "all"}})
    resp = await _start(client, viewer, rid, source)
    assert (resp.status_code, resp.json()["detail"]) == (403, {"code": "forbidden"})
    assert (await client.post(BUILD.format(rid=rid), json={})).status_code == 401


async def test_build_refuses_bad_inputs(client, db, headers, source):
    rid = await _recipe(client, headers, {"roles": {"mode": "all"}})
    resp = await client.post(BUILD.format(rid=uuid.uuid4()), headers=headers,
                             json={"snapshot_id": str(source.id), "reset_passwords": False})
    assert (resp.status_code, resp.json()["detail"]) == (404, {"code": "recipe_not_found"})
    resp = await client.post(BUILD.format(rid=rid), headers=headers,
                             json={"snapshot_id": str(uuid.uuid4()), "reset_passwords": False})
    assert (resp.status_code, resp.json()["detail"]) == (404, {"code": "snapshot_not_found"})
    pending = Snapshot(name="half", origin="environment", source="uat", status="pending")
    db.add(pending)
    await db.commit()
    resp = await client.post(BUILD.format(rid=rid), headers=headers,
                             json={"snapshot_id": str(pending.id), "reset_passwords": False})
    assert (resp.status_code, resp.json()["detail"]) == (409, {"code": "snapshot_not_ready"})
    for body in ({}, {"snapshot_id": "x"}, {"snapshot_id": str(source.id), "reset_passwords": "y"}):
        assert (await client.post(BUILD.format(rid=rid), headers=headers,
                                  json=body)).status_code == 422, body
    assert await db.scalar(select(Snapshot.id).where(Snapshot.origin == "recipe")) is None


async def test_build_without_the_scratch_server(client, db, monkeypatch):
    h = await auth_headers(client, db)
    monkeypatch.setenv("SIRDAR_SCRATCH_URL", "")
    get_settings.cache_clear()
    try:
        resp = await client.post(BUILD.format(rid=uuid.uuid4()), headers=h,
                                 json={"snapshot_id": str(uuid.uuid4()), "reset_passwords": False})
        assert (resp.status_code, resp.json()["detail"]) == (409, {"code": "scratch_not_configured"})
    finally:
        get_settings.cache_clear()


# ---- the bundle format -------------------------------------------------------------------

def test_manifest_extras_are_checked(tmp_path):
    base = {"format": 1, "source": "uat", "created_at": "2026-11-07T00:00:00Z",
            "alembic_revision": "0089", "bucket": "serversherpa", "object_count": 0,
            "object_bytes": 0, "members": {"keys.enc": "0" * 64, "db.dump": "1" * 64,
                                           "objects.tar": "2" * 64}}
    good = {**base, "recipe": {"id": str(uuid.uuid4()), "name": "Demo"},
            "source_snapshot": {"id": str(uuid.uuid4()), "name": "uat-1"},
            "reset_passwords": True, "rows": {"people": 2}, "files": 1}
    assert bundle.check_manifest(good) == good
    for bad in ({"recipe": "Demo"}, {"recipe": {"id": "x", "name": "Demo"}},
                {"source_snapshot": {"id": str(uuid.uuid4())}}, {"reset_passwords": "yes"},
                {"rows": [1]}, {"rows": {"people": -1}}, {"files": True}, {"files": -1},
                {"unknown": 1}):
        with pytest.raises(bundle.BundleError):
            bundle.check_manifest({**base, **bad})


def test_pack_takes_extra_manifest_fields(tmp_path):
    parts = tmp_path / "parts"
    parts.mkdir()
    (parts / "db.dump").write_bytes(b"PGDMP")
    write_objects_tar(parts / "objects.tar", {})
    (parts / "keys").write_bytes(b"k")
    manifest = bundle.pack(tmp_path / "b.tar.gz", source="uat", revision="0089",
                           bucket="serversherpa", db_dump=parts / "db.dump",
                           objects_tar=parts / "objects.tar", keys_file=parts / "keys",
                           extra={"reset_passwords": True, "rows": {}, "files": 0})
    assert manifest["reset_passwords"] is True
    assert bundle.verify(tmp_path / "b.tar.gz")["rows"] == {}
    with pytest.raises(bundle.BundleError):
        bundle.pack(tmp_path / "c.tar.gz", source="uat", revision="0089",
                    bucket="serversherpa", db_dump=parts / "db.dump",
                    objects_tar=parts / "objects.tar", keys_file=parts / "keys",
                    extra={"members": {}})


# ---- startup ----------------------------------------------------------------------------

async def test_startup_marks_pending_builds_of_a_dead_process_failed(db, monkeypatch):
    orphan = Snapshot(name="orphan", origin="recipe", source="uat", status="pending")
    live = Snapshot(name="live", origin="recipe", source="uat", status="pending")
    taking = Snapshot(name="taking", origin="environment", source="uat", status="pending")
    db.add_all([orphan, live, taking])
    await db.commit()
    monkeypatch.setitem(build._tasks, live.id, object())        # this process's own build
    assert await build.recover_orphans() == 1
    rows = {s.name: (s.status, s.notes) for s in await db.scalars(
        select(Snapshot).execution_options(populate_existing=True))}
    assert rows == {"orphan": ("failed", "interrupted"), "live": ("pending", ""),
                    "taking": ("pending", "")}
    assert await build.recover_orphans() == 0
