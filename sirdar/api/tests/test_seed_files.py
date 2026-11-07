"""Seed Data files that follow the records (Task 6)."""

import os
import subprocess
import uuid
from pathlib import Path

import asyncpg
import psycopg
import pytest
from sqlalchemy.engine import make_url

from sirdar_api.config import get_settings
from sirdar_api.db.models import Snapshot
from sirdar_api.deploy import bundle, snapshots
from sirdar_api.seed import files as sf
from sirdar_api.seed import scratch

from .api_helpers import auth_headers
from .bundle_helpers import write_objects_tar
from .conftest import BASE_URL, TEST_DB, _psycopg_url, pg_bin_dir_for_tests
from .deploy_factories import secrets_key, snapshots_dir  # noqa: F401
from .test_seed_scratch import KEYS

SOURCE = f"{TEST_DB}_filessrc"

SCHEMA = [
    "CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)",
    "INSERT INTO alembic_version VALUES ('0089')",
    "CREATE TABLE partners (id int PRIMARY KEY, name text NOT NULL, logo_key text)",
    "INSERT INTO partners VALUES (1, 'Partner A', 'logos/a.png'), (2, 'Partner B', NULL)",
    ("CREATE TABLE people (id int PRIMARY KEY, partner_id int NOT NULL REFERENCES partners, "
     "name text NOT NULL, avatar_key text, keyring text)"),
    ("INSERT INTO people VALUES (1, 1, 'Person A', 'avatars/a.png', 'avatars/b.png'), "
     "(2, 2, 'Person B', 'avatars/b.png', NULL), (3, 2, 'Person C', 'avatars/ghost.png', NULL)"),
    ("CREATE TABLE docs (id int PRIMARY KEY, person_id int NOT NULL REFERENCES people, "
     "title text, scan_storage_key text, preview_key text)"),
    "INSERT INTO docs VALUES (7, 1, 'Plan', 'docs/plan.pdf', 'previews/plan.png')",
    "CREATE TABLE blobs (note text, file_key text)",
    "INSERT INTO blobs VALUES ('x', 'blobs/x.bin')",
]

OBJECTS = {
    "avatars/a.png": (b"A" * 11, "image/png"),
    "avatars/b.png": (b"B" * 12, "image/png"),
    "logos/a.png": (b"L" * 13, "image/png"),
    "docs/plan.pdf": (b"P" * 14, "application/pdf"),
    "previews/plan.png": (b"V" * 15, None),
    "blobs/x.bin": (b"X" * 16, None),
    "loose/readme.txt": (b"R" * 17, "text/plain"),
}


@pytest.fixture(scope="module")
def source_db() -> str:
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{SOURCE}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{SOURCE}"')
    try:
        with psycopg.connect(_psycopg_url(SOURCE), autocommit=True) as conn:
            for sql in SCHEMA:
                conn.execute(sql)
        yield SOURCE
    finally:
        with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{SOURCE}" WITH (FORCE)')


@pytest.fixture
async def conn(source_db):
    c = await asyncpg.connect(_psycopg_url(source_db))
    try:
        yield c
    finally:
        await c.close()


@pytest.fixture(scope="module")
def files_dump(source_db) -> bytes:
    bin_dir = pg_bin_dir_for_tests()
    if bin_dir is None:
        pytest.skip("no pg_dump matching the test Postgres's major version")
    url = make_url(BASE_URL)
    done = subprocess.run(
        [str(Path(bin_dir) / "pg_dump"), "-Fc", "--host", url.host, "--port", str(url.port),
         "--username", url.username, "--no-password", source_db],
        env={**os.environ, "PGPASSWORD": url.password or ""}, check=True, capture_output=True)
    return done.stdout


def _bundle(tmp_path, dump: bytes, objects: dict = OBJECTS) -> Path:
    parts = tmp_path / f"parts-{uuid.uuid4().hex}"
    parts.mkdir()
    (parts / "db.dump").write_bytes(dump)
    write_objects_tar(parts / "objects.tar", objects)
    (parts / "keys").write_bytes(snapshots.encrypt_keys(get_settings(), KEYS))
    src = parts / "bundle.tar.gz"
    bundle.pack(src, source="uat", revision="0089", bucket="serversherpa",
                db_dump=parts / "db.dump", objects_tar=parts / "objects.tar",
                keys_file=parts / "keys")
    return src


def _snapshot(tmp_path, dump: bytes) -> Snapshot:
    src = _bundle(tmp_path, dump)
    snapshot_id = uuid.uuid4()
    snapshots.ensure_dirs(get_settings())
    stored = snapshots.store_bundle(get_settings(), src, snapshot_id)
    return Snapshot(id=snapshot_id, name=f"snap-{snapshot_id.hex[:8]}", origin="upload",
                    source="uat", status="ready", bundle_file=stored.bundle_file,
                    alembic_revision="0089", size_bytes=stored.size_bytes,
                    checksum=stored.checksum)


@pytest.fixture
async def opened(client, db, scratch_url, snapshots_dir, tmp_path, files_dump):  # noqa: F811
    snap = _snapshot(tmp_path, files_dump)
    db.add(snap)
    await db.commit()
    await scratch.ensure_restored(get_settings(), snap)
    headers = await auth_headers(client, db)
    return f"/api/seed/snapshots/{snap.id}", headers


async def _recipe(client, h, tables: dict, files: dict | None = None) -> str:
    resp = await client.post("/api/seed/recipes", json={"name": f"r-{uuid.uuid4().hex[:6]}"},
                             headers=h)
    assert resp.status_code == 201, resp.text
    rid = resp.json()["id"]
    resp = await client.put(f"/api/seed/recipes/{rid}", headers=h,
                            json={"tables": tables, "files": files or {}})
    assert resp.status_code == 200, resp.text
    return rid


# ---- the naming rule ---------------------------------------------------------------

def test_naming_rule_is_exactly_the_listed_names_and_the_suffix():
    cols = ["storage_key", "preview_key", "avatar_key", "logo_key", "file_key",
            "photo_storage_key", "x_storage_key", "_storage_key",
            "storage_keys", "storagekey", "Storage_Key", "avatar", "keyring", "key",
            "file_keys", "logo_key_old", "storage_key_2", "my_file_key", "thumb_key"]
    assert sf.file_columns(cols) == ["storage_key", "preview_key", "avatar_key", "logo_key",
                                     "file_key", "photo_storage_key", "x_storage_key",
                                     "_storage_key"]


def test_because_phrases():
    assert sf.because("avatar_key", "Person A", "people") == "Avatar of Person A (people)"
    assert sf.because("logo_key", "Partner A", "partners") == "Logo of Partner A (partners)"
    assert sf.because("scan_storage_key", "Plan", "docs") == "File on Plan (docs)"
    assert sf.because("file_key", None, "blobs") == "File on a row (blobs)"


# ---- object_keys -------------------------------------------------------------------

def test_object_keys_lists_members_and_sizes(tmp_path, secrets_key):  # noqa: F811
    path = _bundle(tmp_path, b"PGDMP-fake")
    assert sf.object_keys(path) == [(k, len(v[0])) for k, v in OBJECTS.items()]


def test_object_keys_of_an_empty_objects_tar(tmp_path, secrets_key):  # noqa: F811
    assert sf.object_keys(_bundle(tmp_path, b"PGDMP-fake", {})) == []


def test_object_keys_refuses_a_damaged_bundle(tmp_path):
    bad = tmp_path / "bad.tar.gz"
    bad.write_bytes(b"not a bundle")
    with pytest.raises(bundle.BundleError):
        sf.object_keys(bad)


# ---- referenced --------------------------------------------------------------------

async def test_referenced_maps_keys_to_their_first_kept_row(conn):
    refs = await sf.referenced(conn, {"people": {("1",)}, "docs": {("7",)}, "blobs": "all"})
    assert refs == {
        "avatars/a.png": sf.Reason("people", ("1",), "Person A", "avatar_key"),
        "docs/plan.pdf": sf.Reason("docs", ("7",), "Plan", "scan_storage_key"),
        "previews/plan.png": sf.Reason("docs", ("7",), "Plan", "preview_key"),
        "blobs/x.bin": sf.Reason("blobs", None, None, "file_key"),
    }


async def test_referenced_all_rows_first_row_wins(conn):
    refs = await sf.referenced(conn, {"people": "all"})
    assert refs["avatars/b.png"] == sf.Reason("people", ("2",), "Person B", "avatar_key")
    assert refs["avatars/ghost.png"].pk == ("3",)
    assert "logos/a.png" not in refs                  # partners isn't kept


async def test_referenced_compares_pks_as_text(conn):
    assert await sf.referenced(conn, {"people": {("01",)}}) == {}
    assert await sf.referenced(conn, {"people": set()}) == {}


# ---- GET /files ----------------------------------------------------------------------

async def _files(client, base, h, rid, **params):
    resp = await client.get(f"{base}/files", headers=h, params={"recipe_id": rid, **params})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_a_kept_rows_files_are_kept_with_the_reason(client, opened):
    base, h = opened
    rid = await _recipe(client, h, {"docs": {"mode": "rows", "pks": [{"id": "7"}]}})
    out = await _files(client, base, h, rid, size=100)
    assert out["total"] == len(OBJECTS)
    got = {f["key"]: (f["kept"], f["because"]) for f in out["files"]}
    assert got == {
        "avatars/a.png": (True, "Avatar of Person A (people)"),   # docs 7 needs person 1
        "avatars/b.png": (False, "—"),                            # keyring isn't a file column
        "logos/a.png": (True, "Logo of Partner A (partners)"),    # person 1 needs partner 1
        "docs/plan.pdf": (True, "File on Plan (docs)"),
        "previews/plan.png": (True, "File on Plan (docs)"),
        "blobs/x.bin": (False, "—"),
        "loose/readme.txt": (False, "—"),
    }
    sizes = {f["key"]: f["size"] for f in out["files"]}
    assert sizes["loose/readme.txt"] == 17
    assert [f["key"] for f in out["files"]] == sorted(OBJECTS)


async def test_manual_drop_beats_a_reference_and_manual_keep_keeps(client, opened):
    base, h = opened
    rid = await _recipe(client, h, {"people": {"mode": "rows", "pks": [{"id": "1"}]},
                                    "blobs": {"mode": "all", "pks": []}},
                        {"avatars/a.png": False, "loose/readme.txt": True})
    got = {f["key"]: (f["kept"], f["because"])
           for f in (await _files(client, base, h, rid, size=100))["files"]}
    assert got["avatars/a.png"] == (False, "Unticked by hand (Avatar of Person A (people))")
    assert got["loose/readme.txt"] == (True, "Ticked by hand")
    assert got["avatars/b.png"] == (False, "—")               # unreferenced, not kept
    assert got["blobs/x.bin"] == (True, "File on a row (blobs)")


async def test_each_file_carries_its_reference_phrase_or_none(client, opened):
    base, h = opened
    rid = await _recipe(client, h, {"people": {"mode": "rows", "pks": [{"id": "1"}]}},
                        {"avatars/a.png": False, "loose/readme.txt": True})
    got = {f["key"]: f["reference"]
           for f in (await _files(client, base, h, rid, size=100))["files"]}
    assert got["avatars/a.png"] == "Avatar of Person A (people)"   # unticked, still referenced
    assert got["loose/readme.txt"] is None                         # ticked by hand only
    assert got["avatars/b.png"] is None


async def test_a_key_not_in_objects_tar_is_ignored(client, opened):
    base, h = opened
    rid = await _recipe(client, h, {"people": {"mode": "rows", "pks": [{"id": "3"}]}},
                        {"nowhere.bin": True})
    out = await _files(client, base, h, rid, size=100)
    keys = [f["key"] for f in out["files"]]
    assert "avatars/ghost.png" not in keys and "nowhere.bin" not in keys
    assert out["total"] == len(OBJECTS)


async def test_files_page_and_filter(client, opened):
    base, h = opened
    rid = await _recipe(client, h, {})
    out = await _files(client, base, h, rid, page=2, size=3)
    assert out["total"] == len(OBJECTS)
    assert [f["key"] for f in out["files"]] == sorted(OBJECTS)[3:6]
    out = await _files(client, base, h, rid, filter="PLAN")
    assert out["total"] == 2
    assert [f["key"] for f in out["files"]] == ["docs/plan.pdf", "previews/plan.png"]
    out = await _files(client, base, h, rid, filter="100%_")
    assert out == {"files": [], "total": 0}


async def test_files_needs_a_recipe_and_valid_params(client, opened):
    base, h = opened
    resp = await client.get(f"{base}/files", headers=h, params={"recipe_id": str(uuid.uuid4())})
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"code": "recipe_not_found"}
    assert (await client.get(f"{base}/files", headers=h)).status_code == 422
    rid = await _recipe(client, h, {})
    for bad in ({"page": 0}, {"size": 0}, {"size": 1001}):
        resp = await client.get(f"{base}/files", headers=h, params={"recipe_id": rid, **bad})
        assert resp.status_code == 422, bad
    assert (await client.get(f"{base}/files", params={"recipe_id": rid})).status_code == 401


async def test_object_list_is_cached_per_snapshot(client, opened, monkeypatch):
    base, h = opened
    rid = await _recipe(client, h, {})
    calls = []
    real = sf.object_keys
    monkeypatch.setattr(sf, "object_keys", lambda *a: calls.append(a) or real(*a))
    sf.forget_objects()
    await _files(client, base, h, rid)
    await _files(client, base, h, rid, page=2)
    assert len(calls) == 1


async def test_deleting_a_snapshot_forgets_its_object_list(client, db, opened):
    base, h = opened
    rid = await _recipe(client, h, {})
    await _files(client, base, h, rid)
    snapshot_id = uuid.UUID(base.rsplit("/", 1)[1])
    assert snapshot_id in sf._objects
    resp = await client.delete(f"/api/deploy/snapshots/{snapshot_id}", headers=h)
    assert resp.status_code == 204, resp.text
    assert snapshot_id not in sf._objects
