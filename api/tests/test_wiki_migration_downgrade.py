"""The wiki migrations roll back over a database the app and worker have
actually used: upgrade to head, leave behind the rows a real deployment
has (the worker's start-up `reminders` and `retention` jobs, an export
job, a review's `submitted` snapshot), downgrade below the wiki (0073),
and upgrade to head again.

Runs on its own throwaway database (`<SS_TEST_DB>_downgrade`, created and
dropped here) — never the shared test database, whose schema the rest of
the suite relies on staying at head. It takes a few seconds."""
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings

API_DIR = Path(__file__).resolve().parents[1]
THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_downgrade"


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


def _alembic(url, *args):
    env = {**os.environ, "SS_DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run([str(API_DIR / ".venv/bin/alembic"), *args], cwd=API_DIR,
                            env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr[-2000:]


def test_wiki_downgrade_below_0074_with_worker_rows_present(throwaway_url):
    _alembic(throwaway_url, "upgrade", "head")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        for kind in ("reminders", "retention", "export", "purge"):
            conn.execute("INSERT INTO wiki_jobs (kind) VALUES (%s)", (kind,))
        space = conn.execute(
            "INSERT INTO wiki_spaces (key, name) VALUES ('rt', 'RT') RETURNING id").fetchone()[0]
        node = conn.execute(
            "INSERT INTO wiki_nodes (space_id, kind, title) VALUES (%s, 'page', 'P') "
            "RETURNING id", (space,)).fetchone()[0]
        conn.execute("INSERT INTO wiki_pages (node_id) VALUES (%s)", (node,))
        version = conn.execute(
            "INSERT INTO wiki_page_versions (node_id, version_no, title, kind) "
            "VALUES (%s, 1, 'P', 'submitted') RETURNING id", (node,)).fetchone()[0]
        conn.execute("INSERT INTO wiki_reviews (node_id, version_id) VALUES (%s, %s)",
                     (node, version))

    _alembic(throwaway_url, "downgrade", "0075")
    with psycopg.connect(sync, autocommit=True) as conn:
        kinds = sorted(r[0] for r in conn.execute("SELECT kind FROM wiki_jobs"))
    assert kinds == ["purge", "reminders"]       # 0076's kinds went, the rest stay

    _alembic(throwaway_url, "downgrade", "0074")
    with psycopg.connect(sync, autocommit=True) as conn:
        kinds = sorted(r[0] for r in conn.execute("SELECT kind FROM wiki_jobs"))
        versions = [r[0] for r in conn.execute("SELECT kind FROM wiki_page_versions")]
    assert kinds == ["purge"]
    assert versions == ["autosave"]              # the review snapshot stays as history

    _alembic(throwaway_url, "downgrade", "0073")
    _alembic(throwaway_url, "upgrade", "head")
