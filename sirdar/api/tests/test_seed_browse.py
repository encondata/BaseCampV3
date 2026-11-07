"""Browsing a snapshot's tables and rows for Seed Data (Task 3)."""

import os
import subprocess
import urllib.parse
from pathlib import Path

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url

from sirdar_api.config import get_settings
from sirdar_api.seed import SeedError, scratch
from sirdar_api.seed.files import file_columns

from .api_helpers import auth_headers
from .conftest import BASE_URL, TEST_DB, _psycopg_url, pg_bin_dir_for_tests
from .deploy_factories import secrets_key, snapshots_dir  # noqa: F401
from .test_seed_scratch import _snapshot

SOURCE = f"{TEST_DB}_browsesrc"
ODD = 'Odd "Name"'

SCHEMA = [
    "CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)",
    "INSERT INTO alembic_version VALUES ('0089')",
    ("CREATE TABLE sites (id int PRIMARY KEY, name text NOT NULL, logo_key text, "
     "photo_storage_key text, storage_keys text, data bytea, meta json)"),
    ("INSERT INTO sites VALUES (1, 'North', 'logos/n.png', NULL, NULL, '\\x0102', '{\"a\": 1}'), "
     "(2, 'South', NULL, NULL, NULL, NULL, NULL), (3, 'north east', NULL, NULL, NULL, NULL, NULL), "
     f"(4, '{'x' * 300}', NULL, NULL, NULL, NULL, NULL)"),
    ("CREATE TABLE racks (id int PRIMARY KEY, site_id int NOT NULL REFERENCES sites(id), "
     "name text)"),
    ("INSERT INTO racks SELECT i, 1 + i % 2, 'R' || lpad(i::text, 3, '0') "
     "FROM generate_series(1, 120) i"),
    "CREATE TABLE events (msg text, at int)",
    "INSERT INTO events VALUES ('one', 1), ('two', 2), ('three', 3)",
    "CREATE TABLE memberships (person int, team int, role text, PRIMARY KEY (team, person))",
    "INSERT INTO memberships VALUES (1, 7, 'lead'), (2, 7, 'member'), (1, 8, 'member')",
    'CREATE TABLE "Odd ""Name""" ("Weird Col" text PRIMARY KEY)',
    'INSERT INTO "Odd ""Name""" VALUES ' + "('a_b'), ('a%b'), ('axb')",
    "CREATE SCHEMA other",
    "CREATE TABLE other.hidden (id int PRIMARY KEY)",
]


@pytest.fixture(scope="module")
def browse_dump() -> bytes:
    """A pg_dump -Fc of the browse schema above."""
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{SOURCE}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{SOURCE}"')
    try:
        with psycopg.connect(_psycopg_url(SOURCE), autocommit=True) as conn:
            for sql in SCHEMA:
                conn.execute(sql)
        bin_dir = pg_bin_dir_for_tests()
        if bin_dir is None:
            pytest.skip("no pg_dump matching the test Postgres's major version")
        url = make_url(BASE_URL)
        tool = str(Path(bin_dir) / "pg_dump") if bin_dir else "pg_dump"
        done = subprocess.run(
            [tool, "-Fc", "--host", url.host, "--port", str(url.port),
             "--username", url.username, "--no-password", SOURCE],
            env={**os.environ, "PGPASSWORD": url.password or ""}, check=True,
            capture_output=True)
        return done.stdout
    finally:
        with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{SOURCE}" WITH (FORCE)')


@pytest.fixture
async def opened(client, db, scratch_url, snapshots_dir, tmp_path, browse_dump):  # noqa: F811
    """(base URL of the snapshot's browse endpoints, auth headers), restored."""
    snap = _snapshot(tmp_path, browse_dump)
    db.add(snap)
    await db.commit()
    await scratch.ensure_restored(get_settings(), snap)
    headers = await auth_headers(client, db)
    return f"/api/seed/snapshots/{snap.id}", headers


def _t(name: str) -> str:
    return urllib.parse.quote(name, safe="")


def test_file_columns_naming_rule():
    cols = ["id", "storage_key", "preview_key", "avatar_key", "logo_key", "file_key",
            "photo_storage_key", "storage_keys", "my_file_key", "storage_key_old", "_storage_key"]
    assert file_columns(cols) == ["storage_key", "preview_key", "avatar_key", "logo_key",
                                  "file_key", "photo_storage_key", "_storage_key"]


async def test_tables_list(client, opened):
    base, h = opened
    resp = await client.get(f"{base}/tables", headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json() == [
        {"table": ODD, "rows": 3, "pk": ["Weird Col"], "file_columns": []},
        {"table": "events", "rows": 3, "pk": None, "file_columns": []},
        {"table": "memberships", "rows": 3, "pk": ["team", "person"], "file_columns": []},
        {"table": "racks", "rows": 120, "pk": ["id"], "file_columns": []},
        {"table": "sites", "rows": 4, "pk": ["id"],
         "file_columns": ["logo_key", "photo_storage_key"]},
    ]


async def test_rows_page_sort_and_filter(client, opened):
    base, h = opened
    resp = await client.get(f"{base}/tables/racks/rows", headers=h)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 120
    assert body["columns"] == [{"name": "id", "type": "integer"},
                               {"name": "site_id", "type": "integer"},
                               {"name": "name", "type": "text"}]
    assert len(body["rows"]) == 50
    assert body["rows"][0] == {"pk": {"id": "1"},
                               "values": {"id": "1", "site_id": "2", "name": "R001"}}
    assert body["rows"][49]["pk"] == {"id": "50"}

    body = (await client.get(f"{base}/tables/racks/rows?page=3&size=50", headers=h)).json()
    assert [r["pk"]["id"] for r in body["rows"]] == [str(i) for i in range(101, 121)]

    body = (await client.get(f"{base}/tables/racks/rows?sort=name&dir=desc&size=3",
                             headers=h)).json()
    assert [r["values"]["name"] for r in body["rows"]] == ["R120", "R119", "R118"]

    # Ties keep a stable order (by primary key) across pages.
    body = (await client.get(f"{base}/tables/racks/rows?sort=site_id&dir=asc&size=4",
                             headers=h)).json()
    assert [r["pk"]["id"] for r in body["rows"]] == ["2", "4", "6", "8"]

    body = (await client.get(f"{base}/tables/racks/rows?filter_col=name&filter=r01",
                             headers=h)).json()
    assert body["total"] == 10
    assert [r["values"]["name"] for r in body["rows"]] == [f"R01{i}" for i in range(10)]

    body = (await client.get(f"{base}/tables/racks/rows?filter_col=id&filter=11&size=2",
                             headers=h)).json()
    assert body["total"] == 11                      # 11 and 110..119, matched as text
    assert [r["pk"]["id"] for r in body["rows"]] == ["11", "110"]

    for bad in ("page=0", "size=0", "dir=sideways"):
        assert (await client.get(f"{base}/tables/racks/rows?{bad}",
                                 headers=h)).status_code == 422, bad


async def test_values_are_text_cut_to_200_and_bytea_as_a_size(client, opened):
    base, h = opened
    body = (await client.get(f"{base}/tables/sites/rows", headers=h)).json()
    rows = {r["pk"]["id"]: r["values"] for r in body["rows"]}
    assert rows["1"] == {"id": "1", "name": "North", "logo_key": "logos/n.png",
                         "photo_storage_key": None, "storage_keys": None,
                         "data": "<2 bytes>", "meta": '{"a": 1}'}
    assert rows["2"]["data"] is None
    assert rows["4"]["name"] == "x" * 200
    assert {"name": "data", "type": "bytea"} in body["columns"]
    # A column with no ordering (json) can't be sorted on; it says so.
    resp = await client.get(f"{base}/tables/sites/rows?sort=meta", headers=h)
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "column_not_sortable"


async def test_filter_is_case_insensitive_and_literal(client, opened):
    base, h = opened
    body = (await client.get(f"{base}/tables/sites/rows?filter_col=name&filter=NORTH",
                             headers=h)).json()
    assert sorted(r["pk"]["id"] for r in body["rows"]) == ["1", "3"]
    odd = f"{base}/tables/{_t(ODD)}"
    col = _t("Weird Col")
    for needle, expected in (("%", ["a%b"]), ("_", ["a_b"]), ("a", ["a%b", "a_b", "axb"])):
        resp = await client.get(f"{odd}/rows?filter_col={col}&filter={_t(needle)}", headers=h)
        assert resp.status_code == 200, resp.text
        assert sorted(r["values"]["Weird Col"] for r in resp.json()["rows"]) == expected
    # A filter needs its column: never silently the whole table.
    resp = await client.get(f"{base}/tables/racks/keys?filter=R01", headers=h)
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "filter_col_required"


async def test_unknown_or_injected_names_are_refused(client, opened):
    base, h = opened
    for table in ("nope", "racks; DROP TABLE sites", 'racks"--', "other.hidden", "hidden",
                  "alembic_version", "pg_class", "RACKS", "racks\x00"):
        for what in ("rows", "keys"):
            resp = await client.get(f"{base}/tables/{_t(table)}/{what}", headers=h)
            assert resp.status_code == 404, (table, what, resp.text)
            assert resp.json()["detail"]["code"] == "table_not_found"
    for query in ("sort=nope", "sort=id%3B%20DROP%20TABLE%20sites", "sort=ctid",
                  'filter_col=name"--&filter=x', "filter_col=xmin&filter=1"):
        resp = await client.get(f"{base}/tables/racks/rows?{query}", headers=h)
        assert resp.status_code == 404, (query, resp.text)
        assert resp.json()["detail"]["code"] == "column_not_found"
    resp = await client.get(f"{base}/tables/racks/keys?filter_col=nope&filter=1", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "column_not_found"
    # Nothing was dropped.
    assert (await client.get(f"{base}/tables/sites/rows", headers=h)).json()["total"] == 4


async def test_keys_return_every_matching_key(client, opened):
    base, h = opened
    body = (await client.get(f"{base}/tables/racks/keys?filter_col=name&filter=R01",
                             headers=h)).json()
    assert body == {"pks": [{"id": str(i)} for i in range(10, 20)], "total": 10}
    body = (await client.get(f"{base}/tables/racks/keys", headers=h)).json()
    assert body["total"] == 120
    assert body["pks"] == [{"id": str(i)} for i in range(1, 121)]
    body = (await client.get(f"{base}/tables/memberships/keys?filter_col=role&filter=member",
                             headers=h)).json()
    assert body == {"pks": [{"team": "7", "person": "2"}, {"team": "8", "person": "1"}],
                    "total": 2}


async def test_a_table_without_a_primary_key(client, opened):
    base, h = opened
    body = (await client.get(f"{base}/tables/events/rows", headers=h)).json()
    assert body["total"] == 3
    assert [r["pk"] for r in body["rows"]] == [None, None, None]
    assert sorted(r["values"]["msg"] for r in body["rows"]) == ["one", "three", "two"]
    resp = await client.get(f"{base}/tables/events/keys", headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "no_primary_key"


async def test_composite_key_rows(client, opened):
    base, h = opened
    body = (await client.get(f"{base}/tables/memberships/rows", headers=h)).json()
    assert [r["pk"] for r in body["rows"]] == [
        {"team": "7", "person": "1"}, {"team": "7", "person": "2"}, {"team": "8", "person": "1"}]


async def test_access_needs_seed_data(client, db, opened):
    base, _ = opened
    for path in ("/tables", "/tables/racks/rows", "/tables/racks/keys"):
        assert (await client.get(base + path)).status_code == 401
    await db.execute(text("DELETE FROM role_permissions WHERE role = 'admin' "
                          "AND resource = 'seed_data'"))
    await db.commit()
    h = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    for path in ("/tables", "/tables/racks/rows", "/tables/racks/keys"):
        resp = await client.get(base + path, headers=h)
        assert resp.status_code == 403, path
        assert resp.json()["detail"]["code"] == "forbidden"


async def test_browsing_needs_an_open_snapshot(client, db, scratch_url, snapshots_dir,  # noqa: F811
                                               tmp_path, browse_dump):
    import uuid
    snap = _snapshot(tmp_path, browse_dump)
    db.add(snap)
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.get(f"/api/seed/snapshots/{snap.id}/tables", headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "snapshot_not_open", "status": "absent"}
    resp = await client.get(f"/api/seed/snapshots/{uuid.uuid4()}/tables", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "snapshot_not_found"


async def test_an_unreachable_scratch_server_answers_503(client, opened, monkeypatch):
    base, h = opened

    async def broken(settings, name):
        raise OSError("connection refused to 10.0.0.9 secret-host")

    monkeypatch.setattr(scratch, "connect", broken)
    resp = await client.get(f"{base}/tables", headers=h)
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "scratch_unavailable"
    assert "secret-host" not in resp.text


async def test_scratch_unavailable_error_maps_to_503(client, opened, monkeypatch):
    base, h = opened

    async def unavailable(settings, snap, purpose="browse"):
        raise SeedError("scratch_unavailable", reason="The scratch Postgres can't be reached.")

    monkeypatch.setattr(scratch, "ensure_restored", unavailable)
    resp = await client.get(f"{base}/tables/racks/rows", headers=h)
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "scratch_unavailable"
