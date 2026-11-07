"""Needed rows for Seed Data: the closure over required links (Task 4)."""

import os
import subprocess
from pathlib import Path

import asyncpg
import psycopg
import pytest
from sqlalchemy.engine import make_url

from sirdar_api.config import get_settings
from sirdar_api.seed import closure as cl
from sirdar_api.seed import scratch

from .api_helpers import auth_headers
from .conftest import BASE_URL, TEST_DB, _psycopg_url, pg_bin_dir_for_tests
from .deploy_factories import secrets_key, snapshots_dir  # noqa: F401
from .test_seed_scratch import _snapshot

SOURCE = f"{TEST_DB}_closuresrc"

SCHEMA = [
    "CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)",
    "INSERT INTO alembic_version VALUES ('0089')",
    "CREATE TABLE regions (id int PRIMARY KEY, name text NOT NULL)",
    "INSERT INTO regions VALUES (1, 'East'), (2, 'West')",
    ("CREATE TABLE partners (id int PRIMARY KEY, region_id int NOT NULL REFERENCES regions, "
     "name text NOT NULL)"),
    "INSERT INTO partners VALUES (1, 1, 'Partner A'), (2, 1, 'Partner B'), (3, 2, 'Partner C')",
    ("CREATE TABLE people (id int PRIMARY KEY, partner_id int NOT NULL REFERENCES partners, "
     "name text NOT NULL)"),
    "INSERT INTO people VALUES (1, 1, 'Person D'), (2, 2, 'Person E'), (3, 3, 'Person F')",
    "CREATE TABLE sites (id int PRIMARY KEY, name text, created_by int REFERENCES people)",
    "INSERT INTO sites VALUES (1, 'North', 3)",
    ("CREATE TABLE worker_profiles (id int PRIMARY KEY, "
     "person_id int NOT NULL REFERENCES people, site_id int REFERENCES sites, title text)"),
    "INSERT INTO worker_profiles VALUES (10, 1, 1, 'Rigger'), (11, 2, NULL, 'Lead')",
    ("CREATE TABLE wiki_pages (id int PRIMARY KEY, "
     "parent_id int NOT NULL REFERENCES wiki_pages DEFERRABLE INITIALLY DEFERRED, title text)"),
    ("INSERT INTO wiki_pages VALUES (1, 1, 'Home'), (2, 1, 'Guides'), (3, 2, 'Racking'), "
     "(4, 1, 'Other')"),
    ("CREATE TABLE teams (org int, code text, label text NOT NULL, "
     "PRIMARY KEY (org, code))"),
    ("INSERT INTO teams VALUES (1, 'red', 'Red team'), (1, 'blue', 'Blue team'), "
     "(2, 'red', 'Red two')"),
    ("CREATE TABLE members (id int PRIMARY KEY, org int NOT NULL, team_code text NOT NULL, "
     "alt_code text, nick text, "
     "FOREIGN KEY (org, team_code) REFERENCES teams (org, code), "
     "FOREIGN KEY (org, alt_code) REFERENCES teams (org, code))"),
    "INSERT INTO members VALUES (1, 1, 'red', 'blue', 'Ann'), (2, 2, 'red', NULL, NULL)",
    "CREATE TABLE cyc_a (id int PRIMARY KEY, b_id int NOT NULL)",
    "CREATE TABLE cyc_b (id int PRIMARY KEY, a_id int NOT NULL)",
    ("ALTER TABLE cyc_a ADD FOREIGN KEY (b_id) REFERENCES cyc_b "
     "DEFERRABLE INITIALLY DEFERRED"),
    ("ALTER TABLE cyc_b ADD FOREIGN KEY (a_id) REFERENCES cyc_a "
     "DEFERRABLE INITIALLY DEFERRED"),
    ("BEGIN; INSERT INTO cyc_a VALUES (1, 1), (2, 2); "
     "INSERT INTO cyc_b VALUES (1, 1), (2, 2); COMMIT"),
    # A pk-less parent (rows named only by a UNIQUE column), itself linked up.
    ("CREATE TABLE codes (code text UNIQUE NOT NULL, "
     "region_id int NOT NULL REFERENCES regions, note text)"),
    "INSERT INTO codes VALUES ('A', 1, 'first'), ('B', 2, 'second')",
    "CREATE TABLE code_uses (id int PRIMARY KEY, code text NOT NULL REFERENCES codes (code))",
    "INSERT INTO code_uses VALUES (1, 'A')",
    # A link to a UNIQUE column of a parent with a separate surrogate pk.
    ("CREATE TABLE devices (id int PRIMARY KEY, serial text UNIQUE NOT NULL, "
     "name text)"),
    "INSERT INTO devices VALUES (5, 'SN-1', 'Scanner'), (6, 'SN-2', 'Other')",
    ("CREATE TABLE scans (id int PRIMARY KEY, "
     "serial text NOT NULL REFERENCES devices (serial))"),
    "INSERT INTO scans VALUES (1, 'SN-1')",
    # a generated constant in a composite link (ServerSherpa's status columns):
    # Sirdar can't empty it, so the link is required when the rest is NOT NULL
    ("CREATE TABLE kinds (record_type text, key text, PRIMARY KEY (record_type, key))"),
    "INSERT INTO kinds VALUES ('gadget', 'new'), ('gadget', 'used')",
    ("CREATE TABLE gadgets (id int PRIMARY KEY, kind text NOT NULL, "
     "kind_record_type text GENERATED ALWAYS AS ('gadget') STORED, old_kind text, "
     "FOREIGN KEY (kind_record_type, kind) REFERENCES kinds (record_type, key), "
     "FOREIGN KEY (kind_record_type, old_kind) REFERENCES kinds (record_type, key))"),
    "INSERT INTO gadgets (id, kind, old_kind) VALUES (1, 'new', 'used')",
    "CREATE SCHEMA other",
    "CREATE TABLE other.outside (id int PRIMARY KEY)",
    ("CREATE TABLE other.points_in (id int PRIMARY KEY, "
     "partner_id int NOT NULL REFERENCES public.partners)"),
]


@pytest.fixture(scope="module")
def source_db() -> str:
    """A database holding the schema above (dropped after the module)."""
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
def closure_dump(source_db) -> bytes:
    bin_dir = pg_bin_dir_for_tests()
    if bin_dir is None:
        pytest.skip("no pg_dump matching the test Postgres's major version")
    url = make_url(BASE_URL)
    done = subprocess.run(
        [str(Path(bin_dir) / "pg_dump"), "-Fc", "--host", url.host, "--port", str(url.port),
         "--username", url.username, "--no-password", source_db],
        env={**os.environ, "PGPASSWORD": url.password or ""}, check=True, capture_output=True)
    return done.stdout


@pytest.fixture
async def opened(client, db, scratch_url, snapshots_dir, tmp_path, closure_dump):  # noqa: F811
    snap = _snapshot(tmp_path, closure_dump)
    db.add(snap)
    await db.commit()
    await scratch.ensure_restored(get_settings(), snap)
    headers = await auth_headers(client, db)
    return f"/api/seed/snapshots/{snap.id}", headers


# ---- foreign_keys ------------------------------------------------------------------

async def test_foreign_keys_are_read_from_the_catalog(conn):
    fks = {(f.table, f.columns): f for f in await cl.foreign_keys(conn)}
    assert fks[("worker_profiles", ("person_id",))] == cl.ForeignKey(
        "worker_profiles", ("person_id",), "people", ("id",), True)
    assert fks[("worker_profiles", ("site_id",))].required is False
    assert fks[("sites", ("created_by",))].required is False
    assert fks[("members", ("org", "team_code"))] == cl.ForeignKey(
        "members", ("org", "team_code"), "teams", ("org", "code"), True)
    # A composite link with one nullable column is optional.
    assert fks[("members", ("org", "alt_code"))].required is False
    assert fks[("wiki_pages", ("parent_id",))].ref_table == "wiki_pages"
    # A generated column counts as set: only the other columns decide.
    assert fks[("gadgets", ("kind_record_type", "kind"))].required is True
    assert fks[("gadgets", ("kind_record_type", "old_kind"))].required is False
    # Only public tables, at both ends.
    assert all(f.table != "points_in" and f.ref_table != "outside" for f in fks.values())


# ---- closure ----------------------------------------------------------------------

def _reasons(c: cl.Closure) -> list[tuple]:
    return [(r.table, r.pk, r.needed_by_table, r.needed_by_pk, r.via_columns)
            for r in c.reasons]


async def test_required_links_add_rows_three_levels_up(conn):
    c = await cl.closure(conn, {"worker_profiles": {("10",)}})
    assert c.added == {"people": {("1",)}, "partners": {("1",)}, "regions": {("1",)}}
    assert _reasons(c) == [
        ("people", ("1",), "worker_profiles", ("10",), ("person_id",)),
        ("partners", ("1",), "people", ("1",), ("partner_id",)),
        ("regions", ("1",), "partners", ("1",), ("region_id",)),
    ]


async def test_a_shared_parent_is_added_once(conn):
    c = await cl.closure(conn, {"worker_profiles": {("10",), ("11",)}})
    assert c.added == {"people": {("1",), ("2",)}, "partners": {("1",), ("2",)},
                       "regions": {("1",)}}
    assert [r.table for r in c.reasons].count("regions") == 1


async def test_optional_links_add_nothing(conn):
    c = await cl.closure(conn, {"sites": {("1",)}})
    assert c.added == {} and c.reasons == []
    # worker 10's site is optional: only its person's chain comes.
    c = await cl.closure(conn, {"worker_profiles": {("10",)}})
    assert "sites" not in c.added
    assert ("3",) not in c.added["people"]


async def test_kept_rows_are_not_added_again(conn):
    c = await cl.closure(conn, {"worker_profiles": {("10",)}, "people": {("1",)},
                                "regions": {("1",)}})
    assert c.added == {"partners": {("1",)}}
    assert _reasons(c) == [("partners", ("1",), "people", ("1",), ("partner_id",))]


async def test_self_reference_follows_parents_and_terminates(conn):
    c = await cl.closure(conn, {"wiki_pages": {("3",)}})
    assert c.added == {"wiki_pages": {("2",), ("1",)}}
    assert _reasons(c) == [
        ("wiki_pages", ("2",), "wiki_pages", ("3",), ("parent_id",)),
        ("wiki_pages", ("1",), "wiki_pages", ("2",), ("parent_id",)),
    ]


async def test_composite_required_link(conn):
    c = await cl.closure(conn, {"members": {("1",)}})
    # (org, team_code) is required; (org, alt_code) is optional.
    assert c.added == {"teams": {("1", "red")}}
    assert _reasons(c) == [("teams", ("1", "red"), "members", ("1",), ("org", "team_code"))]


async def test_a_two_table_cycle_terminates(conn):
    c = await cl.closure(conn, {"cyc_a": {("1",)}})
    assert c.added == {"cyc_b": {("1",)}}
    assert _reasons(c) == [("cyc_b", ("1",), "cyc_a", ("1",), ("b_id",))]


async def test_all_tables_are_complete(conn):
    c = await cl.closure(conn, {"people": {("1",)}, "partners": "all"})
    # Nothing is added to an All rows table, but its rows' parents come.
    assert "partners" not in c.added
    assert c.added == {"regions": {("1",), ("2",)}}
    c = await cl.closure(conn, {"worker_profiles": {("10",)}, "people": "all",
                                "partners": "all", "regions": "all"})
    assert c.added == {} and c.reasons == []


async def test_a_needed_row_in_a_pk_less_table_brings_the_whole_table(conn):
    c = await cl.closure(conn, {"code_uses": {("1",)}})
    assert c.added_tables == [cl.TableReason("codes", "code_uses", ("code",))]
    assert "codes" not in c.added
    # codes is then complete: every one of its rows' required links is followed.
    assert c.added == {"regions": {("1",), ("2",)}}
    assert {(r.table, r.needed_by_table, r.needed_by_pk) for r in c.reasons} == {
        ("regions", "codes", None)}
    # Nothing needed from it: nothing added.
    c = await cl.closure(conn, {"code_uses": set()})
    assert c.added_tables == [] and c.added == {}
    # Already All rows: not reported again.
    c = await cl.closure(conn, {"code_uses": {("1",)}, "codes": "all"})
    assert c.added_tables == []


async def test_a_link_to_a_unique_column_reports_the_surrogate_pk(conn):
    c = await cl.closure(conn, {"scans": {("1",)}})
    assert c.added == {"devices": {("5",)}}
    assert _reasons(c) == [("devices", ("5",), "scans", ("1",), ("serial",))]


async def test_queries_are_per_link_per_round_not_per_row(conn):
    class Counting:
        def __init__(self, inner):
            self.inner, self.calls = inner, 0

        async def fetch(self, *args, **kwargs):
            self.calls += 1
            return await self.inner.fetch(*args, **kwargs)

    one, two = Counting(conn), Counting(conn)
    await cl.closure(one, {"worker_profiles": {("10",)}})
    await cl.closure(two, {"worker_profiles": {("10",), ("11",)}})
    assert one.calls == two.calls


# ---- POST /resolve ------------------------------------------------------------------

async def test_resolve_endpoint(client, opened):
    base, h = opened
    body = {"tables": {
        "worker_profiles": {"mode": "rows", "pks": [{"id": "10"}, {"id": "99"}]},
        "members": {"mode": "rows", "pks": [{"id": "1"}]},
        "wiki_pages": {"mode": "rows", "pks": [{"id": "2"}]},
        "regions": {"mode": "all", "pks": []},
        "nope": {"mode": "rows", "pks": [{"id": "1"}, {"id": "2"}]},
    }}
    resp = await client.post(f"{base}/resolve", json=body, headers=h)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["added"] == {"people": [{"id": "1"}], "partners": [{"id": "1"}],
                            "teams": [{"org": "1", "code": "red"}],
                            "wiki_pages": [{"id": "1"}]}
    assert sorted(out["reasons"], key=lambda r: r["table"]) == [
        {"table": "partners", "pk": {"id": "1"}, "label": "Partner A",
         "needed_by_table": "people", "needed_by_pk": {"id": "1"},
         "needed_by_label": "Person D"},
        {"table": "people", "pk": {"id": "1"}, "label": "Person D",
         "needed_by_table": "worker_profiles", "needed_by_pk": {"id": "10"},
         "needed_by_label": "Rigger"},
        {"table": "teams", "pk": {"org": "1", "code": "red"}, "label": "Red team",
         "needed_by_table": "members", "needed_by_pk": {"id": "1"},
         "needed_by_label": "Ann"},
        {"table": "wiki_pages", "pk": {"id": "1"}, "label": "Home",
         "needed_by_table": "wiki_pages", "needed_by_pk": {"id": "2"},
         "needed_by_label": "Guides"},
    ]
    assert out["missing"] == {"worker_profiles": [{"id": "99"}],
                              "nope": [{"id": "1"}, {"id": "2"}]}
    assert out["missing_tables"] == ["nope"]
    assert out["added_tables"] == []


async def test_resolve_reports_whole_tables_and_missing_tables(client, opened):
    base, h = opened
    resp = await client.post(f"{base}/resolve", headers=h, json={"tables": {
        "code_uses": {"mode": "rows", "pks": [{"id": "1"}]},
        "gone_all": {"mode": "all", "pks": []},
        "gone_empty": {"mode": "rows", "pks": []}}})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["added_tables"] == [{"table": "codes", "needed_by_table": "code_uses",
                                    "via_columns": ["code"]}]
    assert out["added"] == {"regions": [{"id": "1"}, {"id": "2"}]}
    assert [(r["needed_by_table"], r["needed_by_pk"], r["needed_by_label"])
            for r in out["reasons"]] == [("codes", None, None)] * 2
    assert out["missing_tables"] == ["gone_all", "gone_empty"]
    assert out["missing"] == {}


async def test_resolve_label_falls_back_to_the_pk(client, opened):
    base, h = opened
    resp = await client.post(f"{base}/resolve", headers=h, json={"tables": {
        "cyc_a": {"mode": "rows", "pks": [{"id": "1"}]},
        "members": {"mode": "rows", "pks": [{"id": "2"}]}}})
    assert resp.status_code == 200, resp.text
    reasons = {r["table"]: r for r in resp.json()["reasons"]}
    assert reasons["cyc_b"]["label"] == "1"
    assert reasons["cyc_b"]["needed_by_label"] == "1"
    assert reasons["teams"]["needed_by_label"] == "2"          # nick is NULL
    assert resp.json()["missing"] == {}


async def test_resolve_refuses_bad_keys(client, opened):
    base, h = opened
    for pks in ([{"nope": "1"}], [{"id": "1", "extra": "2"}], [{}], [{"id": "a\x00"}]):
        resp = await client.post(f"{base}/resolve", headers=h, json={"tables": {
            "people": {"mode": "rows", "pks": pks}}})
        assert resp.status_code == 400, (pks, resp.text)
        assert resp.json()["detail"] == {"code": "bad_pk"}
    resp = await client.post(f"{base}/resolve", headers=h, json={"tables": {
        "people": {"mode": "some", "pks": []}}})
    assert resp.status_code == 422
    # A value that isn't one of the column's (text comparison): just missing.
    resp = await client.post(f"{base}/resolve", headers=h, json={"tables": {
        "people": {"mode": "rows", "pks": [{"id": "x'; DROP TABLE people; --"}]}}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["missing"] == {"people": [{"id": "x'; DROP TABLE people; --"}]}
    assert resp.json()["added"] == {}


async def test_resolve_needs_seed_data_and_an_open_snapshot(client, db, opened, tmp_path,
                                                            closure_dump):
    from sqlalchemy import text
    base, _ = opened
    body = {"tables": {}}
    assert (await client.post(f"{base}/resolve", json=body)).status_code == 401
    snap = _snapshot(tmp_path, closure_dump)
    db.add(snap)
    await db.commit()
    h = await auth_headers(client, db, email="other@test.example.com")
    resp = await client.post(f"/api/seed/snapshots/{snap.id}/resolve", json=body, headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "snapshot_not_open"
    await db.execute(text("DELETE FROM role_permissions WHERE role = 'admin' "
                          "AND resource = 'seed_data'"))
    await db.commit()
    h = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.post(f"{base}/resolve", json=body, headers=h)
    assert resp.status_code == 403
