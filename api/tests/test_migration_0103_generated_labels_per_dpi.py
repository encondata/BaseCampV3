"""Migration 0103: generated labels are keyed per DPI as well as per entity,
initiative and type, and a generation run carries its DPI (300 for the runs
before it). Rolling back keeps the newest label of each old key. Runs on a
throwaway database (`<SS_TEST_DB>_m0103`) so the shared test DB stays at
head."""

import os
import uuid

import psycopg
import pytest
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0103"


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


def _label(conn, template_id, entity_id, dpi, code, generated_at="2026-10-01"):
    conn.execute(
        "INSERT INTO generated_labels (entity_type, entity_id, initiative_id, label_type, "
        "template_id, template_version, language_key, dpi_key, size_key, code, generated_at) "
        "VALUES ('asset', %s, NULL, 'top', %s, 1, 'zpl', %s, '4x2', %s, %s)",
        [entity_id, template_id, dpi, code, generated_at])


def test_labels_key_per_dpi_and_roll_back_to_the_newest(throwaway_url):
    _alembic(throwaway_url, "upgrade", "0102")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    entity = uuid.uuid4()
    with psycopg.connect(sync, autocommit=True) as conn:
        template = conn.execute(
            "INSERT INTO label_templates (name, label_type, size_key, dpi_key, language_key, "
            "kind, code) VALUES ('T', 'top', '4x2', '203', 'zpl', 'code', '^XA^XZ') "
            "RETURNING id").fetchone()[0]
        _label(conn, template, entity, "203", "old-203")
        with pytest.raises(psycopg.errors.UniqueViolation):
            _label(conn, template, entity, "300", "old-300")

    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert conn.execute(
            "SELECT column_default FROM information_schema.columns WHERE "
            "table_name = 'label_generation_runs' AND column_name = 'dpi_key'"
        ).fetchone() == ("'300'::text",)
        _label(conn, template, entity, "300", "new-300", generated_at="2026-10-02")
        with pytest.raises(psycopg.errors.UniqueViolation):
            _label(conn, template, entity, "300", "again-300")

    _alembic(throwaway_url, "downgrade", "0102")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert conn.execute("SELECT code FROM generated_labels").fetchall() == [("new-300",)]
        with pytest.raises(psycopg.errors.UniqueViolation):
            _label(conn, template, entity, "203", "old-203")
    _alembic(throwaway_url, "upgrade", "head")
